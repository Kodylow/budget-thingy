import { Router } from "express";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

export function shouldHideCanonicalDashboardGroup(input: {
  usageComplete: boolean;
  spendUsd: number;
  effectiveTeamNames: ReadonlySet<string>;
  hiddenTeamNames: ReadonlySet<string>;
}): boolean {
  if (!input.usageComplete || input.spendUsd !== 0 || input.effectiveTeamNames.size !== 1) {
    return false;
  }
  return input.hiddenTeamNames.has([...input.effectiveTeamNames][0]!);
}

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
    const effectiveTeamByGroup = buildGroupTeamMap(
      usage.groups,
      dir.account,
      new Set(),
      assignments,
    );
    const teamByGroup = buildGroupTeamMap(usage.groups, dir.account, hiddenTeams, assignments);
    const mergePlan = buildCanonicalGroupMergePlan(
      usage.groups,
      dir.workspaces,
      effectiveTeamByGroup,
    );
    const displayGroups = usage.groups.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
    const budgetMap = new Map(budgets.map((row) => [row.groupId, row.amountUsd]));
    const effectiveTeamBudgetMap = new Map(teamSnapshot.teams
      .filter((team) => !team.isHidden)
      .map((team) => [team.teamName, team.effectiveAmountUsd]));
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const memberCounts = computeDedupedMemberCounts(usage.groups, scopedMembers);
    const billing = getBillingPeriod();
    const complete = usage.rollup.isComplete;
    const groupsById = new Map(usage.groups.map((group) => [group.id, group]));
    const visibleDisplayGroups = displayGroups.filter((group) => {
      if (!complete) return true;
      const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
      const spendUsd = sourceIds.reduce(
        (sum, id) => sum + (usage.rollup.byGroup.get(id)?.spendUsd ?? 0), 0);
      if (spendUsd !== 0) return true;
      const effectiveTeams = new Set(sourceIds.flatMap((id) => {
        const source = groupsById.get(id);
        if (!source) return [];
        const teamName = effectiveTeamByGroup.get(groupTeamKey(source));
        return teamName ? [teamName] : [];
      }));
      return !shouldHideCanonicalDashboardGroup({
        usageComplete: complete,
        spendUsd,
        effectiveTeamNames: effectiveTeams,
        hiddenTeamNames: hiddenTeams,
      });
    });
    const fired = billing.start
      ? await getFiredThresholdsBatch(visibleDisplayGroups.map((group) => group.id), billing.start)
      : new Map<string, number[]>();
    const groups = visibleDisplayGroups.map((group) => {
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
      const cycleAgentSpendLoaded = cycleUsage.rollup.isComplete;
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
        cycleAgentSpendUsd: cycleAgentSpendLoaded ? cycleAgentSpendUsd : null,
        agentRemainingUsd: cycleAgentSpendLoaded && hasAgentLimit
          ? monthlyAgentLimitUsd! - cycleAgentSpendUsd
          : null,
        agentPercentUsed: cycleAgentSpendLoaded && hasAgentLimit
          ? (cycleAgentSpendUsd / monthlyAgentLimitUsd!) * 100
          : null,
        agentBlocked: cycleAgentSpendLoaded
          ? hasAgentLimit && cycleAgentSpendUsd >= monthlyAgentLimitUsd!
          : null,
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
      if (
        !isAccountWide(req.authz!) &&
        !req.authz!.workspaceIds.includes(workspaceId)
      ) continue;
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
        monthlyAgentLimitUsd: null, cycleAgentSpendUsd: null,
        agentRemainingUsd: null, agentPercentUsed: null, agentBlocked: false,
        projectedSpendUsd: null,
      });
    }
    const roleOrder = { admin: 0, member: 1, viewer: 2, guest: 3, unsuffixed: 4 };
    type ResponseGroup = (typeof groups)[number];
    type FamilyNode = {
      familyKey: string;
      familyName: string;
      isLegacy: boolean;
      memberCount: number;
      spendUsd: number;
      spendLoaded: boolean;
      groups: ResponseGroup[];
    };
    type TeamNode = { teamName: string | null; families: FamilyNode[] };
    type WorkspaceNode = {
      workspaceId: string;
      workspaceName: string | null;
      teams: TeamNode[];
    };
    const workspaceNodes = new Map<string, WorkspaceNode>();
    for (const group of groups) {
      const workspace = workspaceNodes.get(group.workspaceId) ?? {
        workspaceId: group.workspaceId,
        workspaceName: group.workspaceName,
        teams: [],
      };
      if (!workspaceNodes.has(group.workspaceId)) {
        workspaceNodes.set(group.workspaceId, workspace);
      }
      let team = workspace.teams.find((item) => item.teamName === group.teamName);
      if (!team) {
        team = { teamName: group.teamName, families: [] };
        workspace.teams.push(team);
      }
      let family = team.families.find(
        (item) =>
          item.familyKey === group.familyKey &&
          item.isLegacy === group.isLegacy,
      );
      if (!family) {
        family = {
          familyKey: group.familyKey,
          familyName: group.familyName,
          isLegacy: group.isLegacy,
          memberCount: 0,
          spendUsd: 0,
          spendLoaded: true,
          groups: [],
        };
        team.families.push(family);
      }
      family.groups.push(group);
      family.memberCount += group.rollupMemberCount;
      family.spendUsd += group.rollupSpendUsd;
      family.spendLoaded &&= group.rollupSpendLoaded;
    }
    const hierarchy = [...workspaceNodes.values()]
      .map((workspace) => ({
        ...workspace,
        teams: workspace.teams
          .map((team) => ({
            ...team,
            families: team.families
              .map((family) => ({
                ...family,
                groups: family.groups.sort(
                  (a, b) =>
                    roleOrder[a.role] - roleOrder[b.role] ||
                    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
                ),
              }))
              .sort(
                (a, b) =>
                  a.familyName.localeCompare(b.familyName, undefined, { sensitivity: "base" }) ||
                  a.familyKey.localeCompare(b.familyKey) ||
                  Number(a.isLegacy) - Number(b.isLegacy),
              ),
          }))
          .sort((a, b) =>
            (a.teamName ?? "Unassigned").localeCompare(
              b.teamName ?? "Unassigned",
              undefined,
              { sensitivity: "base" },
            )),
      }))
      .sort(
        (a, b) =>
          (a.workspaceName ?? a.workspaceId).localeCompare(
            b.workspaceName ?? b.workspaceId,
            undefined,
            { sensitivity: "base" },
          ) || a.workspaceId.localeCompare(b.workspaceId),
      );
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
    const fullyVisibleWorkspaceIds = new Set(req.authz!.workspaceIds);
    const accountedGroupIds = new Set(displayGroups
      .flatMap((group) => mergePlan.mergeMap.get(group.id) ?? [group.id])
      .filter((groupId) => {
        const group = usage.groups.find((candidate) => candidate.id === groupId);
        return group && !fullyVisibleWorkspaceIds.has(group.workspaceId);
      }));
    const scopedEligibleSpendUsd =
      [...fullyVisibleWorkspaceIds].reduce(
        (sum, workspaceId) =>
          sum + (usage.rollup.byWorkspace.get(workspaceId) ?? 0),
        0,
      ) +
      [...accountedGroupIds].reduce(
        (sum, groupId) =>
          sum + (usage.rollup.byGroup.get(groupId)?.spendUsd ?? 0),
        0,
      );
    const scopedExcludedInternalSpendUsd =
      [...fullyVisibleWorkspaceIds].reduce(
        (sum, workspaceId) =>
          sum +
          (usage.rollup.excludedInternalSpendByWorkspace.get(workspaceId) ?? 0),
        0,
      ) +
      [...accountedGroupIds].reduce(
        (sum, groupId) =>
          sum + (usage.rollup.excludedInternalSpendByGroup.get(groupId) ?? 0),
        0,
      );
    const eligibleSpendUsd = isAccountWide(req.authz!)
      ? usage.rollup.eligibleSpendUsd
      : scopedEligibleSpendUsd;
    const excludedInternalSpendUsd = isAccountWide(req.authz!)
      ? usage.rollup.excludedInternalSpendUsd
      : scopedExcludedInternalSpendUsd;
    const grossSpendUsd = isAccountWide(req.authz!)
      ? usage.rollup.grossSpendUsd
      : eligibleSpendUsd + excludedInternalSpendUsd;
    res.json(ListGroupsResponse.parse({
      groups, hierarchy, isComplete: complete, syncStatus: usage.snapshot.status,
      syncError: null, pendingCount: usage.rollup.pendingCount,
      failedCount: usage.snapshot.coverage.failedWorkspaceDays.length,
      partialCount: usage.snapshot.coverage.missingWorkspaceDays.length,
      projectSyncStatus: usage.rollup.projectAttribution.isComplete ? "complete" : "partial",
      projectSyncError: null, projectPendingCount: usage.rollup.projectAttribution.pendingCount,
      projectFailedCount: 0, projectPartialCount: usage.rollup.projectAttribution.pendingCount,
      billingPeriodLabel: usage.selection.label,
      grossSpendUsd,
      excludedInternalSpendUsd,
      eligibleSpendUsd,
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
