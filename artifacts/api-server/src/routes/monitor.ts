import { Router, type IRouter, type Response } from "express";
import { eq, desc, inArray } from "drizzle-orm";
import {
  db,
  pool,
  groupBudgetsTable,
  teamLimitTargetsTable,
  teamBudgetsTable,
  adminEmailsTable,
  alertsTable,
  appAdminsTable,
  usersTable,
  apiDirectoryCacheTable,
  apiProjectMetadataTable,
  apiProjectMetadataStateTable,
  usageLimitAuditsTable,
} from "@workspace/db";
import {
  ListGroupsResponse,
  GetSummaryResponse,
  ListBudgetsResponse,
  SetGroupBudgetBody,
  SetGroupBudgetResponse,
  DeleteGroupBudgetResponse,
  GetTeamsBudgetsResponse,
  ListAdminsResponse,
  AddAdminBody,
  AddAdminResponse,
  DeleteAdminResponse,
  ListWorkspaceAdminsResponse,
  ListAlertsQueryParams,
  ListAlertsResponse,
  RunAlertCheckResponse,
  SendTestAlertResponse,
  SendEmailTestExampleBody,
  SendEmailTestExampleResponse,
  GetStatusResponse,
  GetGroupDetailResponse,
  GetGroupProjectsResponse,
  GetCanonicalClusterHeadlineResponse,
  GetTrendsQueryParams,
  GetTrendsResponse,
  ListAppAdminsResponse,
  AddAppAdminBody,
  AddAppAdminResponse,
  DeleteAppAdminResponse,
  ListDirectoryGroupsResponse,
  GetTeamBudgetHistoryResponse,
  GetTeamAllocationAuditResponse,
  UpdateTeamAnnualAllocationParams,
  UpdateTeamAnnualAllocationBody,
  UpdateTeamAnnualAllocationResponse,
  UpdateTeamVisibilityParams,
  UpdateTeamVisibilityBody,
  UpdateTeamVisibilityResponse,
  GetTeamBudgetSyncStatusResponse,
  RetryTeamBudgetUpstreamSyncResponse,
  RefreshTeamBudgetsResponse,
  UpdateTeamBudgetLimitParams,
  UpdateTeamBudgetLimitBody,
  UpdateTeamBudgetLimitResponse,
  ApplyTeamBudgetLimitsBody,
  ApplyTeamBudgetLimitsResponse,
  GetTeamBudgetTargetsResponse,
  AssignTeamBudgetTargetBody,
  AssignTeamBudgetTargetResponse,
  UpdateTeamBudgetTargetParams,
  UpdateTeamBudgetTargetBody,
  UpdateTeamBudgetTargetResponse,
  UpdateLegacyWorkspaceLimitBody,
  UpdateLegacyWorkspaceLimitResponse,
  ListVisibleWorkspacesResponse,
  ListVisibleWorkspaceMembersResponse,
  SetWorkspaceMemberBudgetBody,
  SetWorkspaceMemberBudgetResponse,
  ClearWorkspaceMemberBudgetResponse,
  BulkSetWorkspaceMemberBudgetsBody,
  BulkSetWorkspaceMemberBudgetsResponse,
  ListWorkspaceUsageLimitAuditsResponse,
  GetUserActivityResponse,
  GetAccountUsageObservationExportQueryParams,
  GetAccountUsageObservationExportResponse,
} from "@workspace/api-zod";

function escapeCsvCell(value: unknown): string {
  const text = String(value);
  const literalText = /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)
    ? `'${text}`
    : text;
  return `"${literalText.replace(/"/g, '""')}"`;
}
import {
  isConfigured,
  getApiHealth,
  getCachedDirectory as getDirectory,
  getDirectoryFreshness,
  getBillingPeriod,
  getBillingPeriodMetadata,
  buildCanonicalGroupMergePlan,
  resolveCanonicalMergedGroupBudget,
  type EnterpriseGroup,
} from "../lib/enterprise";
import { buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient } from "../lib/email";
import { resolveAlertRecipients } from "../lib/alert-recipients";
import {
  runCheck,
  getFiredThresholds,
  getFiredThresholdsBatch,
  getLastCheckAt,
  getCheckerState,
} from "../lib/checker";
import {
  requireAuth,
  requireRole,
  requireCapability,
  requireTrueAccountAdmin,
  requireUserLimitWorkspace,
} from "../middlewares/requireAuth";
import {
  canSeeGroup,
  isAccountWide,
  isAdminRole,
  scopeGroups,
  type Authorization,
  scopeFor,
} from "../lib/authz";
import { getRosterHistory, projectEndOfPeriod } from "../lib/history";
import { generateTrendBuckets } from "../lib/trend-buckets";
import {
  getEffectiveTeamBudgets,
  applyTeamBudgetLimits,
  assignTeamLimitTarget,
  getFreshEligibleTeamLimitGroup,
  getTeamLimitTargetConfiguration,
  getTeamBudgetUpstreamSyncRows,
  getVisibleEffectiveTeamBudgetMap,
  queueTeamBudgetUpstreamReconciliation,
  reconcileTeamBudgetsUpstream,
  refreshTeamBudgetSnapshot,
  updateTeamMonthlyLimit,
  updateTeamAnnualAllocation,
  updateTeamVisibility,
  getTeamAllocationAudits,
  updateTeamLimitTargetOverride,
  updateLegacyWorkspaceLimit,
  TEAM_BUDGET_REQUIRED_APPROVAL_STATUS,
  TEAM_BUDGET_SOURCE_TABLE,
} from "../lib/team-budgets";
import {
  listReplitMemberBudgets,
  ReplitBudgetConnectorError,
  setReplitMemberBudget,
} from "../lib/replit-budgets";
import {
  resolveUsageWindow,
  USAGE_DATA_CUTOFF_ISO,
  type UsageWindowSelection,
} from "../lib/usage-window";
import { readUsageSnapshot, type UsageSnapshot } from "../lib/usage-store";
import {
  computeDedupedMemberCounts,
  computeHistoricalSnapshotUsageRollups,
  computeSnapshotUsageRollup,
  projectAttributionKey,
  type SnapshotUsageRollup,
} from "../lib/usage-rollup";
import { BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle } from "../lib/ingest";

const router: IRouter = Router();

// Every monitor endpoint requires an authenticated, authorized user.
// Health and auth entry points live on separate routers and stay public.
router.use(requireAuth);

/**
 * Reduce a directory's group list to the set visible to the current request's
 * authorization. Account admins see every custom group; workspace admins see
 * only groups whose workspace they administer.
 */
function visibleGroups(authz: Authorization, groups: EnterpriseGroup[]): EnterpriseGroup[] {
  return scopeGroups(authz, groups);
}

function visibleGroupMembers(
  authz: Authorization,
  members: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const scope = scopeFor(authz);
  if ("kind" in scope) {
    return new Map([...members].map(([id, userIds]) => [id, [...userIds]]));
  }
  return new Map(
    [...members].map(([id, userIds]) => [
      id,
      userIds.filter((userId) => scope.userIds.has(userId)),
    ]),
  );
}

function visibleRosterMembers(
  authz: Authorization,
  membersByDate: Map<string, Map<string, string[]>>,
): Map<string, Map<string, string[]>> {
  const scope = scopeFor(authz);
  if ("kind" in scope) return membersByDate;
  return new Map(
    [...membersByDate].map(([date, byGroup]) => [
      date,
      new Map(
        [...byGroup].map(([groupId, userIds]) => [
          groupId,
          userIds.filter((userId) => scope.userIds.has(userId)),
        ]),
      ),
    ]),
  );
}

type AlertScopeEntity = {
  entityType: string;
  entityId: string;
  groupId: string;
  workspaceIds: string[];
};

export function canSeeAlertEntity(
  authz: Authorization,
  alert: AlertScopeEntity,
  visibleGroupIds: ReadonlySet<string>,
  visibleTeamNames: ReadonlySet<string>,
): boolean {
  const scope = scopeFor(authz);
  if ("kind" in scope) return true;
  if (alert.entityType !== "team") {
    return visibleGroupIds.has(alert.entityId || alert.groupId);
  }
  if (scope.teamNames.has(alert.entityId)) return true;
  if (authz.roles.includes("workspace_admin")) {
    return alert.workspaceIds.length > 0 &&
      alert.workspaceIds.every((workspaceId) => scope.workspaceIds.has(workspaceId));
  }
  return visibleTeamNames.has(alert.entityId);
}

function targetTeamForGroup(
  group: EnterpriseGroup,
  targets: readonly (typeof teamLimitTargetsTable.$inferSelect)[],
): string | undefined {
  const direct = targets.find((target) =>
    target.workspaceId === group.workspaceId && target.groupId === group.id
  );
  if (direct) return direct.teamName;
  if (group.workspaceId !== "1awqan") return undefined;
  const teams = new Set(
    targets
      .filter((target) =>
        target.workspaceId !== "1awqan" && target.groupName === group.name
      )
      .map((target) => target.teamName),
  );
  return teams.size === 1 ? [...teams][0] : undefined;
}

function groupTeamKey(group: Pick<EnterpriseGroup, "workspaceId" | "id">): string {
  return `${group.workspaceId}\0${group.id}`;
}

function buildGroupTeamMap(
  groups: readonly EnterpriseGroup[],
  targets: readonly (typeof teamLimitTargetsTable.$inferSelect)[],
  hiddenTeamNames: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const result = new Map<string, string>();
  for (const group of groups) {
    const teamName = targetTeamForGroup(group, targets);
    if (teamName && !hiddenTeamNames.has(teamName)) {
      result.set(groupTeamKey(group), teamName);
    }
  }
  return result;
}

function windowFromQuery(query: Record<string, unknown>): UsageWindowSelection {
  const billing = getBillingPeriod();
  return resolveUsageWindow({
    rangeType: typeof query["rangeType"] === "string" ? query["rangeType"] : undefined,
    startDate: typeof query["startDate"] === "string" ? query["startDate"] : undefined,
    endDate: typeof query["endDate"] === "string" ? query["endDate"] : undefined,
    billingPeriod: billing.start && billing.end
      ? { start: billing.start, end: billing.end }
      : null,
  });
}

function workspaceScope(
  authz: Authorization,
  dir: Awaited<ReturnType<typeof getDirectory>>,
  groups: readonly EnterpriseGroup[],
): Set<string> {
  return isAccountWide(authz)
    ? new Set([...dir.workspaces.keys(), ...groups.map((group) => group.workspaceId)])
    : new Set([...authz.workspaceIds, ...groups.map((group) => group.workspaceId)]);
}

interface ProjectMetadataSnapshot {
  byWorkspace: Map<
    string,
    Map<string, { creatorId: string | null; title: string | null }>
  >;
  completeWorkspaceIds: Set<string>;
}

async function readProjectMetadata(
  workspaceIds: Iterable<string>,
): Promise<ProjectMetadataSnapshot> {
  const ids = [...new Set(workspaceIds)].sort();
  if (ids.length === 0) {
    return { byWorkspace: new Map(), completeWorkspaceIds: new Set() };
  }
  const [rows, states] = await Promise.all([
    db.select().from(apiProjectMetadataTable)
      .where(inArray(apiProjectMetadataTable.workspaceId, ids)),
    db.select().from(apiProjectMetadataStateTable)
      .where(inArray(apiProjectMetadataStateTable.workspaceId, ids)),
  ]);
  const byWorkspace = new Map<
    string,
    Map<string, { creatorId: string | null; title: string | null }>
  >();
  for (const row of rows) {
    const projects = byWorkspace.get(row.workspaceId) ?? new Map();
    projects.set(row.projectId, {
      creatorId: row.creatorId,
      title: row.title,
    });
    byWorkspace.set(row.workspaceId, projects);
  }
  return {
    byWorkspace,
    completeWorkspaceIds: new Set(
      states.filter((state) => state.status === "success")
        .map((state) => state.workspaceId),
    ),
  };
}

async function usageForRequest(
  authz: Authorization,
  dir: Awaited<ReturnType<typeof getDirectory>>,
  query: Record<string, unknown>,
  includeDailyMembers = false,
): Promise<{
  authz: Authorization;
  selection: UsageWindowSelection;
  groups: EnterpriseGroup[];
  workspaceIds: Set<string>;
  snapshot: UsageSnapshot;
  rollup: SnapshotUsageRollup;
  projectMetadata: ProjectMetadataSnapshot;
}> {
  const selection = windowFromQuery(query);
  const groups = visibleGroups(authz, dir.groups);
  const workspaceIds = workspaceScope(authz, dir, groups);
  const [snapshot, projectMetadata] = await Promise.all([
    readUsageSnapshot({
      window: selection.window,
      workspaceIds,
      includeDailyMembers,
    }),
    readProjectMetadata(workspaceIds),
  ]);
  return {
    authz,
    selection,
    groups,
    workspaceIds,
    snapshot,
    rollup: computeSnapshotUsageRollup({
      snapshot,
      groups,
      membersByGroup: visibleGroupMembers(authz, dir.groupMembers),
      projectInfoByWorkspace: projectMetadata.byWorkspace,
    }),
    projectMetadata,
  };
}

function usageHealth(
  snapshot: UsageSnapshot,
  rollup: Pick<SnapshotUsageRollup, "accountReconciliationSpendUsd">,
  authz: Authorization,
) {
  return {
    status: snapshot.status,
    dataAsOf: snapshot.dataAsOf,
    coverage: snapshot.coverage,
    accountWorkspaceUnreconciledUsd: isAccountWide(authz)
      ? rollup.accountReconciliationSpendUsd
      : 0,
  };
}

async function dailyUsageRollups(
  dir: Awaited<ReturnType<typeof getDirectory>>,
  usage: Awaited<ReturnType<typeof usageForRequest>>,
): Promise<Map<string, SnapshotUsageRollup>> {
  const startDate = usage.selection.window.start.slice(0, 10);
  const endDate = new Date(Date.parse(usage.selection.window.end) - 1)
    .toISOString().slice(0, 10);
  const roster = await getRosterHistory(
    usage.groups.map((group) => group.id),
    startDate,
    endDate,
  );
  return computeHistoricalSnapshotUsageRollups({
    snapshot: usage.snapshot,
    groups: usage.groups,
    currentUtcDay: new Date().toISOString().slice(0, 10),
    currentMembersByGroup: visibleGroupMembers(usage.authz, dir.groupMembers),
    completedRosterDays: roster.completedDays,
    rosterMembersByDate: visibleRosterMembers(usage.authz, roster.membersByDate),
    projectInfoByWorkspace: usage.projectMetadata.byWorkspace,
  });
}

interface EffectiveBudget {
  amountUsd: number | null;
  source: "app" | null;
}

function effectiveGroupBudget(appBudget: number | undefined): EffectiveBudget {
  if (appBudget != null) return { amountUsd: appBudget, source: "app" };
  return { amountUsd: null, source: null };
}

/**
 * Given a set of source group IDs (a merged group's aliases), return the union of
 * their directory members (deduped) in stable insertion order.
 */
function mergedGroupMemberIds(
  sourceIds: string[],
  groupMembers: ReadonlyMap<string, readonly string[]>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of sourceIds) {
    for (const uid of groupMembers.get(id) ?? []) {
      if (!seen.has(uid)) { seen.add(uid); result.push(uid); }
    }
  }
  return result;
}

