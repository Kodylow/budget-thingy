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
  apiProjectMetadataTable,
  apiProjectMetadataStateTable,
  usageLimitAuditsTable,
} from "@workspace/db";
import {
  ListGroupsResponse,
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
  GetEmailSettingsResponse,
  UpdateEmailSettingsBody,
  UpdateEmailSettingsResponse,
} from "@workspace/api-zod";

export function escapeCsvCell(value: unknown): string {
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
  buildCanonicalAccountDirectory,
  buildCanonicalEffectiveTeams,
  type CanonicalAccountDirectory,
  resolveCanonicalMergedGroupBudget,
  type EnterpriseGroup,
  type DirectoryCache,
} from "../lib/enterprise";
import type { ConfigurationSnapshot } from "../lib/configuration-snapshot";
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
  buildProjectMetadataSnapshot,
  PROJECT_METADATA_COMPLETE_MAX_AGE_MS,
  readProjectMetadata,
  type ProjectMetadataSnapshot,
} from "../lib/project-metadata";
import {
  computeDedupedMemberCounts,
  computeHistoricalSnapshotUsageRollups,
  computeSnapshotUsageRollup,
  projectAttributionKey,
  type SnapshotUsageRollup,
} from "../lib/usage-rollup";
import { BoundedTaskScheduler } from "../lib/bounded-stale-cache";
import { BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle } from "../lib/ingest";
import {
  getNotificationSettings,
  updateNotificationSettings,
} from "../lib/notification-settings";


export { Router, type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings };

/**
 * Reduce a directory's group list to the set visible to the current request's
 * authorization. Account admins see every custom group; workspace admins see
 * only groups whose workspace they administer.
 */
export function visibleGroups(authz: Authorization, groups: EnterpriseGroup[]): EnterpriseGroup[] {
  return scopeGroups(authz, groups);
}

export function visibleGroupMembers(
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
      userIds.filter((userId) => {
        const qualified = scope.groupUserIds.get(id);
        return qualified ? qualified.has(userId) : scope.userIds.has(userId);
      }),
    ]),
  );
}

export function visibleRosterMembers(
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
          userIds.filter((userId) => {
            const qualified = scope.groupUserIds.get(groupId);
            return qualified ? qualified.has(userId) : scope.userIds.has(userId);
          }),
        ]),
      ),
    ]),
  );
}

export type AlertScopeEntity = {
  entityType: string;
  entityId: string;
  groupId: string;
  workspaceIds: string[];
};

export type TeamAlertCanonicalScope = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlySet<string>>
>;

export function buildTeamAlertCanonicalScope(
  groups: readonly EnterpriseGroup[],
  teamByGroup: ReadonlyMap<string, string>,
): TeamAlertCanonicalScope {
  const mutable = new Map<string, Map<string, Set<string>>>();
  for (const group of groups) {
    const teamName = teamByGroup.get(groupTeamKey(group));
    if (!teamName) continue;
    const byWorkspace = mutable.get(teamName) ?? new Map<string, Set<string>>();
    const groupIds = byWorkspace.get(group.workspaceId) ?? new Set<string>();
    groupIds.add(group.id);
    byWorkspace.set(group.workspaceId, groupIds);
    mutable.set(teamName, byWorkspace);
  }
  return mutable;
}

export function canSeeAlertEntity(
  authz: Authorization,
  alert: AlertScopeEntity,
  visibleGroupIds: ReadonlySet<string>,
  canonicalTeamScope: TeamAlertCanonicalScope,
): boolean {
  const scope = scopeFor(authz);
  if ("kind" in scope) return true;
  if (alert.entityType !== "team") {
    return visibleGroupIds.has(alert.entityId || alert.groupId) &&
      scope.managedGroupIds.has(alert.entityId || alert.groupId);
  }
  if (alert.workspaceIds.length === 0) return false;
  if (
    authz.roles.includes("workspace_admin") &&
    alert.workspaceIds.every((workspaceId) => scope.workspaceIds.has(workspaceId))
  ) {
    return true;
  }
  const teamByWorkspace = canonicalTeamScope.get(alert.entityId || alert.groupId);
  if (!teamByWorkspace) return false;
  return alert.workspaceIds.every((workspaceId) => {
    if (scope.workspaceIds.has(workspaceId)) return true;
    const canonicalGroupIds = teamByWorkspace.get(workspaceId);
    if (!canonicalGroupIds || canonicalGroupIds.size === 0) return false;
    return [...canonicalGroupIds].every((groupId) =>
      scope.managedGroupIds.has(groupId)
    );
  });
}

