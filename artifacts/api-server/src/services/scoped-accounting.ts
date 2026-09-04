import { createHash } from "node:crypto";
import {
  db,
  familyTeamMappingsTable,
  groupBudgetsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
} from "@workspace/db";
import type { Authorization } from "../lib/authz";
import {
  buildCanonicalGroupMergePlan,
  getCachedDirectory,
  getDirectoryFreshness,
  hasSuccessfulLimitObservation,
  resolveCanonicalMergedGroupBudget,
} from "../lib/enterprise";
import { getEffectiveTeamBudgets } from "../lib/team-budgets";
import type { SnapshotUsageRollup } from "../lib/usage-rollup";
import {
  buildGroupTeamMap,
  dailyUsageRollups,
  groupTeamKey,
  usageForRequest,
  visibleGroupMembers,
  windowFromQuery,
} from "../routes/monitor.shared";
import { getUsageSnapshotGeneration } from "../lib/usage-store";

export type ViewScope = "managed" | "my" | "all_authorized";
export type TableView = "pools" | "groups" | "people" | "projects";

export function committedGenerationId(identity: {
  usageDataAsOf: string | null;
  directoryDataAsOf: string | null;
  usageStatus: string;
  coverage: unknown;
  limitObservation: unknown;
  period: unknown;
  scope: unknown;
  allocationRevision?: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(identity))
    .digest("hex").slice(0, 24);
}

async function getAllocationRevision(): Promise<string> {
  const [groupBudgets, targets, teams, adjustments, mappings] = await Promise.all([
    db.select().from(groupBudgetsTable),
    db.select().from(teamLimitTargetsTable),
    db.select().from(teamBudgetsTable),
    db.select().from(teamBudgetAdjustmentsTable),
    db.select().from(familyTeamMappingsTable),
  ]);
  const canonicalRows = (rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => Object.fromEntries(Object.entries(row)
      .sort(([a], [b]) => a.localeCompare(b))))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify({
    groupBudgets: canonicalRows(groupBudgets),
    targets: canonicalRows(targets),
    teams: canonicalRows(teams),
    adjustments: canonicalRows(adjustments),
    mappings: canonicalRows(mappings),
  })).digest("hex").slice(0, 24);
}

export interface SpendRow {
  id: string;
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
}