type CanonicalUserAttribution = {
  groupName: string;
  teamName: string;
  workspaceId: string;
  displaySpendUsd: number;
};

/**
 * Choose display metadata from canonical attribution without using it to
 * calculate totals. Totals always come from canonical.byUser.
 */
function canonicalUserAttribution(
  canonical: SnapshotUsageRollup,
  groups: EnterpriseGroup[],
  groupMembers: ReadonlyMap<string, readonly string[]>,
  teamNameMap: ReadonlyMap<string, string>,
): Map<string, CanonicalUserAttribution> {
  const ordered = [...groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const result = new Map<string, CanonicalUserAttribution>();

  // Give every directory member a stable group/team even when their spend is zero.
  for (const group of ordered) {
    const primary = group;
    for (const userId of groupMembers.get(group.id) ?? []) {
      if (!result.has(userId)) {
        result.set(userId, {
          groupName: primary.name,
          teamName: teamNameMap.get(groupTeamKey(primary)) ?? "",
          workspaceId: group.workspaceId,
          displaySpendUsd: 0,
        });
      }
    }
  }

  // Preserve the existing primary-cost-center presentation, but only compare
  // canonical workspace observations. This never changes the canonical total.
  for (const group of ordered) {
    const primary = group;
    for (const [userId, spendUsd] of canonical.byGroup.get(group.id)?.byUser ?? []) {
      const current = result.get(userId);
      if (!current || spendUsd > current.displaySpendUsd) {
        result.set(userId, {
          groupName: primary.name,
          teamName: teamNameMap.get(groupTeamKey(primary)) ?? "",
          workspaceId: group.workspaceId,
          displaySpendUsd: spendUsd,
        });
      }
    }
  }

  return result;
}

interface CurrentAlertUsage {
  spendUsd: number | null;
  percentUsed: number | null;
  isComplete: boolean;
}

function alertToJson(
  a: typeof alertsTable.$inferSelect,
  current?: CurrentAlertUsage,
) {
  return {
    id: a.id,
    entityType: a.entityType,
    entityId: a.entityId || a.groupId,
    entityName: a.entityName || a.groupName,
    workspaceIds: a.workspaceIds,
    threshold: a.threshold,
    spendUsd: a.spendUsd,
    budgetUsd: a.budgetUsd,
    recipients: a.recipients,
    sentAt: a.sentAt.toISOString(),
    status: a.status,
    errorMessage: a.errorMessage,
    dataAsOf: a.dataAsOf?.toISOString() ?? null,
    currentSpendUsd: current?.spendUsd ?? null,
    currentPercentUsed: current?.percentUsed ?? null,
    currentUsageComplete: current?.isComplete ?? false,
  };
}

router.get("/groups", async (req, res): Promise<void> => {
  try {
    const dir = await getDirectory();
    const usage = await usageForRequest(
      req.authz!, dir, req.query as Record<string, unknown>, true);
    const dailyRollups = await dailyUsageRollups(dir, usage);
    const [budgets, assignments, teamSnapshot, teamRows] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(teamLimitTargetsTable),
      getEffectiveTeamBudgets(),
      db.select().from(teamBudgetsTable),
    ]);
    const hiddenTeams = new Set(teamRows.filter((row) => row.isHidden).map((row) => row.teamName));
    const teamByGroup = buildGroupTeamMap(usage.groups, assignments, hiddenTeams);
    const mergePlan = buildCanonicalGroupMergePlan(
      usage.groups,
      dir.workspaces,
      teamByGroup,
    );
    const displayGroups = usage.groups.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
    const budgetMap = new Map(budgets.map((row) => [row.groupId, row.amountUsd]));
    const effectiveTeamBudgetMap = new Map(teamSnapshot.teams
      .filter((team) => !team.isHidden)
      .map((team) => [team.teamName, team.effectiveAmountUsd]));
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const memberCounts = computeDedupedMemberCounts(usage.groups, scopedMembers);
    const billing = getBillingPeriod();
    const fired = billing.start
      ? await getFiredThresholdsBatch(displayGroups.map((group) => group.id), billing.start)
      : new Map<string, number[]>();
    const complete = usage.rollup.isComplete;
    const groups = displayGroups.map((group) => {
      const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
      const spendUsd = sourceIds.reduce(
        (sum, id) => sum + (usage.rollup.byGroup.get(id)?.spendUsd ?? 0), 0);
      const projectSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (usage.rollup.projectAttribution.spendByGroup.get(id) ?? 0), 0);
      const memberIds = mergedGroupMemberIds(sourceIds, scopedMembers);
      const budget = effectiveGroupBudget(
        resolveCanonicalMergedGroupBudget(group.id, mergePlan, budgetMap)?.amountUsd);
      const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
      return {
        groupId: group.id, workspaceId: group.workspaceId,
        workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
        name: group.name,
        teamName: teamByGroup.get(groupTeamKey(group)) ?? null,
        type: group.type,
        isSynthetic: false, syntheticKind: undefined as "no_group" | undefined,
        memberCount: memberIds.length,
        rollupMemberCount: sourceIds.reduce((sum, id) => sum + (memberCounts.get(id) ?? 0), 0),
        spendLoaded: complete, spendUsd, paceSpendLoaded: complete, paceSpendUsd: spendUsd,
        projectSpendLoaded: usage.rollup.projectAttribution.isComplete, projectSpendUsd,
        rollupSpendLoaded: complete, rollupSpendUsd: spendUsd,
        rawMemberSpendUsd: spendUsd, rawMemberSpendLoaded: complete,
        spendUpdatedAt: usage.snapshot.dataAsOf,
        budgetUsd: budget.amountUsd, budgetSource: budget.source,
        remainingUsd: hasBudget ? budget.amountUsd! - spendUsd : null,
        percentUsed: hasBudget ? (spendUsd / budget.amountUsd!) * 100 : null,
        thresholdsFired: fired.get(group.id) ?? [],
        history: [...dailyRollups].map(([date, daily]) => ({
          date,
          spendUsd: sourceIds.reduce(
            (sum, id) => sum + (daily.byGroup.get(id)?.spendUsd ?? 0), 0),
        })),
        projectedSpendUsd: complete
          ? projectEndOfPeriod(spendUsd, usage.selection.window.start, usage.selection.window.end)
          : null,
      };
    });
    for (const [workspaceId, ungrouped] of usage.rollup.ungroupedByWorkspace) {
      groups.push({
        groupId: `synthetic:no-group:${workspaceId}`, workspaceId,
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
        name: "No group", teamName: null, type: "synthetic", isSynthetic: true,
        syntheticKind: "no_group", memberCount: ungrouped.memberCount,
        rollupMemberCount: ungrouped.memberCount, spendLoaded: complete,
        spendUsd: ungrouped.spendUsd, paceSpendLoaded: complete,
        paceSpendUsd: ungrouped.spendUsd, projectSpendLoaded: true, projectSpendUsd: 0,
        rollupSpendLoaded: complete, rollupSpendUsd: ungrouped.spendUsd,
        rawMemberSpendUsd: 0, rawMemberSpendLoaded: false,
        spendUpdatedAt: usage.snapshot.dataAsOf, budgetUsd: null, budgetSource: null,
        remainingUsd: null, percentUsed: null, thresholdsFired: [], history: [],
        projectedSpendUsd: null,
      });
    }
    const teamRawSpend: Record<string, { spendUsd: number; spendLoaded: boolean }> = {};
    for (const group of displayGroups) {
      const team = teamByGroup.get(groupTeamKey(group));
      if (!team) continue;
      const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
      const spend = sourceIds.reduce(
        (sum, id) => sum + (usage.rollup.byGroup.get(id)?.spendUsd ?? 0), 0);
      teamRawSpend[team] = {
        spendUsd: (teamRawSpend[team]?.spendUsd ?? 0) + spend,
        spendLoaded: complete,
      };
    }
    res.json(ListGroupsResponse.parse({
      groups, isComplete: complete, syncStatus: usage.snapshot.status,
      syncError: null, pendingCount: usage.rollup.pendingCount,
      failedCount: usage.snapshot.coverage.failedWorkspaceDays.length,
      partialCount: usage.snapshot.coverage.missingWorkspaceDays.length,
      projectSyncStatus: usage.rollup.projectAttribution.isComplete ? "complete" : "partial",
      projectSyncError: null, projectPendingCount: usage.rollup.projectAttribution.pendingCount,
      projectFailedCount: 0, projectPartialCount: usage.rollup.projectAttribution.pendingCount,
      billingPeriodLabel: usage.selection.label,
      projectSpendLoaded: usage.rollup.projectAttribution.isComplete,
      unattributedProjectSpendUsd: usage.rollup.projectAttribution.unattributedSpendUsd,
      teamRawSpend, teamBudgets: Object.fromEntries(effectiveTeamBudgetMap),
      usageHealth: usageHealth(usage.snapshot, usage.rollup, req.authz!),
      directoryDataAsOf: getDirectoryFreshness().dataAsOf,
      directoryStale: getDirectoryFreshness().isStale,
      usageDataAsOf: usage.snapshot.dataAsOf,
      usageStale: usage.snapshot.status === "stale",
    }));
  } catch (err) {
    req.log.error({ err }, "listGroups failed");
    res.status(503).json({ error: "Usage snapshot unavailable" });
  }
});

