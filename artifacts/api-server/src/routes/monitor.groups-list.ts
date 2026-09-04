import { Router } from "express";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

router.get("/groups", async (req, res): Promise<void> => {
  try {
    const dir = await getDirectory();
    const usage = await usageForRequest(
      req.authz!, dir, req.query as Record<string, unknown>, true);
    const cycleUsage = await usageForRequest(
      req.authz!, dir, { rangeType: "billing" }, true);
    const dailyRollups = await dailyUsageRollups(dir, usage);
    const [budgets, assignments, teamSnapshot, teamRows] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(teamLimitTargetsTable),
      getEffectiveTeamBudgets(),
      db.select().from(teamBudgetsTable),
    ]);
    const hiddenTeams = new Set(teamRows.filter((row) => row.isHidden).map((row) => row.teamName));
    const teamByGroup = buildGroupTeamMap(usage.groups, dir.account, hiddenTeams, assignments);
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
      const monthlyAgentLimitUsd =
        dir.budgets.groupLimits.get(group.workspaceId)?.get(group.id) ?? null;
      const cycleAgentSpendUsd = sourceIds.reduce(
        (sum, id) =>
          sum + [...(cycleUsage.rollup.aiSpendByGroup.get(id)?.values() ?? [])]
            .reduce((subtotal, amount) => subtotal + amount, 0),
        0,
      );
      const hasAgentLimit = monthlyAgentLimitUsd != null && monthlyAgentLimitUsd > 0;
      const canonicalGroup = dir.account.roleGroupsById.get(group.id)!;
      return {
        groupId: group.id, workspaceId: group.workspaceId,
        workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
        name: group.name,
        familyKey: canonicalGroup.familyKey,
        familyName: canonicalGroup.familyName,
        role: canonicalGroup.role,
        isLegacy: canonicalGroup.isLegacy,
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
        monthlyAgentLimitUsd,
        cycleAgentSpendUsd,
        agentRemainingUsd: hasAgentLimit
          ? monthlyAgentLimitUsd! - cycleAgentSpendUsd
          : null,
        agentPercentUsed: hasAgentLimit
          ? (cycleAgentSpendUsd / monthlyAgentLimitUsd!) * 100
          : null,
        agentBlocked: hasAgentLimit && cycleAgentSpendUsd >= monthlyAgentLimitUsd!,
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
        name: "No group", familyKey: `no-group:${workspaceId}`, familyName: "No group",
        role: "unsuffixed", isLegacy: workspaceId === "1awqan",
        teamName: null, type: "synthetic", isSynthetic: true,
        syntheticKind: "no_group", memberCount: ungrouped.memberCount,
        rollupMemberCount: ungrouped.memberCount, spendLoaded: complete,
        spendUsd: ungrouped.spendUsd, paceSpendLoaded: complete,
        paceSpendUsd: ungrouped.spendUsd, projectSpendLoaded: true, projectSpendUsd: 0,
        rollupSpendLoaded: complete, rollupSpendUsd: ungrouped.spendUsd,
        rawMemberSpendUsd: 0, rawMemberSpendLoaded: false,
        spendUpdatedAt: usage.snapshot.dataAsOf, budgetUsd: null, budgetSource: null,
        remainingUsd: null, percentUsed: null, thresholdsFired: [], history: [],
        monthlyAgentLimitUsd: null, cycleAgentSpendUsd: 0,
        agentRemainingUsd: null, agentPercentUsed: null, agentBlocked: false,
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
    const workspaceTeamSpend = new Map<string, {
      workspaceId: string;
      teamName: string;
      spendUsd: number;
    }>();
    for (const group of usage.groups) {
      const teamName = teamByGroup.get(groupTeamKey(group));
      if (!teamName) continue;
      const key = `${group.workspaceId}\0${teamName}`;
      const current = workspaceTeamSpend.get(key);
      workspaceTeamSpend.set(key, {
        workspaceId: group.workspaceId,
        teamName,
        spendUsd: (current?.spendUsd ?? 0) +
          (usage.rollup.byGroup.get(group.id)?.spendUsd ?? 0),
      });
    }
    const workspaceTeamRawSpend = [...workspaceTeamSpend.values()].sort((a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) || a.teamName.localeCompare(b.teamName)
    );
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
      teamRawSpend, workspaceTeamRawSpend,
      teamBudgets: Object.fromEntries(effectiveTeamBudgetMap),
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


export default router;