interface QualifiedRollupTotals {
  eligibleSpendUsd: number;
  agentSpendUsd: number;
  internalExcludedUsd: number;
  unattributedUsd: number;
  reconciliationUsd: number;
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
  return {
    eligibleSpendUsd: [...managedWorkspaceIds].reduce((sum, workspaceId) =>
      sum + (rollup.byWorkspace.get(workspaceId) ?? 0), 0) +
      additionalGroups.reduce((sum, group) =>
        sum +
          qualifiedGroupComponent(rollup.aiSpendByGroup.get(group.id), authz, group) +
          qualifiedGroupComponent(rollup.nonAiSpendByGroup.get(group.id), authz, group),
      0),
    agentSpendUsd: workspaceAgent + additionalAgent,
    internalExcludedUsd: [...managedWorkspaceIds].reduce((sum, workspaceId) =>
      sum + (rollup.excludedInternalSpendByWorkspace.get(workspaceId) ?? 0), 0) +
      additionalGroups.reduce((sum, group) =>
        sum + (rollup.excludedInternalSpendByGroup.get(group.id) ?? 0), 0),
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

function statusFor(allocation: number | null, spend: number, shared = false): string {
  if (shared && allocation === null) return "shared";
  if (allocation === null || allocation <= 0) return "no_allocation";
  const percent = spend / allocation;
  return percent >= 1 ? "over" : percent >= 0.9 ? "attention" : "budgeted";
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
  allocationRevision: string;
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
  const allocationRevision = await getAllocationRevision();
  const allocationMs = performance.now() - allocationStartedAt;
  return {
    dir,
    viewScope,
    effectiveAuth,
    allocationRevision,
    phaseDurations: {
      authorizationMs,
      storedReadsMs: directoryMs + allocationMs,
    },
    cacheIdentity: committedGenerationId({
      usageDataAsOf: String(getUsageSnapshotGeneration()),
      directoryDataAsOf: new Date(dir.fetchedAt).toISOString(),
      usageStatus: "persisted",
      coverage: dir.budgets.observation,
      limitObservation: dir.budgets.observation.generation,
      period: window,
      scope: sortedAuthorization(effectiveAuth),
      allocationRevision,
    }),
  };
}

export async function buildScopedAccounting(
  authz: Authorization,
  query: Record<string, unknown>,
  detailView?: TableView,
  prepared?: ScopedAccountingContext,
) {
  const context = prepared ?? await prepareScopedAccounting(authz, query);
  const { dir, viewScope, effectiveAuth, allocationRevision } = context;
  const [usage, budgets, assignments, teamBudgetSnapshot, teamRows] = await Promise.all([
    usageForRequest(effectiveAuth, dir, query, true),
    db.select().from(groupBudgetsTable),
    db.select().from(teamLimitTargetsTable),
    getEffectiveTeamBudgets(),
    db.select().from(teamBudgetsTable),
  ]);
  const daily = await dailyUsageRollups(dir, usage);
  const hiddenTeams = new Set(teamRows.filter((row) => row.isHidden).map((row) => row.teamName));
  const fullTeamByGroup = buildGroupTeamMap(dir.groups, dir.account, hiddenTeams, assignments);
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
  const effectiveTeamBudgets = new Map(teamBudgetSnapshot.teams
    .filter((team) => !team.isHidden)
    .map((team) => [team.teamName, team.effectiveAmountUsd]));
  const scopedMembers = visibleGroupMembers(effectiveAuth, dir.groupMembers);

  const rawSpendByGroup = new Map<string, number>();
  const rawAgentByGroup = new Map<string, number>();
  for (const rollup of daily.values()) {
    for (const group of usage.groups) {
      const agent = qualifiedGroupComponent(
        rollup.aiSpendByGroup.get(group.id), effectiveAuth, group);
      const other = qualifiedGroupComponent(
        rollup.nonAiSpendByGroup.get(group.id), effectiveAuth, group);
      rawAgentByGroup.set(
        group.id, (rawAgentByGroup.get(group.id) ?? 0) + agent);
      rawSpendByGroup.set(
        group.id, (rawSpendByGroup.get(group.id) ?? 0) + agent + other);
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
    poolRows.push({
      id: `pool:team:${encodeURIComponent(teamName)}`,
      kind: "pool", name: teamName, workspaceId: workspaceIds.size === 1 ? [...workspaceIds][0]! : null,
      workspaceName: workspaceIds.size === 1
        ? dir.workspaces.get([...workspaceIds][0]!)?.name ?? null
        : null,
      spendUsd: round(spend), agentSpendUsd: round(agent),
      otherServicesUsd: round(spend - agent), allocationUsd: allocation,
      remainingUsd: allocation === null ? null : round(allocation - spend),
      percentUsed: allocation && allocation > 0 ? round(spend / allocation * 100) : null,
      status: statusFor(allocation, spend, shared), memberCount: new Set(groups.flatMap(
        (group) => scopedMembers.get(group.id) ?? [])).size,
      ownerName: null, limitState: "not_applicable",
      limitObservationStatus: "not_applicable", sharedPool: shared,
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
    poolRows.push({
      id: `pool:group:${group.workspaceId}:${group.id}`, kind: "pool", name: group.name,
      workspaceId: group.workspaceId,
      workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
      spendUsd: round(spend), agentSpendUsd: round(agent),
      otherServicesUsd: round(spend - agent), allocationUsd: allocation,
      remainingUsd: allocation === null ? null : round(allocation - spend),
      percentUsed: allocation && allocation > 0 ? round(spend / allocation * 100) : null,
      status: statusFor(allocation, spend, shared),
      memberCount: new Set((visibleByCanonical.get(canonicalId) ?? [group])
        .flatMap((item) => scopedMembers.get(item.id) ?? [])).size,
      ownerName: null, limitState: "not_applicable",
      limitObservationStatus: "not_applicable", sharedPool: shared,
    });
  }
  for (const [workspaceId, ungrouped] of ungroupedByWorkspace) {
    if (!effectiveAuth.roles.includes("account") &&
        !effectiveAuth.workspaceIds.includes(workspaceId)) continue;
    poolRows.push({
      id: `pool:unbudgeted:${workspaceId}`, kind: "unattributed",
      name: "Unbudgeted / No group", workspaceId,
      workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
      spendUsd: round(ungrouped.spendUsd), agentSpendUsd: 0,
      otherServicesUsd: round(ungrouped.spendUsd), allocationUsd: null,
      remainingUsd: null, percentUsed: null, status: "unbudgeted",
      memberCount: ungrouped.memberCount, ownerName: null,
      limitState: "not_applicable", limitObservationStatus: "not_applicable",
      sharedPool: false,
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
    return {
      id: `group:${group.workspaceId}:${group.id}`, kind: "group", name: group.name,
      workspaceId: group.workspaceId,
      workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
      spendUsd: round(spend), agentSpendUsd: round(agent),
      otherServicesUsd: round(spend - agent), allocationUsd: allocation,
      remainingUsd: allocation === null ? null : round(allocation - spend),
      percentUsed: allocation && allocation > 0 ? round(spend / allocation * 100) : null,
      status: statusFor(allocation, spend, shared),
      memberCount: new Set(scopedMembers.get(group.id) ?? []).size,
      ownerName: null, limitState: "not_applicable" as const,
      limitObservationStatus: "not_applicable" as const, sharedPool: shared,
    };
  });
  for (const [workspaceId, ungrouped] of ungroupedByWorkspace) {
    if (!effectiveAuth.roles.includes("account") &&
        !effectiveAuth.workspaceIds.includes(workspaceId)) continue;
    groupRows.push({
      id: `group:${workspaceId}:no-group`, kind: "unattributed", name: "No group",
      workspaceId, workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
      spendUsd: round(ungrouped.spendUsd), agentSpendUsd: 0,
      otherServicesUsd: round(ungrouped.spendUsd), allocationUsd: null,
      remainingUsd: null, percentUsed: null, status: "unbudgeted",
      memberCount: ungrouped.memberCount, ownerName: null,
      limitState: "not_applicable", limitObservationStatus: "not_applicable",
      sharedPool: false,
    });
  }

  const peopleRows: SpendRow[] = [];
  const qualifiedUsers = detailView === "people"
    ? qualifiedUserSpendByWorkspace(
      daily, effectiveAuth, usage.groups, usage.workspaceIds)
    : new Map<string, Map<string, { agent: number; other: number }>>();
  const billingWindow = windowFromQuery({ rangeType: "billing" }).window;
  const currentCycleUsage = detailView === "people" &&
      (usage.selection.window.start !== billingWindow.start ||
       usage.selection.window.end !== billingWindow.end)
    ? await usageForRequest(effectiveAuth, dir, { rangeType: "billing" }, true)
    : usage;
  const currentCycleDaily = currentCycleUsage === usage
    ? daily
    : await dailyUsageRollups(dir, currentCycleUsage);
  const currentCycleUsers = detailView === "people"
    ? qualifiedUserSpendByWorkspace(
      currentCycleDaily, effectiveAuth, currentCycleUsage.groups,
      currentCycleUsage.workspaceIds)
    : new Map<string, Map<string, { agent: number; other: number }>>();
  const currentCycleComplete =
    currentCycleUsage.snapshot.status === "complete" ||
    currentCycleUsage.snapshot.status === "stale";
  if (detailView === "people") for (const workspaceId of usage.workspaceIds) {
    const authorizedUserIds = effectiveAuth.roles.includes("account") ||
        effectiveAuth.workspaceIds.includes(workspaceId)
      ? [...dir.members.values()]
        .filter((member) => member.workspaces.has(workspaceId))
        .map((member) => member.userId)
      : [...new Set([
        effectiveAuth.userId,
        ...usage.groups
          .filter((group) => group.workspaceId === workspaceId)
          .flatMap((group) => effectiveAuth.groupUserIds?.[group.id] ?? []),
      ])].filter((userId) => dir.members.get(userId)?.workspaces.has(workspaceId));
    for (const userId of authorizedUserIds) {
      if (dir.internalUserIds.has(userId) && userId !== effectiveAuth.userId) continue;
      const member = dir.members.get(userId);
      const totals = qualifiedUsers.get(workspaceId)?.get(userId) ??
        { agent: 0, other: 0 };
      const agent = dir.internalUserIds.has(userId) ? 0 : totals.agent;
      const other = totals.other;
      const spend = agent + other;
      const limit = resolveStoredMemberLimit(dir, workspaceId, userId);
      const currentAgent = currentCycleComplete
        ? dir.internalUserIds.has(userId)
          ? 0
          : (currentCycleUsers.get(workspaceId)?.get(userId)?.agent ?? 0)
        : null;
      const currentMetrics = currentCycleLimitMetrics(limit.amount, currentAgent);
      peopleRows.push({
        id: `person:${workspaceId}:${userId}`, kind: "person",
        name: member?.name ?? member?.username ?? userId, workspaceId,
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
        spendUsd: round(spend), agentSpendUsd: round(agent), otherServicesUsd: round(other),
        allocationUsd: limit.amount,
        remainingUsd: currentMetrics.remainingUsd,
        percentUsed: currentMetrics.percentUsed,
        currentCycleAgentSpendUsd: currentAgent === null ? null : round(currentAgent),
        currentCycleRemainingUsd: currentMetrics.remainingUsd,
        currentCyclePercentUsed: currentMetrics.percentUsed,
        status: limit.state, memberCount: null, ownerName: null,
        limitState: limit.state,
        limitObservationStatus: dir.budgets.observation.status,
        sharedPool: false,
      });
    }
  }

  const projectRows: SpendRow[] = [];
  if (detailView === "projects") for (const workspaceId of usage.workspaceIds) {
    const projectTotals = new Map<string, { agent: number; other: number }>();
    for (const rollup of daily.values()) {
      for (const [key, agent] of rollup.projectAttribution.aiSpendByProject) {
        const [projectWorkspaceId, projectId] = key.split("\u0000");
        if (projectWorkspaceId !== workspaceId || !projectId) continue;
        const creatorId = rollup.projectAttribution.creatorByProject.get(key) ?? null;
        const groupId = rollup.projectAttribution.projectToGroup.get(key);
        const qualified = effectiveAuth.roles.includes("account") ||
          effectiveAuth.workspaceIds.includes(workspaceId) ||
          (!!groupId && usage.groups.some((group) =>
            group.id === groupId && group.workspaceId === workspaceId) &&
            creatorId !== null &&
            (effectiveAuth.groupUserIds?.[groupId] ?? []).includes(creatorId));
        if (!qualified) continue;
        const current = projectTotals.get(projectId) ?? { agent: 0, other: 0 };
        current.agent += agent;
        current.other += rollup.projectAttribution.nonAiSpendByProject.get(key) ?? 0;
        projectTotals.set(projectId, current);
      }
    }
    for (const [projectId, totals] of projectTotals) {
      const key = `${workspaceId}\u0000${projectId}`;
      const creatorId = usage.rollup.projectAttribution.creatorByProject.get(key) ?? null;
      const metadata = usage.projectMetadata.byWorkspace.get(workspaceId)?.get(projectId);
      const owner = creatorId ? dir.members.get(creatorId) : undefined;
      projectRows.push({
        id: `project:${workspaceId}:${projectId}`, kind: "project",
        name: metadata?.title ?? projectId, workspaceId,
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
        spendUsd: round(totals.agent + totals.other), agentSpendUsd: round(totals.agent),
        otherServicesUsd: round(totals.other),
        allocationUsd: null, remainingUsd: null, percentUsed: null,
        status: metadata ? "attributed" : "unattributed", memberCount: null,
        ownerName: owner?.name ?? owner?.username ?? null,
        limitState: "not_applicable", limitObservationStatus: "not_applicable",
        sharedPool: false,
      });
    }
  }

  const unbudgetedSpend = poolRows
    .filter((row) => row.status === "no_allocation" || row.status === "unbudgeted")
    .reduce((sum, row) => sum + row.spendUsd, 0);
  const qualified = [...daily.values()].map((rollup) =>
    qualifiedRollupTotals(rollup, effectiveAuth, usage.groups));
  const scopedEligibleSpend = qualified.reduce(
    (sum, item) => sum + item.eligibleSpendUsd, 0);
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
    otherServicesUsd: round(scopedEligibleSpend - agentSpend),
  };
  const freshness = getDirectoryFreshness();
  const missingDays = [...new Set([
    ...usage.snapshot.coverage.missingWorkspaceDays.map((item) => item.usageDate),
    ...usage.snapshot.coverage.missingAccountDays,
  ])].sort();
  const failedWorkspaceDays = usage.snapshot.coverage.failedWorkspaceDays
    .map((item) => `${item.workspaceId}:${item.usageDate}`).sort();
  const qualifications = [
    ...(usage.snapshot.status === "partial" ? ["Partial usage coverage; missing facts are not zero."] : []),
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
    usageDataAsOf: usage.snapshot.dataAsOf,
    directoryDataAsOf: freshness.dataAsOf,
    usageStatus: usage.snapshot.status,
    coverage: usage.snapshot.coverage,
    limitObservation: dir.budgets.observation,
    allocationRevision,
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
      status: usage.snapshot.status, dataAsOf: usage.snapshot.dataAsOf,
      directoryDataAsOf: freshness.dataAsOf,
      stale: usage.snapshot.status === "stale" || freshness.isStale,
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
  return qualifiedRollupTotals(rollup, authz, groups).eligibleSpendUsd;
}