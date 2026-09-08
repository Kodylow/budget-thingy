import { createHash } from "node:crypto";
import type { Authorization } from "../lib/authz";
import {
  buildCanonicalAccountDirectory,
  buildCanonicalGroupMergePlan,
  getCachedDirectory,
  getDirectoryFreshness,
  hasSuccessfulLimitObservation,
  resolveCanonicalMergedGroupBudget,
} from "../lib/enterprise";
import { deriveEffectiveTeamBudgets } from "../lib/team-budgets";
import {
  getConfigurationSnapshot,
  type ConfigurationSnapshot,
} from "../lib/configuration-snapshot";
import {
  BoundedTaskScheduler,
  BoundedStaleCache,
  estimateRetainedBytes,
} from "../lib/bounded-stale-cache";
import type { SnapshotUsageRollup } from "../lib/usage-rollup";
import {
  buildGroupTeamMap,
  dailyUsageRollups,
  groupTeamKey,
  usageForRequest,
  visibleGroupMembers,
  visibleGroups,
  windowFromQuery,
  workspaceScope,
} from "../routes/monitor.shared";
import {
  getUsageSnapshotGeneration,
  isUsageGenerationUpdateActive,
  readUsageSnapshot,
} from "../lib/usage-store";
import {
  readCurrentProjectIdentities,
  readProjectMetadata,
} from "../lib/project-metadata";
import { logger } from "../lib/logger";

export type ViewScope = "managed" | "my" | "all_authorized";
export type TableView = "pools" | "groups" | "people" | "projects";

const accountingCache = new BoundedStaleCache<
  Awaited<ReturnType<typeof computeScopedAccounting>>
>({
  maxEntries: 24,
  maxWeight: 128 * 1024 * 1024,
  estimateWeight: estimateRetainedBytes,
  freshMs: 30_000,
  staleMs: 2 * 60_000,
});
let accountingBuildCount = 0;
const accountingBuildScheduler = new BoundedTaskScheduler(2, 8);

export function utcAccountingDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function committedGenerationId(identity: {
  usageDataAsOf: string | null;
  directoryDataAsOf: string | null;
  usageStatus: string;
  coverage: unknown;
  limitObservation: unknown;
  period: unknown;
  scope: unknown;
  allocationRevision?: unknown;
  projectMetadataRevision?: unknown;
  utcDay?: unknown;
  directoryIsStale?: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(identity))
    .digest("hex").slice(0, 24);
}