router.get("/groups/:groupId", async (req, res): Promise<void> => {
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    // Non-disclosing: out-of-scope groups are indistinguishable from missing.
    if (!group || !canSeeGroup(req.authz!, group)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const usage = await usageForRequest(
      req.authz!, dir, req.query as Record<string, unknown>, true);
    const dailyRollups = await dailyUsageRollups(dir, usage);
    const mergePlan = buildCanonicalGroupMergePlan(usage.groups, dir.workspaces);
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
    const requestedScopeIds = String(req.query["scopeGroupIds"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const requestedScopeGroups = requestedScopeIds.map((id) =>
      usage.groups.find((candidate) => candidate.id === id),
    );
    if (
      requestedScopeIds.length > 0 &&
      requestedScopeGroups.some((candidate) => !candidate)
    ) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const canonical = usage.rollup;
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const rollupMemberCounts = computeDedupedMemberCounts(usage.groups, scopedMembers);
    const projectAttribution = canonical.projectAttribution;
    const projectSpendUsd = sourceIds.reduce(
      (sum, id) => sum + (projectAttribution.spendByGroup.get(id) ?? 0),
      0,
    );
    const projectSpendLoaded = projectAttribution.isComplete;

    const attributed = {
      spendUsd: sourceIds.reduce((sum, id) => sum + (canonical.byGroup.get(id)?.spendUsd ?? 0), 0),
      byUser: (() => {
        const m = new Map<string, number>();
        for (const id of sourceIds) {
          for (const [uid, s] of canonical.byGroup.get(id)?.byUser ?? []) {
            m.set(uid, (m.get(uid) ?? 0) + s);
          }
        }
        return m;
      })(),
    };

    const [budgets, groupTeamsRows] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(teamLimitTargetsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const mergedBudget = resolveCanonicalMergedGroupBudget(group.id, mergePlan, budgetMap);
    const budget = effectiveGroupBudget(mergedBudget?.amountUsd);
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingPeriodStart = getBillingPeriod().start;
    const fired =
      billingPeriodStart && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingPeriodStart)
        : [];

    const detailHistoryArr = [...dailyRollups].map(([date, daily]) => ({
      date,
      spendUsd: sourceIds.reduce(
        (sum, id) => sum + (daily.byGroup.get(id)?.spendUsd ?? 0), 0),
    }));

    // Union of directory members across all source groups.
    const requestedUserIds = mergedGroupMemberIds(sourceIds, scopedMembers);
    const requestScope = scopeFor(req.authz!);
    const userIds = "kind" in requestScope
      ? requestedUserIds
      : requestedUserIds.filter((userId) => requestScope.userIds.has(userId));

    const members = userIds.map((userId) => {
      const m = dir.members.get(userId);
      // Use the primary group's workspace for role/isDisabled (the user's workspace membership).
      const ws = m?.workspaces.get(group.workspaceId) ??
        sourceIds.map((id) => {
          const srcGroup = dir.groups.find((g) => g.id === id);
          return srcGroup ? m?.workspaces.get(srcGroup.workspaceId) : undefined;
        }).find(Boolean);
      // Every per-user surface uses the same canonical all-metric total for the
      // caller's selected range and visible workspaces.
      const spendLoaded = canonical.isComplete;
      const totalSpendLoaded = canonical.isComplete;
      const totalSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (canonical.byGroup.get(id)?.byUser.get(userId) ?? 0), 0);
      const aiSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (canonical.aiSpendByGroup.get(id)?.get(userId) ?? 0),
        0,
      );
      const nonAiSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (canonical.nonAiSpendByGroup.get(id)?.get(userId) ?? 0),
        0,
      );
      return {
        userId,
        username: m?.username ?? null,
        email: m?.email ?? null,
        name: m?.name ?? null,
        role: ws?.role ?? null,
        isDisabled: ws?.isDisabled ?? null,
        allocatedBudgetUsd: null,
        budgetSource: null,
        spendLoaded,
        spendUsd: totalSpendUsd,
        aiSpendUsd,
        nonAiSpendUsd,
        remainingUsd: null,
        percentUsed: null,
      };
    });

    // Reconciliation: members removed from the group since the last sync still count
    // toward group spend (they are captured in the rollup).  unattributedSpendUsd
    // surfaces that residual so the cluster page can show an accurate attributed total.
    const combinedSpend = attributed.spendUsd;
    const combinedLoaded = canonical.isComplete;
    const totalSpendLoaded = canonical.isComplete;
    let listedMembersSpend = 0;
    if (totalSpendLoaded) {
      for (const userId of userIds) {
        listedMembersSpend += sourceIds.reduce(
          (sum, id) => sum + (canonical.byGroup.get(id)?.byUser.get(userId) ?? 0),
          0,
        );
      }
    }
    // Unattributed spend = spend from members removed from the group since the last sync
    // (still in the rollup total but no longer in the directory member list).
    // Must be computed from attributed.byUser (not raw member spend) so that members
    // whose spend is attributed elsewhere don't inflate this figure — raw spend can
    // exceed the attributed group total for users in multiple groups.
    // This includes both canonical accounting residuals and spend canonically
    // owned by this group for people who are no longer in its displayed member
    // roster. Deriving it from the authoritative total and the exact displayed
    // rows guarantees the response reconciles, including cross-workspace admin
    // and re-homing paths where the owner is not a current group member.
    const unattributed = totalSpendLoaded
      ? Math.max(0, combinedSpend - listedMembersSpend)
      : 0;

    const mergedRollupMemberCount = sourceIds.reduce(
      (sum, id) => sum + (rollupMemberCounts.get(id) ?? 0),
      0,
    );

    res.json(
      GetGroupDetailResponse.parse({
        group: {
          groupId: group.id,
          workspaceId: group.workspaceId,
          workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
          name: group.name,
          teamName: targetTeamForGroup(group, groupTeamsRows) ?? null,
          type: group.type,
          memberCount: userIds.length,
          rollupMemberCount: mergedRollupMemberCount,
          spendLoaded: totalSpendLoaded,
          spendUsd: combinedSpend,
          paceSpendLoaded: false,
          paceSpendUsd: combinedSpend,
          projectSpendLoaded,
          projectSpendUsd,
          rollupSpendLoaded: canonical.isComplete,
          rollupSpendUsd: combinedSpend,
          spendUpdatedAt: usage.snapshot.dataAsOf,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd: combinedLoaded && hasBudget ? budget.amountUsd! - combinedSpend : null,
          percentUsed: combinedLoaded && hasBudget ? (combinedSpend / budget.amountUsd!) * 100 : null,
          thresholdsFired: fired,
          history: detailHistoryArr,
          projectedSpendUsd: combinedLoaded
            ? projectEndOfPeriod(combinedSpend, usage.selection.window.start, usage.selection.window.end)
            : null,
        },
        members,
        membersSpendUsd: listedMembersSpend,
        unattributedSpendUsd: unattributed,
        isComplete: combinedLoaded,
        usageHealth: usageHealth(usage.snapshot, usage.rollup, req.authz!),
        rangeLabel: usage.selection.label,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getGroupDetail failed");
    res.status(503).json({ error: "Usage snapshot unavailable" });
  }
});

router.get("/groups/:groupId/projects", async (req, res): Promise<void> => {
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    // Non-disclosing: out-of-scope groups are indistinguishable from missing.
    if (!group || !canSeeGroup(req.authz!, group)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const usage = await usageForRequest(req.authz!, dir, req.query as Record<string, unknown>);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const workspaceProjects = usage.snapshot.projects.get(group.workspaceId) ?? new Map();
    const projectMetadata = usage.projectMetadata.byWorkspace.get(group.workspaceId) ?? new Map();
    const titlesComplete = usage.projectMetadata.completeWorkspaceIds.has(group.workspaceId);
    const isComplete = usage.rollup.isComplete && titlesComplete;
    const projects = Array.from(workspaceProjects.entries())
          .filter(([projectId]) =>
            usage.rollup.projectAttribution.projectToGroup.get(
              projectAttributionKey(group.workspaceId, projectId),
            ) === group.id)
          .map(([projectId, p]) => {
            const info = projectMetadata.get(projectId);
            const aiSpendUsd = p.aiCostUsd;
            const creatorId = info?.creatorId ?? null;
            return {
              projectId,
              title: info?.title ?? null,
              totalCostUsd: p.totalCostUsd,
              aiSpendUsd,
              nonAiSpendUsd: Math.max(0, p.totalCostUsd - aiSpendUsd),
              creatorId,
              creatorName: creatorId
                ? (dir.members.get(creatorId)?.name ?? dir.members.get(creatorId)?.username ?? null)
                : null,
              creatorIsCurrentMember:
                creatorId !== null &&
                (scopedMembers.get(group.id) ?? []).includes(creatorId),
              metrics: [],
              workspaceId: group.workspaceId,
              workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
            };
          })
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    // Reconciliation: sum of project rows vs. group total.
    // Anchor to groupSpend.spendUsd (the same figure shown in the header stat card)
    // so the project table total always matches the group's reported spend.
    // Fall back to projectUsage.totalCostUsd only when the plain-group spend
    // hasn't loaded yet.
    const projectsSum = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
    const groupTotal = usage.rollup.byGroup.get(group.id)?.spendUsd ?? 0;
    const unattributedSpendUsd = Math.max(0, groupTotal - projectsSum);

    res.json(
      GetGroupProjectsResponse.parse({
        projects,
        unattributedSpendUsd,
        isComplete,
        titlesComplete,
        usageHealth: usageHealth(usage.snapshot, usage.rollup, req.authz!),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getGroupProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/clusters/:clusterKey/headline", async (req, res): Promise<void> => {
  try {
    const groupIds = String(req.params["clusterKey"]).split(",").map((id) => id.trim()).filter(Boolean);
    if (groupIds.length === 0) {
      res.status(400).json({ error: "No group IDs in cluster key" });
      return;
    }
    const dir = await getDirectory();
    const requested = groupIds.map((id) => dir.groups.find((group) => group.id === id));
    if (requested.some((group) => !group || !canSeeGroup(req.authz!, group))) {
      res.status(404).json({ error: "No matching groups found" });
      return;
    }
    const usage = await usageForRequest(req.authz!, dir, req.query as Record<string, unknown>);
    const visible = usage.groups;
    const accountMergePlan = buildCanonicalGroupMergePlan(visible, dir.workspaces);
    const relevantGroupIds = new Set(
      groupIds.flatMap((groupId) => {
        const primaryId = accountMergePlan.primaryByGroupId.get(groupId) ?? groupId;
        return accountMergePlan.mergeMap.get(primaryId) ?? [groupId];
      }),
    );
    const canonical = usage.rollup;
    const primaryIds = new Set(
      groupIds.map((groupId) => accountMergePlan.primaryByGroupId.get(groupId) ?? groupId),
    );
    const spendUsd = [...primaryIds].reduce(
      (sum, groupId) => sum + (accountMergePlan.mergeMap.get(groupId) ?? [groupId])
        .reduce((subtotal, id) => subtotal + (canonical.byGroup.get(id)?.spendUsd ?? 0), 0),
      0,
    );
    res.json(GetCanonicalClusterHeadlineResponse.parse({
      spendUsd,
      isComplete: canonical.isComplete,
      pendingCount: canonical.pendingCount,
      usageHealth: usageHealth(usage.snapshot, usage.rollup, req.authz!),
    }));
  } catch (err) {
    req.log.error({ err }, "getClusterHeadline failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/clusters/:clusterKey/projects", async (req, res): Promise<void> => {
  try {
    const rawKey = String(req.params["clusterKey"]);
    const groupIds = rawKey.split(",").map((id) => id.trim()).filter(Boolean);
    if (groupIds.length === 0) {
      res.status(400).json({ error: "No group IDs in cluster key" });
      return;
    }

    const dir = await getDirectory();
    const requestedGroups = groupIds
      .map((id) => dir.groups.find((g) => g.id === id))
      .filter((g): g is EnterpriseGroup => g !== undefined);

    // Fail closed if any requested group is missing or outside the caller's
    // workspace scope. Returning the same 404 avoids disclosing its existence.
    if (
      requestedGroups.length !== groupIds.length ||
      requestedGroups.some((group) => !canSeeGroup(req.authz!, group))
    ) {
      res.status(404).json({ error: "No matching groups found" });
      return;
    }
    const groups = requestedGroups;
    const usageContext = await usageForRequest(
      req.authz!, dir, req.query as Record<string, unknown>);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const workspaceIds = new Set(groups.map((group) => group.workspaceId));

    // Member set — union of all members across constituent groups
    const memberSet = new Set<string>();
    for (const g of groups) {
      for (const userId of scopedMembers.get(g.id) ?? []) {
        memberSet.add(userId);
      }
    }

    // Collect unique projects across all sub-groups; de-dup by taking max totalCostUsd entry.
    // When the same project appears in multiple sub-group responses (because the creator is in
    // multiple sub-groups), we pick the entry with the highest reported total rather than summing,
    // which would inflate the figure.
    const projectMap = new Map<
      string,
      {
        entry: { projectId: string; totalCostUsd: number; aiCostUsd: number };
        workspaceId: string;
        groupId: string;
      }
    >();
    for (const g of groups) {
      for (const [projectId, totals] of usageContext.snapshot.projects.get(g.workspaceId) ?? []) {
        if (
          usageContext.rollup.projectAttribution.projectToGroup.get(
            projectAttributionKey(g.workspaceId, projectId),
          ) !== g.id
        ) continue;
        const entry = { projectId, ...totals };
        const projectKey = projectAttributionKey(g.workspaceId, projectId);
        const existing = projectMap.get(projectKey);
        if (
          !existing ||
          entry.totalCostUsd > existing.entry.totalCostUsd ||
          (
            entry.totalCostUsd === existing.entry.totalCostUsd &&
            g.id.localeCompare(existing.groupId) < 0
          )
        ) {
          projectMap.set(projectKey, {
            entry,
            workspaceId: g.workspaceId,
            groupId: g.id,
          });
        }
      }
    }

    // Project info (creatorId) availability — needed for exact attribution
    const projectInfoLoaded = Array.from(workspaceIds).every((wsId) =>
      usageContext.projectMetadata.completeWorkspaceIds.has(wsId));

    // Attribute projects by creator membership
    const attributed: {
      projectId: string;
      title: string | null;
      totalCostUsd: number;
      aiSpendUsd: number;
      nonAiSpendUsd: number;
      creatorId: string | null;
      creatorName: string | null;
      creatorIsCurrentMember: boolean;
      metrics: [];
      workspaceId: string | null;
      workspaceName: string | null;
    }[] = [];
    let unattributedSpendUsd = 0;

    for (const { entry, workspaceId } of projectMap.values()) {
      const info = usageContext.projectMetadata.byWorkspace
        .get(workspaceId)?.get(entry.projectId);
      const creatorId = info?.creatorId ?? null;
      const aiSpendUsd = entry.aiCostUsd;
      const nonAiSpendUsd = Math.max(0, entry.totalCostUsd - aiSpendUsd);
      const creatorIsCurrentMember = creatorId !== null && memberSet.has(creatorId);
      attributed.push({
        projectId: entry.projectId,
        title: info?.title ?? null,
        totalCostUsd: entry.totalCostUsd,
        aiSpendUsd,
        nonAiSpendUsd,
        creatorId,
        creatorName: creatorId
          ? (dir.members.get(creatorId)?.name ?? dir.members.get(creatorId)?.username ?? null)
          : null,
        creatorIsCurrentMember,
        metrics: [],
        workspaceId,
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
      });
      if (!creatorIsCurrentMember) {
        unattributedSpendUsd += nonAiSpendUsd;
      }
    }

    attributed.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    res.json(
      GetGroupProjectsResponse.parse({
        projects: attributed,
        unattributedSpendUsd,
        isComplete: usageContext.rollup.isComplete && projectInfoLoaded,
        titlesComplete: projectInfoLoaded,
        usageHealth: usageHealth(usageContext.snapshot, usageContext.rollup, req.authz!),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getClusterProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/summary", async (req, res): Promise<void> => {
  const selectedRangeType =
    typeof req.query["rangeType"] === "string" ? req.query["rangeType"] : "billing";
  const authz = req.authz!;
  const isAccount = isAccountWide(authz);

  // Defensive timeout: the entire handler must respond within 25 s even if an
  // upstream call (DB, getDirectory) stalls.  Any unhandled throw in the outer
  // body is caught here so Express never sees an unanswered request.
  const SUMMARY_TIMEOUT_MS = 25_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("summary handler timed out")), SUMMARY_TIMEOUT_MS),
  );

  try {
    await Promise.race([
      (async () => {
        const [budgets, effectiveTeamSnapshot, allTeamBudgetRows, groupTeams] = await Promise.all([
          db.select().from(groupBudgetsTable),
          getEffectiveTeamBudgets(),
          db.select().from(teamBudgetsTable),
          db.select().from(teamLimitTargetsTable),
        ]);
        const effectiveBudgetMap = new Map(
          effectiveTeamSnapshot.teams
            .filter((team) => !team.isHidden)
            .map((team) => [team.teamName, team.effectiveAmountUsd]),
        );
        const teamBudgets = allTeamBudgetRows.filter((tb) => !tb.isHidden);
        const hiddenSummaryTeamNames = new Set(
          allTeamBudgetRows.filter((tb) => tb.isHidden).map((tb) => tb.teamName),
        );
        const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));

        let totalGroups = 0;
        let totalSpendUsd = 0;
        let memberBasedTotalSpendUsd = 0;
        let accountUsageTotalSpendUsd: number | null = null;
        let accountUsageAttributableSpendUsd: number | null = null;
        let accountUsageUnattributableSpendUsd: number | null = null;
        let reconciliationSpendUsd: number | null = null;
        let totalRemainingUsd = 0;
        let totalBudgetUsd = 0;
        let budgetedGroups = 0;
        let pending = 0;
        let projectPending = 0;
        let summaryExtraComplete = true; // tracks extra-workspace load state for isComplete
        let over50 = 0;
        let over75 = 0;
        let over90 = 0;
        let over100 = 0;
        let scoped: EnterpriseGroup[] = [];
        let snapshot: UsageSnapshot | null = null;

        // Set of visible groups, used both to scope spend and to filter alerts.
        let visibleGroupIds = new Set<string>();
        let visibleTeamNames = new Set<string>();

        try {
            const dir = await getDirectory();
            const usage = await usageForRequest(authz, dir, req.query as Record<string, unknown>);
            scoped = usage.groups;
            snapshot = usage.snapshot;
            visibleGroupIds = new Set(scoped.map((g) => g.id));
            const groupTeamMap = buildGroupTeamMap(
              scoped,
              groupTeams,
              hiddenSummaryTeamNames,
            );
            visibleTeamNames = new Set(groupTeamMap.values());
            const canonical = usage.rollup;
            const mergePlan = buildCanonicalGroupMergePlan(
              scoped,
              dir.workspaces,
              groupTeamMap,
            );
            const displayGroups = scoped.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
            const spendByPrimaryGroup = new Map(displayGroups.map((group) => [
              group.id,
              (mergePlan.mergeMap.get(group.id) ?? [group.id]).reduce(
                (sum, id) => sum + (canonical.byGroup.get(id)?.spendUsd ?? 0), 0),
            ]));
            const scopedMemberSpendUsd = [...canonical.byUser.values()]
              .reduce((sum, amount) => sum + amount, 0);
            memberBasedTotalSpendUsd = isAccount
              ? canonical.totalSpendUsd
              : scopedMemberSpendUsd;
            totalGroups = displayGroups.length;
            budgetedGroups = displayGroups.filter(
              (group) =>
                (resolveCanonicalMergedGroupBudget(
                  group.id,
                    mergePlan,
                  budgetMap,
                )?.amountUsd ?? 0) > 0,
            ).length;
            // Workspace-aware member attribution is the source of truth for rows,
            // budgets, teams, and alerts. For account-wide viewers, the unfiltered
            // account /usage anchor is the headline total and the difference is an
            // explicit reconciliation row so the visible table sums to gross usage.
            totalSpendUsd = memberBasedTotalSpendUsd;
            if (isAccount) {
              if (snapshot) {
                accountUsageTotalSpendUsd = snapshot.accountTotalUsd;
                accountUsageAttributableSpendUsd = canonical.totalSpendUsd;
                accountUsageUnattributableSpendUsd = canonical.accountReconciliationSpendUsd;
                reconciliationSpendUsd = canonical.accountReconciliationSpendUsd;
              }
            }
            pending = canonical.pendingCount;
            projectPending = canonical.projectAttribution.pendingCount;
            summaryExtraComplete = canonical.isComplete;

            // Compute over-threshold counts using the same top-level pool logic as tableTotals.
            // Groups assigned to a team: aggregate attributed spend per team and compare against team budget.
            // Unassigned groups: compare attributed spend against the group's own budget.
            const teamBudgetAmountMap = effectiveBudgetMap;
            const teamAttributedSpend = new Map<string, number>();
            for (const group of displayGroups) {
              const team = groupTeamMap.get(groupTeamKey(group));
              if (team) teamAttributedSpend.set(
                team, (teamAttributedSpend.get(team) ?? 0) + (spendByPrimaryGroup.get(group.id) ?? 0));
            }
            for (const group of displayGroups) {
              const spend = spendByPrimaryGroup.get(group.id) ?? 0;
              const teamName = groupTeamMap.get(groupTeamKey(group));
              if (!teamName) {
                const groupBudget = resolveCanonicalMergedGroupBudget(
                  group.id,
                  mergePlan,
                  budgetMap,
                )?.amountUsd;
                if (groupBudget != null && groupBudget > 0) {
                  const pct = (spend / groupBudget) * 100;
                  if (pct >= 50) over50++;
                  if (pct >= 75) over75++;
                  if (pct >= 90) over90++;
                  if (pct >= 100) over100++;
                }
              }
            }
            for (const [teamName, spend] of teamAttributedSpend) {
              const budget = teamBudgetAmountMap.get(teamName);
              if (budget != null && budget > 0) {
                const pct = (spend / budget) * 100;
                if (pct >= 50) over50++;
                if (pct >= 75) over75++;
                if (pct >= 90) over90++;
                if (pct >= 100) over100++;
              }
            }

            // Compute totalBudgetUsd and totalRemainingUsd using the same top-level pool model as
            // tableTotals: one budget entry per team pool, plus each unassigned group's own budget.
            // Remaining subtracts only the attributed spend from budgeted pools so it reconciles
            // with the table footer (unattributed / unbudgeted spend does not reduce remaining).
            const seenTeams = new Set<string>();
            let budgetedPoolSpend = 0;
            totalBudgetUsd = 0; // override outer default; set correctly below
            for (const group of displayGroups) {
              const teamName = groupTeamMap.get(groupTeamKey(group));
              if (teamName) {
                if (!seenTeams.has(teamName)) {
                  seenTeams.add(teamName);
                  const budget = teamBudgetAmountMap.get(teamName);
                  if (budget != null && budget > 0) {
                    totalBudgetUsd += budget;
                    budgetedPoolSpend += teamAttributedSpend.get(teamName) ?? 0;
                  }
                }
              } else {
                const budget = resolveCanonicalMergedGroupBudget(
                  group.id,
                    mergePlan,
                  budgetMap,
                )?.amountUsd;
                if (budget != null && budget > 0) {
                  totalBudgetUsd += budget;
                  budgetedPoolSpend += spendByPrimaryGroup.get(group.id) ?? 0;
                }
              }
            }
            // Include every visible budget-only team in account-wide totals at zero spend.
            if (isAccount) {
              for (const [teamName, budget] of teamBudgetAmountMap) {
                if (
                  seenTeams.has(teamName) ||
                  budget <= 0
                ) continue;
                seenTeams.add(teamName);
                totalBudgetUsd += budget;
              }
            }
            totalRemainingUsd = totalBudgetUsd - budgetedPoolSpend;
        } catch (err) {
          req.log.error({ err }, "summary directory fetch failed");
        }

        const billing = getBillingPeriod();
        const pacePeriod = getBillingPeriodMetadata();
        const allAlerts = await db.select().from(alertsTable);
        const periodStart = billing.start ? new Date(billing.start) : null;
        const alertsSentThisPeriod = allAlerts.filter(
          (a) =>
            a.status === "sent" &&
            (a.entityType !== "team" || !hiddenSummaryTeamNames.has(a.entityId)) &&
            canSeeAlertEntity(authz, a, visibleGroupIds, visibleTeamNames) &&
            (!periodStart || a.sentAt >= periodStart),
        ).length;

        const selection = windowFromQuery(req.query as Record<string, unknown>);
        if (!snapshot) throw new Error("Usage snapshot unavailable");
        const syncStatus = snapshot?.status ?? "empty";
        res.json(
          GetSummaryResponse.parse({
            totalGroups,
            budgetedGroups,
            totalSpendUsd,
            memberBasedTotalSpendUsd,
            accountUsageTotalSpendUsd,
            accountUsageAttributableSpendUsd,
            accountUsageUnattributableSpendUsd,
            reconciliationSpendUsd,
            totalBudgetUsd,
            totalRemainingUsd,
            groupsOver50: over50,
            groupsOver75: over75,
            groupsOver90: over90,
            groupsOver100: over100,
            alertsSentThisPeriod,
            billingPeriodLabel: selection.label,
            reportingRangeStart: selection.window.start,
            reportingRangeEnd: selection.window.end,
            billingPeriodDiffersFromReportingCutoff:
              selectedRangeType === "billing" && pacePeriod.differsFromReportingCutoff,
            pacePeriodStart: pacePeriod.start,
            pacePeriodEnd: pacePeriod.end,
            pacePeriodLabel: pacePeriod.label,
            pacePeriodIsFallback: pacePeriod.isFallback,
            // Project usage has its own status and cannot hold dashboard
            // headline readiness open.
            isComplete:
              syncStatus === "complete" &&
              pending === 0 &&
              summaryExtraComplete &&
              (!isAccount || accountUsageTotalSpendUsd !== null),
            syncStatus, syncError: null, pendingCount: pending,
            failedCount: snapshot?.coverage.failedWorkspaceDays.length ?? 0,
            partialCount: snapshot?.coverage.missingWorkspaceDays.length ?? 0,
            projectSyncStatus: projectPending === 0 ? "complete" : "partial",
            projectSyncError: null, projectPendingCount: projectPending,
            projectFailedCount: 0, projectPartialCount: projectPending,
            directoryDataAsOf: getDirectoryFreshness().dataAsOf,
            directoryStale: getDirectoryFreshness().isStale,
            usageDataAsOf: snapshot?.dataAsOf ?? null,
            usageStale: snapshot?.status === "stale",
            usageHealth: usageHealth(snapshot, {
              accountReconciliationSpendUsd: reconciliationSpendUsd ?? 0,
            }, req.authz!),
          }),
        );
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    req.log.error({ err }, "summary handler failed or timed out");
    if (!res.headersSent) {
      res.status(503).json({ error: "Summary unavailable — please retry" });
    }
  }
});

// Account-wide roles see every team pool. Workspace admins get read-only pool
// values only for teams containing a group in one of their administered workspaces.
router.get("/teams/budgets", async (req, res): Promise<void> => {
  const snapshot = await getEffectiveTeamBudgets();
  const budgets = snapshot.teams.filter((team) => !team.isHidden);
  const [dir, assignments] = await Promise.all([
    getDirectory(),
    db.select().from(teamLimitTargetsTable),
  ]);
  const scopedGroups = visibleGroups(req.authz!, dir.groups);
  const visibleTeams = new Set(
    scopedGroups
      .map((group) => targetTeamForGroup(group, assignments))
      .filter((teamName): teamName is string => teamName != null),
  );
  for (const teamName of req.authz!.teamNames) visibleTeams.add(teamName);
  const allWorkspaceIdsByTeam = new Map<string, Set<string>>();
  for (const group of dir.groups) {
    const teamName = targetTeamForGroup(group, assignments);
    if (!teamName) continue;
    const ids = allWorkspaceIdsByTeam.get(teamName) ?? new Set<string>();
    ids.add(group.workspaceId);
    allWorkspaceIdsByTeam.set(teamName, ids);
  }
  const workspaceIdsByTeam = new Map<string, Set<string>>();
  for (const group of scopedGroups) {
    const teamName = targetTeamForGroup(group, assignments);
    if (!teamName) continue;
    const ids = workspaceIdsByTeam.get(teamName) ?? new Set<string>();
    ids.add(group.workspaceId);
    workspaceIdsByTeam.set(teamName, ids);
  }
  const visibleBudgets = isAccountWide(req.authz)
    ? budgets
    : budgets.filter((budget) => visibleTeams.has(budget.teamName));
  res.json(
    GetTeamsBudgetsResponse.parse({
      budgets: visibleBudgets.map((b) => ({
        teamName: b.teamName,
        amountUsd: b.effectiveAmountUsd,
        workspaceIds: [
          ...(isAccountWide(req.authz)
            ? allWorkspaceIdsByTeam.get(b.teamName) ?? []
            : workspaceIdsByTeam.get(b.teamName) ?? []),
        ].sort(),
      })),
    }),
  );
});

function serializeTeamBudgetHistoryTeam(
  team: Awaited<ReturnType<typeof getEffectiveTeamBudgets>>["teams"][number],
  adjustments: Awaited<ReturnType<typeof getEffectiveTeamBudgets>>["adjustments"],
) {
  return {
    teamName: team.teamName,
    originalAmountUsd: team.originalAmountUsd,
    effectiveAmountUsd: team.effectiveAmountUsd,
    annualAllocationUsd: team.annualAllocationUsd,
    monthlyLimitUsd: team.monthlyLimitUsd,
    monthlyLimitSource: team.monthlyLimitSource,
    isHidden: team.isHidden,
    adjustments: adjustments
      .filter((adjustment) =>
        adjustment.teamName === team.teamName &&
        adjustment.matchState === "accepted"
      )
      .map((adjustment) => ({
        recordId: adjustment.sourceRecordId,
        amountUsd: adjustment.amountUsd!,
        submissionPeriod: adjustment.submissionPeriod!,
      })),
  };
}

router.get("/admin/team-budgets/history", requireRole("account"), async (req, res): Promise<void> => {
  const snapshot = await getEffectiveTeamBudgets();
  const visible = req.authz!.isTrueAccountAdmin
    ? snapshot.teams
    : snapshot.teams.filter((team) => !team.isHidden);
  res.json(GetTeamBudgetHistoryResponse.parse({
    teams: visible.map((team) =>
      serializeTeamBudgetHistoryTeam(team, snapshot.adjustments)
    ),
    issues: snapshot.adjustments
      .filter((adjustment) => adjustment.matchState !== "accepted")
      .map((adjustment) => ({
        recordId: adjustment.sourceRecordId,
        sourceTeamName: adjustment.sourceTeamName,
        matchState: adjustment.matchState,
        error: adjustment.errorMessage,
      })),
  }));
});

router.get(
  "/admin/team-budgets/audit",
  requireTrueAccountAdmin,
  async (_req, res): Promise<void> => {
    const changes = await getTeamAllocationAudits();
    res.json(GetTeamAllocationAuditResponse.parse({
      changes: changes.map((change) => ({
        id: change.id,
        teamName: change.teamName,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        actor: change.actorUserId,
        timestamp: change.createdAt,
      })),
    }));
  },
);

router.patch(
  "/admin/team-budgets/:teamName/allocation",
  requireTrueAccountAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateTeamAnnualAllocationParams.safeParse(req.params);
    const body = UpdateTeamAnnualAllocationBody.safeParse(req.body);
    const bodyKeys = req.body && typeof req.body === "object"
      ? Object.keys(req.body as Record<string, unknown>)
      : [];
    if (
      !params.success ||
      !body.success ||
      bodyKeys.length !== 1 ||
      bodyKeys[0] !== "annualAllocationUsd"
    ) {
      res.status(400).json({
        error: !params.success
          ? params.error.message
          : !body.success
            ? body.error.message
            : "Body must contain only annualAllocationUsd",
      });
      return;
    }
    const team = await updateTeamAnnualAllocation(
      params.data.teamName,
      body.data.annualAllocationUsd,
      req.user!.id,
    );
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const snapshot = await getEffectiveTeamBudgets();
    res.json(UpdateTeamAnnualAllocationResponse.parse(
      serializeTeamBudgetHistoryTeam(team, snapshot.adjustments),
    ));
  },
);

router.patch(
  "/admin/team-budgets/:teamName/visibility",
  requireTrueAccountAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateTeamVisibilityParams.safeParse(req.params);
    const body = UpdateTeamVisibilityBody.safeParse(req.body);
    const bodyKeys = req.body && typeof req.body === "object"
      ? Object.keys(req.body as Record<string, unknown>)
      : [];
    if (
      !params.success ||
      !body.success ||
      bodyKeys.length !== 1 ||
      bodyKeys[0] !== "isHidden"
    ) {
      res.status(400).json({
        error: !params.success
          ? params.error.message
          : !body.success
            ? body.error.message
            : "Body must contain only isHidden",
      });
      return;
    }
    const team = await updateTeamVisibility(
      params.data.teamName,
      body.data.isHidden,
      req.user!.id,
    );
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const snapshot = await getEffectiveTeamBudgets();
    res.json(UpdateTeamVisibilityResponse.parse(
      serializeTeamBudgetHistoryTeam(team, snapshot.adjustments),
    ));
  },
);

async function buildTeamBudgetSyncStatus() {
  const [{ sync }, teams] = await Promise.all([
    getEffectiveTeamBudgets(),
    getTeamBudgetUpstreamSyncRows(),
  ]);
  return {
    sourceTable: TEAM_BUDGET_SOURCE_TABLE,
    requiredApprovalStatus: TEAM_BUDGET_REQUIRED_APPROVAL_STATUS,
    lastAttemptAt: sync?.lastAttemptAt?.toISOString() ?? null,
    lastSuccessfulAt: sync?.lastSuccessfulAt?.toISOString() ?? null,
    lastError: sync?.lastError ?? null,
    recordCount: sync?.recordCount ?? 0,
    acceptedCount: sync?.acceptedCount ?? 0,
    issueCount: sync?.issueCount ?? 0,
    teams: teams.map((team) => ({
      teamName: team.teamName,
      workspaceId: team.workspaceId,
      targetGroupId: team.targetGroupId,
      targetGroupName: team.targetGroupName,
      targetType: team.targetType,
      desiredAmountUsd: team.desiredAmountUsd,
      upstreamAmountUsd: team.upstreamAmountUsd,
      status: team.status,
      reason: team.reason,
      lastAttemptAt: team.lastAttemptAt?.toISOString() ?? null,
    })),
  };
}

router.get("/admin/team-budgets/sync", requireCapability("canWriteGroupLimits"), async (_req, res): Promise<void> => {
  res.json(GetTeamBudgetSyncStatusResponse.parse(await buildTeamBudgetSyncStatus()));
});

router.post(
  "/admin/team-budgets/reconcile",
  requireCapability("canWriteGroupLimits"),
  async (_req, res): Promise<void> => {
    await reconcileTeamBudgetsUpstream();
    res.json(
      RetryTeamBudgetUpstreamSyncResponse.parse(await buildTeamBudgetSyncStatus()),
    );
  },
);

router.patch(
  "/admin/team-budgets/:teamName/limit",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const params = UpdateTeamBudgetLimitParams.safeParse(req.params);
    const body = UpdateTeamBudgetLimitBody.safeParse(req.body);
    const bodyKeys = req.body && typeof req.body === "object"
      ? Object.keys(req.body as Record<string, unknown>)
      : [];
    if (
      !params.success ||
      !body.success ||
      bodyKeys.length !== 1 ||
      bodyKeys[0] !== "monthlyLimitUsd"
    ) {
      res.status(400).json({
        error: !params.success
          ? params.error.message
          : !body.success
            ? body.error.message
            : "Body must contain only monthlyLimitUsd",
      });
      return;
    }
    const team = await updateTeamMonthlyLimit(
      params.data.teamName,
      body.data.monthlyLimitUsd,
    );
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const snapshot = await getEffectiveTeamBudgets();
    res.json(UpdateTeamBudgetLimitResponse.parse(
      serializeTeamBudgetHistoryTeam(team, snapshot.adjustments),
    ));
  },
);

router.get(
  "/admin/team-budgets/targets",
  requireCapability("canWriteGroupLimits"),
  async (_req, res): Promise<void> => {
    const config = await getTeamLimitTargetConfiguration();
    res.json(GetTeamBudgetTargetsResponse.parse({
      ...config,
      unassignedGroups: config.unassignedGroups.map((group) => ({
        workspaceId: group.workspaceId,
        groupId: group.id,
        groupName: group.name,
      })),
    }));
  },
);

router.post(
  "/admin/team-budgets/targets",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const body = AssignTeamBudgetTargetBody.safeParse(req.body);
    if (!body.success || Object.keys(req.body ?? {}).length !== 3) {
      res.status(400).json({ error: body.success ? "Invalid assignment body" : body.error.message });
      return;
    }
    const [group, budget, existingTarget] = await Promise.all([
      getFreshEligibleTeamLimitGroup(body.data.workspaceId, body.data.groupId),
      db.select({ teamName: teamBudgetsTable.teamName }).from(teamBudgetsTable)
        .where(eq(teamBudgetsTable.teamName, body.data.teamName)),
      db.select({ groupId: teamLimitTargetsTable.groupId }).from(teamLimitTargetsTable)
        .where(eq(teamLimitTargetsTable.workspaceId, body.data.workspaceId)),
    ]);
    if (
      !group ||
      budget.length === 0 ||
      existingTarget.some((target) => target.groupId === body.data.groupId)
    ) {
      res.status(400).json({ error: "Target must be an unassigned nonlegacy member group and an existing team" });
      return;
    }
    await assignTeamLimitTarget({ ...body.data, groupName: group.name });
    const config = await getTeamLimitTargetConfiguration();
    const target = config.targets.find((row) =>
      row.workspaceId === body.data.workspaceId && row.groupId === body.data.groupId
    )!;
    res.json(AssignTeamBudgetTargetResponse.parse(target));
  },
);

router.patch(
  "/admin/team-budgets/targets/:workspaceId/:groupId",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const params = UpdateTeamBudgetTargetParams.safeParse(req.params);
    const body = UpdateTeamBudgetTargetBody.safeParse(req.body);
    if (!params.success || !body.success || Object.keys(req.body ?? {}).length !== 1) {
      res.status(400).json({ error: "Invalid target override" });
      return;
    }
    const updated = await updateTeamLimitTargetOverride(
      params.data.workspaceId,
      params.data.groupId,
      body.data.monthlyLimitUsd,
    );
    if (!updated) {
      res.status(404).json({ error: "Target not found" });
      return;
    }
    const config = await getTeamLimitTargetConfiguration();
    const target = config.targets.find((row) =>
      row.workspaceId === params.data.workspaceId && row.groupId === params.data.groupId
    )!;
    res.json(UpdateTeamBudgetTargetResponse.parse(target));
  },
);

router.patch(
  "/admin/team-budgets/legacy-limit",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const body = UpdateLegacyWorkspaceLimitBody.safeParse(req.body);
    if (!body.success || Object.keys(req.body ?? {}).length !== 1) {
      res.status(400).json({ error: body.success ? "Invalid legacy limit body" : body.error.message });
      return;
    }
    const updated = await updateLegacyWorkspaceLimit(body.data.monthlyLimitUsd);
    res.json(UpdateLegacyWorkspaceLimitResponse.parse(updated));
  },
);

router.post(
  "/admin/team-budgets/apply",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const body = ApplyTeamBudgetLimitsBody.safeParse(req.body);
    const keys = req.body && typeof req.body === "object"
      ? Object.keys(req.body as Record<string, unknown>)
      : [];
    const exactSelection =
      keys.length === 1 &&
      (
        (keys[0] === "teamNames" && Array.isArray(req.body.teamNames)) ||
        (keys[0] === "all" && req.body.all === true) ||
        (keys[0] === "targets" && Array.isArray(req.body.targets))
      );
    const exactTargets = !Array.isArray(req.body?.targets) ||
      req.body.targets.every((target: unknown) => {
        if (!target || typeof target !== "object") return false;
        const targetKeys = Object.keys(target as Record<string, unknown>);
        return targetKeys.length >= 1 &&
          targetKeys.length <= 2 &&
          targetKeys.every((key) => key === "workspaceId" || key === "groupId");
      });
    if (!body.success || !exactSelection || !exactTargets) {
      res.status(400).json({
        error: body.success
          ? 'Body must be exactly {"all":true} or {"teamNames":[...]}'
          : body.error.message,
      });
      return;
    }
    const selection = "teamNames" in body.data
      ? { teamNames: body.data.teamNames }
      : "targets" in body.data
        ? { targets: body.data.targets }
        : { all: true as const };
    res.json(ApplyTeamBudgetLimitsResponse.parse(
      await applyTeamBudgetLimits(selection),
    ));
  },
);

router.post("/admin/team-budgets/refresh", requireRole("account"), async (_req, res): Promise<void> => {
  const result = await refreshTeamBudgetSnapshot();
  res.status(result.ok ? 200 : 502).json(RefreshTeamBudgetsResponse.parse({
    sourceTable: TEAM_BUDGET_SOURCE_TABLE,
    requiredApprovalStatus: TEAM_BUDGET_REQUIRED_APPROVAL_STATUS,
    ...result,
  }));
});

router.get("/budgets", async (req, res): Promise<void> => {
  const authz = req.authz!;
  const budgets = await db.select().from(groupBudgetsTable);
  let visible = budgets;
  if (!isAccountWide(authz)) {
    // Scope budgets to the groups this workspace admin can see.
    try {
      const dir = await getDirectory();
      const allowedIds = new Set(visibleGroups(authz, dir.groups).map((g) => g.id));
      visible = budgets.filter((b) => allowedIds.has(b.groupId));
    } catch {
      // Fail closed: if scope can't be resolved, expose nothing.
      visible = [];
    }
  }
  res.json(
    ListBudgetsResponse.parse(
      visible.map((b) => ({
        groupId: b.groupId,
        amountUsd: b.amountUsd,
        updatedAt: b.updatedAt.toISOString(),
      })),
    ),
  );
});

router.put("/groups/:groupId/budget", requireCapability("canWriteGroupLimits"), async (req, res): Promise<void> => {
  const groupId = String(req.params["groupId"]);
  const parsed = SetGroupBudgetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(groupBudgetsTable)
    .values({ groupId, amountUsd: parsed.data.amountUsd })
    .onConflictDoUpdate({
      target: groupBudgetsTable.groupId,
      set: { amountUsd: parsed.data.amountUsd, updatedAt: new Date() },
    })
    .returning();
  if (!row) {
    res.status(400).json({ error: "Failed to save budget" });
    return;
  }
  res.json(
    SetGroupBudgetResponse.parse({
      groupId: row.groupId,
      amountUsd: row.amountUsd,
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

router.delete("/groups/:groupId/budget", requireCapability("canWriteGroupLimits"), async (req, res): Promise<void> => {
  const groupId = String(req.params["groupId"]);
  const deleted = await db
    .delete(groupBudgetsTable)
    .where(eq(groupBudgetsTable.groupId, groupId))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "No budget configured for this group" });
    return;
  }
  res.json(DeleteGroupBudgetResponse.parse({ ok: true }));
});

router.get("/workspace-admins", requireRole("account"), async (_req, res): Promise<void> => {
  const [rows, groupTeams] = await Promise.all([
    db.select({ directoryJson: apiDirectoryCacheTable.directoryJson }).from(apiDirectoryCacheTable),
    db.select().from(teamLimitTargetsTable),
  ]);

  if (!rows[0]) {
    res.json(ListWorkspaceAdminsResponse.parse([]));
    return;
  }

  const raw = rows[0].directoryJson as Record<string, unknown>;
  const rawWorkspaces = (raw["workspaces"] ?? {}) as Record<string, Record<string, unknown>>;
  const rawMembers = (raw["members"] ?? {}) as Record<string, Record<string, unknown>>;
  const rawGroupMembers = (raw["groupMembers"] ?? {}) as Record<string, string[]>;
  const rawGroups = (raw["groups"] ?? []) as Array<{
    id: string;
    name: string;
    type: string;
    workspaceId: string;
  }>;

  const BUILT_IN = new Set(["admin", "member", "guest"]);
  const result = rawGroups
    .filter((g) => !BUILT_IN.has(g.type.toLowerCase()))
    .map((g) => {
      // Resolve the actual members of this group from the directory's groupMembers map.
      const memberIds = rawGroupMembers[g.id] ?? [];
      const admins = memberIds.flatMap((userId) => {
        const m = rawMembers[userId] as Record<string, unknown> | undefined;
        if (!m) return [];
        return [{
          userId,
          username: m["username"] as string,
          email: (m["email"] as string | null) ?? null,
          name: (m["name"] as string | null) ?? null,
        }];
      });
      return {
        groupId: g.id,
        groupName: g.name,
        workspaceId: g.workspaceId,
        workspaceName: (rawWorkspaces[g.workspaceId]?.["name"] as string | undefined) ?? g.workspaceId,
        teamName: targetTeamForGroup(g, groupTeams) ?? null,
        admins,
      };
    })
    .sort((a, b) => a.groupName.localeCompare(b.groupName));

  res.json(ListWorkspaceAdminsResponse.parse(result));
});

// ---------------------------------------------------------------------------
// Project spend CSV export — all groups, one row per project
// ---------------------------------------------------------------------------
router.get("/projects/export", async (req, res): Promise<void> => {
  let selection: UsageWindowSelection;
  try {
    selection = windowFromQuery(req.query as Record<string, unknown>);
  } catch {
    selection = windowFromQuery({});
  }

  try {
    const [dir, groupTeams] = await Promise.all([
      getDirectory(),
      db.select().from(teamLimitTargetsTable),
    ]);

    const groups = visibleGroups(req.authz!, dir.groups);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const groupTeamMap = buildGroupTeamMap(groups, groupTeams);
    const scopedWorkspaceIds = workspaceScope(req.authz!, dir, groups);
    const [snapshot, projectMetadata] = await Promise.all([
      readUsageSnapshot({
        window: selection.window,
        workspaceIds: scopedWorkspaceIds,
      }),
      readProjectMetadata(scopedWorkspaceIds),
    ]);
    const rollup = computeSnapshotUsageRollup({
      snapshot,
      groups,
      membersByGroup: scopedMembers,
      projectInfoByWorkspace: projectMetadata.byWorkspace,
    });

    const workspaceIds = new Set(groups.map((g) => g.workspaceId));

    // Aggregate across all groups: one row per projectId.
    // Dedup strategy: keep the entry with the highest reported spend to avoid
    // double-counting when a project appears in multiple groups because its
    // creator belongs to more than one group.  Track every group that
    // reported the project for informational columns.
    const projectMap = new Map<string, {
      entry: { projectId: string; totalCostUsd: number; aiCostUsd: number };
      workspaceId: string;
      winnerGroupId: string;
      groupNames: Set<string>;
      groupIds: Set<string>;
    }>();

    for (const g of groups) {
      for (const [projectId, totals] of snapshot.projects.get(g.workspaceId) ?? []) {
        if (
          rollup.projectAttribution.projectToGroup.get(
            projectAttributionKey(g.workspaceId, projectId),
          ) !== g.id
        ) continue;
        const entry = { projectId, ...totals };
        const projectKey = projectAttributionKey(g.workspaceId, projectId);
        const existing = projectMap.get(projectKey);
        if (!existing) {
          projectMap.set(projectKey, {
            entry,
            workspaceId: g.workspaceId,
            winnerGroupId: g.id,
            groupNames: new Set([g.name]),
            groupIds: new Set([g.id]),
          });
        } else {
          existing.groupNames.add(g.name);
          existing.groupIds.add(g.id);
          if (
            entry.totalCostUsd > existing.entry.totalCostUsd ||
            (
              entry.totalCostUsd === existing.entry.totalCostUsd &&
              g.id.localeCompare(existing.winnerGroupId) < 0
            )
          ) {
            existing.entry = entry;
            existing.workspaceId = g.workspaceId;
            existing.winnerGroupId = g.id;
          }
        }
      }
    }

    // Build output rows
    type ExportRow = {
      projectId: string;
      title: string;
      workspaceName: string;
      ownerName: string;
      ownerUsername: string;
      teams: string;
      groups: string;
      aiUsd: number;
      hostingUsd: number;
      storageUsd: number;
      otherUsd: number;
      creatorIsCurrentMember: boolean;
      attributedGroup: string;
      attributedNonAiUsd: number;
      unattributedNonAiUsd: number;
      totalUsd: number;
    };

    const rows: ExportRow[] = [];

    const orderedGroups = [...groups].sort(
      (a, b) =>
        a.workspaceId.localeCompare(b.workspaceId) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
    for (const { entry, workspaceId, groupNames, groupIds } of projectMap.values()) {
      const info = projectMetadata.byWorkspace.get(workspaceId)?.get(entry.projectId);
      const creatorId = info?.creatorId ?? null;
      const member = creatorId ? dir.members.get(creatorId) : undefined;

      const groupArr = Array.from(groupNames).sort();
      const teamSet = new Set<string>();
      for (const groupId of groupIds) {
        const group = groups.find((candidate) => candidate.id === groupId);
        const t = group && groupTeamMap.get(groupTeamKey(group));
        if (t) teamSet.add(t);
      }

      const aiUsd = entry.aiCostUsd;
      const hostingUsd = 0;
      const storageUsd = 0;
      // totalCostUsd is authoritative even when the API omits or introduces a
      // metric category, so the non-AI breakdown always reconciles to it.
      const otherUsd = Math.max(0, entry.totalCostUsd - aiUsd - hostingUsd - storageUsd);
      const nonAiUsd = Math.max(0, entry.totalCostUsd - aiUsd);
      const creatorOwner = creatorId
        ? orderedGroups.find(
          (group) =>
            group.workspaceId === workspaceId &&
            (scopedMembers.get(group.id) ?? []).includes(creatorId),
        )
        : undefined;
      const creatorIsCurrentMember = creatorOwner !== undefined;
      // This is the canonical stable member owner, not necessarily the
      // highest-total project observation's winning group.
      const attributedGroup = creatorOwner?.name ?? "";
      const attributedNonAiUsd = creatorOwner ? nonAiUsd : 0;
      const unattributedNonAiUsd = creatorOwner ? 0 : nonAiUsd;

      rows.push({
        projectId: entry.projectId,
        title: info?.title ?? "",
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? workspaceId,
        ownerName: member?.name ?? "",
        ownerUsername: member?.username ?? "",
        teams: Array.from(teamSet).sort().join("; "),
        groups: groupArr.join("; "),
        aiUsd,
        hostingUsd,
        storageUsd,
        otherUsd,
        creatorIsCurrentMember,
        attributedGroup,
        attributedNonAiUsd,
        unattributedNonAiUsd,
        totalUsd: entry.totalCostUsd,
      });
    }

    rows.sort((a, b) => b.totalUsd - a.totalUsd);

    // Emit CSV
    const fmt = (n: number) => n.toFixed(4);

    const header = [
      "Project Title",
      "Project ID",
      "Workspace",
      "Owner Name",
      "Owner Username",
      "Creator Is Current Member",
      "Attributed Group",
      "Team(s)",
      "Group(s)",
      "AI ($)",
      "Hosting ($)",
      "Storage ($)",
      "Other ($)",
      "Attributed Non-AI ($)",
      "Unattributed Non-AI Residual ($)",
      "Total ($)",
    ];

    const lines: string[] = [header.map(escapeCsvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          escapeCsvCell(r.title),
          escapeCsvCell(r.projectId),
          escapeCsvCell(r.workspaceName),
          escapeCsvCell(r.ownerName),
          escapeCsvCell(r.ownerUsername),
          escapeCsvCell(r.creatorIsCurrentMember ? "Yes" : "No"),
          escapeCsvCell(r.attributedGroup),
          escapeCsvCell(r.teams),
          escapeCsvCell(r.groups),
          fmt(r.aiUsd),
          fmt(r.hostingUsd),
          fmt(r.storageUsd),
          fmt(r.otherUsd),
          fmt(r.attributedNonAiUsd),
          fmt(r.unattributedNonAiUsd),
          fmt(r.totalUsd),
        ].join(","),
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const filename = `project-spend-${today}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(lines.join("\r\n"));
  } catch (err) {
    req.log.error({ err }, "projectsExport failed");
    res.status(503).json({ error: "Failed to generate export" });
  }
});

// Notification recipients are account-only data; workspace admins can neither
// view nor modify them.
router.get("/admins", requireRole("account"), async (_req, res): Promise<void> => {
  const admins = await db.select().from(adminEmailsTable).orderBy(adminEmailsTable.id);
  res.json(
    ListAdminsResponse.parse(
      admins.map((a) => ({
        id: a.id,
        email: a.email,
        createdAt: a.createdAt.toISOString(),
      })),
    ),
  );
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/admins", requireRole("account"), async (req, res): Promise<void> => {
  const parsed = AddAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  const existing = await db
    .select()
    .from(adminEmailsTable)
    .where(eq(adminEmailsTable.email, email));
  if (existing.length > 0) {
    res.status(400).json({ error: "This email is already on the list" });
    return;
  }
  const [row] = await db.insert(adminEmailsTable).values({ email }).returning();
  if (!row) {
    res.status(400).json({ error: "Failed to add email" });
    return;
  }
  res.status(201).json(
    AddAdminResponse.parse({
      id: row.id,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

router.delete("/admins/:adminId", requireRole("account"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params["adminId"])
    ? req.params["adminId"][0]
    : req.params["adminId"];
  const id = parseInt(String(raw), 10);
  if (Number.isNaN(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const deleted = await db
    .delete(adminEmailsTable)
    .where(eq(adminEmailsTable.id, id))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(DeleteAdminResponse.parse({ ok: true }));
});

router.get("/app-admins", requireCapability("canManageAccess"), async (_req, res): Promise<void> => {
  const editors = await db
    .select()
    .from(appAdminsTable)
    .orderBy(appAdminsTable.createdAt);
  res.json(
    ListAppAdminsResponse.parse(
      editors.map((editor) => ({
        userId: editor.userId,
        email: editor.email,
        createdBy: editor.createdBy,
        createdAt: editor.createdAt.toISOString(),
      })),
    ),
  );
});

router.post("/app-admins", requireCapability("canManageAccess"), async (req, res): Promise<void> => {
  const parsed = AddAppAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = parsed.data.userId.trim();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "This Replit user has not signed in to the app" });
    return;
  }
  const [row] = await db
    .insert(appAdminsTable)
    .values({
      userId,
      email: user.email ?? "",
      createdBy: req.user!.id,
    })
    .onConflictDoNothing({ target: appAdminsTable.userId })
    .returning();
  if (!row) {
    res.status(400).json({ error: "This user is already an editor" });
    return;
  }
  res.status(201).json(
    AddAppAdminResponse.parse({
      userId: row.userId,
      email: row.email,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

router.delete("/app-admins/:userId", requireCapability("canManageAccess"), async (req, res): Promise<void> => {
  const userId = decodeURIComponent(String(req.params["userId"]));
  const deleted = await db
    .delete(appAdminsTable)
    .where(eq(appAdminsTable.userId, userId))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(DeleteAppAdminResponse.parse({ ok: true }));
});

router.get("/alerts", async (req, res): Promise<void> => {
  const authz = req.authz!;
  const accountWide = isAccountWide(authz);
  const canSeeRecipients = authz.capabilities.canManageAccess;
  const parsed = ListAlertsQueryParams.safeParse(req.query);
  const limit = parsed.success && parsed.data.limit ? parsed.data.limit : 100;
  let allowedIds = new Set<string>();
  let visibleAlertTeamNames = new Set<string>();
  let currentByEntity = new Map<string, CurrentAlertUsage>();
  let hiddenAlertTeamNames = new Set<string>();
  try {
    const dir = await getDirectory();
    const scoped = visibleGroups(authz, dir.groups);
    allowedIds = new Set(scoped.map((g) => g.id));
    const [groupTeams, groupBudgets, effectiveAlertTeamBudgets, allAlertTeamBudgetRows] = await Promise.all([
      db.select().from(teamLimitTargetsTable),
      db.select().from(groupBudgetsTable),
      getVisibleEffectiveTeamBudgetMap(),
      db.select().from(teamBudgetsTable),
    ]);
    const teamBudgets = allAlertTeamBudgetRows.filter((row) => !row.isHidden);
    hiddenAlertTeamNames = new Set(allAlertTeamBudgetRows.filter((row) => row.isHidden).map((row) => row.teamName));
    const teamByGroupName = buildGroupTeamMap(
      scoped,
      groupTeams,
      hiddenAlertTeamNames,
    );
    visibleAlertTeamNames = new Set(teamByGroupName.values());
    const groupBudgetById = new Map(groupBudgets.map((row) => [row.groupId, row.amountUsd]));
    const teamBudgetByName = effectiveAlertTeamBudgets;
    const usage = await usageForRequest(authz, dir, { rangeType: "billing" });
    const canonical = usage.rollup;
    const mergePlan = buildCanonicalGroupMergePlan(
      scoped,
      dir.workspaces,
      teamByGroupName,
    );
    const displayGroups = scoped.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
    const byTeam = new Map<string, number>();
    for (const group of displayGroups) {
      const budget = resolveCanonicalMergedGroupBudget(
        group.id,
        mergePlan,
        groupBudgetById,
      )?.amountUsd;
      const spend = (mergePlan.mergeMap.get(group.id) ?? [group.id]).reduce(
        (sum, id) => sum + (canonical.byGroup.get(id)?.spendUsd ?? 0), 0);
      const team = teamByGroupName.get(groupTeamKey(group));
      if (team) byTeam.set(team, (byTeam.get(team) ?? 0) + spend);
      currentByEntity.set(`group|${group.id}`, {
        spendUsd: canonical.isComplete ? spend : null,
        percentUsed: canonical.isComplete && budget != null && budget > 0
          ? (spend / budget) * 100
          : null,
        isComplete: canonical.isComplete,
      });
    }
    for (const [teamName, spend] of byTeam) {
      const budget = teamBudgetByName.get(teamName);
      currentByEntity.set(`team|${teamName}`, {
        spendUsd: canonical.isComplete ? spend : null,
        percentUsed: canonical.isComplete && budget != null && budget > 0
          ? (spend / budget) * 100
          : null,
        isComplete: canonical.isComplete,
      });
    }
  } catch {
    if (!accountWide) {
      // Fail closed: expose no alert history if workspace scope can't be resolved.
      res.json(ListAlertsResponse.parse([]));
      return;
    }
  }
  const allAlerts = await db
    .select()
    .from(alertsTable)
    .orderBy(desc(alertsTable.sentAt));
  const scoped = allAlerts
    .filter((a) =>
      (a.entityType !== "team" || !hiddenAlertTeamNames.has(a.entityId)) &&
      canSeeAlertEntity(authz, a, allowedIds, visibleAlertTeamNames)
    )
    .slice(0, limit)
    .map((a) => {
      const entityId = a.entityId || a.groupId;
      const alert = alertToJson(a, currentByEntity.get(`${a.entityType}|${entityId}`));
      return canSeeRecipients ? alert : { ...alert, recipients: [] };
    });
  res.json(ListAlertsResponse.parse(scoped));
});

router.post("/alerts/check", requireRole("account"), async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  try {
    const result = await runCheck();
    res.json(
      RunAlertCheckResponse.parse({
        checkedGroups: result.checkedGroups,
        checkedTeams: result.checkedTeams,
        alertsSent: result.alerts.filter((a) => a.status === "sent").length,
        alerts: result.alerts.map((alert) => alertToJson(alert)),
        evaluatedAt: result.evaluatedAt?.toISOString() ?? null,
        dataAsOf: result.dataAsOf?.toISOString() ?? null,
        skipped: result.skipped,
        skipReason: result.skipReason,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "manual check failed");
    res.status(503).json({ error: getApiHealth().error ?? "Check failed" });
  }
});

router.post(
  "/alerts/:alertId/test",
  requireCapability("canManageAccess"),
  async (req, res): Promise<void> => {
    const alertId = Number(req.params["alertId"]);
    if (!Number.isInteger(alertId) || alertId <= 0) {
      res.status(404).json({ error: "Email activity not found" });
      return;
    }
    const [source] = await db
      .select()
      .from(alertsTable)
      .where(eq(alertsTable.id, alertId))
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "Email activity not found" });
      return;
    }

    const { subject, html } = buildAlertEmail({
      entityType: source.entityType === "team" ? "team" : "group",
      entityName: source.entityName || source.groupName,
      entityId: source.entityId || source.groupId,
      groupName: source.groupName,
      workspaceName: null,
      threshold: source.threshold,
      spendUsd: source.spendUsd,
      budgetUsd: source.budgetUsd,
      billingPeriodLabel: getBillingPeriod().label,
      dataAsOf: source.dataAsOf,
      testDeliveryLabel: "Email activity copy",
    });
    const testSubject = `[TEST] ${subject}`;
    const result = await sendTestEmail(
      testSubject,
      html,
    );
    res.json(SendTestAlertResponse.parse({
      ok: result.ok,
       recipient: getEmailTestRecipient(),
      subject: testSubject,
      error: result.error ?? null,
      messageId: result.messageId ?? null,
      senderEmail: result.senderEmail ?? null,
    }));
  },
);

router.post(
  "/alerts/test-email",
  requireCapability("canManageAccess"),
  async (req, res): Promise<void> => {
    const selection = SendEmailTestExampleBody.safeParse(req.body);
    const allowedKeys = new Set(["entityType", "threshold"]);
    const hasUnknownInput =
      !req.body ||
      typeof req.body !== "object" ||
      Object.keys(req.body).some((key) => !allowedKeys.has(key));
    if (!selection.success || hasUnknownInput) {
      res.status(400).json({ error: "Choose a supported group or team threshold example" });
      return;
    }
    const { entityType, threshold } = selection.data;
    const entityName = entityType === "group" ? "Engineering" : "Platform Team";
    const entityId = entityType === "group" ? "example-engineering" : "Platform Team";
    const budgetUsd = 10_000;
    const spendUsd = threshold === 100 ? 10_250 : budgetUsd * (threshold / 100);
    const { subject, html } = buildAlertEmail({
      entityType,
      entityName,
      entityId,
      groupName: entityName,
      workspaceName: entityType === "group" ? "Example Workspace" : null,
      threshold,
      spendUsd,
      budgetUsd,
      billingPeriodLabel: getBillingPeriod().label,
      dataAsOf: new Date(),
      testDeliveryLabel: `Predefined ${entityType} example`,
    });
    const testSubject = `[TEST] ${subject}`;
    const result = await sendTestEmail(
      testSubject,
      html,
    );
    res.json(SendEmailTestExampleResponse.parse({
      ok: result.ok,
       recipient: getEmailTestRecipient(),
      subject: testSubject,
      error: result.error ?? null,
      messageId: result.messageId ?? null,
      senderEmail: result.senderEmail ?? null,
    }));
  },
);

// System status is account-only configuration; not exposed to workspace admins.
router.get("/status", requireRole("account"), async (_req, res): Promise<void> => {
  const health = getApiHealth();
  const emailConfigured = await isEmailConfigured();
  const billingPeriod = getBillingPeriodMetadata();
  const reportingRange = windowFromQuery({ rangeType: "billing" });
  const checker = getCheckerState();
  const directory = getDirectoryFreshness();
  const [runsResult, backfillResult, reconciliationResult] = await Promise.all([
    pool.query(`select id,kind,started_at,finished_at,units,calls,failures,error
      from ingest_run order by started_at desc limit 20`),
    pool.query(`with dates as (
        select d::date usage_date
        from generate_series($1::date, current_date - 3, interval '1 day') d
      ), expected as (
        select w.workspace_id,d.usage_date
        from (select distinct workspace_id from usage_workspace_day) w
        cross join dates d
      ), workspace_missing as (
        select count(*)::int remaining from expected e
        left join usage_workspace_day u using (workspace_id,usage_date)
        where u.status is distinct from 'complete'
      ), account_missing as (
        select count(*)::int remaining from dates d
        left join usage_account_day a using (usage_date)
        where a.usage_date is null
      )
      select workspace_missing.remaining + account_missing.remaining as remaining
      from workspace_missing,account_missing`, [USAGE_DATA_CUTOFF_ISO.slice(0, 10)]),
    pool.query(`select month_start::text,scope,scope_id,upstream_usd,stored_usd,
        delta_usd,checked_at
      from ingest_reconciliation
      where month_start=date_trunc('month',current_date)::date
      order by scope,scope_id`),
  ]);
  const recentRuns = runsResult.rows.map((row) => ({
    id: Number(row.id), kind: String(row.kind),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    units: Number(row.units), calls: Number(row.calls), failures: Number(row.failures),
    error: row.error == null ? null : String(row.error),
    status: !row.finished_at ? "running" : row.error ? "failed"
      : Number(row.failures) > 0 ? "partial" : "succeeded",
  }));
  res.json(GetStatusResponse.parse({
      enterpriseApiConfigured: isConfigured(),
      enterpriseApiOk: health.ok,
      enterpriseApiError: health.error,
      emailConfigured,
      checkerIntervalMinutes: BACKGROUND_CYCLE_INTERVAL_MINUTES,
      lastCheckAt: getLastCheckAt()?.toISOString() ?? null,
      lastSuccessfulEvaluationAt: checker.lastSuccessfulEvaluationAt?.toISOString() ?? null,
      lastEvaluatedDataAsOf: checker.lastEvaluatedDataAsOf?.toISOString() ?? null,
      lastCheckerAttemptAt: checker.lastAttemptAt?.toISOString() ?? null,
      lastCheckerSkipReason: checker.lastSkipReason,
      billingPeriodStart: billingPeriod.start,
      billingPeriodEnd: billingPeriod.end,
      billingPeriodLabel: billingPeriod.label,
      billingPeriodFetchedAt: billingPeriod.fetchedAt,
      billingPeriodFresh: billingPeriod.isFresh,
      billingPeriodFallback: billingPeriod.isFallback,
      billingPeriodDiffersFromReportingCutoff: billingPeriod.differsFromReportingCutoff,
      reportingCutoff: USAGE_DATA_CUTOFF_ISO,
      reportingRangeStart: reportingRange.window.start,
      reportingRangeEnd: reportingRange.window.end,
      reportingRangeLabel: reportingRange.label,
      recentRuns,
      remainingBackfillCount: Number(backfillResult.rows[0]?.remaining ?? 0),
      currentMonthReconciliation: reconciliationResult.rows.map((row) => ({
        monthStart: String(row.month_start), scope: String(row.scope),
        scopeId: String(row.scope_id), upstreamUsd: Number(row.upstream_usd),
        storedUsd: Number(row.stored_usd), deltaUsd: Number(row.delta_usd),
        checkedAt: new Date(row.checked_at).toISOString(),
      })),
      directoryDataAsOf: directory.dataAsOf,
      directoryAgeMs: directory.dataAsOf
        ? Math.max(0, Date.now() - Date.parse(directory.dataAsOf))
        : null,
      rateLimitTelemetry: {
        peakRequestsPerMinute: recentRuns[0]?.calls ?? 0,
        lowestRateLimitRemaining: null,
      },
    }));
});

router.get(
  "/usage/account-observation/export",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const parsed = GetAccountUsageObservationExportQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "A valid billingPeriodStart date is required" });
      return;
    }
    const result = await pool.query(
      `select billing_period_start::text,total_cost_usd,interval_start,interval_end,
              fetched_at,source_status
       from usage_account_observation
       where billing_period_start=$1::date`,
      [parsed.data.billingPeriodStart],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({
        error: "No scheduler-owned account usage observation exists for this billing period",
      });
      return;
    }
    const payload = GetAccountUsageObservationExportResponse.parse({
      billingPeriodStart: String(row.billing_period_start),
      totalCostUsd: row.total_cost_usd == null ? null : Number(row.total_cost_usd),
      upstreamInterval: {
        startTime: new Date(row.interval_start).toISOString(),
        endTime: new Date(row.interval_end).toISOString(),
      },
      fetchedAt: new Date(row.fetched_at).toISOString(),
      sourceStatus: String(row.source_status),
    });
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="account-usage-observation-${payload.billingPeriodStart}.json"`,
    );
    res.json(payload);
  },
);

router.post(
  "/admin/usage/ingest/cycle",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    try {
      res.json(await runCycle());
    } catch (error) {
      req.log.error({ err: error }, "manual usage ingest cycle failed");
      res.status(503).json({ error: error instanceof Error ? error.message : "Usage ingest failed" });
    }
  },
);

router.get(
  "/admin/usage/ingest/runs/recent",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const rawLimit = Number(req.query["limit"] ?? 20);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
    const result = await pool.query(
      `select id,kind,started_at,finished_at,units,calls,failures,error
       from ingest_run order by started_at desc limit $1`,
      [limit],
    );
    res.json(result.rows.map((row) => ({
      id: Number(row.id), kind: String(row.kind),
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      units: Number(row.units), calls: Number(row.calls), failures: Number(row.failures),
      error: row.error == null ? null : String(row.error),
      status: !row.finished_at ? "running" : row.error ? "failed"
        : Number(row.failures) > 0 ? "partial" : "succeeded",
    })));
  },
);

// ---------- Trends: bucketed spend over time ----------

router.get("/trends", async (req, res): Promise<void> => {
  const normalizeArrayQuery = (value: unknown): unknown[] | undefined =>
    value == null ? undefined : Array.isArray(value) ? value : [value];
  const parsed = GetTrendsQueryParams.safeParse({
    ...req.query,
    teamNames: normalizeArrayQuery(req.query["teamNames"]),
    groupIds: normalizeArrayQuery(req.query["groupIds"]),
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { granularity, teamNames, groupIds } = parsed.data;
  let selectedRange: UsageWindowSelection;
  try {
    selectedRange = windowFromQuery(parsed.data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const buckets = generateTrendBuckets({
    params: { startTime: selectedRange.window.start, endTime: selectedRange.window.end },
  } as unknown as Parameters<typeof generateTrendBuckets>[0], granularity);

  try {
    const dir = await getDirectory();
    const visible = visibleGroups(req.authz!, dir.groups);
    const groupTeams = await db.select().from(teamLimitTargetsTable);
    const teamNameMap = buildGroupTeamMap(visible, groupTeams);
    const requestedTeams = teamNames ? new Set(teamNames) : null;
    const requestedGroups = groupIds ? new Set(groupIds) : null;
    const mergePlan = buildCanonicalGroupMergePlan(
      visible,
      dir.workspaces,
      teamNameMap,
    );
    const displayGroups = visible.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
    const groups = displayGroups.filter((group) => {
      const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
      if (requestedGroups && !sourceIds.some((id) => requestedGroups.has(id))) return false;
      const teamName = targetTeamForGroup(group, groupTeams) ?? null;
      return !requestedTeams || (teamName !== null && requestedTeams.has(teamName));
    });

    const scopedWorkspaceIds = workspaceScope(req.authz!, dir, visible);
    const rosterHistory = await getRosterHistory(
      visible.map((group) => group.id),
      buckets[0]!.startDate,
      buckets.at(-1)!.endDate,
    );
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const currentUtcDay = new Date().toISOString().slice(0, 10);
    const [snapshot, projectMetadata] = await Promise.all([
      readUsageSnapshot({
        window: selectedRange.window,
        workspaceIds: scopedWorkspaceIds,
        includeDailyMembers: true,
      }),
      readProjectMetadata(scopedWorkspaceIds),
    ]);
    const dailyRollups = computeHistoricalSnapshotUsageRollups({
      snapshot, groups: visible, currentUtcDay,
      currentMembersByGroup: scopedMembers,
      completedRosterDays: rosterHistory.completedDays,
      rosterMembersByDate: visibleRosterMembers(req.authz!, rosterHistory.membersByDate),
      projectInfoByWorkspace: projectMetadata.byWorkspace,
    });
    const fullRollup = computeSnapshotUsageRollup({
      snapshot, groups: visible, membersByGroup: scopedMembers,
      projectInfoByWorkspace: projectMetadata.byWorkspace,
    });

    interface TrendUsageResult {
      spendByPrimaryGroup: Map<string, number>;
      totalSpendUsd: number;
      isComplete: boolean;
    }

    const bucketResults = buckets.map((bucket): TrendUsageResult => {
      const spendByPrimaryGroup = new Map<string, number>();
      let totalSpendUsd = 0;
      let isComplete = true;
      for (const [usageDate, result] of dailyRollups) {
        if (usageDate < bucket.startDate || usageDate > bucket.endDate) continue;
        isComplete &&= result.isComplete;
        totalSpendUsd += result.totalSpendUsd;
        for (const group of displayGroups) {
          const spend = (mergePlan.mergeMap.get(group.id) ?? [group.id]).reduce(
            (sum, id) => sum + (result.byGroup.get(id)?.spendUsd ?? 0), 0);
          spendByPrimaryGroup.set(group.id, (spendByPrimaryGroup.get(group.id) ?? 0) + spend);
        }
      }
      return { spendByPrimaryGroup, totalSpendUsd, isComplete };
    });
    const totalCount = bucketResults.length;
    const loadedCount = bucketResults.filter((result) => result.isComplete).length;

    const duplicateGroupNames = new Set(
      groups
        .filter((group, index) =>
          groups.findIndex((candidate) => candidate.name === group.name) !== index,
        )
        .map((group) => group.name),
    );
    const groupSeries = groups.map((group) => ({
      name: duplicateGroupNames.has(group.name)
        ? `${group.name} (${dir.workspaces.get(group.workspaceId)?.name ?? group.workspaceId})`
        : group.name,
      type: "group" as const,
      data: bucketResults.map((result) => {
        return result.spendByPrimaryGroup.get(group.id) ?? 0;
      }),
    }));

    const teams = new Map<string, typeof groups>();
    for (const group of groups) {
      const teamName = targetTeamForGroup(group, groupTeams);
      if (!teamName) continue;
      const teamGroups = teams.get(teamName) ?? [];
      teamGroups.push(group);
      teams.set(teamName, teamGroups);
    }
    const teamSeries = [...teams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, teamGroups]) => ({
        name,
        type: "team" as const,
        data: bucketResults.map((result) => {
          return teamGroups.reduce(
                (sum, group) => sum + (result.spendByPrimaryGroup.get(group.id) ?? 0),
                0);
        }),
      }));

    const totals = bucketResults.map((result) => {
      return groups.reduce(
        (sum, group) => sum + (result.spendByPrimaryGroup.get(group.id) ?? 0),
        0,
      );
    });

    res.json(
      GetTrendsResponse.parse({
        buckets: buckets.map((bucket) => bucket.startDate),
        bucketRanges: buckets.map((bucket) => ({
          start: bucket.startDate,
          end: bucket.endDate,
          isPartial: bucket.isPartial,
        })),
        totals,
        series: [...teamSeries, ...groupSeries],
        isComplete: loadedCount === totalCount,
        loadedCount,
        totalCount,
        usageHealth: usageHealth(snapshot, fullRollup, req.authz!),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getTrends failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

// ── GET /export/users.csv ─────────────────────────────────────────────────────
// Returns one row per unique member of the explicitly requested group(s).
router.get("/export/users.csv", async (req, res): Promise<void> => {
  let selection: UsageWindowSelection;
  try {
    selection = windowFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  let dir: Awaited<ReturnType<typeof getDirectory>>;
  try {
    dir = await getDirectory();
  } catch (err) {
    req.log.error({ err }, "export directory fetch failed");
    res.status(503).json({ error: "Directory unavailable" });
    return;
  }

  const requestedIds = String(req.query["groupIds"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (requestedIds.length === 0) {
    res.status(400).json({ error: "At least one group ID is required" });
    return;
  }
  const uniqueRequestedIds = [...new Set(requestedIds)];
  const requestedGroups = uniqueRequestedIds.map((id) =>
    dir.groups.find((group) => group.id === id),
  );
  // Fail closed without revealing whether an unknown or inaccessible group exists.
  if (
    requestedGroups.some((group) => !group) ||
    requestedGroups.some((group) => group && !canSeeGroup(req.authz!, group))
  ) {
    res.status(404).json({ error: "No matching groups found" });
    return;
  }

  const visible = visibleGroups(req.authz!, dir.groups);
  const groupTeams = await db.select().from(teamLimitTargetsTable);
  const teamNameMap = buildGroupTeamMap(visible, groupTeams);
  const mergePlan = buildCanonicalGroupMergePlan(
    visible,
    dir.workspaces,
    teamNameMap,
  );
  const primaryIds = uniqueRequestedIds.map(
    (id) => mergePlan.primaryByGroupId.get(id) ?? id,
  );
  const exportGroupIds = [...new Set(
    primaryIds.flatMap((id) => mergePlan.mergeMap.get(id) ?? [id]),
  )];
  const exportGroupIdSet = new Set(exportGroupIds);
  const exportGroups = visible.filter((group) => exportGroupIdSet.has(group.id));

  const scopedWorkspaceIds = workspaceScope(req.authz!, dir, visible);
  const [snapshot, projectMetadata] = await Promise.all([
    readUsageSnapshot({
      window: selection.window,
      workspaceIds: scopedWorkspaceIds,
    }),
    readProjectMetadata(scopedWorkspaceIds),
  ]);
  const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
  const canonical = computeSnapshotUsageRollup({
    snapshot, groups: visible, membersByGroup: scopedMembers,
    projectInfoByWorkspace: projectMetadata.byWorkspace,
  });

  const sortedGroupsForCsv = [...exportGroups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const requestedMemberIds = new Set(
    sortedGroupsForCsv.flatMap((group) => scopedMembers.get(group.id) ?? []),
  );
  const userGroupAttr = canonicalUserAttribution(
    canonical,
    sortedGroupsForCsv,
    scopedMembers,
    teamNameMap,
  );
  const rows: { email: string; name: string; username: string; group: string; team: string; workspaces: string; aiSpendUsd: number; nonAiSpendUsd: number; spendUsd: number }[] = [];
  for (const userId of requestedMemberIds) {
    const member = dir.members.get(userId);
    if (!member) continue;
    const attr = userGroupAttr.get(userId);
    const memberGroups = sortedGroupsForCsv.filter((group) =>
      (scopedMembers.get(group.id) ?? []).includes(userId),
    );
    const workspaceNames = [...new Set(
      memberGroups.map((group) => dir.workspaces.get(group.workspaceId)?.name ?? group.workspaceId),
    )];
    const sumForUser = (byGroup: ReadonlyMap<string, ReadonlyMap<string, number>>) =>
      exportGroupIds.reduce((sum, id) => sum + (byGroup.get(id)?.get(userId) ?? 0), 0);
    rows.push({
      email: member.email,
      name: member.name ?? "",
      username: member.username,
      group: attr?.groupName ?? "",
      team: attr?.teamName ?? "",
      workspaces: workspaceNames.join("; "),
      aiSpendUsd: sumForUser(canonical.aiSpendByGroup),
      nonAiSpendUsd: sumForUser(canonical.nonAiSpendByGroup),
      spendUsd: exportGroupIds.reduce(
        (sum, id) => sum + (canonical.byGroup.get(id)?.byUser.get(userId) ?? 0), 0),
    });
  }

  // Sort by spend descending
  rows.sort((a, b) => b.spendUsd - a.spendUsd);

  // Build CSV
  const header = ["Email", "Name", "Username", "Workspace(s)", "Group", "Team", "AI Spend (USD)", "Hosting / Non-AI Spend (USD)", "Spend (USD)"].map(escapeCsvCell).join(",");
  const lines = rows.map((r) =>
    [r.email, r.name, r.username, r.workspaces, r.group, r.team, r.aiSpendUsd.toFixed(2), r.nonAiSpendUsd.toFixed(2), r.spendUsd.toFixed(2)].map(escapeCsvCell).join(","),
  );

  const isComplete = canonical.isComplete;
  const csv = [header, ...lines].join("\r\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${primaryIds.length === 1 ? "group-users" : "group-cluster-users"}-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.setHeader("X-Groups-Loaded", String(canonical.isComplete ? exportGroups.length : 0));
  res.setHeader("X-Groups-Total", String(exportGroups.length));
  res.setHeader("X-Export-Complete", String(isComplete));
  res.setHeader("X-Usage-Window", `${selection.window.start}/${selection.window.end}`);
  res.send(csv);
});

// ── GET /users/activity ───────────────────────────────────────────────────────
// Returns workspace members with canonical all-metric spend for the selected range.
// Each user-workspace pair is counted once and distinct workspaces are summed.
// The displayed group/team is the user's highest-spend group (primary cost center).
// NOTE: these per-user totals can exceed the deduped budget totals in /groups
// and /summary, which attribute shared users to a single group to avoid
// double-counting group budgets — different accounting views by design.
// Scoped to the caller's visible groups: account admins see all members;
// workspace admins see only members in their visible groups. Responds
// immediately with cached data; isComplete=false while usage is still loading.
router.get("/users/activity", async (req, res): Promise<void> => {
  let selection: UsageWindowSelection;
  try {
    selection = windowFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  let dir: Awaited<ReturnType<typeof getDirectory>>;
  try {
    dir = await getDirectory();
  } catch (err) {
    req.log.error({ err }, "users/activity directory fetch failed");
    res.status(503).json({ error: "Directory unavailable" });
    return;
  }

  // Scope groups to what the caller can see, then apply deterministic ordering
  // (matches the orderGroups() logic in usage-rollup.ts)
  const scopedGroups = visibleGroups(req.authz!, dir.groups);
  const orderedGroups = [...scopedGroups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );

  const groupTeams = await db.select().from(teamLimitTargetsTable);
  const teamNameMap = buildGroupTeamMap(orderedGroups, groupTeams);

  const callerIsAccountAdmin = isAccountWide(req.authz);
  const groupedWorkspaceIds = orderedGroups.map((group) => group.workspaceId);
  const scopedWorkspaceIds = callerIsAccountAdmin
    ? new Set([...dir.workspaces.keys(), ...groupedWorkspaceIds])
    : new Set([...req.authz!.workspaceIds, ...groupedWorkspaceIds]);
  const activityScope = scopeFor(req.authz!);
  const visibleUserIds = "kind" in activityScope
    ? new Set(dir.members.keys())
    : activityScope.userIds;

  const [snapshot, projectMetadata] = await Promise.all([
    readUsageSnapshot({
      window: selection.window,
      workspaceIds: scopedWorkspaceIds,
    }),
    readProjectMetadata(scopedWorkspaceIds),
  ]);
  const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
  const canonical = computeSnapshotUsageRollup({
    snapshot,
    groups: orderedGroups,
    membersByGroup: scopedMembers,
    projectInfoByWorkspace: projectMetadata.byWorkspace,
  });
  const userGroupAttr = canonicalUserAttribution(
    canonical,
    orderedGroups,
    scopedMembers,
    teamNameMap,
  );

  // Pass 2: emit one entry per relevant member.
  // Workspace admins see only members in their visible groups.
  const users: {
    userId: string;
    username: string;
    email: string;
    teamName: string;
    groupName: string;
    spendUsd: number;
    aiSpendUsd: number;
    nonAiSpendUsd: number;
    workspaceRole: string;
  }[] = [];

  for (const [userId, m] of dir.members) {
    if (!callerIsAccountAdmin && !visibleUserIds.has(userId)) continue;

    const attr = userGroupAttr.get(userId);
    let workspaceRole = "member";
    if (m.isAccountAdmin) {
      workspaceRole = "account_admin";
    } else if (attr) {
      const ws = m.workspaces.get(attr.workspaceId);
      if (ws) workspaceRole = ws.role;
    } else {
      const first = m.workspaces.values().next().value;
      if (first) workspaceRole = (first as { role: string }).role;
    }

    users.push({
      userId,
      username: m.username,
      email: m.email,
      teamName: attr?.teamName ?? "",
      groupName: attr?.groupName ?? "",
      spendUsd: canonical.byUser.get(userId) ?? 0,
      aiSpendUsd: canonical.aiSpendByUser.get(userId) ?? 0,
      nonAiSpendUsd: canonical.nonAiSpendByUser.get(userId) ?? 0,
      workspaceRole,
    });
  }

  // Sort spend descending
  users.sort((a, b) => b.spendUsd - a.spendUsd);

  const totalCount = scopedWorkspaceIds.size;
  res.json(GetUserActivityResponse.parse({
    usageHealth: usageHealth(snapshot, canonical, req.authz!),
    isComplete: canonical.isComplete,
    loadedCount: Math.max(0, totalCount - canonical.pendingCount),
    totalCount,
    users,
  }));
});

// ---------- Directory members ----------

router.get("/directory/workspaces", async (req, res): Promise<void> => {
  try {
    const dir = await getDirectory();
    const allowed = isAccountWide(req.authz)
      ? null
      : new Set(req.authz!.workspaceIds);
    const workspaces = [...dir.workspaces.values()]
      .filter((workspace) => !allowed || allowed.has(workspace.id))
      .map((workspace) => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        memberCount: [...dir.members.values()].filter((member) =>
          member.workspaces.has(workspace.id),
        ).length,
      }))
      .sort((a, b) =>
        a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: "base" }) ||
        a.workspaceId.localeCompare(b.workspaceId),
      );
    res.json(ListVisibleWorkspacesResponse.parse(workspaces));
  } catch (err) {
    req.log.error({ err }, "listVisibleWorkspaces failed");
    res.status(503).json({ error: "Directory unavailable" });
  }
});

router.get(
  "/directory/workspaces/:workspaceId/members",
  async (req, res): Promise<void> => {
    try {
      const workspaceId = String(req.params["workspaceId"]);
      const dir = await getDirectory();
      const workspace = dir.workspaces.get(workspaceId);
      const authzScope = scopeFor(req.authz!);
      const hasScopedGroupInWorkspace =
        !("kind" in authzScope) &&
        dir.groups.some(
          (group) =>
            group.workspaceId === workspaceId &&
            authzScope.groupIds.has(group.id),
        );
      if (
        !workspace ||
        (!("kind" in authzScope) &&
          !authzScope.workspaceIds.has(workspaceId) &&
          !hasScopedGroupInWorkspace)
      ) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      const snapshot = await listReplitMemberBudgets(workspaceId);
      const selection = windowFromQuery({ rangeType: "billing" });
      const usage = await readUsageSnapshot({
        window: selection.window,
        workspaceIds: [workspaceId],
      });
      const workspaceUsage = usage.members.get(workspaceId);
      const workspaceUsageComplete = usage.status === "complete" || usage.status === "stale";
      const seen = new Set<string>();
      const members = [...dir.members.values()]
        .flatMap((member) => {
          const membership = member.workspaces.get(workspaceId);
          // Defensive identity deduplication protects against replayed/duplicate
          // memberships in upstream directory snapshots.
          if (
            !membership ||
            seen.has(member.userId) ||
            (!("kind" in authzScope) &&
              !authzScope.userIds.has(member.userId))
          ) return [];
          seen.add(member.userId);
          const budget = snapshot.budgets.get(member.userId);
          const budgetUsd = budget?.budgetUsd ?? null;
          // One workspace_member observation avoids role-subgroup duplicates.
          // Only its Agent metric is used, always for the current billing range.
          const usageUsd = !workspaceUsage || !workspaceUsageComplete
            ? null
            : !workspaceUsage.has(member.userId)
              ? 0
              : (workspaceUsage.get(member.userId)?.aiCostUsd ?? null);
          return [{
            userId: member.userId,
            username: member.username,
            name: member.name,
            email: member.email,
            role: membership.role,
            isDisabled: membership.isDisabled,
            budgetUsd,
            usageUsd,
            // Do not clamp: a negative value is meaningful overspend.
            remainingUsd:
              budgetUsd == null || usageUsd == null ? null : budgetUsd - usageUsd,
          }];
        })
        .sort((a, b) =>
          a.username.localeCompare(b.username, undefined, { sensitivity: "base" }) ||
          a.userId.localeCompare(b.userId),
        );
      res.json(ListVisibleWorkspaceMembersResponse.parse({
        workspaceId,
        workspaceName: workspace.name,
        billingPeriod: "current",
        connector: {
          status: snapshot.status,
          canWrite: snapshot.canWrite,
          error: snapshot.error,
        },
        members,
      }));
    } catch (err) {
      req.log.error({ err }, "listVisibleWorkspaceMembers failed");
      res.status(503).json({ error: "Directory unavailable" });
    }
  },
);

async function validateWorkspaceMembers(
  workspaceId: string,
  userIds: readonly string[],
): Promise<boolean> {
  const dir = await getDirectory();
  return dir.workspaces.has(workspaceId) &&
    userIds.every((userId) =>
      dir.members.get(userId)?.workspaces.has(workspaceId) === true
    );
}

async function recordUsageLimitAudit(
  req: Parameters<typeof requireAuth>[0],
  workspaceId: string,
  userId: string,
  action: "set" | "clear",
  operation: "individual" | "bulk",
  requestedAmountUsd: number | null,
  outcome: "success" | "failed",
): Promise<void> {
  const dir = await getDirectory();
  const workspace = dir.workspaces.get(workspaceId);
  const member = dir.members.get(userId);
  const operatorName = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(" ") || null;
  await db.insert(usageLimitAuditsTable).values({
    operatorUserId: req.user!.id,
    operatorEmail: req.user!.email,
    operatorName,
    workspaceId,
    workspaceName: workspace?.name ?? null,
    memberUserId: userId,
    memberEmail: member?.email ?? null,
    memberName: member?.name ?? member?.username ?? null,
    action,
    operation,
    requestedAmountUsd,
    outcome,
  });
}

function sendBudgetConnectorError(
  error: unknown,
  res: Response,
): void {
  if (error instanceof ReplitBudgetConnectorError) {
    res.status(error.kind === "unavailable" ? 503 : 502).json({ error: error.message });
    return;
  }
  res.status(502).json({
    error: error instanceof Error ? error.message : "Replit budgets API request failed",
  });
}

router.put(
  "/directory/workspaces/:workspaceId/members/budget",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const parsed = BulkSetWorkspaceMemberBudgetsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const workspaceId = String(req.params["workspaceId"]);
    const userIds = [...new Set(parsed.data.userIds)];
    try {
      if (!(await validateWorkspaceMembers(workspaceId, userIds))) {
        res.status(404).json({ error: "Workspace member not found" });
        return;
      }
      const outcomes = await Promise.all(userIds.map(async (userId) => {
        try {
          await setReplitMemberBudget(workspaceId, userId, parsed.data.amountUsd);
        } catch (error) {
          await recordUsageLimitAudit(
            req,
            workspaceId,
            userId,
            "set",
            "bulk",
            parsed.data.amountUsd,
            "failed",
          );
          return {
            userId,
            success: false,
            budgetUsd: null,
            error: error instanceof Error
              ? error.message
              : "Replit budgets API request failed",
          };
        }
        await recordUsageLimitAudit(
          req,
          workspaceId,
          userId,
          "set",
          "bulk",
          parsed.data.amountUsd,
          "success",
        );
        return {
          userId,
          success: true,
          budgetUsd: parsed.data.amountUsd,
          error: null,
        };
      }));
      if (
        outcomes.every((outcome) => !outcome.success) &&
        outcomes.some((outcome) => /write:budgets|connector/i.test(outcome.error ?? ""))
      ) {
        res.status(503).json({ error: outcomes[0]?.error ?? "Budget editing unavailable" });
        return;
      }
      res.json(BulkSetWorkspaceMemberBudgetsResponse.parse({
        workspaceId,
        amountUsd: parsed.data.amountUsd,
        outcomes,
      }));
    } catch (error) {
      sendBudgetConnectorError(error, res);
    }
  },
);

router.put(
  "/directory/workspaces/:workspaceId/members/:userId/budget",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const parsed = SetWorkspaceMemberBudgetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const workspaceId = String(req.params["workspaceId"]);
    const userId = String(req.params["userId"]);
    try {
      if (!(await validateWorkspaceMembers(workspaceId, [userId]))) {
        res.status(404).json({ error: "Workspace member not found" });
        return;
      }
      try {
        await setReplitMemberBudget(workspaceId, userId, parsed.data.amountUsd);
      } catch (error) {
        await recordUsageLimitAudit(
          req,
          workspaceId,
          userId,
          "set",
          "individual",
          parsed.data.amountUsd,
          "failed",
        );
        sendBudgetConnectorError(error, res);
        return;
      }
      await recordUsageLimitAudit(
        req,
        workspaceId,
        userId,
        "set",
        "individual",
        parsed.data.amountUsd,
        "success",
      );
      res.json(SetWorkspaceMemberBudgetResponse.parse({
        workspaceId,
        userId,
        budgetUsd: parsed.data.amountUsd,
      }));
    } catch (error) {
      req.log.error({ err: error }, "set usage limit failed");
      res.status(500).json({ error: "Usage limit audit could not be recorded" });
    }
  },
);

router.delete(
  "/directory/workspaces/:workspaceId/members/:userId/budget",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const workspaceId = String(req.params["workspaceId"]);
    const userId = String(req.params["userId"]);
    try {
      if (!(await validateWorkspaceMembers(workspaceId, [userId]))) {
        res.status(404).json({ error: "Workspace member not found" });
        return;
      }
      try {
        await setReplitMemberBudget(workspaceId, userId, null);
      } catch (error) {
        await recordUsageLimitAudit(
          req,
          workspaceId,
          userId,
          "clear",
          "individual",
          null,
          "failed",
        );
        sendBudgetConnectorError(error, res);
        return;
      }
      await recordUsageLimitAudit(
        req,
        workspaceId,
        userId,
        "clear",
        "individual",
        null,
        "success",
      );
      res.json(ClearWorkspaceMemberBudgetResponse.parse({
        workspaceId,
        userId,
        budgetUsd: null,
      }));
    } catch (error) {
      req.log.error({ err: error }, "clear usage limit failed");
      res.status(500).json({ error: "Usage limit audit could not be recorded" });
    }
  },
);

router.get(
  "/directory/workspaces/:workspaceId/usage-limit-audits",
  requireCapability("canWriteGroupLimits"),
  async (req, res): Promise<void> => {
    const workspaceId = String(req.params["workspaceId"]);
    const dir = await getDirectory();
    if (!dir.workspaces.has(workspaceId)) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const rows = await db
      .select()
      .from(usageLimitAuditsTable)
      .where(eq(usageLimitAuditsTable.workspaceId, workspaceId))
      .orderBy(desc(usageLimitAuditsTable.createdAt), desc(usageLimitAuditsTable.id))
      .limit(200);
    res.json(ListWorkspaceUsageLimitAuditsResponse.parse(rows));
  },
);

router.get("/directory/groups", requireRole("account"), async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  try {
    const dir = await getDirectory();
    if (!dir) {
      res.status(503).json({ error: "Directory not yet available" });
      return;
    }

    const groups = dir.groups.map((group) => ({
      groupId: group.id,
      groupName: group.name,
      workspaceId: group.workspaceId,
      workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? group.workspaceId,
    }));
    groups.sort(
      (a, b) =>
        a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: "base" }) ||
        a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" }) ||
        a.groupId.localeCompare(b.groupId),
    );

    res.json(ListDirectoryGroupsResponse.parse(groups));
  } catch (err) {
    req.log.error({ err }, "listDirectoryGroups failed");
    res.status(503).json({ error: "Directory unavailable" });
  }
});

router.get("/directory/members", requireRole("account"), async (req, res): Promise<void> => {
  try {
    const dir = await getDirectory();
    if (!dir) {
      res.status(503).json({ error: "Directory not yet available" });
      return;
    }

    const usage = await readUsageSnapshot({
      window: windowFromQuery(req.query as Record<string, unknown>).window,
      workspaceIds: dir.workspaces.keys(),
    });
    const members = [...dir.members.values()].map((m) => {
      return {
        userId: m.userId,
        username: m.username,
        name: m.name,
        email: m.email,
        isAccountAdmin: m.isAccountAdmin,
        workspaces: [...m.workspaces.entries()].map(([workspaceId, ws]) => {
          return {
            workspaceId,
            workspaceName: dir.workspaces.get(workspaceId)?.name ?? workspaceId,
            role: ws.role,
            isDisabled: ws.isDisabled,
            spendUsd: usage.members.get(workspaceId)?.get(m.userId)?.totalCostUsd ?? 0,
          };
        }),
      };
    });

    members.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));

    res.json(members);
  } catch (err) {
    req.log.error({ err }, "listDirectoryMembers failed");
    res.status(503).json({ error: "Directory unavailable" });
  }
});

export default router;