export function targetTeamForGroup(
  group: EnterpriseGroup,
  source: CanonicalAccountDirectory,
  targets: readonly (typeof teamLimitTargetsTable.$inferSelect)[] = [],
  fundingOverrides: readonly import("@workspace/db").FundingGroupOverride[] = [],
): string | undefined {
  return buildCanonicalEffectiveTeams(source, targets, fundingOverrides)
    .byRoleGroupId.get(group.id) ?? undefined;
}

export function groupTeamKey(group: Pick<EnterpriseGroup, "workspaceId" | "id">): string {
  return `${group.workspaceId}\0${group.id}`;
}

/** Rebuilds canonical families from the same committed snapshot as attribution. */
export function buildSnapshotCanonicalAccount(
  directory: Pick<
    DirectoryCache,
    "workspaces" | "groups" | "groupMembers" | "members"
  >,
  configuration: ConfigurationSnapshot,
): CanonicalAccountDirectory {
  return buildCanonicalAccountDirectory({
    workspaces: directory.workspaces,
    groups: directory.groups,
    groupMembers: directory.groupMembers,
    members: directory.members,
    mappings: configuration.familyTeamMappings,
  });
}
export function buildGroupTeamMap(
  groups: readonly EnterpriseGroup[],
  source: CanonicalAccountDirectory,
  hiddenTeamNames: ReadonlySet<string> = new Set(),
  targets: readonly (typeof teamLimitTargetsTable.$inferSelect)[] = [],
  fundingOverrides: readonly import("@workspace/db").FundingGroupOverride[] = [],
): Map<string, string> {
  const result = new Map<string, string>();
  const effectiveTeams = buildCanonicalEffectiveTeams(source, targets, fundingOverrides);
  for (const group of groups) {
    const teamName = effectiveTeams.byRoleGroupId.get(group.id);
    if (teamName && !hiddenTeamNames.has(teamName)) {
      result.set(groupTeamKey(group), teamName);
    }
  }
  return result;
}