export function computeProjectMetadataRevision(
  states: readonly {
    workspaceId: string;
    status: string;
    completedAt: Date;
  }[],
): string {
  return createHash("sha256").update(JSON.stringify({
    states: states.map((row) => ({
      ...row,
      completedAt: row.completedAt.toISOString(),
    })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  })).digest("hex").slice(0, 24);
}

export interface SpendRow {
  id: string;
  projectId?: string;
  kind: "pool" | "group" | "person" | "project" | "unattributed" | "reconciliation";
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  spendUsd: number;
  agentSpendUsd: number;
  otherServicesUsd: number;
  allocationUsd: number | null;
  remainingUsd: number | null;
  percentUsed: number | null;
  currentCycleAgentSpendUsd?: number | null;
  currentCycleRemainingUsd?: number | null;
  currentCyclePercentUsed?: number | null;
  status: string;
  memberCount: number | null;
  ownerName: string | null;
  limitState: "not_applicable" | "explicit" | "inherited" | "no_limit" | "unavailable";
  limitObservationStatus:
    | "not_applicable"
    | "complete"
    | "failed"
    | "unavailable"
    | "refreshing";
  sharedPool: boolean;
  usageObserved: boolean;
  isPublished?: boolean | null;
  sourceGroupIds?: string[];
  ownerId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  metadataAvailability?: "complete" | "stale" | "unavailable";
  hasDeployment?: boolean | null;
  deploymentAvailability?: "complete" | "stale" | "unavailable";
  deployments?: Array<{
    id: string;
    url: string | null;
    privacy: string | null;
    status: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  currentMonthSpendUsd?: number | null;
  currentMonthUsageAvailability?: "complete" | "partial" | "unavailable";
  staleButSpending?: boolean;
}

export interface StaleSpendEvaluation {
  evaluatedAt: string;
  staleCutoff: string;
  monthStart: string;
  monthEndExclusive: string;
  availability: "complete" | "partial" | "unavailable";
  coverage: Awaited<ReturnType<typeof usageForRequest>>["snapshot"]["coverage"];
}

export function staleSpendEvaluation(
  snapshot: Awaited<ReturnType<typeof usageForRequest>>["snapshot"],
  evaluatedAt = new Date(),
): StaleSpendEvaluation {
  const evaluatedMs = evaluatedAt.getTime();
  const monthStart = new Date(Date.UTC(
    evaluatedAt.getUTCFullYear(), evaluatedAt.getUTCMonth(), 1,
  ));
  const monthEndExclusive = new Date(Date.UTC(
    evaluatedAt.getUTCFullYear(), evaluatedAt.getUTCMonth() + 1, 1,
  ));
  const coverage = snapshot.coverage;
  const availability = coverage.presentWorkspaceDays === 0
    ? "unavailable" as const
    : coverage.failedWorkspaceDays.length === 0 &&
        coverage.missingWorkspaceDays.length === 0 &&
        coverage.ratio === 1
      ? "complete" as const
      : "partial" as const;
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    staleCutoff: new Date(evaluatedMs - 30 * 86_400_000).toISOString(),
    monthStart: monthStart.toISOString(),
    monthEndExclusive: monthEndExclusive.toISOString(),
    availability,
    coverage,
  };
}

export function isStaleButSpending(
  updatedAt: string | Date | null | undefined,
  currentMonthSpendUsd: number | null,
  staleCutoff: string | Date,
): boolean {
  if (updatedAt == null || currentMonthSpendUsd == null ||
      currentMonthSpendUsd <= 0) return false;
  const updatedMs = new Date(updatedAt).getTime();
  const cutoffMs = new Date(staleCutoff).getTime();
  return Number.isFinite(updatedMs) && updatedMs <= cutoffMs;
}

export function personalProjectCatalog(
  projectMetadata: Awaited<ReturnType<typeof usageForRequest>>["projectMetadata"],
  workspaceIds: Iterable<string>,
  authz: Authorization,
) {
  if (!isSelfOnly(authz)) return undefined;
  const ids = [...new Set(workspaceIds)].sort();
  const candidates = new Map<string, Array<{
    projectId: string;
    workspaceId: string;
    creatorId: string | null;
    title: string | null;
    isPublished: boolean | null;
    observedAt: number;
  }>>();
  for (const workspaceId of ids) {
    const observedAt = projectMetadata.freshnessByWorkspace
      .get(workspaceId)?.lastSuccessfulAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    for (const [projectId, metadata] of
      projectMetadata.byWorkspace.get(workspaceId) ?? []) {
      const current = candidates.get(projectId) ?? [];
      current.push({
        projectId,
        workspaceId,
        creatorId: metadata.creatorId,
        title: metadata.title,
        isPublished: projectMetadata.deploymentObservedWorkspaceIds
            .has(workspaceId)
          ? metadata.hasDeployment
          : null,
        observedAt,
      });
      candidates.set(projectId, current);
    }
  }
  const projects = new Map<string, {
    projectId: string;
    workspaceId: string;
    title: string | null;
    isPublished: boolean | null;
  }>();
  let hasAmbiguousCurrentProject = false;
  for (const [projectId, rows] of candidates) {
    const freshestAt = Math.max(...rows.map((row) => row.observedAt));
    const freshest = rows.filter((row) => row.observedAt === freshestAt)
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    if (new Set(freshest.map((row) => row.creatorId)).size > 1) {
      hasAmbiguousCurrentProject = true;
      continue;
    }
    if (freshest.length > 1) hasAmbiguousCurrentProject = true;
    const current = {
      ...freshest[0]!,
      isPublished: new Set(freshest.map((row) => row.isPublished)).size > 1
        ? null
        : freshest[0]!.isPublished,
    };
    if (current.creatorId !== authz.userId) continue;
    projects.set(projectId, {
      projectId,
      workspaceId: current.workspaceId,
      title: current.title,
      isPublished: current.isPublished,
    });
  }
  const freshness = ids.map((workspaceId) =>
    projectMetadata.freshnessByWorkspace.get(workspaceId));
  const successfulDates = freshness.flatMap((item) =>
    item?.lastSuccessfulAt ? [item.lastSuccessfulAt] : []);
  const complete = !hasAmbiguousCurrentProject && ids.length > 0 &&
    ids.every((workspaceId) =>
    projectMetadata.completeWorkspaceIds.has(workspaceId) &&
    projectMetadata.deploymentCompleteWorkspaceIds.has(workspaceId) &&
    projectMetadata.freshnessByWorkspace.get(workspaceId)?.status === "success");
  const observed = projects.size > 0 ||
    freshness.some((item) => item?.lastSuccessfulAt != null);
  const values = [...projects.values()];
  return {
    projects: values,
    projectCount: values.length,
    publishedProjectCount:
      values.filter((project) => project.isPublished === true).length,
    publicationKnownProjectCount:
      values.filter((project) => project.isPublished !== null).length,
    publicationUnknownProjectCount:
      values.filter((project) => project.isPublished === null).length,
    coverage: complete ? "complete" as const
      : observed ? "partial" as const : "missing" as const,
    dataAsOf: successfulDates.length === 0
      ? null
      : new Date(Math.min(...successfulDates.map((date) => date.getTime())))
        .toISOString(),
  };
}

interface QualifiedRollupTotals {
  /** Spend displayed in this report; personal reports include the actor's own usage. */
  reportedSpendUsd: number;
  eligibleSpendUsd: number;
  agentSpendUsd: number;
  internalExcludedUsd: number;
  unattributedUsd: number;
  reconciliationUsd: number;
}

function isSelfOnly(authz: Authorization): boolean {
  return authz.roles.length === 1 &&
    authz.roles[0] === "member" &&
    authz.userIds?.length === 1 &&
    authz.userIds[0] === authz.userId;
}

function ownInternalComponents(
  rollup: SnapshotUsageRollup,
  authz: Authorization,
): { agent: number; other: number } {
  if (!isSelfOnly(authz)) return { agent: 0, other: 0 };
  let agent = 0;
  let other = 0;
  for (const users of rollup.excludedInternalAgentSpendByWorkspaceUser?.values() ?? []) {
    agent += users.get(authz.userId) ?? 0;
  }
  for (const users of rollup.excludedInternalOtherSpendByWorkspaceUser?.values() ?? []) {
    other += users.get(authz.userId) ?? 0;
  }
  return { agent, other };
}

function ownActualComponents(
  rollup: SnapshotUsageRollup,
  authz: Authorization,
): { agent: number; other: number } {
  if (!isSelfOnly(authz)) return { agent: 0, other: 0 };
  let agent = 0;
  let other = 0;
  for (const users of rollup.agentSpendByWorkspaceUser?.values() ?? []) {
    agent += users.get(authz.userId) ?? 0;
  }
  for (const users of rollup.otherSpendByWorkspaceUser?.values() ?? []) {
    other += users.get(authz.userId) ?? 0;
  }
  return { agent, other };
}

function sumMap(values: ReadonlyMap<string, number> | undefined): number {
  return [...(values?.values() ?? [])].reduce((sum, value) => sum + value, 0);
}

function qualifiedGroupComponent(
  values: ReadonlyMap<string, number> | undefined,
  authz: Authorization,
  group: { id: string; workspaceId: string },
): number {
  if (authz.roles.includes("account") ||
      authz.workspaceIds.includes(group.workspaceId)) return sumMap(values);
  const allowed = new Set(authz.groupUserIds?.[group.id] ?? []);
  return [...(values ?? [])].reduce((sum, [userId, value]) =>
    sum + (allowed.has(userId) ? value : 0), 0);
}

export function qualifiedGroupSpendComponents(
  rollup: SnapshotUsageRollup,
  authz: Authorization,
  groups: readonly { id: string; workspaceId: string }[],
): { spendUsd: number; agentSpendUsd: number; otherServicesUsd: number } {
  let agentSpendUsd = 0;
  let otherServicesUsd = 0;
  for (const group of groups) {
    agentSpendUsd += qualifiedGroupComponent(
      rollup.aiSpendByGroup.get(group.id), authz, group);
    otherServicesUsd += qualifiedGroupComponent(
      rollup.nonAiSpendByGroup.get(group.id), authz, group);
  }
  return {
    spendUsd: agentSpendUsd + otherServicesUsd,
    agentSpendUsd,
    otherServicesUsd,
  };
}

/**
 * Apply one workspace/group/user qualification predicate to every accounting
 * component. A group grant contributes only that group's attributed users; it
 * never promotes the request to the group's entire workspace.
 */
export function qualifiedRollupTotals(
  rollup: SnapshotUsageRollup,
  authz: Authorization,
  groups: readonly { id: string; workspaceId: string }[],
): QualifiedRollupTotals {
  if (authz.roles.includes("account")) {
    return {
      reportedSpendUsd: rollup.eligibleSpendUsd,
      eligibleSpendUsd: rollup.eligibleSpendUsd,
      agentSpendUsd: sumMap(rollup.aiSpendByUser) +
        [...rollup.ungroupedByWorkspace.values()]
          .reduce((sum, item) => sum + sumMap(item.byUser), 0),
      internalExcludedUsd: rollup.excludedInternalSpendUsd,
      unattributedUsd: rollup.residualSpendUsd,
      reconciliationUsd: rollup.accountReconciliationSpendUsd,
    };
  }
  const managedWorkspaceIds = new Set(authz.workspaceIds);
  const workspaceGroups = groups.filter((group) =>
    managedWorkspaceIds.has(group.workspaceId));
  const additionalGroups = groups.filter((group) =>
    !managedWorkspaceIds.has(group.workspaceId));
  const workspaceAgent = workspaceGroups.reduce((sum, group) =>
    sum + sumMap(rollup.aiSpendByGroup.get(group.id)), 0) +
    [...managedWorkspaceIds].reduce((sum, workspaceId) =>
      sum + sumMap(rollup.ungroupedByWorkspace.get(workspaceId)?.byUser), 0);
  const additionalAgent = additionalGroups.reduce((sum, group) =>
    sum + qualifiedGroupComponent(
      rollup.aiSpendByGroup.get(group.id), authz, group), 0);
  const eligibleSpendUsd = [...managedWorkspaceIds].reduce((sum, workspaceId) =>
      sum + (rollup.byWorkspace.get(workspaceId) ?? 0), 0) +
      additionalGroups.reduce((sum, group) =>
        sum +
          qualifiedGroupComponent(rollup.aiSpendByGroup.get(group.id), authz, group) +
          qualifiedGroupComponent(rollup.nonAiSpendByGroup.get(group.id), authz, group),
       0);
  const ownInternal = ownInternalComponents(rollup, authz);
  if (
    isSelfOnly(authz) &&
    (rollup.agentSpendByWorkspaceUser !== undefined ||
      rollup.otherSpendByWorkspaceUser !== undefined)
  ) {
    const ownActual = ownActualComponents(rollup, authz);
    const ownExcluded = ownInternal.agent + ownInternal.other;
    return {
      reportedSpendUsd: ownActual.agent + ownActual.other,
      eligibleSpendUsd:
        ownActual.agent + ownActual.other - ownExcluded,
      agentSpendUsd: ownActual.agent,
      internalExcludedUsd: ownExcluded,
      unattributedUsd: 0,
      reconciliationUsd: 0,
    };
  }
  const internalExcludedUsd = [...managedWorkspaceIds].reduce((sum, workspaceId) =>
      sum + (rollup.excludedInternalSpendByWorkspace.get(workspaceId) ?? 0), 0) +
      additionalGroups.reduce((sum, group) =>
        sum + [...(rollup.excludedInternalSpendByGroupUser
          ?.get(group.id) ?? [])].reduce(
          (groupSum, [userId, value]) =>
            groupSum + ((authz.groupUserIds?.[group.id] ?? [])
              .includes(userId) ? value : 0),
          0,
         ), 0);
  return {
    reportedSpendUsd: eligibleSpendUsd + ownInternal.agent + ownInternal.other,
    eligibleSpendUsd,
    agentSpendUsd: workspaceAgent + additionalAgent + ownInternal.agent,
    internalExcludedUsd: isSelfOnly(authz)
      ? ownInternal.agent + ownInternal.other
      : internalExcludedUsd,
    unattributedUsd: [...managedWorkspaceIds].reduce((sum, workspaceId) =>
      sum + (rollup.ungroupedByWorkspace.get(workspaceId)?.spendUsd ?? 0), 0),
    reconciliationUsd: 0,
  };
}

export function canExposeCanonicalAllocation(
  authz: Authorization,
  contributingGroups: readonly { id: string; workspaceId: string }[],
): boolean {
  if (authz.roles.includes("account")) return true;
  const workspaces = new Set(authz.workspaceIds);
  const managedGroups = new Set(authz.managedGroupIds ?? []);
  return contributingGroups.length > 0 && contributingGroups.every((group) =>
    workspaces.has(group.workspaceId) || managedGroups.has(group.id));
}

export function resolveCanonicalPoolAccess(
  authz: Authorization,
  contributingGroups: readonly { id: string; workspaceId: string }[],
  visibleContributingGroupCount: number,
  allocationUsd: number | null,
): { sharedPool: boolean; allocationUsd: number | null } {
  const sharedPool =
    new Set(contributingGroups.map((group) => group.workspaceId)).size > 1 ||
    contributingGroups.length > visibleContributingGroupCount;
  return {
    sharedPool,
    allocationUsd: canExposeCanonicalAllocation(authz, contributingGroups)
      ? allocationUsd
      : null,
  };
}

/** Stable qualified identity shared by canonical team-pool producers and selectors. */
export function canonicalTeamPoolId(teamName: string): string {
  return `pool:team:${encodeURIComponent(teamName)}`;
}

const DAY_MS = 86_400_000;

export function buildBudgetTrackingPoints(
  start: string,
  endExclusive: string,
  dailySpend: ReadonlyMap<string, number>,
  unavailableDays: ReadonlySet<string>,
): Array<{ date: string; spendUsd: number | null }> {
  const points: Array<{ date: string; spendUsd: number | null }> = [];
  let cumulative = 0;
  let hasObservedValue = false;
  for (
    let time = Date.parse(start);
    time < Date.parse(endExclusive);
    time += DAY_MS
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (dailySpend.has(date)) {
      cumulative += dailySpend.get(date) ?? 0;
      hasObservedValue = true;
    }
    points.push({
      date,
      // A leading wholly-unobserved period has no known cumulative value.
      // Once any value (including a known zero) is observed, later source
      // gaps do not erase the recorded cumulative history.
      spendUsd: unavailableDays.has(date) && !hasObservedValue
        ? null
        : cumulative,
    });
  }
  return points;
}

export function summarizeReportingSemantics(
  rollups: Iterable<SnapshotUsageRollup>,
): {
  acquisitionCoverage: "complete" | "partial" | "unavailable";
  rosterAttributionBasis: "observed_roster" | "current_membership" | "mixed";
  creatorCoverage: "complete" | "partial" | "not_applicable";
  creatorAttributionBasis:
    | "verified_historical"
    | "current_catalog_observation"
    | "mixed"
    | "unavailable"
    | "not_applicable";
  freshness: "fresh" | "stale" | "unavailable";
  valueBasis:
    | "verified"
    | "current_membership_qualified"
    | "current_catalog_qualified"
    | "partial_known"
    | "unavailable";
  comparisonsVerified: boolean;
} {
  const values = [...rollups];
  const observed = values.filter((item) =>
    item.reporting.acquisitionCoverage !== "unavailable");
  const acquisitionCoverage = observed.length === 0
    ? "unavailable" as const
    : observed.length === values.length &&
        values.every((item) => item.reporting.acquisitionCoverage === "complete")
      ? "complete" as const
      : "partial" as const;
  const hasCurrentMembershipFallback = observed.some((item) =>
    item.reporting.rosterAttributionBasis === "current_membership");
  const hasVerifiedRoster = observed.some((item) =>
    item.reporting.rosterAttributionBasis !== "current_membership");
  const rosterAttributionBasis =
    hasCurrentMembershipFallback && hasVerifiedRoster
      ? "mixed" as const
      : hasCurrentMembershipFallback
        ? "current_membership" as const
        : "observed_roster" as const;
  const creatorCoverage = observed.some((item) =>
    item.reporting.creatorCoverage === "partial")
    ? "partial" as const
    : observed.some((item) => item.reporting.creatorCoverage === "complete")
      ? "complete" as const
      : "not_applicable" as const;
  const creatorBases = new Set(observed.map((item) =>
    item.reporting.creatorAttributionBasis).filter((basis) =>
      basis !== "not_applicable"));
  const creatorAttributionBasis = creatorBases.size === 0
    ? "not_applicable" as const
    : creatorBases.size > 1
      ? "mixed" as const
      : [...creatorBases][0]!;
  const freshness = observed.length === 0
    ? "unavailable" as const
    : observed.some((item) => item.reporting.freshness === "stale")
      ? "stale" as const
      : "fresh" as const;
  const comparisonsVerified = values.length > 0 &&
    values.every((item) => item.reporting.comparisonsVerified);
  const valueBasis = acquisitionCoverage === "unavailable"
    ? "unavailable" as const
    : rosterAttributionBasis === "current_membership" ||
        rosterAttributionBasis === "mixed"
      ? "current_membership_qualified" as const
      : creatorAttributionBasis === "current_catalog_observation" ||
          creatorAttributionBasis === "mixed"
        ? "current_catalog_qualified" as const
        : comparisonsVerified
          ? "verified" as const
          : "partial_known" as const;
  return {
    acquisitionCoverage,
    rosterAttributionBasis,
    creatorCoverage,
    creatorAttributionBasis,
    freshness,
    valueBasis,
    comparisonsVerified,
  };
}

export function qualifiedUserSpendByWorkspace(
  daily: ReadonlyMap<string, SnapshotUsageRollup>,
  authz: Authorization,
  groups: readonly { id: string; workspaceId: string }[],
  scopedWorkspaceIds: Iterable<string> = groups.map((group) => group.workspaceId),
): Map<string, Map<string, { agent: number; other: number }>> {
  const result = new Map<string, Map<string, { agent: number; other: number }>>();
  const add = (
    workspaceId: string,
    userId: string,
    agent: number,
    other: number,
  ): void => {
    const users = result.get(workspaceId) ?? new Map();
    const current = users.get(userId) ?? { agent: 0, other: 0 };
    current.agent += agent;
    current.other += other;
    users.set(userId, current);
    result.set(workspaceId, users);
  };
  for (const rollup of daily.values()) {
    if (isSelfOnly(authz)) {
      for (const workspaceId of scopedWorkspaceIds) {
        add(
          workspaceId,
          authz.userId,
          rollup.agentSpendByWorkspaceUser
            ?.get(workspaceId)?.get(authz.userId) ?? 0,
          rollup.otherSpendByWorkspaceUser
            ?.get(workspaceId)?.get(authz.userId) ?? 0,
        );
      }
      continue;
    }
    for (const group of groups) {
      const agents = rollup.aiSpendByGroup.get(group.id) ?? new Map();
      const others = rollup.nonAiSpendByGroup.get(group.id) ?? new Map();
      for (const userId of new Set([...agents.keys(), ...others.keys()])) {
        if (!authz.roles.includes("account") &&
            !authz.workspaceIds.includes(group.workspaceId) &&
            !(authz.groupUserIds?.[group.id] ?? []).includes(userId)) continue;
        add(group.workspaceId, userId,
          agents.get(userId) ?? 0, others.get(userId) ?? 0);
      }
    }
    for (const workspaceId of new Set(authz.roles.includes("account")
      ? [...scopedWorkspaceIds]
      : authz.workspaceIds)) {
      for (const [userId, amount] of
        rollup.ungroupedByWorkspace.get(workspaceId)?.byUser ?? []) {
        add(workspaceId, userId, amount, 0);
      }
    }
  }
  return result;
}

function requestedViewScope(authz: Authorization, value: unknown): ViewScope {
  if (value === "managed" || value === "my" || value === "all_authorized") return value;
  return authz.roles.some((role) => role !== "member") ? "managed" : "my";
}

export function resolveAuthorizationForView(
  authz: Authorization,
  viewScope: ViewScope,
  groupMembers: ReadonlyMap<string, readonly string[]>,
): Authorization {
  if (viewScope === "my") {
    const groupIds = [...groupMembers]
      .filter(([, members]) => members.includes(authz.userId))
      .map(([groupId]) => groupId);
    return {
      ...authz,
      role: "member",
      roles: ["member"],
      workspaceIds: [],
      teamNames: [],
      groupIds,
      managedGroupIds: [],
      groupUserIds: Object.fromEntries(groupIds.map((id) => [id, [authz.userId]])),
      userIds: [authz.userId],
      isTrueAccountAdmin: false,
    };
  }
  if (
    viewScope === "managed" &&
    !authz.roles.includes("account") &&
    authz.managedGroupIds
  ) {
    const managed = new Set(authz.managedGroupIds);
    const groupUserIds = Object.fromEntries(
      Object.entries(authz.groupUserIds ?? {})
        .filter(([groupId]) => managed.has(groupId)),
    );
    return {
      ...authz,
      groupIds: [...managed].sort(),
      groupUserIds,
      userIds: [...new Set(Object.values(groupUserIds).flat())].sort(),
    };
  }
  return authz;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

export function currentCycleLimitMetrics(
  limitUsd: number | null,
  currentCycleAgentSpendUsd: number | null,
): {
  remainingUsd: number | null;
  percentUsed: number | null;
} {
  return {
    remainingUsd: limitUsd === null || currentCycleAgentSpendUsd === null
      ? null
      : round(limitUsd - currentCycleAgentSpendUsd),
    percentUsed: limitUsd !== null && limitUsd > 0 &&
        currentCycleAgentSpendUsd !== null
      ? round(currentCycleAgentSpendUsd / limitUsd * 100)
      : null,
  };
}

export async function getCurrentCycleMemberSnapshot(
  base: Awaited<ReturnType<typeof buildScopedAccounting>>,
  workspaceIds?: Iterable<string>,
) {
  const billingWindow = windowFromQuery({ rangeType: "billing" }).window;
  const requestedWorkspaceIds = workspaceIds
    ? [...new Set(workspaceIds)].sort()
    : base.usage.workspaceIds;
  return workspaceIds === undefined &&
      base.usage.selection.window.start === billingWindow.start &&
      base.usage.selection.window.end === billingWindow.end
    ? base.usage.snapshot
    : readUsageSnapshot({
      window: billingWindow,
      workspaceIds: requestedWorkspaceIds,
      includeAccountAnchor: base.authz.roles.includes("account"),
    });
}

function statusFor(allocation: number | null, spend: number, shared = false): string {
  if (shared && allocation === null) return "shared";
  if (allocation === null || allocation <= 0) return "no_allocation";
  const percent = spend / allocation;
  return percent >= 1 ? "over" : percent >= 0.9 ? "attention" : "budgeted";
}

function observedWorkspaceIds(
  snapshot: Awaited<ReturnType<typeof usageForRequest>>["snapshot"],
): Set<string> {
  const failed = new Set(snapshot.coverage.failedWorkspaceDays.map(
    ({ workspaceId, usageDate }) => `${workspaceId}\0${usageDate}`));
  const observed = new Set<string>();
  for (const [usageDate, workspaces] of snapshot.dailyWorkspaces ?? []) {
    for (const workspaceId of workspaces.keys()) {
      if (!failed.has(`${workspaceId}\0${usageDate}`)) observed.add(workspaceId);
    }
  }
  return observed;
}

function workspaceUsageIsComplete(
  snapshot: Awaited<ReturnType<typeof usageForRequest>>["snapshot"],
  workspaceId: string,
): boolean {
  if (snapshot.coverage.failedWorkspaceDays.some((item) =>
      item.workspaceId === workspaceId) ||
    snapshot.coverage.missingWorkspaceDays.some((item) =>
      item.workspaceId === workspaceId)) return false;
  const startDay = snapshot.window.start.slice(0, 10);
  const endDay = snapshot.window.end.slice(0, 10);
  const requestedDays = Math.max(0, (
    Date.parse(`${endDay}T00:00:00.000Z`) -
    Date.parse(`${startDay}T00:00:00.000Z`)
  ) / 86_400_000);
  const observedDays = [...(snapshot.dailyWorkspaces ?? [])].filter(
    ([day, workspaces]) =>
      day >= startDay && day < endDay &&
      workspaces.has(workspaceId),
  ).length;
  return observedDays === requestedDays;
}
export function resolveStoredMemberLimit(
  dir: Awaited<ReturnType<typeof getCachedDirectory>>,
  workspaceId: string,
  userId: string,
): { amount: number | null; state: SpendRow["limitState"] } {
  if (!hasSuccessfulLimitObservation(dir.budgets)) {
    return { amount: null, state: "unavailable" };
  }
  const explicit = dir.budgets.userLimits.get(workspaceId)?.get(userId);
  if (explicit !== undefined) return { amount: explicit, state: "explicit" };
  const inherited = dir.budgets.workspaceDefaults.get(workspaceId);
  if (inherited !== undefined) return { amount: inherited, state: "inherited" };
  return { amount: null, state: "no_limit" };
}

export interface ScopedAccountingContext {
  dir: Awaited<ReturnType<typeof getCachedDirectory>>;
  viewScope: ViewScope;
  effectiveAuth: Authorization;
  cacheIdentity: string;
  baseCacheIdentity: string;
  allocationRevision: string;
  configuration: ConfigurationSnapshot;
  projectMetadataRevision: string;
  usageGeneration: number;
  phaseDurations: {
    authorizationMs: number;
    storedReadsMs: number;
  };
}

function sortedAuthorization(authz: Authorization): unknown {
  return {
    userId: authz.userId,
    role: authz.role,
    roles: [...authz.roles].sort(),
    workspaceIds: [...authz.workspaceIds].sort(),
    teamNames: [...authz.teamNames].sort(),
    groupIds: [...authz.groupIds].sort(),
    managedGroupIds: [...(authz.managedGroupIds ?? [])].sort(),
    groupUserIds: Object.fromEntries(Object.entries(authz.groupUserIds ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([groupId, userIds]) => [groupId, [...userIds].sort()])),
    userIds: [...authz.userIds].sort(),
    isTrueAccountAdmin: authz.isTrueAccountAdmin,
    isPreview: !!authz.isPreview,
    capabilities: {
      ...authz.capabilities,
      canWriteUserLimitsIn: [...authz.capabilities.canWriteUserLimitsIn].sort(),
    },
  };
}

export async function prepareScopedAccounting(
  authz: Authorization,
  query: Record<string, unknown>,
  detailView?: TableView,
  suppliedConfiguration?: ConfigurationSnapshot,
): Promise<ScopedAccountingContext> {
  const directoryStartedAt = performance.now();
  const dir = await getCachedDirectory();
  const directoryMs = performance.now() - directoryStartedAt;
  const authorizationStartedAt = performance.now();
  const viewScope = requestedViewScope(authz, query["viewScope"]);
  const effectiveAuth = resolveAuthorizationForView(authz, viewScope, dir.groupMembers);
  const window = windowFromQuery(query).window;
  const authorizationMs = performance.now() - authorizationStartedAt;
  const allocationStartedAt = performance.now();
  const configuration =
    suppliedConfiguration ?? await getConfigurationSnapshot();
  const allocationRevision = configuration.revision;
  const authorizedProjectWorkspaceIds = [...workspaceScope(
    effectiveAuth,
    dir,
    visibleGroups(effectiveAuth, dir.groups),
  )];
  const requestedWorkspaceId = typeof query["workspaceId"] === "string" &&
      query["workspaceId"]
    ? query["workspaceId"]
    : null;
  const projectWorkspaceIds = requestedWorkspaceId === null
    ? authorizedProjectWorkspaceIds
    : authorizedProjectWorkspaceIds.includes(requestedWorkspaceId)
      ? [requestedWorkspaceId]
      : [];
  const projectMetadataRevision =
    (await readProjectMetadata(projectWorkspaceIds)).revision;
  const allocationMs = performance.now() - allocationStartedAt;
  const usageGeneration = getUsageSnapshotGeneration();
  const identity = {
    usageDataAsOf: String(usageGeneration),
    directoryDataAsOf: new Date(dir.fetchedAt).toISOString(),
    usageStatus: "persisted",
    coverage: dir.budgets.observation,
    limitObservation: dir.budgets.observation.generation,
    period: window,
    utcDay: utcAccountingDay(),
    directoryIsStale: getDirectoryFreshness().isStale,
    scope: {
      authorization: sortedAuthorization(effectiveAuth),
      workspaceFilter: requestedWorkspaceId,
    },
    allocationRevision,
  };
  const baseCacheIdentity = committedGenerationId({
    ...identity,
    projectMetadataRevision,
  });
  return {
    dir,
    viewScope,
    effectiveAuth,
    allocationRevision,
    configuration,
    projectMetadataRevision,
    usageGeneration,
    phaseDurations: {
      authorizationMs,
      storedReadsMs: directoryMs + allocationMs,
    },
    baseCacheIdentity,
    cacheIdentity: baseCacheIdentity,
  };
}

async function computeScopedAccounting(
  authz: Authorization,
  query: Record<string, unknown>,
  prepared?: ScopedAccountingContext,
) {
  accountingBuildCount += 1;
  if (accountingBuildCount % 25 === 0) {
    logger.info({
      accountingCache: {
        entries: accountingCache.size,
        estimatedRetainedBytes: accountingCache.weight,
        heapUsedBytes: process.memoryUsage().heapUsed,
        builds: accountingBuildCount,
        activeBuilds: accountingBuildScheduler.activeCount,
        queuedBuilds: accountingBuildScheduler.queuedCount,
      },
    }, "scoped accounting cache footprint");
  }
  const context = prepared ?? await prepareScopedAccounting(authz, query);
  const {
    dir, viewScope, effectiveAuth, allocationRevision, configuration,
    projectMetadataRevision,
  } = context;
  const usage = await usageForRequest(effectiveAuth, dir, query, true);
  const budgets = configuration.groupBudgets;
  const assignments = configuration.teamLimitTargets;
  const teamRows = configuration.teamBudgets;
  const effectiveTeams = deriveEffectiveTeamBudgets(
    configuration.teamBudgets,
    configuration.teamBudgetAdjustments,
  );
  const daily = await dailyUsageRollups(dir, usage);
  const hiddenTeams = new Set(teamRows.filter((row) => row.isHidden).map((row) => row.teamName));
  const configuredAccount = buildCanonicalAccountDirectory({
    workspaces: dir.workspaces,
    groups: dir.groups,
    groupMembers: dir.groupMembers,
    members: dir.members,
    mappings: configuration.familyTeamMappings,
  });
  const fullTeamByGroup = buildGroupTeamMap(
    dir.groups, configuredAccount, hiddenTeams, assignments);
  const fullMergePlan = buildCanonicalGroupMergePlan(
    dir.groups, dir.workspaces, fullTeamByGroup);
  const teamByGroup = new Map([...fullTeamByGroup].filter(([key]) =>
    usage.groups.some((group) => groupTeamKey(group) === key)));
  const visibleByCanonical = new Map<string, typeof usage.groups>();
  for (const group of usage.groups) {
    const canonicalId = fullMergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const visible = visibleByCanonical.get(canonicalId) ?? [];
    visible.push(group);
    visibleByCanonical.set(canonicalId, visible);
  }
  const displayGroups = [...visibleByCanonical.values()].map((groups) =>
    groups.find((group) => group.id ===
      (fullMergePlan.primaryByGroupId.get(group.id) ?? group.id)) ?? groups[0]!);
  const groupBudgetMap = new Map(budgets.map((row) => [row.groupId, row.amountUsd]));
  const effectiveTeamBudgets = new Map(effectiveTeams
    .filter((team) => !team.isHidden)
    .map((team) => [team.teamName, team.effectiveAmountUsd]));
  const scopedMembers = visibleGroupMembers(effectiveAuth, dir.groupMembers);
  const observedWorkspaces = observedWorkspaceIds(usage.snapshot);
  const usageObservedFor = (workspaceIds: Iterable<string>): boolean => {
    const contributing = [...new Set(workspaceIds)];
    // A configured pool with no contributing groups is an observed empty
    // configuration, not an unknown usage scope.
    return contributing.length === 0 ||
      contributing.some((workspaceId) => observedWorkspaces.has(workspaceId));
  };

  const rawSpendByGroup = new Map<string, number>();
  const rawAgentByGroup = new Map<string, number>();
  for (const rollup of daily.values()) {
    for (const group of usage.groups) {
      const agent = qualifiedGroupComponent(
        rollup.aiSpendByGroup.get(group.id), effectiveAuth, group);
      const other = qualifiedGroupComponent(
        rollup.nonAiSpendByGroup.get(group.id), effectiveAuth, group);
      const ownInternalAgent = isSelfOnly(effectiveAuth)
        ? rollup.excludedInternalAgentSpendByGroupUser
          ?.get(group.id)?.get(effectiveAuth.userId) ?? 0
        : 0;
      const ownInternalOther = isSelfOnly(effectiveAuth)
        ? rollup.excludedInternalOtherSpendByGroupUser
          ?.get(group.id)?.get(effectiveAuth.userId) ?? 0
        : 0;
      rawAgentByGroup.set(
        group.id, (rawAgentByGroup.get(group.id) ?? 0) + agent + ownInternalAgent);
      rawSpendByGroup.set(
        group.id, (rawSpendByGroup.get(group.id) ?? 0) +
          agent + other + ownInternalAgent + ownInternalOther);
    }
  }
  const spendByGroup = new Map<string, number>();
  const agentByGroup = new Map<string, number>();
  for (const group of displayGroups) {
    const canonicalId = fullMergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const sourceIds = (visibleByCanonical.get(canonicalId) ?? [group])
      .map((item) => item.id);
    spendByGroup.set(group.id, sourceIds.reduce(
      (sum, id) => sum + (rawSpendByGroup.get(id) ?? 0), 0));
    agentByGroup.set(group.id, sourceIds.reduce(
      (sum, id) => sum + (rawAgentByGroup.get(id) ?? 0), 0));
  }
  const ungroupedByWorkspace = new Map<string, { spendUsd: number; memberCount: number }>();
  for (const rollup of daily.values()) {
    for (const [workspaceId, ungrouped] of rollup.ungroupedByWorkspace) {
      const current = ungroupedByWorkspace.get(workspaceId) ?? {
        spendUsd: 0,
        memberCount: 0,
      };
      current.spendUsd += ungrouped.spendUsd;
      current.memberCount = Math.max(current.memberCount, ungrouped.memberCount);
      ungroupedByWorkspace.set(workspaceId, current);
    }
  }

  const teamGroups = new Map<string, typeof displayGroups>();
  for (const group of displayGroups) {
    const team = teamByGroup.get(groupTeamKey(group));
    if (!team) continue;
    const groups = teamGroups.get(team) ?? [];
    groups.push(group);
    teamGroups.set(team, groups);
  }
  if (effectiveAuth.roles.includes("account")) {
    for (const teamName of effectiveTeamBudgets.keys()) {
      if (!teamGroups.has(teamName)) teamGroups.set(teamName, []);
    }
  }

  const poolRows: SpendRow[] = [];
  const pooledGroupIds = new Set<string>();
  for (const [teamName, groups] of teamGroups) {
    groups.forEach((group) => pooledGroupIds.add(group.id));
    const spend = groups.reduce((sum, group) => sum + (spendByGroup.get(group.id) ?? 0), 0);
    const agent = groups.reduce((sum, group) => sum + (agentByGroup.get(group.id) ?? 0), 0);
    const fullGroups = dir.groups.filter((group) =>
      fullTeamByGroup.get(groupTeamKey(group)) === teamName);
    const workspaceIds = new Set(fullGroups.map((group) => group.workspaceId));
    const access = resolveCanonicalPoolAccess(
      effectiveAuth,
      fullGroups,
      groups.length,
      effectiveTeamBudgets.get(teamName) ?? null,
    );
    const shared = access.sharedPool;
    const allocation = access.allocationUsd;
    // Marker scope follows only the groups visible to this request. Full pool
    // membership remains relevant to allocation disclosure, but must not leak
    // hidden contributing workspace identities through observation state.
    const usageObserved = usageObservedFor(
      groups.map((group) => group.workspaceId));
    const reporting = reportingSemanticsForGroups(daily, groups);
    const comparisonsVerified = reporting.comparisonsVerified;
    const sourceGroupIds = [...new Set(groups.flatMap((group) => {
      const canonicalId =
        fullMergePlan.primaryByGroupId.get(group.id) ?? group.id;
      return (visibleByCanonical.get(canonicalId) ?? [group])
        .map((source) => source.id);
    }))].sort();
    poolRows.push({
      id: canonicalTeamPoolId(teamName),
      kind: "pool", name: teamName, workspaceId: workspaceIds.size === 1 ? [...workspaceIds][0]! : null,
      workspaceName: workspaceIds.size === 1
        ? dir.workspaces.get([...workspaceIds][0]!)?.name ?? null
        : null,
      spendUsd: round(spend), agentSpendUsd: round(agent),
      otherServicesUsd: round(spend - agent), allocationUsd: allocation,
      remainingUsd: !usageObserved || !comparisonsVerified || allocation === null
        ? null : round(allocation - spend),
      percentUsed: usageObserved && comparisonsVerified &&
          allocation && allocation > 0
        ? round(spend / allocation * 100) : null,
      status: usageObserved && comparisonsVerified
        ? statusFor(allocation, spend, shared)
        : "unavailable",
      memberCount: new Set(groups.flatMap(
        (group) => scopedMembers.get(group.id) ?? [])).size,
      ownerName: null, limitState: "not_applicable",
      limitObservationStatus: "not_applicable", sharedPool: shared,
      usageObserved,
      sourceGroupIds,
    });
  }
  for (const group of displayGroups.filter((item) => !pooledGroupIds.has(item.id))) {
    const spend = spendByGroup.get(group.id) ?? 0;
    const agent = agentByGroup.get(group.id) ?? 0;
    const canonicalId = fullMergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const fullSources = dir.groups.filter((item) =>
      (fullMergePlan.primaryByGroupId.get(item.id) ?? item.id) === canonicalId);
    const access = resolveCanonicalPoolAccess(
      effectiveAuth,
      fullSources,
      visibleByCanonical.get(canonicalId)?.length ?? 0,
      resolveCanonicalMergedGroupBudget(
        canonicalId, fullMergePlan, groupBudgetMap)?.amountUsd ?? null,
    );
    const shared = access.sharedPool;
    const allocation = access.allocationUsd;
    const usageObserved = usageObservedFor(
      (visibleByCanonical.get(canonicalId) ?? [group])
        .map((item) => item.workspaceId));
    const reporting = reportingSemanticsForGroups(
      daily,
      visibleByCanonical.get(canonicalId) ?? [group],
    );
    const comparisonsVerified = reporting.comparisonsVerified;
    poolRows.push({
      id: `pool:group:${group.workspaceId}:${group.id}`, kind: "pool", name: group.name,
      workspaceId: group.workspaceId,
      workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
      spendUsd: round(spend), agentSpendUsd: round(agent),
      otherServicesUsd: round(spend - agent), allocationUsd: allocation,
      remainingUsd: !usageObserved || !comparisonsVerified || allocation === null
        ? null : round(allocation - spend),
      percentUsed: usageObserved && comparisonsVerified &&
          allocation && allocation > 0
        ? round(spend / allocation * 100) : null,
      status: usageObserved && comparisonsVerified
        ? statusFor(allocation, spend, shared)
        : "unavailable",
      memberCount: new Set((visibleByCanonical.get(canonicalId) ?? [group])
        .flatMap((item) => scopedMembers.get(item.id) ?? [])).size,
      ownerName: null, limitState: "not_applicable",
      limitObservationStatus: "not_applicable", sharedPool: shared,
      usageObserved,
    });
  }
  for (const [workspaceId, ungrouped] of ungroupedByWorkspace) {
    if (!effectiveAuth.roles.includes("account") &&
        !effectiveAuth.workspaceIds.includes(workspaceId)) continue;
    const usageObserved = observedWorkspaces.has(workspaceId);
    poolRows.push({
      id: `pool:unbudgeted:${workspaceId}`, kind: "unattributed",
      name: "Unbudgeted / No group", workspaceId,
      workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
      spendUsd: round(ungrouped.spendUsd), agentSpendUsd: 0,
      otherServicesUsd: round(ungrouped.spendUsd), allocationUsd: null,
      remainingUsd: null, percentUsed: null,
      status: usageObserved ? "unbudgeted" : "unavailable",
      memberCount: ungrouped.memberCount, ownerName: null,
      limitState: "not_applicable", limitObservationStatus: "not_applicable",
      sharedPool: false, usageObserved,
    });
  }

  const groupRows: SpendRow[] = displayGroups.map((group) => {
    const spend = spendByGroup.get(group.id) ?? 0;
    const agent = agentByGroup.get(group.id) ?? 0;
    const team = teamByGroup.get(groupTeamKey(group));
    const canonicalId = fullMergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const fullSources = team
      ? dir.groups.filter((item) =>
        fullTeamByGroup.get(groupTeamKey(item)) === team)
      : dir.groups.filter((item) =>
        (fullMergePlan.primaryByGroupId.get(item.id) ?? item.id) === canonicalId);
    const access = resolveCanonicalPoolAccess(
      effectiveAuth,
      fullSources,
      visibleByCanonical.get(canonicalId)?.length ?? 0,
      team
        ? effectiveTeamBudgets.get(team) ?? null
        : resolveCanonicalMergedGroupBudget(
          canonicalId, fullMergePlan, groupBudgetMap)?.amountUsd ?? null,
    );
    const shared = access.sharedPool;
    const allocation = access.allocationUsd;
    const usageObserved = usageObservedFor(
      (visibleByCanonical.get(canonicalId) ?? [group])
        .map((item) => item.workspaceId));
    const reporting = reportingSemanticsForGroups(
      daily,
      visibleByCanonical.get(canonicalId) ?? [group],
    );
    const comparisonsVerified = reporting.comparisonsVerified;
    return {
      id: `group:${group.workspaceId}:${group.id}`, kind: "group", name: group.name,
      workspaceId: group.workspaceId,
      workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
      spendUsd: round(spend), agentSpendUsd: round(agent),
      otherServicesUsd: round(spend - agent), allocationUsd: allocation,
      remainingUsd: !usageObserved || !comparisonsVerified || allocation === null
        ? null : round(allocation - spend),
      percentUsed: usageObserved && comparisonsVerified &&
          allocation && allocation > 0
        ? round(spend / allocation * 100) : null,
      status: usageObserved && comparisonsVerified
        ? statusFor(allocation, spend, shared)
        : "unavailable",
      memberCount: new Set(scopedMembers.get(group.id) ?? []).size,
      ownerName: null, limitState: "not_applicable" as const,
      limitObservationStatus: "not_applicable" as const, sharedPool: shared,
      usageObserved,
    };
  });
  if (isSelfOnly(effectiveAuth)) {
    for (const workspaceId of usage.workspaceIds) {
      let ownInternalAgent = 0;
      let ownInternalOther = 0;
      for (const rollup of daily.values()) {
        ownInternalAgent += rollup.excludedInternalAgentSpendByWorkspaceUser
          ?.get(workspaceId)?.get(effectiveAuth.userId) ?? 0;
        ownInternalOther += rollup.excludedInternalOtherSpendByWorkspaceUser
          ?.get(workspaceId)?.get(effectiveAuth.userId) ?? 0;
        for (const group of usage.groups.filter(
          (candidate) => candidate.workspaceId === workspaceId)) {
          ownInternalAgent -= rollup.excludedInternalAgentSpendByGroupUser
            ?.get(group.id)?.get(effectiveAuth.userId) ?? 0;
          ownInternalOther -= rollup.excludedInternalOtherSpendByGroupUser
            ?.get(group.id)?.get(effectiveAuth.userId) ?? 0;
        }
      }
      const spend = ownInternalAgent + ownInternalOther;
      if (spend <= 1e-9) continue;
      const usageObserved = observedWorkspaces.has(workspaceId);
      groupRows.push({
        id: `group:${workspaceId}:my-no-group`,
        kind: "unattributed",
        name: "My usage outside a group",
        workspaceId,
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
        spendUsd: round(spend),
        agentSpendUsd: round(ownInternalAgent),
        otherServicesUsd: round(ownInternalOther),
        allocationUsd: null,
        remainingUsd: null,
        percentUsed: null,
        status: usageObserved ? "personal_usage" : "unavailable",
        memberCount: 1,
        ownerName: null,
        limitState: "not_applicable",
        limitObservationStatus: "not_applicable",
        sharedPool: false,
        usageObserved,
      });
    }
  }
  for (const [workspaceId, ungrouped] of ungroupedByWorkspace) {
    if (!effectiveAuth.roles.includes("account") &&
        !effectiveAuth.workspaceIds.includes(workspaceId)) continue;
    const usageObserved = observedWorkspaces.has(workspaceId);
    groupRows.push({
      id: `group:${workspaceId}:no-group`, kind: "unattributed", name: "No group",
      workspaceId, workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
      spendUsd: round(ungrouped.spendUsd), agentSpendUsd: 0,
      otherServicesUsd: round(ungrouped.spendUsd), allocationUsd: null,
      remainingUsd: null, percentUsed: null,
      status: usageObserved ? "unbudgeted" : "unavailable",
      memberCount: ungrouped.memberCount, ownerName: null,
      limitState: "not_applicable", limitObservationStatus: "not_applicable",
      sharedPool: false, usageObserved,
    });
  }

  const peopleRows: SpendRow[] = [];
  const projectRows: SpendRow[] = [];

  const unbudgetedSpend = poolRows
    .filter((row) => row.status === "no_allocation" || row.status === "unbudgeted")
    .reduce((sum, row) => sum + row.spendUsd, 0);
  const qualified = [...daily.values()].map((rollup) =>
    qualifiedRollupTotals(rollup, effectiveAuth, usage.groups));
  const scopedEligibleSpend = qualified.reduce(
    (sum, item) => sum + item.eligibleSpendUsd, 0);
  const scopedReportedSpend = qualified.reduce(
    (sum, item) => sum + item.reportedSpendUsd, 0);
  const agentSpend = qualified.reduce((sum, item) => sum + item.agentSpendUsd, 0);
  const scopedInternalExcluded = qualified.reduce(
    (sum, item) => sum + item.internalExcludedUsd, 0);
  const scopedResidualSpend = qualified.reduce(
    (sum, item) => sum + item.unattributedUsd, 0);
  const accounting = {
    eligibleSpendUsd: round(scopedEligibleSpend),
    grossSpendUsd: round(scopedEligibleSpend + scopedInternalExcluded),
    internalExcludedUsd: round(scopedInternalExcluded),
    unbudgetedUsd: round(unbudgetedSpend),
    unattributedUsd: round(scopedResidualSpend),
    reconciliationUsd: round(qualified.reduce(
      (sum, item) => sum + item.reconciliationUsd, 0)),
    agentSpendUsd: round(agentSpend),
    otherServicesUsd: round(scopedReportedSpend - agentSpend),
  };
  if (viewScope === "my" && usage.workspaceIds.size === 0) {
    logger.warn({
      accountingDiagnostic: {
        condition: "missing_personal_workspace_scope",
        actorUserId: effectiveAuth.userId,
        directoryWorkspaceCount:
          dir.members.get(effectiveAuth.userId)?.workspaces.size ?? 0,
        rangeStart: usage.selection.window.start,
        rangeEndExclusive: usage.selection.window.end,
      },
    }, "personal accounting scope has no workspaces");
  } else if (viewScope === "my" && scopedReportedSpend === 0) {
    const sourceEntryCount = [...usage.snapshot.members.values()]
      .filter((members) => (members.get(effectiveAuth.userId)?.totalCostUsd ?? 0) > 0)
      .length;
    const sourceCostUsd = [...usage.snapshot.members.values()].reduce(
      (sum, members) =>
        sum + (members.get(effectiveAuth.userId)?.totalCostUsd ?? 0), 0);
    if (sourceEntryCount > 0 || sourceCostUsd > 0) {
      logger.warn({
        accountingDiagnostic: {
          condition: "personal_report_zero_with_source_facts",
          actorUserId: effectiveAuth.userId,
          workspaceCount: usage.workspaceIds.size,
          sourceEntryCount,
          sourceCostUsd: round(sourceCostUsd),
          exclusionReason: dir.internalUserIds.has(effectiveAuth.userId)
            ? "internal_replit_user"
            : "qualification",
          rangeStart: usage.selection.window.start,
          rangeEndExclusive: usage.selection.window.end,
        },
      }, "personal accounting reported zero despite stored source facts");
    }
  }
  const freshness = getDirectoryFreshness();
  const accountWide = effectiveAuth.roles.includes("account");
  const usageStatus = accountWide
    ? usage.snapshot.status
    : usage.snapshot.workspaceStatus;
  const usageDataAsOf = accountWide
    ? usage.snapshot.dataAsOf
    : usage.snapshot.workspaceDataAsOf;
  const missingDays = [...new Set([
    ...usage.snapshot.coverage.missingWorkspaceDays.map((item) => item.usageDate),
    ...(accountWide ? usage.snapshot.coverage.missingAccountDays : []),
  ])].sort();
  const failedWorkspaceDays = usage.snapshot.coverage.failedWorkspaceDays
    .map((item) => `${item.workspaceId}:${item.usageDate}`).sort();
  const qualifications = [
    ...(usageStatus === "partial" ? ["Partial usage coverage; missing facts are not zero."] : []),
    ...(usage.snapshot.latestFailedAttempts.length > 0
      ? ["The latest usage refresh failed for part of this scope; last successful facts are shown."]
      : []),
    ...(usage.rollup.projectAttribution.isComplete ? [] : ["Project attribution is incomplete."]),
    ...(accounting.internalExcludedUsd !== 0 ? ["Internal Replit usage is excluded from eligible spend."] : []),
    ...(accounting.reconciliationUsd !== 0 ? ["Account/workspace reconciliation is shown separately."] : []),
    ...(poolRows.some((row) => row.sharedPool && row.allocationUsd === null)
      ? ["Shared canonical allocation is unavailable for this scope; only authorized contribution is shown."]
      : []),
    ...(dir.budgets.observation.status === "complete" ? [] : [
      dir.budgets.observation.status === "failed"
        ? hasSuccessfulLimitObservation(dir.budgets)
          ? "The latest member-limit refresh failed; last successful limits are shown."
          : "The persisted member-limit observation failed; limits are unavailable."
        : dir.budgets.observation.status === "refreshing"
          ? hasSuccessfulLimitObservation(dir.budgets)
            ? "Member limits are refreshing; last successful limits are shown."
            : "The first member-limit observation is still refreshing."
          : "No completed persisted member-limit observation is available.",
    ]),
  ];
  const generationId = committedGenerationId({
    usageDataAsOf,
    directoryDataAsOf: freshness.dataAsOf,
    usageStatus,
    coverage: usage.snapshot.coverage,
    limitObservation: dir.budgets.observation,
    allocationRevision,
    projectMetadataRevision,
    period: usage.selection.window, scope: {
      viewScope, workspaceIds: [...usage.workspaceIds].sort(),
      groupIds: usage.groups.map((group) => group.id).sort(),
      groupUserIds: Object.fromEntries(Object.entries(
        effectiveAuth.groupUserIds ?? {}).sort(([a], [b]) => a.localeCompare(b))
        .map(([groupId, userIds]) => [groupId, [...userIds].sort()])),
      userIds: [...effectiveAuth.userIds].sort(),
    },
  });
  const scope = {
    viewScope,
    label: viewScope === "my" ? "My usage"
      : viewScope === "managed" ? "Managed scope" : "All authorized",
    workspaceIds: [...usage.workspaceIds].sort(),
    groupIds: usage.groups.map((group) => group.id).sort(),
    isPersonal: viewScope === "my",
  };
  return {
    authz: effectiveAuth, dir, usage, daily, poolRows, groupRows, peopleRows, projectRows,
    configuredAccount, fullTeamByGroup, fullMergePlan, visibleByCanonical,
    personalLimits: [...usage.workspaceIds].map((workspaceId) => ({
      workspaceId,
      ...resolveStoredMemberLimit(dir, workspaceId, effectiveAuth.userId),
    })),
    accounting, scope,
    period: {
      start: usage.selection.window.start,
      endExclusive: usage.selection.window.end,
      timezone: "UTC" as const,
      label: usage.selection.label,
    },
    metadata: {
      generationId, costBasis: "allocation_eligible_committed" as const,
      status: usageStatus, dataAsOf: usageDataAsOf,
      directoryDataAsOf: freshness.dataAsOf,
      stale: usageStatus === "stale" || freshness.isStale,
      coverage: {
        ratio: usage.snapshot.coverage.ratio,
        requestedDays: usage.snapshot.coverage.requestedDays,
        missingDays, failedWorkspaceDays,
      },
      qualifications,
      limitObservation: dir.budgets.observation,
    },
  };
}

function freezeAccountingResult<T extends Awaited<ReturnType<typeof computeScopedAccounting>>>(
  result: T,
): T {
  for (const rows of [
    result.poolRows,
    result.groupRows,
    result.peopleRows,
    result.projectRows,
  ]) {
    rows.forEach(Object.freeze);
    Object.freeze(rows);
  }
  Object.freeze(result.scope.workspaceIds);
  Object.freeze(result.scope.groupIds);
  Object.freeze(result.metadata.coverage.missingDays);
  Object.freeze(result.metadata.coverage.failedWorkspaceDays);
  Object.freeze(result.metadata.coverage);
  Object.freeze(result.metadata.qualifications);
  Object.freeze(result.accounting);
  Object.freeze(result.scope);
  Object.freeze(result.period);
  Object.freeze(result.metadata);
  return Object.freeze(result);
}

function qualifiedProjectComponents(
  authz: Authorization,
  groups: readonly { id: string; workspaceId: string }[],
  workspaceId: string,
  creatorId: string | null,
  projectGroupId: string | undefined,
  agent: number,
  other: number,
): { agent: number; other: number } | null {
  if (authz.roles.includes("account") ||
      authz.workspaceIds.includes(workspaceId)) {
    return { agent, other };
  }
  if (isSelfOnly(authz) && creatorId === authz.userId) {
    // Project Agent totals are not user-granular. Personal views may show the
    // non-Agent amount attributed by current ownership, but must not claim the
    // entire project's Agent spend belongs to the viewer.
    return { agent: 0, other };
  }
  const groupQualified = creatorId !== null &&
    projectGroupId !== undefined && groups.some((group) =>
    group.id === projectGroupId && group.workspaceId === workspaceId &&
    (authz.groupUserIds?.[group.id] ?? []).includes(creatorId));
  return groupQualified ? { agent, other } : null;
}

function qualifyFailedAccountingRefresh(
  result: Awaited<ReturnType<typeof computeScopedAccounting>>,
) {
  const qualification =
    "The latest accounting refresh failed; the last successful stored result is shown.";
  return freezeAccountingResult({
    ...result,
    metadata: {
      ...result.metadata,
      stale: true,
      qualifications: result.metadata.qualifications.includes(qualification)
        ? result.metadata.qualifications
        : [...result.metadata.qualifications, qualification],
    },
  });
}

function qualifyStaleAccountingResult(
  result: Awaited<ReturnType<typeof computeScopedAccounting>>,
) {
  const qualification =
    "Accounting is refreshing; the last successful stored result is shown.";
  return freezeAccountingResult({
    ...result,
    metadata: {
      ...result.metadata,
      stale: true,
      qualifications: result.metadata.qualifications.includes(qualification)
        ? result.metadata.qualifications
        : [...result.metadata.qualifications, qualification],
    },
  });
}

async function buildDetailProjection(
  base: Awaited<ReturnType<typeof computeScopedAccounting>>,
  detailView: "people" | "projects",
) {
  const { daily, authz: effectiveAuth, usage, dir } = base;
  const peopleRows: SpendRow[] = [];
  if (detailView === "people") {
    const observedWorkspaces = observedWorkspaceIds(usage.snapshot);
    const qualifiedUsers = qualifiedUserSpendByWorkspace(
      daily, effectiveAuth, usage.groups, usage.workspaceIds);
    const currentCycleUsage = await getCurrentCycleMemberSnapshot(base);
    for (const workspaceId of usage.workspaceIds) {
      const authorizedUserIds = effectiveAuth.roles.includes("account") ||
          effectiveAuth.workspaceIds.includes(workspaceId)
        ? [...dir.members.values()]
          .filter((member) => member.workspaces.has(workspaceId))
          .map((member) => member.userId)
        : [...new Set([
          effectiveAuth.userId,
          ...usage.groups
            .filter((group) => group.workspaceId === workspaceId)
            .flatMap((group) =>
              effectiveAuth.groupUserIds?.[group.id] ?? []),
        ])].filter((userId) =>
          dir.members.get(userId)?.workspaces.has(workspaceId));
      for (const userId of authorizedUserIds) {
        if (dir.internalUserIds.has(userId) &&
            userId !== effectiveAuth.userId) continue;
        const member = dir.members.get(userId);
        const totals = qualifiedUsers.get(workspaceId)?.get(userId) ??
          { agent: 0, other: 0 };
        const agent = totals.agent;
        const other = totals.other;
        const limit = resolveStoredMemberLimit(dir, workspaceId, userId);
        const currentCycleComplete = currentCycleUsage.status !== "empty" &&
          !currentCycleUsage.coverage.failedWorkspaceDays.some(
            (item) => item.workspaceId === workspaceId) &&
          !currentCycleUsage.coverage.missingWorkspaceDays.some(
            (item) => item.workspaceId === workspaceId);
        const currentEntry =
          currentCycleUsage.members.get(workspaceId)?.get(userId);
        const exposeInternalCurrentCycle =
          isSelfOnly(effectiveAuth) && userId === effectiveAuth.userId;
        const currentAgent = currentCycleComplete
          ? dir.internalUserIds.has(userId) && !exposeInternalCurrentCycle
            ? 0
            : currentEntry === undefined
              ? 0
              : currentEntry.agentMetricsComplete === true
                ? currentEntry.aiCostUsd
                : null
          : null;
        const currentMetrics = currentCycleLimitMetrics(
          limit.amount, currentAgent);
        const usageObserved = observedWorkspaces.has(workspaceId);
        peopleRows.push({
          id: `person:${workspaceId}:${userId}`,
          kind: "person",
          name: member?.name ?? member?.username ?? userId,
          workspaceId,
          workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
          spendUsd: round(agent + other),
          agentSpendUsd: round(agent),
          otherServicesUsd: round(other),
          allocationUsd: limit.amount,
          remainingUsd: currentMetrics.remainingUsd,
          percentUsed: currentMetrics.percentUsed,
          currentCycleAgentSpendUsd:
            currentAgent === null ? null : round(currentAgent),
          currentCycleRemainingUsd: currentMetrics.remainingUsd,
          currentCyclePercentUsed: currentMetrics.percentUsed,
          status: limit.state,
          memberCount: null,
          ownerName: null,
          limitState: limit.state,
          limitObservationStatus: dir.budgets.observation.status,
          sharedPool: false,
          usageObserved,
        });
      }
    }
  }

  const projectRows: SpendRow[] = [];
  if (detailView === "projects") {
    const observedWorkspaces = observedWorkspaceIds(usage.snapshot);
    const catalog = personalProjectCatalog(
      usage.projectMetadata, usage.workspaceIds, effectiveAuth);
    if (catalog) {
      const totalsByKey = new Map<string, { agent: number; other: number }>();
      for (const rollup of daily.values()) {
        const keys = new Set([
          ...rollup.projectAttribution.aiSpendByProject.keys(),
          ...rollup.projectAttribution.nonAiSpendByProject.keys(),
        ]);
        for (const key of keys) {
          const [workspaceId, projectId] = key.split("\u0000");
          if (!workspaceId || !projectId) continue;
          const creatorId =
            rollup.projectAttribution.creatorByProject.get(key) ?? null;
          const qualified = qualifiedProjectComponents(
            effectiveAuth,
            usage.groups,
            workspaceId,
            creatorId,
            rollup.projectAttribution.projectToGroup.get(key),
            rollup.projectAttribution.aiSpendByProject.get(key) ?? 0,
            rollup.projectAttribution.nonAiSpendByProject.get(key) ?? 0,
          );
          if (!qualified) continue;
          const current = totalsByKey.get(key) ?? { agent: 0, other: 0 };
          current.agent += qualified.agent;
          current.other += qualified.other;
          totalsByKey.set(key, current);
        }
      }
      for (const project of catalog.projects) {
        const totals = totalsByKey.get(
          `${project.workspaceId}\u0000${project.projectId}`,
        ) ?? { agent: 0, other: 0 };
        projectRows.push({
          id: `project:${project.workspaceId}:${project.projectId}`,
          kind: "project",
          name: project.title ?? project.projectId,
          workspaceId: project.workspaceId,
          workspaceName:
            dir.workspaces.get(project.workspaceId)?.name ?? null,
          spendUsd: round(totals.agent + totals.other),
          agentSpendUsd: round(totals.agent),
          otherServicesUsd: round(totals.other),
          allocationUsd: null,
          remainingUsd: null,
          percentUsed: null,
          status: "attributed",
          memberCount: null,
          ownerName: dir.members.get(effectiveAuth.userId)?.name ??
            dir.members.get(effectiveAuth.userId)?.username ?? null,
          limitState: "not_applicable",
          limitObservationStatus: "not_applicable",
          sharedPool: false,
          usageObserved:
            workspaceUsageIsComplete(usage.snapshot, project.workspaceId),
          isPublished: project.isPublished,
        });
      }
      return freezeAccountingResult({ ...base, peopleRows, projectRows });
    }
    for (const workspaceId of usage.workspaceIds) {
      const projectTotals = new Map<string, { agent: number; other: number }>();
      for (const rollup of daily.values()) {
        const projectKeys = new Set([
          ...rollup.projectAttribution.aiSpendByProject.keys(),
          ...rollup.projectAttribution.nonAiSpendByProject.keys(),
        ]);
        for (const key of projectKeys) {
          const [projectWorkspaceId, projectId] = key.split("\u0000");
          if (projectWorkspaceId !== workspaceId || !projectId) continue;
          const creatorId =
            rollup.projectAttribution.creatorByProject.get(key) ?? null;
          const qualified = qualifiedProjectComponents(
            effectiveAuth,
            usage.groups,
            workspaceId,
            creatorId,
            rollup.projectAttribution.projectToGroup.get(key),
            rollup.projectAttribution.aiSpendByProject.get(key) ?? 0,
            rollup.projectAttribution.nonAiSpendByProject.get(key) ?? 0,
          );
          if (!qualified) continue;
          const current = projectTotals.get(projectId) ??
            { agent: 0, other: 0 };
          current.agent += qualified.agent;
          current.other += qualified.other;
          projectTotals.set(projectId, current);
        }
      }
      for (const [projectId, totals] of projectTotals) {
        const key = `${workspaceId}\u0000${projectId}`;
        const creatorId =
          usage.rollup.projectAttribution.creatorByProject.get(key) ?? null;
        const metadata =
          usage.projectMetadata.byWorkspace.get(workspaceId)?.get(projectId);
        const owner = creatorId ? dir.members.get(creatorId) : undefined;
        const usageObserved = observedWorkspaces.has(workspaceId);
        projectRows.push({
          id: `project:${workspaceId}:${projectId}`,
          kind: "project",
          name: metadata?.title ?? projectId,
          workspaceId,
          workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
          spendUsd: round(totals.agent + totals.other),
          agentSpendUsd: round(totals.agent),
          otherServicesUsd: round(totals.other),
          allocationUsd: null,
          remainingUsd: null,
          percentUsed: null,
          status: metadata ? "attributed" : "unattributed",
          memberCount: null,
          ownerName: owner?.name ?? owner?.username ?? null,
          limitState: "not_applicable",
          limitObservationStatus: "not_applicable",
          sharedPool: false,
          usageObserved,
        });
      }
    }
  }
  return freezeAccountingResult({ ...base, peopleRows, projectRows });
}

type AccountingResult = Awaited<ReturnType<typeof buildScopedAccounting>>;

type ProjectObservation = {
  creatorId: string | null;
  title: string | null;
  hasDeployment: boolean | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  deployments?: readonly {
    id?: string;
    deploymentId?: string;
    url?: string | null;
    privacy?: string | null;
    deploymentPrivacy?: string | null;
    status?: string | null;
    createdAt?: string | Date | null;
    updatedAt?: string | Date | null;
  }[] | null;
  deploymentsObservedAt?: string | Date | null;
  fetchedAt?: string | Date | null;
};

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeDeploymentUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function projectRowKey(row: SpendRow): string | null {
  if (!row.workspaceId) return null;
  const prefix = `project:${row.workspaceId}:`;
  return row.id.startsWith(prefix)
    ? `${row.workspaceId}\u0000${row.id.slice(prefix.length)}`
    : `${row.workspaceId}\u0000${row.id}`;
}

function currentCatalog(
  result: AccountingResult,
  globalIdentities: ReadonlyMap<string, { workspaceId: string | null }>,
): Map<string, { workspaceId: string; projectId: string; metadata: ProjectObservation }> {
  const candidates = new Map<string, Array<{
    workspaceId: string;
    projectId: string;
    metadata: ProjectObservation;
    observedAt: number;
  }>>();
  for (const workspaceId of result.usage.workspaceIds) {
    for (const [projectId, value] of
      result.usage.projectMetadata.byWorkspace.get(workspaceId) ?? []) {
      const metadata = value as ProjectObservation;
      const fetchedAt = metadata.fetchedAt == null
        ? Number.NaN : new Date(metadata.fetchedAt).getTime();
      const observedAt = Number.isFinite(fetchedAt)
        ? fetchedAt
        : result.usage.projectMetadata.freshnessByWorkspace
          .get(workspaceId)?.lastSuccessfulAt?.getTime() ??
            Number.NEGATIVE_INFINITY;
      const rows = candidates.get(projectId) ?? [];
      rows.push({
        workspaceId,
        projectId,
        metadata,
        observedAt,
      });
      candidates.set(projectId, rows);
    }
  }
  const catalog = new Map<string, {
    workspaceId: string;
    projectId: string;
    metadata: ProjectObservation;
  }>();
  for (const [projectId, rows] of candidates) {
    const globalIdentity = globalIdentities.get(projectId);
    const newest = Math.max(...rows.map((row) => row.observedAt));
    const current = rows.filter((row) => row.observedAt === newest)
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    // Conflicting equally-current workspace observations do not establish a
    // safe transfer destination. Omit rather than disclose the old workspace.
    if (current.length !== 1) continue;
    const row = current[0]!;
    if (globalIdentity && globalIdentity.workspaceId !== row.workspaceId) {
      continue;
    }
    const ownerId = row.metadata.creatorId;
    const canSee = result.authz.roles.includes("account") ||
      result.authz.workspaceIds.includes(row.workspaceId) ||
      (ownerId !== null && ownerId === result.authz.userId &&
        result.scope.isPersonal) ||
      (ownerId !== null && Object.entries(result.authz.groupUserIds ?? {})
        .some(([groupId, userIds]) =>
          userIds.includes(ownerId) && result.usage.groups.some((group) =>
            group.id === groupId && group.workspaceId === row.workspaceId)));
    if (canSee) catalog.set(projectId, row);
  }
  return catalog;
}

function enrichedProjectRows(
  selected: AccountingResult,
  currentMonth: AccountingResult,
  evaluation: StaleSpendEvaluation,
  globalIdentities: ReadonlyMap<string, { workspaceId: string | null }>,
): SpendRow[] {
  const monthAvailabilityFor = (
    workspaceId: string,
  ): "complete" | "partial" | "unavailable" => {
    const snapshot = currentMonth.usage.snapshot;
    const presentDays = [...(snapshot.dailyWorkspaces ?? [])].filter(
      ([, workspaces]) => workspaces.has(workspaceId)).length;
    const hasFailed = snapshot.coverage.failedWorkspaceDays.some(
      (item) => item.workspaceId === workspaceId);
    const hasMissing = snapshot.coverage.missingWorkspaceDays.some(
      (item) => item.workspaceId === workspaceId);
    if (presentDays === 0) return "unavailable";
    return !hasFailed && !hasMissing &&
        presentDays === snapshot.coverage.requestedDays
      ? "complete" : "partial";
  };
  const selectedByKey = new Map(selected.projectRows.flatMap((row) => {
    const key = projectRowKey(row);
    return key ? [[key, row] as const] : [];
  }));
  const monthByKey = new Map(currentMonth.projectRows.flatMap((row) => {
    const key = projectRowKey(row);
    return key ? [[key, row] as const] : [];
  }));
  const rows: SpendRow[] = [];
  const catalog = currentCatalog(selected, globalIdentities);
  for (const { workspaceId, projectId, metadata } of catalog.values()) {
    const key = `${workspaceId}\u0000${projectId}`;
    const selectedSpend = selectedByKey.get(key);
    const monthSpend = monthByKey.get(key);
    const freshness = selected.usage.projectMetadata.freshnessByWorkspace
      .get(workspaceId);
    const metadataAvailability = !freshness?.lastSuccessfulAt
      ? "unavailable" as const
      : selected.usage.projectMetadata.completeWorkspaceIds.has(workspaceId)
        ? "complete" as const : "stale" as const;
    const deploymentObserved =
      selected.usage.projectMetadata.deploymentObservedWorkspaceIds
        .has(workspaceId);
    const richDeploymentObserved = deploymentObserved &&
      metadata.deployments !== null &&
      isoOrNull(metadata.deploymentsObservedAt) !== null;
    const deploymentAvailability = !richDeploymentObserved
      ? "unavailable" as const
      : selected.usage.projectMetadata.deploymentCompleteWorkspaceIds
          .has(workspaceId)
        ? "complete" as const : "stale" as const;
    const currentMonthUsageAvailability = monthAvailabilityFor(workspaceId);
    const currentMonthSpendUsd =
      currentMonthUsageAvailability === "unavailable"
      ? null
      : round(monthSpend?.spendUsd ?? 0);
    const updatedAt = isoOrNull(metadata.updatedAt);
    const owner = metadata.creatorId
      ? selected.dir.members.get(metadata.creatorId) : undefined;
    const deployments = richDeploymentObserved
      ? [...(metadata.deployments ?? [])].map((deployment, index) => ({
          id: deployment.id ?? deployment.deploymentId ??
            `${projectId}:deployment:${index}`,
          url: safeDeploymentUrl(deployment.url),
          privacy: deployment.privacy ?? deployment.deploymentPrivacy ?? null,
          status: deployment.status ?? null,
          createdAt: isoOrNull(deployment.createdAt),
          updatedAt: isoOrNull(deployment.updatedAt),
        }))
      : [];
    rows.push({
      id: `project:${workspaceId}:${projectId}`,
      projectId,
      kind: "project",
      name: metadata.title ?? projectId,
      workspaceId,
      workspaceName: selected.dir.workspaces.get(workspaceId)?.name ?? null,
      spendUsd: selectedSpend?.spendUsd ?? 0,
      agentSpendUsd: selectedSpend?.agentSpendUsd ?? 0,
      otherServicesUsd: selectedSpend?.otherServicesUsd ?? 0,
      allocationUsd: null,
      remainingUsd: null,
      percentUsed: null,
      status: selectedSpend?.status ?? "attributed",
      memberCount: null,
      ownerId: metadata.creatorId,
      ownerName: owner?.name ?? owner?.username ?? null,
      limitState: "not_applicable",
      limitObservationStatus: "not_applicable",
      sharedPool: false,
      usageObserved: selectedSpend?.usageObserved ??
        observedWorkspaceIds(selected.usage.snapshot).has(workspaceId),
      createdAt: isoOrNull(metadata.createdAt),
      updatedAt,
      metadataAvailability,
      hasDeployment: deploymentObserved ? metadata.hasDeployment : null,
      isPublished: deploymentObserved ? metadata.hasDeployment : null,
      deploymentAvailability,
      deployments,
      currentMonthSpendUsd,
      currentMonthUsageAvailability:
        currentMonthUsageAvailability === "complete" &&
          !currentMonth.usage.rollup.projectAttribution.isComplete
          ? "partial"
          : currentMonthUsageAvailability,
      staleButSpending: isStaleButSpending(
        updatedAt, currentMonthSpendUsd, evaluation.staleCutoff),
    });
  }
  const observedCatalogIds = new Set(
    [...selected.usage.projectMetadata.byWorkspace.values()]
      .flatMap((projects) => [...projects.keys()]),
  );
  for (const selectedSpend of selected.projectRows) {
    const key = projectRowKey(selectedSpend);
    if (!key) continue;
    const [workspaceId, projectId] = key.split("\u0000");
    if (!workspaceId || !projectId || catalog.has(projectId) ||
        observedCatalogIds.has(projectId) ||
        globalIdentities.has(projectId)) continue;
    const monthSpend = monthByKey.get(key);
    const currentMonthUsageAvailability = monthAvailabilityFor(workspaceId);
    const currentMonthSpendUsd =
      currentMonthUsageAvailability === "unavailable"
      ? null : round(monthSpend?.spendUsd ?? 0);
    rows.push({
      ...selectedSpend,
      id: `project:${workspaceId}:${projectId}`,
      projectId,
      ownerId: null,
      ownerName: null,
      createdAt: null,
      updatedAt: null,
      metadataAvailability: "unavailable",
      hasDeployment: null,
      isPublished: null,
      deploymentAvailability: "unavailable",
      deployments: [],
      currentMonthSpendUsd,
      currentMonthUsageAvailability:
        currentMonthUsageAvailability === "complete" &&
          !currentMonth.usage.rollup.projectAttribution.isComplete
          ? "partial"
          : currentMonthUsageAvailability,
      staleButSpending: false,
    });
  }
  return rows;
}

function projectSpendRowsForUsage(
  selected: AccountingResult,
  usage: AccountingResult["usage"],
  daily: AccountingResult["daily"],
  globalIdentities: ReadonlyMap<string, { workspaceId: string | null }>,
): SpendRow[] {
  const catalog = currentCatalog(selected, globalIdentities);
  const totals = new Map<string, { agent: number; other: number }>();
  for (const rollup of daily.values()) {
    for (const key of new Set([
      ...rollup.projectAttribution.aiSpendByProject.keys(),
      ...rollup.projectAttribution.nonAiSpendByProject.keys(),
    ])) {
      const [workspaceId, projectId] = key.split("\u0000");
      const current = projectId ? catalog.get(projectId) : undefined;
      if (!workspaceId || !projectId || current?.workspaceId !== workspaceId) {
        continue;
      }
      const qualified = qualifiedProjectComponents(
        selected.authz,
        usage.groups,
        workspaceId,
        current.metadata.creatorId,
        rollup.projectAttribution.projectToGroup.get(key),
        rollup.projectAttribution.aiSpendByProject.get(key) ?? 0,
        rollup.projectAttribution.nonAiSpendByProject.get(key) ?? 0,
      );
      if (!qualified) continue;
      const value = totals.get(key) ?? { agent: 0, other: 0 };
      value.agent += qualified.agent;
      value.other += qualified.other;
      totals.set(key, value);
    }
  }
  return [...catalog.values()].map(({ workspaceId, projectId }) => {
    const value = totals.get(`${workspaceId}\u0000${projectId}`) ??
      { agent: 0, other: 0 };
    return {
      id: `project:${workspaceId}:${projectId}`,
      projectId,
      kind: "project" as const,
      name: projectId,
      workspaceId,
      workspaceName: null,
      spendUsd: round(value.agent + value.other),
      agentSpendUsd: round(value.agent),
      otherServicesUsd: round(value.other),
      allocationUsd: null,
      remainingUsd: null,
      percentUsed: null,
      status: "attributed",
      memberCount: null,
      ownerName: null,
      limitState: "not_applicable" as const,
      limitObservationStatus: "not_applicable" as const,
      sharedPool: false,
      usageObserved: workspaceUsageIsComplete(usage.snapshot, workspaceId),
    };
  });
}

export async function buildProjectIntelligence(
  authz: Authorization,
  query: Record<string, unknown>,
  prepared?: ScopedAccountingContext,
  evaluatedAt = new Date(),
) {
  const context = prepared ?? await prepareScopedAccounting(
    authz, query, "projects");
  const selected = await buildScopedAccounting(
    authz, query, "projects", context);
  return buildProjectIntelligenceFromResult(
    selected,
    context,
    evaluatedAt,
    typeof query["workspaceId"] === "string" ? query["workspaceId"] : undefined,
  );
}

export async function buildProjectIntelligenceFromResult(
  selected: AccountingResult,
  context: ScopedAccountingContext,
  evaluatedAt = new Date(),
  workspaceId?: string,
) {
  const candidateProjectIds = new Set<string>();
  for (const projects of selected.usage.projectMetadata.byWorkspace.values()) {
    for (const projectId of projects.keys()) candidateProjectIds.add(projectId);
  }
  for (const row of selected.projectRows) {
    if (row.projectId) candidateProjectIds.add(row.projectId);
    else {
      const key = projectRowKey(row);
      const projectId = key?.split("\u0000")[1];
      if (projectId) candidateProjectIds.add(projectId);
    }
  }
  const globalIdentities =
    await readCurrentProjectIdentities(candidateProjectIds);
  const monthQuery = {
    rangeType: "mtd",
    viewScope: context.viewScope,
    ...(workspaceId ? { workspaceId } : {}),
  };
  const monthWindow = windowFromQuery(monthQuery).window;
  let currentMonth = {
    ...selected,
    projectRows: projectSpendRowsForUsage(
      selected, selected.usage, selected.daily, globalIdentities),
  };
  if (selected.usage.selection.window.start !== monthWindow.start ||
      selected.usage.selection.window.end !== monthWindow.end) {
    const usage = await usageForRequest(
      context.effectiveAuth, context.dir, monthQuery, true);
    const daily = await dailyUsageRollups(context.dir, usage);
    currentMonth = {
      ...selected,
      usage,
      daily,
      projectRows: projectSpendRowsForUsage(
        selected, usage, daily, globalIdentities),
    };
  }
  const staleEvaluation = staleSpendEvaluation(
    currentMonth.usage.snapshot, evaluatedAt);
  if (staleEvaluation.availability === "complete" &&
      !currentMonth.usage.rollup.projectAttribution.isComplete) {
    staleEvaluation.availability = "partial";
  }
  return {
    result: {
      ...selected,
      projectRows: enrichedProjectRows(
        selected, currentMonth, staleEvaluation, globalIdentities),
    },
    staleEvaluation,
  };
}

function withRequestContext(
  result: Awaited<ReturnType<typeof computeScopedAccounting>>,
  context: ScopedAccountingContext,
  query: Record<string, unknown>,
) {
  const selection = windowFromQuery(query);
  return freezeAccountingResult({
    ...result,
    scope: {
      ...result.scope,
      viewScope: context.viewScope,
      label: context.viewScope === "my" ? "My usage"
        : context.viewScope === "managed" ? "Managed scope" : "All authorized",
      isPersonal: context.viewScope === "my",
    },
    period: {
      ...result.period,
      start: selection.window.start,
      endExclusive: selection.window.end,
      label: selection.label,
    },
  });
}

/**
 * Shared accounting is keyed only by committed inputs. Pools, groups and the
 * Dashboard use the same base build; expensive People/Projects enrichments are
 * separate demand-built projections, never presentation-query partitions.
 */
export async function buildScopedAccounting(
  authz: Authorization,
  query: Record<string, unknown>,
  detailView?: TableView,
  prepared?: ScopedAccountingContext,
) {
  const context = prepared ?? await prepareScopedAccounting(authz, query, detailView);
  const cacheOptions = {
    refreshStale: !isUsageGenerationUpdateActive(),
    onStale: qualifyStaleAccountingResult,
    onRefreshError: qualifyFailedAccountingRefresh,
  };
  const base = await accountingCache.getOrLoad(
    scopedAccountingCacheKey(context.baseCacheIdentity),
    () => accountingBuildScheduler.schedule(async () =>
      freezeAccountingResult(await computeScopedAccounting(
        authz,
        query,
        context,
      ))),
    cacheOptions,
  );
  if (detailView !== "people" && detailView !== "projects") {
    return withRequestContext(base, context, query);
  }
  const detail = await accountingCache.getOrLoad(
    scopedAccountingCacheKey(context.cacheIdentity, detailView),
    () => accountingBuildScheduler.schedule(() =>
      buildDetailProjection(base, detailView)),
    cacheOptions,
  );
  return withRequestContext(detail, context, query);
}

export function scopedAccountingCacheKey(
  cacheIdentity: string,
  detailView?: TableView,
): string {
  const projection = detailView === "people" || detailView === "projects"
    ? detailView
    : "base";
  return `${cacheIdentity}:${projection}`;
}

export function __getScopedAccountingCacheSizeForTests(): number {
  return accountingCache.size;
}

export function __getScopedAccountingCacheWeightForTests(): number {
  return accountingCache.weight;
}

export function __getScopedAccountingBuildCountForTests(): number {
  return accountingBuildCount;
}

export function rowsForView(
  result: Awaited<ReturnType<typeof buildScopedAccounting>>,
  view: TableView,
): SpendRow[] {
  return view === "pools" ? result.poolRows
    : view === "groups" ? result.groupRows
    : view === "people" ? result.peopleRows
    : result.projectRows;
}

export function bucketRollupSpend(
  rollup: SnapshotUsageRollup,
  authz: Authorization,
  groups: readonly { id: string; workspaceId: string }[] = [],
): number {
  return qualifiedRollupTotals(rollup, authz, groups).reportedSpendUsd;
}

/**
 * Shared qualified reporting semantics for a concrete group scope. Unknown
 * creator evidence affects every group sharing that workspace; known evidence
 * affects only the group to which the creator was attributed.
 */
export function reportingSemanticsForGroups(
  daily: ReadonlyMap<string, SnapshotUsageRollup>,
  groups: readonly { id: string; workspaceId: string }[],
): ReturnType<typeof summarizeReportingSemantics> {
  const groupIds = new Set(groups.map((group) => group.id));
  const workspaceIds = new Set(groups.map((group) => group.workspaceId));
  const scoped = [...daily.values()].map((rollup): SnapshotUsageRollup => {
    const acquisition = [...workspaceIds].map((workspaceId) =>
      rollup.reporting.workspaceAcquisitionCoverage.get(workspaceId) ??
        "unavailable");
    const acquisitionCoverage = acquisition.length === 0 ||
        acquisition.every((status) => status === "unavailable")
      ? "unavailable" as const
      : acquisition.every((status) => status === "complete")
        ? "complete" as const
        : "partial" as const;
    const creatorBases: string[] = [];
    let creatorMissing = false;
    for (const [projectKey, nonAiSpend] of
      rollup.projectAttribution.nonAiSpendByProject) {
      if (nonAiSpend <= 1e-9) continue;
      const separator = projectKey.indexOf("\0");
      const workspaceId = separator < 0
        ? ""
        : projectKey.slice(0, separator);
      if (!workspaceIds.has(workspaceId)) continue;
      const attributedGroup =
        rollup.projectAttribution.projectToGroup.get(projectKey);
      if (attributedGroup && !groupIds.has(attributedGroup)) continue;
      const basis =
        rollup.projectAttribution.creatorBasisByProject.get(projectKey) ??
          "unavailable";
      if (basis === "unavailable") creatorMissing = true;
      else creatorBases.push(basis);
    }
    const uniqueCreatorBases = new Set(creatorBases);
    const creatorCoverage = creatorMissing
      ? "partial" as const
      : creatorBases.length > 0
        ? "complete" as const
        : "not_applicable" as const;
    const creatorAttributionBasis = creatorMissing &&
        uniqueCreatorBases.size === 0
      ? "unavailable" as const
      : uniqueCreatorBases.size > 1 ||
          creatorMissing && uniqueCreatorBases.size > 0
        ? "mixed" as const
        : uniqueCreatorBases.size === 1
          ? [...uniqueCreatorBases][0] as
            "verified_historical" | "current_catalog_observation"
          : "not_applicable" as const;
    const comparisonsVerified =
      acquisitionCoverage === "complete" &&
      rollup.reporting.rosterAttributionBasis !== "current_membership" &&
      creatorCoverage !== "partial" &&
      (creatorAttributionBasis === "verified_historical" ||
        creatorAttributionBasis === "not_applicable") &&
      rollup.reporting.freshness === "fresh";
    return {
      ...rollup,
      reporting: {
        ...rollup.reporting,
        acquisitionCoverage,
        creatorCoverage,
        creatorAttributionBasis,
        comparisonsVerified,
      },
    };
  });
  return summarizeReportingSemantics(scoped);
}
