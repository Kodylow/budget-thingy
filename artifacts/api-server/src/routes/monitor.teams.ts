import { Router } from "express";
import { getAirtableSourceConfigurationStatus } from "../lib/team-budgets";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

router.get("/teams/budgets", async (req, res): Promise<void> => {
  const snapshot = await getEffectiveTeamBudgets();
  const budgets = snapshot.teams.filter((team) => !team.isHidden);
  const [dir, assignments] = await Promise.all([
    getDirectory(),
    db.select().from(teamLimitTargetsTable),
  ]);
  const cycleUsage = await usageForRequest(
    req.authz!,
    dir,
    { rangeType: "billing" },
    true,
  );
  const scopedGroups = visibleGroups(req.authz!, dir.groups);
  const visibleTeams = new Set(
    scopedGroups
      .map((group) => targetTeamForGroup(group, dir.account, assignments))
      .filter((teamName): teamName is string => teamName != null),
  );
  for (const teamName of req.authz!.teamNames) visibleTeams.add(teamName);
  const allWorkspaceIdsByTeam = new Map<string, Set<string>>();
  for (const group of dir.groups) {
    const teamName = targetTeamForGroup(group, dir.account, assignments);
    if (!teamName) continue;
    const ids = allWorkspaceIdsByTeam.get(teamName) ?? new Set<string>();
    ids.add(group.workspaceId);
    allWorkspaceIdsByTeam.set(teamName, ids);
  }
  const workspaceIdsByTeam = new Map<string, Set<string>>();
  for (const group of scopedGroups) {
    const teamName = targetTeamForGroup(group, dir.account, assignments);
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
      budgets: visibleBudgets.map((b) => {
        const cycleAgentSpendUsd = scopedGroups
          .filter((group) =>
            targetTeamForGroup(group, dir.account, assignments) === b.teamName
          )
          .reduce((sum, group) =>
            sum + [...(cycleUsage.rollup.aiSpendByGroup.get(group.id)?.values() ?? [])]
              .reduce((subtotal, amount) => subtotal + amount, 0), 0);
        const monthlyAgentLimitUsd =
          b.monthlyLimitUsd != null && b.monthlyLimitUsd > 0
          ? b.monthlyLimitUsd
          : null;
        return {
          teamName: b.teamName,
          amountUsd: b.effectiveAmountUsd,
          monthlyAgentLimitUsd,
          cycleAgentSpendUsd,
          agentRemainingUsd: monthlyAgentLimitUsd == null
            ? null
            : monthlyAgentLimitUsd - cycleAgentSpendUsd,
          agentPercentUsed: monthlyAgentLimitUsd == null
            ? null
            : (cycleAgentSpendUsd / monthlyAgentLimitUsd) * 100,
          agentBlocked:
            monthlyAgentLimitUsd != null &&
            cycleAgentSpendUsd >= monthlyAgentLimitUsd,
          workspaceIds: [
            ...(isAccountWide(req.authz)
              ? allWorkspaceIdsByTeam.get(b.teamName) ?? []
              : workspaceIdsByTeam.get(b.teamName) ?? []),
          ].sort(),
        };
      }),
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
        adjustment.isActive &&
        adjustment.matchState === "accepted"
      )
      .map((adjustment) => ({
        recordId: adjustment.sourceRecordId,
        amountUsd: adjustment.amountUsd!,
        submissionPeriod: adjustment.submissionPeriod!,
        source: adjustment.source,
        sourceKind: adjustment.sourceKind,
        sourceBaseId: adjustment.sourceBaseId,
        sourceTableId: adjustment.sourceTableId,
        sourceUrl: adjustment.sourceRecordUrl,
        sourceCreatedAt: adjustment.sourceCreatedAt?.toISOString() ?? null,
        sourceUpdatedAt: adjustment.sourceUpdatedAt?.toISOString() ?? null,
        ingestedAt: adjustment.ingestedAt.toISOString(),
      })),
  };
}

router.get("/admin/team-budgets/history", requireCapability("canViewAccountUsage"), async (req, res): Promise<void> => {
  const snapshot = await getEffectiveTeamBudgets();
  const visible = req.authz!.isTrueAccountAdmin
    ? snapshot.teams
    : snapshot.teams.filter((team) => !team.isHidden);
  res.json(GetTeamBudgetHistoryResponse.parse({
    teams: visible.map((team) =>
      serializeTeamBudgetHistoryTeam(team, snapshot.adjustments)
    ),
    issues: snapshot.adjustments
      .filter((adjustment) => adjustment.isActive && adjustment.matchState !== "accepted")
      .map((adjustment) => ({
        recordId: adjustment.sourceRecordId,
        source: adjustment.source,
        sourceKind: adjustment.sourceKind,
        sourceBaseId: adjustment.sourceBaseId,
        sourceTableId: adjustment.sourceTableId,
        sourceUrl: adjustment.sourceRecordUrl,
        sourceTeamName: adjustment.sourceTeamName,
        teamName: adjustment.teamName,
        amountUsd: adjustment.amountUsd,
        submissionPeriod: adjustment.submissionPeriod,
        matchState: adjustment.matchState,
        error: adjustment.errorMessage,
        sourceCreatedAt: adjustment.sourceCreatedAt?.toISOString() ?? null,
        sourceUpdatedAt: adjustment.sourceUpdatedAt?.toISOString() ?? null,
        ingestedAt: adjustment.ingestedAt.toISOString(),
      })),
  }));
});

router.get(
  "/admin/team-budgets/audit",
  requireCapability("canEditAllocations"),
  async (req, res): Promise<void> => {
    const changes = await getTeamAllocationAudits();
    const visibleChanges = req.authz!.isTrueAccountAdmin
      ? changes
      : changes.filter((change) => change.field === "annualAllocationUsd");
    res.json(GetTeamAllocationAuditResponse.parse({
      changes: visibleChanges.map((change) => ({
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
  requireCapability("canEditAllocations"),
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
  const configuration = getAirtableSourceConfigurationStatus();
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
    sourceBaseId: sync?.sourceBaseId ?? configuration.baseId,
    sourceTableId: sync?.sourceTableId ?? configuration.tableId,
    sourceAvailable: configuration.configured && (sync?.sourceAvailable ?? false),
    unavailableReason: configuration.reason ?? sync?.unavailableReason ??
      (!sync?.sourceAvailable
        ? "Airtable allocation source has not completed a validated synchronization"
        : null),
    fetchedCount: sync?.fetchedCount ?? 0,
    approvedCount: sync?.approvedCount ?? 0,
    recordCount: sync?.recordCount ?? 0,
    acceptedCount: sync?.acceptedCount ?? 0,
    unmatchedCount: sync?.unmatchedCount ?? 0,
    invalidCount: sync?.invalidCount ?? 0,
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

router.post("/admin/team-budgets/refresh", requireCapability("canManageSystem"), async (_req, res): Promise<void> => {
  const result = await refreshTeamBudgetSnapshot();
  res.status(result.ok ? 200 : 502).json(RefreshTeamBudgetsResponse.parse({
    sourceTable: TEAM_BUDGET_SOURCE_TABLE,
    requiredApprovalStatus: TEAM_BUDGET_REQUIRED_APPROVAL_STATUS,
    ...result,
  }));
});


export default router;