export function windowFromQuery(query: Record<string, unknown>): UsageWindowSelection {
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

export function workspaceScope(
  authz: Authorization,
  dir: Awaited<ReturnType<typeof getDirectory>>,
  groups: readonly EnterpriseGroup[],
): Set<string> {
  if (isAccountWide(authz)) {
    return new Set([...dir.workspaces.keys(), ...groups.map((group) => group.workspaceId)]);
  }
  const ownActiveWorkspaces = authz.roles.length === 1 &&
      authz.roles[0] === "member" &&
      authz.userIds.length === 1 &&
      authz.userIds[0] === authz.userId
    ? [...(dir.members.get(authz.userId)?.workspaces ?? [])]
      .filter(([, membership]) => !membership.isDisabled)
      .map(([workspaceId]) => workspaceId)
    : [];
  return new Set([
    ...authz.workspaceIds,
    ...groups.map((group) => group.workspaceId),
    ...ownActiveWorkspaces,
  ]);
}

export {
  buildProjectMetadataSnapshot,
  PROJECT_METADATA_COMPLETE_MAX_AGE_MS,
  readProjectMetadata,
  type ProjectMetadataSnapshot,
};

export async function usageForRequest(
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
  const visible = visibleGroups(authz, dir.groups);
  const authorizedWorkspaceIds = workspaceScope(authz, dir, visible);
  const requestedWorkspaceId = typeof query["workspaceId"] === "string" &&
      query["workspaceId"]
    ? query["workspaceId"]
    : null;
  const workspaceIds = requestedWorkspaceId === null
    ? authorizedWorkspaceIds
    : authorizedWorkspaceIds.has(requestedWorkspaceId)
      ? new Set([requestedWorkspaceId])
      : new Set<string>();
  const groups = requestedWorkspaceId === null
    ? visible
    : visible.filter((group) => group.workspaceId === requestedWorkspaceId);
  const [snapshot, projectMetadata] = await Promise.all([
    readUsageSnapshot({
      window: selection.window,
      workspaceIds,
      includeDailyMembers,
      // A workspace-filtered report must not pull an account-wide total into
      // its reconciliation or disclose it through a workspace card.
      includeAccountAnchor: isAccountWide(authz) &&
        requestedWorkspaceId === null,
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
      internalUserIds: dir.internalUserIds,
      projectInfoByWorkspace: projectMetadata.attributionByWorkspace,
    }),
    projectMetadata,
  };
}

export function usageHealth(
  snapshot: UsageSnapshot,
  rollup: Pick<SnapshotUsageRollup, "accountReconciliationSpendUsd">,
  authz: Authorization,
) {
  const accountWide = isAccountWide(authz);
  return {
    status: accountWide ? snapshot.status : snapshot.workspaceStatus,
    dataAsOf: accountWide ? snapshot.dataAsOf : snapshot.workspaceDataAsOf,
    coverage: snapshot.coverage,
    accountWorkspaceUnreconciledUsd: accountWide
      ? rollup.accountReconciliationSpendUsd
      : 0,
  };
}

const dailyRollupMemo = new WeakMap<
  UsageSnapshot,
  Map<string, Promise<Map<string, SnapshotUsageRollup>>>
>();
const dailyRollupScheduler = new BoundedTaskScheduler(2, 8);

export async function dailyUsageRollups(
  dir: Awaited<ReturnType<typeof getDirectory>>,
  usage: Awaited<ReturnType<typeof usageForRequest>>,
): Promise<Map<string, SnapshotUsageRollup>> {
  const currentUtcDay = new Date().toISOString().slice(0, 10);
  const key = JSON.stringify([
    usage.authz.userId,
    usage.authz.role,
    usage.authz.workspaceIds,
    usage.authz.teamNames,
    usage.authz.groupIds,
    usage.authz.userIds,
    usage.authz.managedGroupIds,
    usage.authz.groupUserIds,
    usage.groups.map((group) => group.id),
    getDirectoryFreshness().dataAsOf,
    currentUtcDay,
    usage.projectMetadata.revision,
  ]);
  const byScope = dailyRollupMemo.get(usage.snapshot) ?? new Map();
  dailyRollupMemo.set(usage.snapshot, byScope);
  const current = byScope.get(key);
  if (current) {
    return current;
  }

  const startDate = usage.selection.window.start.slice(0, 10);
  const endDate = new Date(Date.parse(usage.selection.window.end) - 1)
    .toISOString().slice(0, 10);
  const computed = dailyRollupScheduler.schedule(async () => {
    const roster = await getRosterHistory(
      usage.groups.map((group) => group.id),
      startDate,
      endDate,
    );
    return computeHistoricalSnapshotUsageRollups({
      snapshot: usage.snapshot,
      groups: usage.groups,
      currentUtcDay,
      currentMembersByGroup: visibleGroupMembers(usage.authz, dir.groupMembers),
      internalUserIds: dir.internalUserIds,
      completedRosterDays: roster.completedDays,
      rosterMembersByDate: visibleRosterMembers(usage.authz, roster.membersByDate),
      projectInfoByWorkspace: usage.projectMetadata.attributionByWorkspace,
    });
  });
  byScope.set(key, computed);
  void computed.then(() => {
    if (byScope.get(key) === computed) byScope.delete(key);
  }, () => {
    if (byScope.get(key) === computed) byScope.delete(key);
  });
  return computed;
}

export interface EffectiveBudget {
  amountUsd: number | null;
  source: "app" | null;
}

export function effectiveGroupBudget(appBudget: number | undefined): EffectiveBudget {
  if (appBudget != null) return { amountUsd: appBudget, source: "app" };
  return { amountUsd: null, source: null };
}

/**
 * Given a set of source group IDs (a merged group's aliases), return the union of
 * their directory members (deduped) in stable insertion order.
 */
export function mergedGroupMemberIds(
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

export type CanonicalUserAttribution = {
  groupName: string;
  teamName: string;
  workspaceId: string;
  displaySpendUsd: number;
};

/**
 * Choose display metadata from canonical attribution without using it to
 * calculate totals. Totals always come from canonical.byUser.
 */
export function canonicalUserAttribution(
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

export interface CurrentAlertUsage {
  spendUsd: number | null;
  percentUsed: number | null;
  isComplete: boolean;
}

export function alertToJson(
  a: typeof alertsTable.$inferSelect,
  current?: CurrentAlertUsage,
) {
  return {
    id: a.id,
    entityType: a.entityType,
    entityId: a.entityId || a.groupId,
    entityName: a.entityName || a.groupName,
    alertType: a.alertType,
    blockedMemberCount: a.blockedMemberCount,
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

export function buildSnapshotGroupTeamMap(
  groups: readonly EnterpriseGroup[],
  directory: Pick<
    DirectoryCache,
    "workspaces" | "groups" | "groupMembers" | "members"
  >,
  configuration: ConfigurationSnapshot,
  hiddenTeamNames: ReadonlySet<string> = new Set(),
): Map<string, string> {
  return buildGroupTeamMap(
    groups,
    buildSnapshotCanonicalAccount(directory, configuration),
    hiddenTeamNames,
    configuration.teamLimitTargets,
    configuration.fundingGroupOverrides,
  );
}
