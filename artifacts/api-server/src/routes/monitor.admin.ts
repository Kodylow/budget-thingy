import { Router } from "express";
import { isNull } from "drizzle-orm";
import { revokeAppAdmin } from "../lib/authz";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

router.get("/workspace-admins", requireCapability("canManageAccess"), async (_req, res): Promise<void> => {
  const dir = await getDirectory();
  const result = [...dir.account.familiesById.values()]
    .map((family) => {
      const adminGroup = family.roleGroups.get("admin");
      return {
        groupId: adminGroup?.id ?? family.id,
        groupName: family.name,
        workspaceId: family.workspaceId,
        workspaceName: dir.workspaces.get(family.workspaceId)?.name ?? family.workspaceId,
        familyKey: family.key,
        familyName: family.name,
        isLegacy: family.isLegacy,
        teamName: family.teamName,
        admins: [...(adminGroup?.members.values() ?? [])].map((member) => ({
          userId: member.userId,
          username: member.username,
          email: member.email,
          name: member.name,
        })),
      };
    })
    .sort((a, b) => a.groupName.localeCompare(b.groupName));

  res.json(ListWorkspaceAdminsResponse.parse(result));
});

// ---------------------------------------------------------------------------
// Project spend CSV export — all groups, one row per project
// ---------------------------------------------------------------------------

router.get("/admins", requireCapability("canManageNotifications"), async (_req, res): Promise<void> => {
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

router.post("/admins", requireCapability("canManageNotifications"), async (req, res): Promise<void> => {
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

router.delete("/admins/:adminId", requireCapability("canManageNotifications"), async (req, res): Promise<void> => {
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
    .where(isNull(appAdminsTable.revokedAt))
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
  const revoked = await revokeAppAdmin(userId, req.user!.id);
  if (!revoked) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(DeleteAppAdminResponse.parse({ ok: true }));
});


router.get("/status", requireCapability("canManageSystem"), async (_req, res): Promise<void> => {
  const health = getApiHealth();
  const [emailConfigured, notificationSettings] = await Promise.all([
    isEmailConfigured(),
    getNotificationSettings(),
  ]);
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
      automatedEmailEnabled: notificationSettings.automatedEmailEnabled,
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
  requireCapability("canViewAccountUsage"),
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
  requireCapability("canRunChecks"),
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
  requireCapability("canManageSystem"),
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


export default router;
