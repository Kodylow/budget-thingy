import { Router, type Request } from "express";
import {
  GetBudgetTeamReportQueryParams,
  GetReportingDetailQueryParams,
  GetReportingDetailResponse,
} from "@workspace/api-zod";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

import {
  buildScopedAccounting,
  canExposeCanonicalAllocation,
  currentCycleLimitMetrics,
  getCurrentCycleMemberSnapshot,
  prepareScopedAccounting,
  qualifiedGroupSpendComponents,
  resolveStoredMemberLimit,
} from "../services/scoped-accounting";
import { hasSuccessfulLimitObservation } from "../lib/enterprise";
import { UsageWindowError } from "../lib/usage-window";
import { authorizeSpendView } from "./monitor.spend-tables";

const router = Router();
const MAX_REPORTING_GROUP_IDS = 32;
const DAY_MS = 86_400_000;

function reportingQuery(req: Request, teamMode: boolean) {
  if (!teamMode) return GetReportingDetailQueryParams.safeParse(req.query);
  const raw = req.query["includeBudgetTracking"];
  return GetBudgetTeamReportQueryParams.safeParse({
    ...req.query,
    includeBudgetTracking: raw === "true",
  });
}

export function buildBudgetTrackingPoints(
  start: string,
  endExclusive: string,
  dailySpend: ReadonlyMap<string, number>,
  unavailableDays: ReadonlySet<string>,
): Array<{ date: string; spendUsd: number | null }> {
  const points: Array<{ date: string; spendUsd: number | null }> = [];
  let cumulative = 0;
  for (
    let time = Date.parse(start);
    time < Date.parse(endExclusive);
    time += DAY_MS
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    cumulative += dailySpend.get(date) ?? 0;
    if (unavailableDays.has(date)) {
      points.push({ date, spendUsd: null });
      continue;
    }
    points.push({ date, spendUsd: cumulative });
  }
  return points;
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
  if (teamMode && !authorizeSpendView(req.authz!, "pools")) {
    res.status(403).json({ error: "The pools view is outside your authorized scope" });
    return;
  }
  const rawBudgetTracking = req.query["includeBudgetTracking"];
  if (
    teamMode &&
    rawBudgetTracking !== undefined &&
    rawBudgetTracking !== "true" &&
    rawBudgetTracking !== "false"
  ) {
    res.status(400).json({ error: "includeBudgetTracking must be true or false" });
    return;
  }
  const parsed = reportingQuery(req, teamMode);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
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
    const authorizedAt = performance.now();

    const query = { ...parsed.data, viewScope: "all_authorized" as const };
    const prepared = await prepareScopedAccounting(
      req.authz!,
      query,
      undefined,
      req.configurationSnapshot,
    );
    const accountingStartedAt = performance.now();
    const accounting = await buildScopedAccounting(
      req.authz!,
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
      req.authz!,
      detailDirectory.groupMembers,
    );
    const relevantMissing = accounting.usage.snapshot.coverage.missingWorkspaceDays
      .filter((item) => requestedWorkspaceIds.has(item.workspaceId));
    const relevantFailed = accounting.usage.snapshot.coverage.failedWorkspaceDays
      .filter((item) => requestedWorkspaceIds.has(item.workspaceId));
    const selectedComplete = requestedWorkspaceIds.size === 0 ||
      (accounting.usage.snapshot.workspaceStatus !== "empty" &&
        relevantMissing.length === 0 &&
        relevantFailed.length === 0);
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

    const groupRows = selections.map(({ display: group, sources }, index) => {
      const components = [...accounting.daily.values()].reduce(
        (total, rollup) => {
          const day = qualifiedGroupSpendComponents(
            rollup,
            req.authz!,
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
        remainingUsd: selectedComplete && allocationUsd !== null
          ? allocationUsd - components.spendUsd
          : null,
        percentUsed: selectedComplete && allocationUsd !== null && allocationUsd > 0
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

    // A team headline is the canonical pool row, not a sum of current people
    // or display rows; this preserves committed accounting residuals.
    const spendUsd = teamRow?.spendUsd ??
      groupRows.reduce((sum, group) => sum + group.spendUsd, 0);
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
        "Partial usage coverage for the requested workspaces; missing facts are not zero.",
      );
    }
    if (groupRows.some((group) =>
      group.sharedPool && group.allocationUsd === null)) {
      detailQualifications.push(
        "Shared canonical allocation is unavailable for this scope; only authorized contribution is shown.",
      );
    }
    if (currentCycle.status === "stale") {
      detailQualifications.push(
        "Current-cycle Agent usage is stale; known values are shown and limit remaining may be outdated.",
      );
    }
    if (currentRelevantFailed.length > 0) {
      detailQualifications.push(
        "Current-cycle Agent usage failed for a requested workspace; affected usage and remaining values are unknown.",
      );
    } else if (currentRelevantMissing.length > 0 ||
        currentCycle.status === "empty") {
      detailQualifications.push(
        "Current-cycle Agent usage is incomplete for a requested workspace; affected usage and remaining values are unknown.",
      );
    }
    if (metricClassificationUnknown) {
      detailQualifications.push(
        "Current-cycle Agent metric classification is unavailable for one or more members; affected usage and remaining values are unknown.",
      );
    }
    const includeBudgetTracking = teamMode &&
      (parsed.data as { includeBudgetTracking?: boolean }).includeBudgetTracking === true;
    const budgetTracking = includeBudgetTracking
      ? (() => {
        const selectedSourceIds = new Set(sourceGroups.map((group) => group.groupId));
        const fullFundingGroups = accounting.dir.groups.filter((group) =>
          accounting.fullTeamByGroup.get(groupTeamKey(group)) === teamRow!.name
        );
        const scopeComplete =
          canExposeCanonicalAllocation(req.authz!, fullFundingGroups) &&
          fullFundingGroups.every((group) => selectedSourceIds.has(group.id));
        const unavailableDays = new Set([
          ...relevantMissing.map((item) => item.usageDate),
          ...relevantFailed.map((item) => item.usageDate),
        ]);
        const dailySpend = new Map<string, number>();
        for (const [date, rollup] of accounting.daily) {
          dailySpend.set(
            date.slice(0, 10),
            qualifiedGroupSpendComponents(
              rollup,
              req.authz!,
              selections.flatMap((selection) => selection.sources),
            ).spendUsd,
          );
        }
        const points = buildBudgetTrackingPoints(
          accounting.period.start,
          accounting.period.endExclusive,
          dailySpend,
          unavailableDays,
        );
        // No persisted allocation start/end currently exists in the budget
        // snapshot. Reporting through today must not be promoted to a budget
        // term, so period-dependent comparisons remain explicitly withheld.
        const periodStart = null;
        const periodEnd = null;
        const usageComplete = false;
        const benchmarkEligible = false;
        const qualification = !scopeComplete
          ? "The full funding team is outside the authorized scope; allocation-period comparisons are withheld."
          : "The persisted allocation period is unavailable; remaining, percent used, and benchmark are withheld.";
        return {
          periodStart,
          periodEnd,
          periodLabel: "Allocation period unavailable",
          asOf: accounting.metadata.dataAsOf ?? null,
          allocationUsd: scopeComplete ? allocationUsd : null,
          spendUsd: teamRow!.usageObserved ? teamRow!.spendUsd : null,
          remainingUsd: null,
          percentUsed: null,
          scopeComplete,
          usageComplete,
          benchmarkEligible,
          qualification,
          points,
        };
      })()
      : undefined;
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
        remainingUsd: selectedComplete && allocationUsd !== null
          ? allocationUsd - spendUsd
          : null,
        percentUsed: selectedComplete && allocationUsd !== null && allocationUsd > 0
          ? spendUsd / allocationUsd * 100
          : null,
        memberCount: members.length,
        membersSpendUsd,
        unattributedSpendUsd: Math.max(0, spendUsd - membersSpendUsd),
        isComplete: selectedComplete,
      },
      groups: groupRows,
      sourceGroups,
      members,
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
      db.select().from(teamLimitTargetsTable),
    ]);
    const mergePlan = buildCanonicalGroupMergePlan(usage.groups, dir.workspaces);
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
    const fullMergePlan = buildCanonicalGroupMergePlan(dir.groups, dir.workspaces);
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
          familyKey: dir.account.roleGroupsById.get(group.id)!.familyKey,
          familyName: dir.account.roleGroupsById.get(group.id)!.familyName,
          role: dir.account.roleGroupsById.get(group.id)!.role,
          isLegacy: dir.account.roleGroupsById.get(group.id)!.isLegacy,
          teamName: targetTeamForGroup(group, dir.account, groupTeamsRows) ?? null,
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
    const mergePlan = buildCanonicalGroupMergePlan(usage.groups, dir.workspaces);
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
      (group) => dir.account.roleGroupsById.get(group!.id)!,
    );
    const familyName = requestedFamilies[0]!.familyName;
    const roles = [...new Set(requestedFamilies.map((family) => family.role))]
      .sort((a, b) => roleOrder[a] - roleOrder[b]);
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
