import { Router } from "express";
import { type TeamAlertCanonicalScope } from "./monitor.shared";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

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
        let alertTeamScope: TeamAlertCanonicalScope = new Map();

        try {
            const dir = await getDirectory();
            const usage = await usageForRequest(authz, dir, req.query as Record<string, unknown>);
            scoped = usage.groups;
            snapshot = usage.snapshot;
            visibleGroupIds = new Set(scoped.map((g) => g.id));
            const groupTeamMap = buildGroupTeamMap(
              scoped,
              dir.account,
              hiddenSummaryTeamNames,
              groupTeams,
            );
            alertTeamScope = buildTeamAlertCanonicalScope(
              dir.groups,
              buildGroupTeamMap(
                dir.groups,
                dir.account,
                hiddenSummaryTeamNames,
                groupTeams,
              ),
            );
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
            (a.entityType !== "team" ||
              !hiddenSummaryTeamNames.has(a.entityId || a.groupId)) &&
            canSeeAlertEntity(authz, a, visibleGroupIds, alertTeamScope) &&
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
    const teamNameMap = buildGroupTeamMap(visible, dir.account, new Set(), groupTeams);
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
      const teamName = targetTeamForGroup(group, dir.account, groupTeams) ?? null;
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
      const teamName = targetTeamForGroup(group, dir.account, groupTeams);
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

export default router;
