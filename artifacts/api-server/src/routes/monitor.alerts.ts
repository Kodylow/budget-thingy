import { Router } from "express";
import { type CurrentAlertUsage, type TeamAlertCanonicalScope } from "./monitor.shared";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

export { canSeeAlertEntity };

const router = Router();

router.get("/alerts", async (req, res): Promise<void> => {
  const authz = req.authz!;
  const accountWide = isAccountWide(authz);
  const canSeeRecipients = authz.capabilities.canManageNotifications;
  const parsed = ListAlertsQueryParams.safeParse(req.query);
  const limit = parsed.success && parsed.data.limit ? parsed.data.limit : 100;
  let allowedIds = new Set<string>();
  let alertTeamScope: TeamAlertCanonicalScope = new Map();
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
      dir.account,
      hiddenAlertTeamNames,
      groupTeams,
    );
    alertTeamScope = buildTeamAlertCanonicalScope(
      dir.groups,
      buildGroupTeamMap(
        dir.groups,
        dir.account,
        hiddenAlertTeamNames,
        groupTeams,
      ),
    );
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
      (a.entityType !== "team" ||
        !hiddenAlertTeamNames.has(a.entityId || a.groupId)) &&
      canSeeAlertEntity(authz, a, allowedIds, alertTeamScope)
    )
    .slice(0, limit)
    .map((a) => {
      const entityId = a.entityId || a.groupId;
      const alert = alertToJson(a, currentByEntity.get(`${a.entityType}|${entityId}`));
      return canSeeRecipients ? alert : { ...alert, recipients: [] };
    });
  res.json(ListAlertsResponse.parse(scoped));
});

router.post("/alerts/check", requireCapability("canRunChecks"), async (req, res): Promise<void> => {
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
  requireCapability("canSendTestEmail"),
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
  requireCapability("canSendTestEmail"),
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

router.get(
  "/settings/email",
  requireCapability("canManageNotifications"),
  async (_req, res): Promise<void> => {
    const settings = await getNotificationSettings();
    res.json(GetEmailSettingsResponse.parse({
      automatedEmailEnabled: settings.automatedEmailEnabled,
      updatedAt: settings.updatedAt.toISOString(),
    }));
  },
);

router.patch(
  "/settings/email",
  requireCapability("canManageNotifications"),
  async (req, res): Promise<void> => {
    const update = UpdateEmailSettingsBody.safeParse(req.body);
    if (!update.success) {
      res.status(400).json({ error: "automatedEmailEnabled must be a boolean" });
      return;
    }
    const settings = await updateNotificationSettings(
      update.data.automatedEmailEnabled,
    );
    res.json(UpdateEmailSettingsResponse.parse({
      automatedEmailEnabled: settings.automatedEmailEnabled,
      updatedAt: settings.updatedAt.toISOString(),
    }));
  },
);

// System status is account-only configuration; not exposed to workspace admins.

export default router;
