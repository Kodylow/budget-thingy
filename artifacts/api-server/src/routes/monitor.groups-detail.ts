import { Router, type Request } from "express";
import { buildSnapshotCanonicalAccount } from "./monitor.shared";
import {
  GetBudgetTeamReportQueryParams,
  GetReportingDetailQueryParams,
  GetReportingDetailResponse,
} from "@workspace/api-zod";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

import {
  buildScopedAccounting,
  buildBudgetTrackingPoints,
  reportingSemanticsForGroups,
  canonicalTeamPoolId,
  canExposeCanonicalAllocation,
  currentCycleLimitMetrics,
  getCurrentCycleMemberSnapshot,
  prepareScopedAccounting,
  qualifiedGroupSpendComponents,
  resolveStoredMemberLimit,
} from "../services/scoped-accounting";
import {
  buildCanonicalAccountDirectory,
  hasSuccessfulLimitObservation,
} from "../lib/enterprise";
import {
  fixedTeamBudgetPeriodAsOf,
  UsageWindowError,
} from "../lib/usage-window";
import {
  assertStableReportingUsageGeneration,
  ReportingUsageTransitionError,
  REPORTING_USAGE_RETRY_AFTER_SECONDS,
} from "../lib/reporting-usage-transition";
export {
  assertStableReportingUsageGeneration,
  ReportingUsageTransitionError,
} from "../lib/reporting-usage-transition";
import { authorizeSpendView } from "./monitor.spend-tables";
import { buildAuthorization } from "../lib/authz";
import { buildOwnReportMembershipContext } from "../lib/membership-context";

const router = Router();
const MAX_REPORTING_GROUP_IDS = 32;
const DAY_MS = 86_400_000;

function reportingQuery(req: Request, teamMode: boolean) {
  if (!teamMode) return GetReportingDetailQueryParams.safeParse(req.query);
  const raw = req.query["includeBudgetTracking"];
  const rawHierarchy = req.query["includeHierarchy"];
  return GetBudgetTeamReportQueryParams.safeParse({
    ...req.query,
    includeBudgetTracking: raw === "true",
    includeHierarchy: rawHierarchy === "true",
  });
}

export function buildFixedTeamBudgetTracking(input: {
  dailySpend: ReadonlyMap<string, number>;
  unavailableDays: ReadonlySet<string>;
  scopeComplete: boolean;
  usageObserved: boolean;
  allocationUsd: number | null;
  canonicalSpendUsd: number;
  now?: Date;
  reportingStart?: string;
  reportingEndExclusive?: string;
  reportingLabel?: string;
  comparisonsMatchBudgetWindow?: boolean;
  budgetKind?: "annual" | "monthly_agent";
  workspaceCount?: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  periodLabel?: string;
  asOf?: string | null;
  reporting?: ReturnType<typeof reportingSemanticsForGroups>;
}) {
  const period = fixedTeamBudgetPeriodAsOf(input.now);
  const reportingStart = input.reportingStart ?? period.start;
  const reportingEndExclusive =
    input.reportingEndExclusive ?? period.reportingEndExclusive;
  const reportingEnd = Date.parse(reportingEndExclusive) > Date.parse(reportingStart)
    ? new Date(Date.parse(reportingEndExclusive) - DAY_MS)
      .toISOString().slice(0, 10)
    : null;
  const points = reportingEnd === null
    ? []
    : buildBudgetTrackingPoints(
      reportingStart,
      reportingEndExclusive,
      input.dailySpend,
      input.unavailableDays,
    );
  const usageComplete = input.scopeComplete &&
    input.usageObserved &&
    input.unavailableDays.size === 0;
  const comparisonsVerified =
    input.reporting?.comparisonsVerified ?? true;
  const comparisonsMatchBudgetWindow =
    input.comparisonsMatchBudgetWindow ?? true;
  const comparisonsEligible = comparisonsMatchBudgetWindow &&
    usageComplete && comparisonsVerified && input.allocationUsd !== null;
  // The annual pace is a plan, not a claim that historical spend is verified.
  // Keep exact balances (and monthly Agent comparisons) subject to coverage.
  const benchmarkEligible = comparisonsMatchBudgetWindow &&
    input.scopeComplete && input.allocationUsd !== null && input.allocationUsd > 0 &&
    (input.budgetKind !== "monthly_agent" || comparisonsEligible);
  const spendUsd = input.usageObserved ? input.canonicalSpendUsd : null;
  const qualification = !comparisonsMatchBudgetWindow
    ? !input.scopeComplete
      ? "Comparisons are unavailable because the range differs from the budget-to-date window and the full funding team is outside scope."
      : "Comparisons are unavailable because the range differs from the budget-to-date window."
    : !input.scopeComplete
    ? "Allocation comparisons are unavailable outside the full funding-team scope."
    : !usageComplete
      ? input.budgetKind === "monthly_agent"
        ? "Cycle comparisons are unavailable because Agent usage coverage is incomplete."
        : "Budget comparisons are unavailable because budget-to-date window coverage is incomplete."
      : input.allocationUsd === null
        ? "Budget comparisons are unavailable because the team allocation is unavailable."
        : input.allocationUsd <= 0
          ? "Percent used and benchmark are unavailable for a non-positive allocation."
          : null;
  return {
    budgetKind: input.budgetKind ?? "annual",
    workspaceCount: input.workspaceCount ?? 0,
    periodStart: input.periodStart === undefined
      ? period.periodStart
      : input.periodStart,
    periodEnd: input.periodEnd === undefined ? period.periodEnd : input.periodEnd,
    periodLabel: input.periodLabel ?? "May 20, 2026 to May 20, 2027",
    reportingStart: reportingStart.slice(0, 10),
    reportingEnd,
    reportingLabel: input.reportingLabel ??
      `${reportingStart.slice(0, 10)} to ${reportingEnd ?? reportingStart.slice(0, 10)}`,
    asOf: input.asOf === undefined ? period.asOf : input.asOf,
    allocationUsd: input.scopeComplete ? input.allocationUsd : null,
    spendUsd,
    remainingUsd: comparisonsEligible
      ? input.allocationUsd! - input.canonicalSpendUsd
      : null,
    percentUsed: comparisonsEligible && input.allocationUsd! > 0
      ? input.canonicalSpendUsd / input.allocationUsd! * 100
      : null,
    scopeComplete: input.scopeComplete,
    usageComplete,
    benchmarkEligible,
    comparisonsMatchBudgetWindow,
    qualification,
    reporting: input.reporting ?? {
      acquisitionCoverage: input.usageObserved ? "complete" : "unavailable",
      rosterAttributionBasis: "observed_roster",
      creatorCoverage: "not_applicable",
      creatorAttributionBasis: "not_applicable",
      freshness: input.usageObserved ? "fresh" : "unavailable",
      valueBasis: input.usageObserved ? "verified" : "unavailable",
      comparisonsVerified: input.usageObserved,
    },
    points,
  };
}

export function __reportingDetailBaseQualificationsForTests(
  qualifications: readonly string[],
): string[] {
  return qualifications.filter(
    (qualification) =>
      qualification.startsWith("Accounting is refreshing") ||
      qualification.startsWith("The latest accounting refresh failed") ||
      /member[- ]limit|limit observation/i.test(qualification),
  );
}

export function normalizeReportingGroupIds(raw: string): string[] {
  if (raw.length > 8_192) throw new Error("Group IDs are too long");
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("At least one group ID is required");
  if (ids.length > MAX_REPORTING_GROUP_IDS) {
    throw new Error(`At most ${MAX_REPORTING_GROUP_IDS} group IDs are allowed`);
  }
  if (ids.some((id) => id.length > 256)) throw new Error("A group ID is too long");
  return ids;
}

function qualifiedGroupDataComplete(
  snapshot: Awaited<ReturnType<typeof usageForRequest>>["snapshot"],
): boolean {
  return snapshot.workspaceStatus !== "empty" &&
    snapshot.coverage.failedWorkspaceDays.length === 0 &&
    snapshot.coverage.missingWorkspaceDays.length === 0;
}

function qualifiedGroupUsageHealth(
  usage: Awaited<ReturnType<typeof usageForRequest>>,
) {
  return {
    ...usageHealth(usage.snapshot, usage.rollup, usage.authz),
    // Account/workspace reconciliation has no truthful group attribution.
    accountWorkspaceUnreconciledUsd: 0,
  };
}

async function reportingDetailHandler(req: Request, res: Response): Promise<void> {
  const startedAt = performance.now();
  const teamMode = req.params["poolId"] !== undefined;
  const rawBudgetTracking = req.query["includeBudgetTracking"];
  const rawHierarchy = req.query["includeHierarchy"];
  if (
    teamMode &&
    rawBudgetTracking !== undefined &&
    rawBudgetTracking !== "true" &&
    rawBudgetTracking !== "false"
  ) {
    res.status(400).json({ error: "includeBudgetTracking must be true or false" });
    return;
  }
  if (
    teamMode &&
    rawHierarchy !== undefined &&
    rawHierarchy !== "true" &&
    rawHierarchy !== "false"
  ) {
    res.status(400).json({ error: "includeHierarchy must be true or false" });
    return;
  }
  const parsed = reportingQuery(req, teamMode);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let restrictedOwnView = false;
  let reportingAuthz = req.authz!;
  if (teamMode) {
    const ownQuery = parsed.data as {
      scope?: "authorized" | "own";
      workspaceId?: string;
      includeBudgetTracking?: boolean;
      includeHierarchy?: boolean;
    };
    const isOwnRequest = ownQuery.scope === "own";
    if (isOwnRequest && ownQuery.includeHierarchy === true) {
      res.status(403).json({
        error: "Hierarchy is unavailable for an own team report",
      });
      return;
    }
    if (!isOwnRequest && !authorizeSpendView(req.authz!, "pools")) {
      res.status(403).json({ error: "The pools view is outside your authorized scope" });
      return;
    }
    if (isOwnRequest && !ownQuery.workspaceId) {
      res.status(400).json({ error: "workspaceId is required for an own team report" });
      return;
    }
    if (
      !authorizeSpendView(req.authz!, "pools") &&
      ownQuery.includeBudgetTracking !== true
    ) {
      res.status(403).json({ error: "The pools view is outside your authorized scope" });
      return;
    }
    if (!isOwnRequest) {
      // Authorized manager/account views retain their normal authorization.
    } else try {
      const directory = await getDirectory();
      const membershipContext = buildOwnReportMembershipContext(
        req.authz!.userId,
        directory,
        req.configurationSnapshot!,
      );
      const selectedMembership = membershipContext.workspaces
        .find((workspace) => workspace.workspaceId === ownQuery.workspaceId)
        ?.budgetTeams.find((team) =>
          team.poolId === String(req.params["poolId"]));
      if (!selectedMembership) {
        res.status(403).json({
          error: "The requested funding team is outside your own workspace scope",
        });
        return;
      }
      const configuredAccount = buildCanonicalAccountDirectory({
        workspaces: directory.workspaces,
        groups: directory.allGroups,
        groupMembers: directory.groupMembers,
        members: directory.members,
        mappings: req.configurationSnapshot!.familyTeamMappings,
      });
      const personalGroups = directory.groups.filter((group) =>
        targetTeamForGroup(
          group,
          configuredAccount,
          req.configurationSnapshot!.teamLimitTargets,
          req.configurationSnapshot!.fundingGroupOverrides,
        ) === selectedMembership.teamName);
      const groupUserIds = new Map(personalGroups.map((group) => [
        group.id,
        directory.groupMembers.get(group.id) ?? [],
      ]));
      reportingAuthz = buildAuthorization({
        userId: req.authz!.userId,
        roles: ["team_admin"],
        teamNames: [selectedMembership.teamName],
        groupIds: personalGroups.map((group) => group.id),
        managedGroupIds: personalGroups.map((group) => group.id),
        userIds: new Set([
          req.authz!.userId,
          ...personalGroups.flatMap((group) =>
            directory.groupMembers.get(group.id) ?? []),
        ]),
        groupUserIds,
      });
      // Own reports expose team totals, but retain the member-safe response
      // shape regardless of the caller's administrative roles.
      restrictedOwnView = true;
    } catch (error) {
      req.log.error({ err: error }, "own budget team authorization failed");
      res.status(503).json({ error: "Budget team authorization unavailable" });
      return;
    }
  }
  let groupIds: string[] = [];
  if (!teamMode) {
    try {
      groupIds = normalizeReportingGroupIds(String(req.params["groupIds"] ?? ""));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid group IDs",
      });
      return;
    }
  }

  try {
    // Authorize every normalized identity before touching shared accounting caches.
    let groups: EnterpriseGroup[] = [];
    if (!teamMode) {
      const directory = await getDirectory();
      const requested = groupIds.map((id) =>
        directory.groups.find((group) => group.id === id));
      if (requested.some((group) => !group || !canSeeGroup(req.authz!, group))) {
        res.status(404).json({ error: "Reporting detail not found" });
        return;
      }
      groups = requested as EnterpriseGroup[];
    }
    // An ingest cycle publishes one generation only after all of its admitted
    // units settle. Do not populate an old-generation cache from an
    // intermediate set of committed units.
    assertStableReportingUsageGeneration();
    const authorizedAt = performance.now();

    const includeHierarchy = teamMode &&
      (parsed.data as { includeHierarchy?: boolean }).includeHierarchy === true;
    // Keep the long-standing report projection unchanged unless the canonical
    // hierarchy was explicitly requested. Hierarchy callers must reconcile to
    // the same scope as the Spend surface that linked them here.
    const query = includeHierarchy
      ? { ...parsed.data }
      : { ...parsed.data, viewScope: "all_authorized" as const };
    const prepared = await prepareScopedAccounting(
      reportingAuthz,
      query,
      undefined,
      req.configurationSnapshot,
    );
    const accountingStartedAt = performance.now();
    const accounting = await buildScopedAccounting(
      reportingAuthz,
      query,
      undefined,
      prepared,
    );
    const accountingMs = performance.now() - accountingStartedAt;
    const requestedPoolId = String(req.params["poolId"] ?? "");
    const teamRow = teamMode
      ? accounting.poolRows.find((row) =>
        row.kind === "pool" &&
        row.id.startsWith("pool:team:") &&
        row.id === requestedPoolId)
      : undefined;
    if (teamMode && !teamRow) {
      res.status(404).json({ error: "Budget team report not found" });
      return;
    }
    if (teamMode) {
      const sourceIds = new Set(teamRow!.sourceGroupIds ?? []);
      groups = accounting.dir.groups.filter((group) => sourceIds.has(group.id));
    }
    const canonicalIds = [...new Set(groups.map((group) =>
      accounting.fullMergePlan.primaryByGroupId.get(group.id) ?? group.id))];
    const canonicalGroups = canonicalIds.map((canonicalId) => {
      const sources = accounting.visibleByCanonical.get(canonicalId) ?? [];
      const display = sources.find((group) => group.id === canonicalId) ?? sources[0];
      return display ? { display, sources } : null;
    });
    if (canonicalGroups.some((item) => !item)) {
      res.status(404).json({ error: "Reporting detail not found" });
      return;
    }
    const selections = canonicalGroups as Array<{
      display: EnterpriseGroup;
      sources: EnterpriseGroup[];
    }>;
    const families = selections.map(({ display }) =>
      accounting.configuredAccount.roleGroupsById.get(display.id));
    if (families.some((family) => !family)) {
      res.status(404).json({ error: "Reporting detail not found" });
      return;
    }
    if (!teamMode &&
        new Set(families.map((family) => family!.familyKey)).size !== 1) {
      res.status(400).json({ error: "Requested groups must belong to one family" });
      return;
    }
    const requestedWorkspaceIds = new Set(selections.flatMap((selection) =>
      selection.sources.map((group) => group.workspaceId)));
    const currentCycleStartedAt = performance.now();
    const currentCycle = await getCurrentCycleMemberSnapshot(
      accounting,
      requestedWorkspaceIds,
    );
    const currentCycleMs = performance.now() - currentCycleStartedAt;
    const projectionStartedAt = performance.now();
    const detailDirectory = accounting.dir;
    const scopedMembers = visibleGroupMembers(
      prepared.effectiveAuth,
      detailDirectory.groupMembers,
    );
    const relevantMissing = accounting.usage.snapshot.coverage.missingWorkspaceDays
      .filter((item) => requestedWorkspaceIds.has(item.workspaceId));
    const relevantFailed = accounting.usage.snapshot.coverage.failedWorkspaceDays
      .filter((item) => requestedWorkspaceIds.has(item.workspaceId));
    const detailReporting = reportingSemanticsForGroups(
      accounting.daily,
      selections.flatMap((selection) => selection.sources),
    );
    const selectedComplete = requestedWorkspaceIds.size > 0 &&
      (accounting.usage.snapshot.workspaceStatus !== "empty" &&
        relevantMissing.length === 0 &&
        relevantFailed.length === 0);
    const comparisonsVerified =
      selectedComplete && detailReporting.comparisonsVerified;
    const currentWorkspaceComplete = new Map(
      [...new Set(selections.flatMap((selection) =>
        selection.sources.map((group) => group.workspaceId)))].map((workspaceId) => [
        workspaceId,
        currentCycle.workspaceStatus !== "empty" &&
          !currentCycle.coverage.failedWorkspaceDays.some(
            (item) => item.workspaceId === workspaceId,
          ) &&
          !currentCycle.coverage.missingWorkspaceDays.some(
            (item) => item.workspaceId === workspaceId,
          ),
      ]),
    );
    const selectedWorkspaceComplete = new Map(
      [...requestedWorkspaceIds].map((workspaceId) => [
        workspaceId,
        accounting.usage.snapshot.workspaceStatus !== "empty" &&
          !relevantFailed.some((item) => item.workspaceId === workspaceId) &&
          !relevantMissing.some((item) => item.workspaceId === workspaceId),
      ]),
    );

    const groupRows = selections.map(({ display: group, sources }, index) => {
      const components = [...accounting.daily.values()].reduce(
        (total, rollup) => {
          const day = qualifiedGroupSpendComponents(
            rollup,
             prepared.effectiveAuth,
            sources,
          );
          total.spendUsd += day.spendUsd;
          total.agentSpendUsd += day.agentSpendUsd;
          total.otherServicesUsd += day.otherServicesUsd;
          return total;
        },
        { spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0 },
      );
      const row = accounting.groupRows.find((candidate) =>
        candidate.id === `group:${group.workspaceId}:${group.id}`);
      const allocationUsd = row?.allocationUsd ?? null;
      return {
        groupId: group.id,
        workspaceId: group.workspaceId,
        workspaceName:
          detailDirectory.workspaces.get(group.workspaceId)?.name ?? null,
        name: group.name,
        familyKey: families[index]!.familyKey,
        familyName: families[index]!.familyName,
        role: families[index]!.role,
        isLegacy: families[index]!.isLegacy,
        memberCount: new Set(sources.flatMap((source) =>
          scopedMembers.get(source.id) ?? [])).size,
        spendUsd: components.spendUsd,
        agentSpendUsd: components.agentSpendUsd,
        otherServicesUsd: components.otherServicesUsd,
        allocationUsd,
        remainingUsd: comparisonsVerified && allocationUsd !== null
          ? allocationUsd - components.spendUsd
          : null,
        percentUsed: comparisonsVerified &&
            allocationUsd !== null && allocationUsd > 0
          ? components.spendUsd / allocationUsd * 100
          : null,
        sharedPool: row?.sharedPool ?? false,
      };
    });
    const sourceGroups = selections.flatMap(({ sources }) => sources.map((group) => {
      const role = accounting.configuredAccount.roleGroupsById.get(group.id);
      return {
        groupId: group.id,
        workspaceId: group.workspaceId,
        workspaceName:
          detailDirectory.workspaces.get(group.workspaceId)?.name ?? null,
        role: role?.role ?? "unsuffixed",
      };
    }));

    const memberMap = new Map<string, {
      workspaceId: string;
      userId: string;
      groupIds: string[];
      agentSpendUsd: number;
      otherServicesUsd: number;
    }>();
    for (const { sources } of selections) {
      for (const group of sources) {
        for (const userId of scopedMembers.get(group.id) ?? []) {
          const key = `${group.workspaceId}\u0000${userId}`;
          const member = memberMap.get(key) ?? {
            workspaceId: group.workspaceId,
            userId,
            groupIds: [],
            agentSpendUsd: 0,
            otherServicesUsd: 0,
          };
          member.groupIds.push(group.id);
          for (const rollup of accounting.daily.values()) {
            member.agentSpendUsd +=
              rollup.aiSpendByGroup.get(group.id)?.get(userId) ?? 0;
            member.otherServicesUsd +=
              rollup.nonAiSpendByGroup.get(group.id)?.get(userId) ?? 0;
          }
          memberMap.set(key, member);
        }
      }
    }
    const members = [...memberMap.values()].map((item) => {
      const member = detailDirectory.members.get(item.userId);
      const workspaceMember = member?.workspaces.get(item.workspaceId);
      const limit = resolveStoredMemberLimit(
        detailDirectory,
        item.workspaceId,
        item.userId,
      );
      const cycleEntry =
        currentCycle.members.get(item.workspaceId)?.get(item.userId);
      const currentCycleAgentSpendUsd = !currentWorkspaceComplete.get(item.workspaceId)
        ? null
        : member?.isInternalReplitUser
          ? 0
          : cycleEntry === undefined
            ? 0
            : cycleEntry.agentMetricsComplete === true
              ? cycleEntry.aiCostUsd
              : null;
      const metrics = currentCycleLimitMetrics(
        limit.amount,
        currentCycleAgentSpendUsd,
      );
      return {
        workspaceId: item.workspaceId,
        userId: item.userId,
        username: member?.username ?? null,
        email: member?.email ?? null,
        name: member?.name ?? null,
        role: workspaceMember?.role ?? null,
        isDisabled: workspaceMember?.isDisabled ?? null,
        isInternal: member?.isInternalReplitUser ?? false,
        groupIds: [...new Set(item.groupIds)],
        spendUsd: item.agentSpendUsd + item.otherServicesUsd,
        agentSpendUsd: item.agentSpendUsd,
        otherServicesUsd: item.otherServicesUsd,
        currentCycleAgentSpendUsd,
        limitUsd: limit.amount,
        remainingUsd: metrics.remainingUsd,
        percentUsed: metrics.percentUsed,
        limitState: limit.state,
        limitObservationStatus: detailDirectory.budgets.observation.status,
      };
    }).sort((a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) || a.userId.localeCompare(b.userId));

    const canonicalHeadlineSpendUsd = teamRow?.spendUsd ??
      groupRows.reduce((sum, group) => sum + group.spendUsd, 0);
    const hierarchy = includeHierarchy
      ? (() => {
        const observedWorkspaceIds = new Set<string>();
        for (const workspaces of
          accounting.usage.snapshot.dailyWorkspaces?.values() ?? []) {
          for (const workspaceId of workspaces.keys()) {
            observedWorkspaceIds.add(workspaceId);
          }
        }
        const round = (value: number) =>
          Math.round((value + Number.EPSILON) * 1e8) / 1e8;
        const selfOnly = prepared.effectiveAuth.roles.length === 1 &&
          prepared.effectiveAuth.roles[0] === "member" &&
          prepared.effectiveAuth.userIds.length === 1 &&
          prepared.effectiveAuth.userIds[0] === prepared.effectiveAuth.userId;
        const sourceByWorkspace = new Map<string, EnterpriseGroup[]>();
        for (const source of selections.flatMap((selection) => selection.sources)) {
          const workspaceGroups = sourceByWorkspace.get(source.workspaceId) ?? [];
          if (!workspaceGroups.some((group) => group.id === source.id)) {
            workspaceGroups.push(source);
          }
          sourceByWorkspace.set(source.workspaceId, workspaceGroups);
        }
        const workspaceRows = [...sourceByWorkspace].map(
          ([workspaceId, workspaceGroups]) => {
            const workspaceComplete = selectedWorkspaceComplete.get(workspaceId) ??
              false;
            const groupHierarchy = workspaceGroups
              .sort((a, b) =>
                a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
              .map((group) => {
                const role = accounting.configuredAccount.roleGroupsById.get(group.id);
                const components = [...accounting.daily.values()].reduce(
                  (total, rollup) => {
                    const day = qualifiedGroupSpendComponents(
                      rollup,
                      prepared.effectiveAuth,
                      [group],
                    );
                    const ownAgent = selfOnly
                      ? rollup.excludedInternalAgentSpendByGroupUser
                        ?.get(group.id)?.get(prepared.effectiveAuth.userId) ?? 0
                      : 0;
                    const ownOther = selfOnly
                      ? rollup.excludedInternalOtherSpendByGroupUser
                        ?.get(group.id)?.get(prepared.effectiveAuth.userId) ?? 0
                      : 0;
                    total.spendUsd += day.spendUsd + ownAgent + ownOther;
                    total.agentSpendUsd += day.agentSpendUsd + ownAgent;
                    total.otherServicesUsd += day.otherServicesUsd + ownOther;
                    return total;
                  },
                  { spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0 },
                );
                const allowedUserIds = new Set<string>(
                  prepared.effectiveAuth.roles.includes("account") ||
                    prepared.effectiveAuth.workspaceIds.includes(workspaceId)
                    ? [
                      ...(scopedMembers.get(group.id) ?? []),
                      ...[...accounting.daily.values()].flatMap((rollup) => [
                        ...(
                          rollup.aiSpendByGroup.get(group.id)?.keys() ?? []
                        ),
                        ...(
                          rollup.nonAiSpendByGroup.get(group.id)?.keys() ?? []
                        ),
                      ]),
                    ]
                    : prepared.effectiveAuth.groupUserIds?.[group.id] ?? [],
                );
                const hierarchyMembers = [...allowedUserIds].map((userId) => {
                  let memberAgent = 0;
                  let memberOther = 0;
                  for (const rollup of accounting.daily.values()) {
                    memberAgent +=
                      rollup.aiSpendByGroup.get(group.id)?.get(userId) ?? 0;
                    memberOther +=
                      rollup.nonAiSpendByGroup.get(group.id)?.get(userId) ?? 0;
                    if (selfOnly && userId === prepared.effectiveAuth.userId) {
                      memberAgent += rollup.excludedInternalAgentSpendByGroupUser
                        ?.get(group.id)?.get(userId) ?? 0;
                      memberOther += rollup.excludedInternalOtherSpendByGroupUser
                        ?.get(group.id)?.get(userId) ?? 0;
                    }
                  }
                  const member = detailDirectory.members.get(userId);
                  const workspaceMember = member?.workspaces.get(workspaceId);
                  const limit = resolveStoredMemberLimit(
                    detailDirectory,
                    workspaceId,
                    userId,
                  );
                  const cycleEntry =
                    currentCycle.members.get(workspaceId)?.get(userId);
                  const currentCycleAgentSpendUsd =
                    !currentWorkspaceComplete.get(workspaceId)
                    ? null
                    : member?.isInternalReplitUser
                      ? 0
                      : cycleEntry === undefined
                        ? 0
                        : cycleEntry.agentMetricsComplete === true
                          ? cycleEntry.aiCostUsd
                          : null;
                  const metrics = currentCycleLimitMetrics(
                    limit.amount,
                    currentCycleAgentSpendUsd,
                  );
                  return {
                    workspaceId,
                    userId,
                    username: member?.username ?? null,
                    email: member?.email ?? null,
                    name: member?.name ?? null,
                    role: workspaceMember?.role ?? null,
                    isDisabled: workspaceMember?.isDisabled ?? null,
                    isInternal: member?.isInternalReplitUser ?? false,
                    groupIds: [group.id],
                    spendUsd: round(memberAgent + memberOther),
                    agentSpendUsd: round(memberAgent),
                    otherServicesUsd: round(memberOther),
                    currentCycleAgentSpendUsd,
                    limitUsd: limit.amount,
                    remainingUsd: metrics.remainingUsd,
                    percentUsed: metrics.percentUsed,
                    limitState: limit.state,
                    limitObservationStatus:
                      detailDirectory.budgets.observation.status,
                  };
                }).sort((a, b) => a.userId.localeCompare(b.userId));
                const memberSpend = hierarchyMembers.reduce(
                  (sum, member) => sum + member.spendUsd,
                  0,
                );
                return {
                  groupId: group.id,
                  name: group.name,
                  familyKey: role?.familyKey ?? group.id,
                  spendUsd: round(components.spendUsd),
                  agentSpendUsd: round(components.agentSpendUsd),
                  otherServicesUsd: round(components.otherServicesUsd),
                  usageObserved: observedWorkspaceIds.has(workspaceId),
                  isComplete: workspaceComplete,
                  memberCount: new Set(
                    hierarchyMembers.map((member) => member.userId),
                  ).size,
                  unattributedSpendUsd: round(components.spendUsd - memberSpend),
                  members: hierarchyMembers,
                };
              });
            const spend = groupHierarchy.reduce(
              (sum, group) => sum + group.spendUsd,
              0,
            );
            const agent = groupHierarchy.reduce(
              (sum, group) => sum + group.agentSpendUsd,
              0,
            );
            return {
              workspaceId,
              workspaceName:
                detailDirectory.workspaces.get(workspaceId)?.name ?? null,
              spendUsd: round(spend),
              agentSpendUsd: round(agent),
              otherServicesUsd: round(spend - agent),
              usageObserved: observedWorkspaceIds.has(workspaceId),
              isComplete: workspaceComplete,
              memberCount: new Set(groupHierarchy.flatMap((group) =>
                group.members.map((member) => member.userId))).size,
              unattributedSpendUsd: round(
                spend - groupHierarchy.reduce(
                  (sum, group) => sum + group.spendUsd,
                  0,
                ),
              ),
              groups: groupHierarchy,
            };
          },
        ).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
        // Never hide a pool/source mismatch in an arbitrary workspace. The
        // source maps and pool row share one accounting generation, so more
        // than final-rounding drift is an invariant failure.
        if (teamRow) {
          const represented = workspaceRows.reduce(
            (sum, workspace) => sum + workspace.spendUsd,
            0,
          );
          const residual = round(teamRow.spendUsd - represented);
          if (Math.abs(residual) > 1e-7) {
            throw new Error(
              `Hierarchy source spend does not reconcile to team headline (${residual})`,
            );
          }
        }
        return workspaceRows;
      })()
      : undefined;
    const hierarchyMemberSpendUsd = hierarchy?.flatMap((workspace) =>
      workspace.groups.flatMap((group) => group.members))
      .reduce((sum, member) => sum + member.spendUsd, 0);
    const hierarchyMemberIds = hierarchy
      ? new Set(hierarchy.flatMap((workspace) =>
        workspace.groups.flatMap((group) =>
          group.members.map((member) => member.userId))))
      : null;
    const hierarchyUnattributedSpendUsd = hierarchy
      ? Math.round((
        canonicalHeadlineSpendUsd - hierarchy.reduce(
          (sum, workspace) => sum + workspace.spendUsd,
          0,
        ) + Number.EPSILON
      ) * 1e8) / 1e8
      : undefined;

    // A team headline is the canonical pool row, not a sum of current people
    // or display rows; this preserves committed accounting residuals.
    const spendUsd = canonicalHeadlineSpendUsd;
    const agentSpendUsd = teamRow?.agentSpendUsd ?? groupRows.reduce(
      (sum, group) => sum + group.agentSpendUsd, 0);
    const membersSpendUsd = members.reduce(
      (sum, member) => sum + member.spendUsd, 0);
    const allocationUsd = teamRow?.allocationUsd ?? (groupRows.length === 1
      ? groupRows[0]!.allocationUsd
      : null);
    const currentRelevantFailed = currentCycle.coverage.failedWorkspaceDays
      .filter((item) => requestedWorkspaceIds.has(item.workspaceId));
    const currentRelevantMissing = currentCycle.coverage.missingWorkspaceDays
      .filter((item) => requestedWorkspaceIds.has(item.workspaceId));
    const metricClassificationUnknown = members.some((member) =>
      currentWorkspaceComplete.get(member.workspaceId) &&
      member.currentCycleAgentSpendUsd === null);
    const requestedWorkspaceDays =
      requestedWorkspaceIds.size * accounting.usage.snapshot.coverage.requestedDays;
    const presentWorkspaceDays = Math.max(
      0,
      requestedWorkspaceDays - relevantMissing.length - relevantFailed.length,
    );
    const detailStatus = requestedWorkspaceIds.size === 0
      ? accounting.metadata.stale
        ? "stale" as const
        : "complete" as const
      : presentWorkspaceDays === 0
      ? "empty" as const
      : !selectedComplete
        ? "partial" as const
        : accounting.metadata.stale
          ? "stale" as const
          : "complete" as const;
    const detailQualifications = __reportingDetailBaseQualificationsForTests(
      accounting.metadata.qualifications,
    );
    if (!selectedComplete) {
      detailQualifications.push(
        "Usage coverage is partial; missing facts are not zero.",
      );
    }
    if (groupRows.some((group) =>
      group.sharedPool && group.allocationUsd === null)) {
      detailQualifications.push(
        "Shared allocation is unavailable; only authorized contribution is shown.",
      );
    }
    if (currentCycle.status === "stale") {
      detailQualifications.push(
        "Current-cycle Agent usage is stale; remaining may be outdated.",
      );
    }
    if (currentRelevantFailed.length > 0) {
      detailQualifications.push(
        "Current-cycle Agent usage is unavailable for an affected workspace.",
      );
    } else if (currentRelevantMissing.length > 0 ||
        currentCycle.status === "empty") {
      detailQualifications.push(
        "Current-cycle Agent usage is incomplete for an affected workspace.",
      );
    }
    if (metricClassificationUnknown) {
      detailQualifications.push(
        "Agent metric classification is unavailable for affected members.",
      );
    }
    const includeBudgetTracking = teamMode &&
      (parsed.data as { includeBudgetTracking?: boolean }).includeBudgetTracking === true;
    const trackingRange = teamMode
      ? (parsed.data as { trackingRange?: "budget" | "billing" | "selected" }).trackingRange ?? "budget"
      : "budget";
    const budgetTracking = includeBudgetTracking
      ? await (async () => {
        const budgetPeriod = fixedTeamBudgetPeriodAsOf();
        if (budgetPeriod.asOf === null) {
          return buildFixedTeamBudgetTracking({
            dailySpend: new Map(),
            unavailableDays: new Set(),
            scopeComplete: false,
            usageObserved: false,
            allocationUsd: null,
            canonicalSpendUsd: 0,
          });
        }
        assertStableReportingUsageGeneration(prepared.usageGeneration);
        const selectedTracking = trackingRange === "selected";
        const billingTracking = trackingRange === "billing";
        const billingMetadata = billingTracking ? getBillingPeriodMetadata() : null;
        const verifiedBilling = billingMetadata !== null &&
          !billingMetadata.isFallback;
        const budgetQuery = selectedTracking
          ? query
          : billingTracking
            ? {
              rangeType: "billing",
              viewScope: "all_authorized" as const,
            }
          : {
            rangeType: "custom",
            startDate: budgetPeriod.periodStart,
            endDate: budgetPeriod.asOf,
            viewScope: "all_authorized" as const,
          };
        const budgetPrepared = selectedTracking
          ? prepared
          : await prepareScopedAccounting(
            reportingAuthz,
            budgetQuery,
            undefined,
            prepared.configuration,
          );
        if (budgetPrepared.usageGeneration !== prepared.usageGeneration) {
          throw new ReportingUsageTransitionError();
        }
        // The selected report may have the same dates while still carrying a
        // workspace filter. Only selected tracking may reuse that projection.
        const budgetAccounting = selectedTracking &&
            accounting.period.start === windowFromQuery(budgetQuery).window.start &&
            accounting.period.endExclusive ===
              windowFromQuery(budgetQuery).window.end
          ? accounting
          : await buildScopedAccounting(
            reportingAuthz,
            budgetQuery,
            undefined,
            budgetPrepared,
          );
        assertStableReportingUsageGeneration(prepared.usageGeneration);
        const budgetTeamRow = budgetAccounting.poolRows.find((row) =>
          row.id === requestedPoolId);
        const fullFundingGroups = budgetAccounting.dir.groups.filter((group) =>
          budgetAccounting.fullTeamByGroup.get(groupTeamKey(group)) === teamRow!.name
        );
        const visibleFundingGroupIds = new Set(
          budgetTeamRow?.sourceGroupIds ?? [],
        );
        const visibleFundingGroups = fullFundingGroups.filter((group) =>
          visibleFundingGroupIds.has(group.id));
        const trackingGroups = selectedTracking
          ? selections.flatMap((selection) => selection.sources)
          : visibleFundingGroups;
        const selectedSourceIds = new Set(sourceGroups.map((group) => group.groupId));
        const scopeComplete = selectedTracking
          ? (parsed.data as { workspaceId?: string }).workspaceId === undefined &&
            canExposeCanonicalAllocation(prepared.effectiveAuth, fullFundingGroups) &&
            fullFundingGroups.every((group) => selectedSourceIds.has(group.id))
          : canExposeCanonicalAllocation(
            budgetPrepared.effectiveAuth,
            fullFundingGroups,
          );
        const fundingWorkspaceIds = new Set(
          trackingGroups.map((group) => group.workspaceId),
        );
        const relevantBudgetMissing =
          budgetAccounting.usage.snapshot.coverage.missingWorkspaceDays
            .filter((item) => fundingWorkspaceIds.has(item.workspaceId));
        const relevantBudgetFailed =
          budgetAccounting.usage.snapshot.coverage.failedWorkspaceDays
            .filter((item) => fundingWorkspaceIds.has(item.workspaceId));
        const unavailableByWorkspaceDay = new Set([
          ...relevantBudgetMissing.map((item) =>
            `${item.workspaceId}\0${item.usageDate}`),
          ...relevantBudgetFailed.map((item) =>
            `${item.workspaceId}\0${item.usageDate}`),
        ]);
        const unavailableDays = new Set([...budgetAccounting.daily.keys()]
          .filter((date) => fundingWorkspaceIds.size > 0 &&
            [...fundingWorkspaceIds].every((workspaceId) =>
              unavailableByWorkspaceDay.has(`${workspaceId}\0${date}`))));
        const dailySpend = new Map<string, number>();
        for (const [date, rollup] of budgetAccounting.daily) {
          if (unavailableDays.has(date.slice(0, 10))) continue;
          const components = qualifiedGroupSpendComponents(
            rollup,
            budgetPrepared.effectiveAuth,
            trackingGroups,
          );
          dailySpend.set(
            date.slice(0, 10),
            billingTracking ? components.agentSpendUsd : components.spendUsd,
          );
        }
        const effectiveBudgets = billingTracking
          ? await getEffectiveTeamBudgets()
          : null;
        const monthlyLimitUsd = effectiveBudgets?.teams.find((budget) =>
          budget.teamName === teamRow!.name && !budget.isHidden
        )?.monthlyLimitUsd ?? null;
        const agentBreakdownComplete = !billingTracking ||
          [...fundingWorkspaceIds].every((workspaceId) => {
            const workspaceMembers =
              budgetAccounting.usage.snapshot.members.get(workspaceId);
            return workspaceMembers !== undefined &&
              [...workspaceMembers.values()].every((entry) =>
                entry.agentMetricsComplete === true);
          });
        const billingUsageValid = verifiedBilling &&
          agentBreakdownComplete &&
          relevantBudgetMissing.length === 0 &&
          relevantBudgetFailed.length === 0;
        if (billingTracking && !billingUsageValid) {
          dailySpend.clear();
          for (
            let time = Date.parse(budgetAccounting.period.start);
            time < Date.parse(budgetAccounting.period.endExclusive);
            time += DAY_MS
          ) {
            unavailableDays.add(new Date(time).toISOString().slice(0, 10));
          }
        }
        const billingPeriodEnd = billingMetadata
          ? new Date(Date.parse(billingMetadata.end) - DAY_MS)
            .toISOString().slice(0, 10)
          : null;
        assertStableReportingUsageGeneration(budgetPrepared.usageGeneration);
        return buildFixedTeamBudgetTracking({
          dailySpend,
          unavailableDays,
          scopeComplete,
          usageObserved: billingTracking
            ? Boolean(billingUsageValid && budgetTeamRow?.usageObserved)
            : budgetTeamRow?.usageObserved ?? false,
          allocationUsd: billingTracking
            ? monthlyLimitUsd
            : budgetTeamRow?.allocationUsd ?? allocationUsd,
          canonicalSpendUsd: billingTracking
            ? budgetTeamRow?.agentSpendUsd ?? 0
            : budgetTeamRow?.spendUsd ?? 0,
          reporting: reportingSemanticsForGroups(
            budgetAccounting.daily,
            trackingGroups,
          ),
          budgetKind: billingTracking ? "monthly_agent" : "annual",
          workspaceCount: new Set(
            trackingGroups.map((group) => group.workspaceId),
          ).size,
          ...(billingTracking ? {
            periodStart: verifiedBilling
              ? billingMetadata!.start.slice(0, 10)
              : null,
            periodEnd: verifiedBilling ? billingPeriodEnd! : null,
            periodLabel: verifiedBilling ? billingMetadata!.label : "Billing cycle unavailable",
            asOf: verifiedBilling && budgetAccounting.period.endExclusive >
                budgetAccounting.period.start
              ? new Date(Date.parse(budgetAccounting.period.endExclusive) - DAY_MS)
                .toISOString().slice(0, 10)
              : null,
            reportingStart: budgetAccounting.period.start,
            reportingEndExclusive: budgetAccounting.period.endExclusive,
            reportingLabel: budgetAccounting.period.label,
          } : {}),
          ...(selectedTracking ? {
            reportingStart: budgetAccounting.period.start,
            reportingEndExclusive: budgetAccounting.period.endExclusive,
            reportingLabel: budgetAccounting.period.label,
            comparisonsMatchBudgetWindow:
              budgetAccounting.period.start === budgetPeriod.start &&
              budgetAccounting.period.endExclusive ===
                budgetPeriod.reportingEndExclusive,
          } : {}),
        });
      })()
      : undefined;
    assertStableReportingUsageGeneration(prepared.usageGeneration);
    const response = GetReportingDetailResponse.parse({
      kind: teamMode ? "team" : groupRows.length === 1 ? "group" : "family",
      ...(teamRow ? { id: teamRow.id, name: teamRow.name } : {}),
      ...(budgetTracking ? { budgetTracking } : {}),
      headline: {
        familyKey: teamMode ? null : families[0]!.familyKey,
        familyName: teamRow?.name ?? families[0]!.familyName,
        ...(teamRow ? { usageObserved: teamRow.usageObserved } : {}),
        spendUsd,
        agentSpendUsd,
        otherServicesUsd: teamRow?.otherServicesUsd ?? spendUsd - agentSpendUsd,
        allocationUsd,
        remainingUsd: comparisonsVerified && allocationUsd !== null
          ? allocationUsd - spendUsd
          : null,
        percentUsed: comparisonsVerified &&
            allocationUsd !== null && allocationUsd > 0
          ? spendUsd / allocationUsd * 100
          : null,
        memberCount: includeHierarchy
          ? hierarchyMemberIds!.size
          : members.length,
        membersSpendUsd: includeHierarchy
          ? hierarchyMemberSpendUsd!
          : membersSpendUsd,
        unattributedSpendUsd: includeHierarchy
          ? spendUsd - hierarchyMemberSpendUsd!
          : Math.max(0, spendUsd - membersSpendUsd),
        isComplete: selectedComplete,
      },
      ...(hierarchy ? { hierarchy } : {}),
      ...(hierarchyUnattributedSpendUsd !== undefined
        ? { hierarchyUnattributedSpendUsd }
        : {}),
      groups: restrictedOwnView ? [] : groupRows,
      sourceGroups: restrictedOwnView ? [] : sourceGroups,
      members: restrictedOwnView ? [] : members,
      period: accounting.period,
      metadata: {
        ...accounting.metadata,
        status: detailStatus,
        coverage: {
          ratio: requestedWorkspaceDays === 0
            ? 1
            : presentWorkspaceDays / requestedWorkspaceDays,
          requestedDays: accounting.usage.snapshot.coverage.requestedDays,
          missingDays: [...new Set(relevantMissing.map((item) => item.usageDate))],
          failedWorkspaceDays: relevantFailed.map(
            (item) => `${item.workspaceId}:${item.usageDate}`),
        },
        qualifications: detailQualifications,
      },
    });
    const projectionMs = performance.now() - projectionStartedAt;
    res.setHeader(
      "Server-Timing",
      [
        `authorization;dur=${(authorizedAt - startedAt).toFixed(1)}`,
        `stored-read;dur=${prepared.phaseDurations.storedReadsMs.toFixed(1)}`,
        `cache;dur=${accountingMs.toFixed(1)};desc="shared-accounting"`,
        `current-cycle;dur=${currentCycleMs.toFixed(1)};desc="usage-store"`,
        `projection;dur=${projectionMs.toFixed(1)}`,
        `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
      ].join(", "),
    );
    res.json(response);
  } catch (error) {
    if (error instanceof UsageWindowError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof ReportingUsageTransitionError) {
      res.locals.reportingUsageRefreshing = true;
      res.setHeader(
        "Retry-After",
        String(REPORTING_USAGE_RETRY_AFTER_SECONDS),
      );
      res.status(503).json({
        error: error.message,
        code: error.code,
      });
      return;
    }
    if (error instanceof Error &&
        error.message.startsWith("Hierarchy source spend does not reconcile")) {
      req.log.error({ err: error }, "reporting hierarchy invariant failed");
      res.status(503).json({
        error: "Reporting hierarchy does not reconcile to the team headline",
      });
      return;
    }
    req.log.error({ err: error }, "getReportingDetail failed");
    res.status(503).json({ error: "Reporting detail unavailable" });
  }
}

router.get("/reporting/details/:groupIds", reportingDetailHandler);
router.get("/reporting/teams/:poolId", reportingDetailHandler);

router.get("/groups/:groupId", async (req, res): Promise<void> => {
  const startedAt = performance.now();
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
    const billingWindow = windowFromQuery({ rangeType: "billing" }).window;
    const selectedIsBilling =
      usage.selection.window.start === billingWindow.start &&
      usage.selection.window.end === billingWindow.end;
    const cycleUsagePromise = selectedIsBilling
      ? Promise.resolve(usage)
      : usageForRequest(req.authz!, dir, { rangeType: "billing" }, true);
    const cycleMemberSnapshotPromise = selectedIsBilling
      ? Promise.resolve(usage.snapshot)
      : readUsageSnapshot({
        window: billingWindow,
        workspaceIds: workspaceScope(req.authz!, dir, usage.groups),
        includeAccountAnchor: isAccountWide(req.authz!),
      });
    const [
      cycleUsage,
      cycleMemberSnapshot,
      dailyRollups,
      budgets,
      groupTeamsRows,
    ] = await Promise.all([
      cycleUsagePromise,
      cycleMemberSnapshotPromise,
      dailyUsageRollups(dir, usage),
      db.select().from(groupBudgetsTable),
      Promise.resolve([...req.configurationSnapshot!.teamLimitTargets]),
    ]);
    const mergePlan = buildCanonicalGroupMergePlan(
      usage.groups,
      dir.workspaces,
      buildGroupTeamMap(
        usage.groups,
        buildSnapshotCanonicalAccount(dir, req.configurationSnapshot!),
        new Set(),
        req.configurationSnapshot!.teamLimitTargets,
        req.configurationSnapshot!.fundingGroupOverrides,
      ),
    );
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
    const sourceGroups = sourceIds.map((id) =>
      usage.groups.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is EnterpriseGroup => !!candidate);
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
    const qualifiedDataComplete = qualifiedGroupDataComplete(usage.snapshot);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const rollupMemberCounts = computeDedupedMemberCounts(usage.groups, scopedMembers);
    const projectAttribution = canonical.projectAttribution;
    const projectSpendUsd = sourceIds.reduce((sum, id) =>
      sum + (projectAttribution.spendByGroup.get(id) ?? 0), 0);
    const projectSpendLoaded = projectAttribution.isComplete;

    const attributedComponents = qualifiedGroupSpendComponents(
      canonical, req.authz!, sourceGroups);
    const attributed = {
      spendUsd: attributedComponents.spendUsd,
      byUser: (() => {
        const result = new Map<string, number>();
        for (const id of sourceIds) {
          for (const [userId, spend] of canonical.byGroup.get(id)?.byUser ?? []) {
            result.set(userId, (result.get(userId) ?? 0) + spend);
          }
        }
        return result;
      })(),
    };

    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const fullMergePlan = buildCanonicalGroupMergePlan(
      dir.groups,
      dir.workspaces,
      buildGroupTeamMap(
        dir.groups,
        buildSnapshotCanonicalAccount(dir, req.configurationSnapshot!),
        new Set(),
        groupTeamsRows,
        req.configurationSnapshot!.fundingGroupOverrides,
      ),
    );
    const fullPrimaryId = fullMergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const fullSourceIds = fullMergePlan.mergeMap.get(fullPrimaryId) ?? [group.id];
    const fullSourceGroups = fullSourceIds.map((id) =>
      dir.groups.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is EnterpriseGroup => !!candidate);
    const allocationAuthorized = canExposeCanonicalAllocation(
      req.authz!, fullSourceGroups) && fullSourceGroups.every((source) => {
        if (req.authz!.roles.includes("account") ||
            req.authz!.workspaceIds.includes(source.workspaceId)) return true;
        const visible = new Set(scopedMembers.get(source.id) ?? []);
        return (dir.groupMembers.get(source.id) ?? [])
          .every((userId) => visible.has(userId));
      });
    const mergedBudget = allocationAuthorized
      ? resolveCanonicalMergedGroupBudget(fullPrimaryId, fullMergePlan, budgetMap)
      : null;
    const budget = effectiveGroupBudget(mergedBudget?.amountUsd);
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingPeriodStart = getBillingPeriod().start;
    const fired =
      billingPeriodStart && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingPeriodStart)
        : [];

    const detailHistoryArr = [...dailyRollups].map(([date, daily]) => ({
      date,
      spendUsd: qualifiedGroupSpendComponents(
        daily, req.authz!, sourceGroups).spendUsd,
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
      const spendLoaded = qualifiedDataComplete;
      const totalSpendLoaded = qualifiedDataComplete;
      const aiSpendUsd = sourceIds.reduce((sum, id) =>
        sum + (canonical.aiSpendByGroup.get(id)?.get(userId) ?? 0), 0);
      const nonAiSpendUsd = sourceIds.reduce((sum, id) =>
        sum + (canonical.nonAiSpendByGroup.get(id)?.get(userId) ?? 0), 0);
      const totalSpendUsd = aiSpendUsd + nonAiSpendUsd;
      const limitWorkspaceId = m?.workspaces.has(group.workspaceId)
        ? group.workspaceId
        : sourceGroups.find((source) => m?.workspaces.has(source.workspaceId))
          ?.workspaceId ?? group.workspaceId;
      const limit = resolveStoredMemberLimit(dir, limitWorkspaceId, userId);
      const cycleWorkspaceComplete = cycleMemberSnapshot.status !== "empty" &&
        !cycleMemberSnapshot.coverage.failedWorkspaceDays.some(
          (item) => item.workspaceId === limitWorkspaceId,
        ) &&
        !cycleMemberSnapshot.coverage.missingWorkspaceDays.some(
          (item) => item.workspaceId === limitWorkspaceId,
        );
      const cycleEntry =
        cycleMemberSnapshot.members.get(limitWorkspaceId)?.get(userId);
      const cycleAgentSpendUsd = !cycleWorkspaceComplete
        ? null
        : m?.isInternalReplitUser
          ? 0
          : cycleEntry === undefined
            ? 0
            : cycleEntry.agentMetricsComplete === true
              ? cycleEntry.aiCostUsd
              : null;
      return {
        userId,
        username: m?.username ?? null,
        email: m?.email ?? null,
        name: m?.name ?? null,
        role: ws?.role ?? null,
        isDisabled: ws?.isDisabled ?? null,
        isInternal: m?.isInternalReplitUser ?? false,
        allocatedBudgetUsd: limit.amount,
        budgetSource: limit.state === "explicit"
          ? "workspace_user_limit"
          : limit.state === "inherited"
            ? "workspace_default_user_limit"
            : null,
        limitState: limit.state,
        limitObservationStatus: dir.budgets.observation.status,
        spendLoaded,
        spendUsd: totalSpendUsd,
        aiSpendUsd,
        nonAiSpendUsd,
        remainingUsd: limit.amount === null || cycleAgentSpendUsd === null
          ? null
          : limit.amount - cycleAgentSpendUsd,
        percentUsed: limit.amount !== null && limit.amount > 0 &&
            cycleAgentSpendUsd !== null
          ? (cycleAgentSpendUsd / limit.amount) * 100
          : null,
      };
    });

    // Reconciliation: members removed from the group since the last sync still count
    // toward group spend (they are captured in the rollup).  unattributedSpendUsd
    // surfaces that residual so the cluster page can show an accurate attributed total.
    const combinedSpend = attributed.spendUsd;
    const combinedLoaded = qualifiedDataComplete;
    const totalSpendLoaded = qualifiedDataComplete;
    let listedMembersSpend = 0;
    for (const userId of userIds) {
      listedMembersSpend += sourceIds.reduce(
        (sum, id) =>
          sum + (canonical.aiSpendByGroup.get(id)?.get(userId) ?? 0) +
          (canonical.nonAiSpendByGroup.get(id)?.get(userId) ?? 0),
        0,
      );
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
    const unattributed = Math.max(0, combinedSpend - listedMembersSpend);

    const mergedRollupMemberCount = sourceIds.reduce(
      (sum, id) => sum + (rollupMemberCounts.get(id) ?? 0),
      0,
    );
    const monthlyAgentLimitUsd = allocationAuthorized &&
      hasSuccessfulLimitObservation(dir.budgets)
      ? dir.budgets.groupLimits.get(group.workspaceId)?.get(group.id) ?? null
      : null;
    const cycleAgentSpendUsd = qualifiedGroupSpendComponents(
      cycleUsage.rollup, req.authz!, sourceGroups).agentSpendUsd;
    const hasAgentLimit = monthlyAgentLimitUsd != null && monthlyAgentLimitUsd > 0;

    res.setHeader("Server-Timing", `group;dur=${(performance.now() - startedAt).toFixed(1)}`);
    res.json(
      GetGroupDetailResponse.parse({
        group: {
          groupId: group.id,
          workspaceId: group.workspaceId,
          workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
          name: group.name,
          familyKey: buildSnapshotCanonicalAccount(
            dir,
            req.configurationSnapshot!,
          ).roleGroupsById.get(group.id)!.familyKey,
          familyName: buildSnapshotCanonicalAccount(
            dir,
            req.configurationSnapshot!,
          ).roleGroupsById.get(group.id)!.familyName,
          role: buildSnapshotCanonicalAccount(
            dir,
            req.configurationSnapshot!,
          ).roleGroupsById.get(group.id)!.role,
          isLegacy: buildSnapshotCanonicalAccount(
            dir,
            req.configurationSnapshot!,
          ).roleGroupsById.get(group.id)!.isLegacy,
          teamName: targetTeamForGroup(
            group,
            buildSnapshotCanonicalAccount(dir, req.configurationSnapshot!),
            groupTeamsRows,
            req.configurationSnapshot!.fundingGroupOverrides,
          ) ?? null,
          type: group.type,
          memberCount: userIds.length,
          rollupMemberCount: mergedRollupMemberCount,
          spendLoaded: totalSpendLoaded,
          spendUsd: combinedSpend,
          paceSpendLoaded: false,
          paceSpendUsd: combinedSpend,
          projectSpendLoaded,
          projectSpendUsd,
          rollupSpendLoaded: qualifiedDataComplete,
          rollupSpendUsd: combinedSpend,
          spendUpdatedAt: usage.snapshot.dataAsOf,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd: combinedLoaded && hasBudget ? budget.amountUsd! - combinedSpend : null,
          percentUsed: combinedLoaded && hasBudget ? (combinedSpend / budget.amountUsd!) * 100 : null,
          monthlyAgentLimitUsd,
          cycleAgentSpendUsd,
          agentRemainingUsd: hasAgentLimit
            ? monthlyAgentLimitUsd! - cycleAgentSpendUsd
            : null,
          agentPercentUsed: hasAgentLimit
            ? (cycleAgentSpendUsd / monthlyAgentLimitUsd!) * 100
            : null,
          agentBlocked: hasAgentLimit && cycleAgentSpendUsd >= monthlyAgentLimitUsd!,
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
        usageHealth: qualifiedGroupUsageHealth(usage),
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
    const mergePlan = buildCanonicalGroupMergePlan(
      usage.groups,
      dir.workspaces,
      buildGroupTeamMap(
        usage.groups,
        buildSnapshotCanonicalAccount(dir, req.configurationSnapshot!),
        new Set(),
        req.configurationSnapshot!.teamLimitTargets,
        req.configurationSnapshot!.fundingGroupOverrides,
      ),
    );
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
    const sourceGroups = sourceIds.map((id) =>
      usage.groups.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is EnterpriseGroup => !!candidate);
    const titlesComplete = sourceGroups.every((source) =>
      usage.projectMetadata.completeWorkspaceIds.has(source.workspaceId));
    const isComplete = qualifiedGroupDataComplete(usage.snapshot) && titlesComplete;
    const projects = sourceGroups.flatMap((source) =>
      Array.from(usage.snapshot.projects.get(source.workspaceId)?.entries() ?? [])
          .filter(([projectId]) => {
            const key = projectAttributionKey(source.workspaceId, projectId);
            const creatorId =
              usage.rollup.projectAttribution.creatorByProject.get(key) ?? null;
            return usage.rollup.projectAttribution.projectToGroup.get(key) === source.id &&
              creatorId !== null &&
              (scopedMembers.get(source.id) ?? []).includes(creatorId);
          })
          .map(([projectId, p]) => {
            const info = usage.projectMetadata.byWorkspace
              .get(source.workspaceId)?.get(projectId);
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
                (scopedMembers.get(source.id) ?? []).includes(creatorId),
              metrics: [],
              workspaceId: source.workspaceId,
              workspaceName: dir.workspaces.get(source.workspaceId)?.name ?? null,
            };
          }))
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    // Reconciliation: sum of project rows vs. group total.
    // Anchor to groupSpend.spendUsd (the same figure shown in the header stat card)
    // so the project table total always matches the group's reported spend.
    // Fall back to projectUsage.totalCostUsd only when the plain-group spend
    // hasn't loaded yet.
    const projectsSum = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
    const groupTotal = qualifiedGroupSpendComponents(
      usage.rollup, req.authz!, sourceGroups).spendUsd;
    const unattributedSpendUsd = Math.max(0, groupTotal - projectsSum);

    res.json(
      GetGroupProjectsResponse.parse({
        projects,
        unattributedSpendUsd,
        isComplete,
        titlesComplete,
        usageHealth: qualifiedGroupUsageHealth(usage),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getGroupProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/clusters/:clusterKey/headline", async (req, res): Promise<void> => {
  try {
    const groupIds = String(req.params["clusterKey"])
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
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
    const roleOrder = { admin: 0, member: 1, viewer: 2, guest: 3, unsuffixed: 4 };
    const requestedFamilies = requested.map(
      (group) => buildSnapshotCanonicalAccount(
        dir,
        req.configurationSnapshot!,
      ).roleGroupsById.get(group!.id)!,
    );
    const familyName = requestedFamilies[0]!.familyName;
    const roles = [...new Set(requestedFamilies.map((family) => family.role))]
      .sort((a, b) => roleOrder[a] - roleOrder[b]);
    const usage = await usageForRequest(req.authz!, dir, req.query as Record<string, unknown>);
    const visible = usage.groups;
    const accountMergePlan = buildCanonicalGroupMergePlan(
      visible,
      dir.workspaces,
      buildGroupTeamMap(
        visible,
        buildSnapshotCanonicalAccount(dir, req.configurationSnapshot!),
        new Set(),
        req.configurationSnapshot!.teamLimitTargets,
        req.configurationSnapshot!.fundingGroupOverrides,
      ),
    );
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
      familyName,
      roles,
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


export default router;
