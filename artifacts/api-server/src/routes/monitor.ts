import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  groupBudgetsTable,
  groupTeamsTable,
  teamBudgetsTable,
  adminEmailsTable,
  alertsTable,
} from "@workspace/db";
import {
  ListGroupsResponse,
  RefreshGroupUsageResponse,
  GetSummaryResponse,
  ListBudgetsResponse,
  SetGroupBudgetBody,
  SetGroupBudgetResponse,
  DeleteGroupBudgetResponse,
  GetTeamsBudgetsResponse,
  SetTeamBudgetBody,
  SetTeamBudgetResponse,
  ListAdminsResponse,
  AddAdminBody,
  AddAdminResponse,
  DeleteAdminResponse,
  ListAlertsQueryParams,
  ListAlertsResponse,
  RunAlertCheckResponse,
  GetStatusResponse,
  GetGroupDetailResponse,
  GetGroupProjectsResponse,
} from "@workspace/api-zod";
import {
  isConfigured,
  getApiHealth,
  getDirectory,
  getSpend,
  getBillingPeriod,
  queueGroupSpendFetch,
  refreshAllGroupSpends,
  queueMemberUsageFetch,
  getMemberUsage,
  queueProjectUsageFetch,
  getProjectUsage,
  queueProjectTitlesFetch,
  getProjectTitles,
  getDedupedUsageRollup,
  getDedupedMemberCounts,
  resolveRange,
  isBadRangeError,
  type UsageRange,
  type EnterpriseGroup,
} from "../lib/enterprise";
import { isEmailConfigured } from "../lib/email";
import {
  runCheck,
  getFiredThresholds,
  getLastCheckAt,
  CHECK_INTERVAL_MINUTES,
} from "../lib/checker";

const router: IRouter = Router();

function rangeFromQuery(query: Record<string, unknown>): UsageRange {
  return resolveRange(
    typeof query["rangeType"] === "string" ? query["rangeType"] : undefined,
    typeof query["startDate"] === "string" ? query["startDate"] : undefined,
    typeof query["endDate"] === "string" ? query["endDate"] : undefined,
  );
}

interface EffectiveBudget {
  amountUsd: number | null;
  source: "app" | null;
}

function effectiveGroupBudget(appBudget: number | undefined): EffectiveBudget {
  if (appBudget != null) return { amountUsd: appBudget, source: "app" };
  return { amountUsd: null, source: null };
}

function alertToJson(a: typeof alertsTable.$inferSelect) {
  return {
    id: a.id,
    groupId: a.groupId,
    groupName: a.groupName,
    threshold: a.threshold,
    spendUsd: a.spendUsd,
    budgetUsd: a.budgetUsd,
    recipients: a.recipients,
    sentAt: a.sentAt.toISOString(),
    status: a.status,
    errorMessage: a.errorMessage,
  };
}

router.get("/groups", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const dir = await getDirectory();
    void refreshAllGroupSpends(1, undefined, range).catch(() => undefined);
    for (const group of dir.groups) queueMemberUsageFetch(group, range, 1);

    const [budgets, groupTeams] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(groupTeamsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const groupTeamMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));
    const billing = getBillingPeriod();
    const rollup = getDedupedUsageRollup(dir.groups, range.key);
    const rollupMemberCounts = getDedupedMemberCounts(dir.groups, dir.groupMembers);

    let pendingCount = 0;
    const groups = await Promise.all(
      dir.groups.map(async (g) => {
        const spend = getSpend(g.id, range.key);
        if (!spend) pendingCount += 1;
        const attributed = rollup.byGroup.get(g.id);
        const budget = effectiveGroupBudget(budgetMap.get(g.id));
        // Threshold state is always tracked against the cutoff-anchored billing period.
        const billingSpend = getSpend(g.id, "billing:from-cutoff");
        const fired =
          billingSpend && budget.amountUsd != null
            ? await getFiredThresholds(g.id, billingSpend.periodStart)
            : [];
        const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
        return {
          groupId: g.id,
          workspaceId: g.workspaceId,
          workspaceName: dir.workspaces.get(g.workspaceId)?.name ?? null,
          name: g.name,
          teamName: groupTeamMap.get(g.name) ?? null,
          type: g.type,
          memberCount: dir.groupMembers.get(g.id)?.length ?? null,
          rollupMemberCount: rollupMemberCounts.get(g.id) ?? 0,
          spendLoaded: !!spend,
          spendUsd: spend?.spendUsd ?? null,
          rollupSpendLoaded: rollup.isComplete,
          rollupSpendUsd: attributed?.spendUsd ?? 0,
          spendUpdatedAt: spend ? new Date(spend.fetchedAt).toISOString() : null,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd:
            spend && hasBudget ? budget.amountUsd! - spend.spendUsd : null,
          percentUsed:
            spend && hasBudget ? (spend.spendUsd / budget.amountUsd!) * 100 : null,
          thresholdsFired: fired,
        };
      }),
    );

    res.json(
      ListGroupsResponse.parse({
        groups,
        isComplete: pendingCount === 0 && rollup.isComplete,
        pendingCount: pendingCount + rollup.pendingCount,
        billingPeriodLabel: range.key === "billing:from-cutoff" ? billing.label : range.label,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "listGroups failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/groups/:groupId", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    // Ensure group total, per-member usage, and per-project usage are queued (high priority).
    queueGroupSpendFetch(group, 0, false, undefined, range);
    queueMemberUsageFetch(group, range, 0);
    queueProjectUsageFetch(group, range, 0);
    queueProjectTitlesFetch(group.workspaceId, 0);

    const spend = getSpend(group.id, range.key);
    const memberUsage = getMemberUsage(group.id, range.key);
    const rollup = getDedupedUsageRollup(dir.groups, range.key);
    const rollupMemberCounts = getDedupedMemberCounts(dir.groups, dir.groupMembers);
    const attributed = rollup.byGroup.get(group.id);
    const [budgets, groupTeamsRows] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(groupTeamsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const groupTeamMap = new Map(groupTeamsRows.map((gt) => [gt.groupName, gt.teamName]));
    const budget = effectiveGroupBudget(budgetMap.get(group.id));
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingSpend = getSpend(group.id, "billing:from-cutoff");
    const fired =
      billingSpend && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingSpend.periodStart)
        : [];

    const userIds = dir.groupMembers.get(group.id) ?? [];

    const members = userIds.map((userId) => {
      const m = dir.members.get(userId);
      const ws = m?.workspaces.get(group.workspaceId);
      const spendLoaded = !!memberUsage;
      const spendUsd = memberUsage ? (memberUsage.byUser.get(userId) ?? 0) : null;
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
        spendUsd,
        remainingUsd: null,
        percentUsed: null,
      };
    });

    // Reconciliation: members listed in usage but no longer in the group
    // (removed users) still count toward group spend — fold them into
    // unattributed so member rows + unattributed = group total.
    let listedMembersSpend = 0;
    if (memberUsage) {
      for (const userId of userIds) {
        listedMembersSpend += memberUsage.byUser.get(userId) ?? 0;
      }
    }
    const groupTotal = memberUsage?.totalCostUsd ?? spend?.spendUsd ?? 0;
    const unattributed = memberUsage ? Math.max(0, groupTotal - listedMembersSpend) : 0;

    res.json(
      GetGroupDetailResponse.parse({
        group: {
          groupId: group.id,
          workspaceId: group.workspaceId,
          workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
          name: group.name,
          teamName: groupTeamMap.get(group.name) ?? null,
          type: group.type,
          memberCount: userIds.length,
          rollupMemberCount: rollupMemberCounts.get(group.id) ?? 0,
          spendLoaded: !!spend,
          spendUsd: spend?.spendUsd ?? null,
          rollupSpendLoaded: rollup.isComplete,
          rollupSpendUsd: attributed?.spendUsd ?? 0,
          spendUpdatedAt: spend ? new Date(spend.fetchedAt).toISOString() : null,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd: spend && hasBudget ? budget.amountUsd! - spend.spendUsd : null,
          percentUsed: spend && hasBudget ? (spend.spendUsd / budget.amountUsd!) * 100 : null,
          thresholdsFired: fired,
        },
        members,
        membersSpendUsd: listedMembersSpend,
        unattributedSpendUsd: unattributed,
        isComplete: !!spend && !!memberUsage,
        rangeLabel: range.label,
      }),
    );
  } catch (err) {
    if (isBadRangeError(err)) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, "getGroupDetail failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/groups/:groupId/projects", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    // Kick off fetches (high priority); serve from cache if available.
    queueProjectUsageFetch(group, range, 0);
    queueProjectTitlesFetch(group.workspaceId, 0);

    const projectUsage = getProjectUsage(group.id, range.key);
    const titleMap = getProjectTitles(group.workspaceId);
    const groupSpend = getSpend(group.id, range.key);

    const isComplete = !!projectUsage;

    const projects = projectUsage
      ? Array.from(projectUsage.byProject.values())
          .map((p) => ({
            projectId: p.projectId,
            title: titleMap.get(p.projectId) ?? null,
            totalCostUsd: p.totalCostUsd,
            metrics: p.metrics,
          }))
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      : [];

    // Reconciliation: sum of project rows vs. group total
    const projectsSum = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
    const groupTotal = projectUsage?.totalCostUsd ?? groupSpend?.spendUsd ?? 0;
    const unattributedSpendUsd = Math.max(0, groupTotal - projectsSum);

    res.json(
      GetGroupProjectsResponse.parse({
        projects,
        unattributedSpendUsd,
        isComplete,
      }),
    );
  } catch (err) {
    if (isBadRangeError(err)) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, "getGroupProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.post("/groups/:groupId/refresh", async (req, res): Promise<void> => {
  const groupId = String(req.params["groupId"]);
  const dir = await getDirectory();
  const group = dir.groups.find((g) => g.id === groupId);
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  queueGroupSpendFetch(group, 0, true);
  res.status(202).json(RefreshGroupUsageResponse.parse({ ok: true }));
});

router.get("/summary", async (req, res): Promise<void> => {
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const [budgets, teamBudgets] = await Promise.all([
    db.select().from(groupBudgetsTable),
    db.select().from(teamBudgetsTable),
  ]);
  const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
  const totalBudgetUsd = teamBudgets.reduce((sum, tb) => sum + tb.amountUsd, 0);

  let totalGroups = 0;
  let totalSpendUsd = 0;
  let totalRemainingUsd = 0;
  let budgetedGroups = 0;
  let pending = 0;
  let over50 = 0;
  let over75 = 0;
  let over90 = 0;
  let over100 = 0;

  if (isConfigured()) {
    try {
      const dir = await getDirectory();
      totalGroups = dir.groups.length;
      for (const g of dir.groups) {
        const budget = effectiveGroupBudget(budgetMap.get(g.id));
        if (budget.amountUsd != null && budget.amountUsd > 0) {
          budgetedGroups += 1;
        }
        const spend = getSpend(g.id, range.key);
        if (!spend) {
          pending += 1;
        } else {
          totalSpendUsd += spend.spendUsd;
        }
      }
    } catch (err) {
      req.log.error({ err }, "summary directory fetch failed");
    }
  }

  // Remaining is team budget total (from spreadsheet) minus all loaded spend.
  totalRemainingUsd = totalBudgetUsd - totalSpendUsd;

  const billing = getBillingPeriod();
  const allAlerts = await db.select().from(alertsTable);
  const periodStart = billing.start ? new Date(billing.start) : null;
  const alertsSentThisPeriod = allAlerts.filter(
    (a) => a.status === "sent" && (!periodStart || a.sentAt >= periodStart),
  ).length;

  res.json(
    GetSummaryResponse.parse({
      totalGroups,
      budgetedGroups,
      totalSpendUsd,
      totalBudgetUsd,
      totalRemainingUsd,
      groupsOver50: over50,
      groupsOver75: over75,
      groupsOver90: over90,
      groupsOver100: over100,
      alertsSentThisPeriod,
      billingPeriodLabel: range.key === "billing:from-cutoff" ? billing.label : range.label,
      isComplete: pending === 0,
    }),
  );
});

router.get("/teams/budgets", async (_req, res): Promise<void> => {
  const budgets = await db.select().from(teamBudgetsTable);
  res.json(
    GetTeamsBudgetsResponse.parse({
      budgets: budgets.map((b) => ({
        teamName: b.teamName,
        amountUsd: b.amountUsd,
      })),
    }),
  );
});

router.put("/teams/:teamName/budget", async (req, res): Promise<void> => {
  const teamName = decodeURIComponent(String(req.params["teamName"]));
  const parsed = SetTeamBudgetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(teamBudgetsTable)
    .values({ teamName, amountUsd: parsed.data.amountUsd })
    .onConflictDoUpdate({
      target: teamBudgetsTable.teamName,
      set: { amountUsd: parsed.data.amountUsd, updatedAt: new Date() },
    })
    .returning();
  if (!row) {
    res.status(400).json({ error: "Failed to save team budget" });
    return;
  }
  res.json(
    SetTeamBudgetResponse.parse({
      teamName: row.teamName,
      amountUsd: row.amountUsd,
    }),
  );
});

router.delete("/teams/:teamName/budget", async (req, res): Promise<void> => {
  const teamName = decodeURIComponent(String(req.params["teamName"]));
  await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, teamName));
  res.status(204).send();
});

router.get("/budgets", async (_req, res): Promise<void> => {
  const budgets = await db.select().from(groupBudgetsTable);
  res.json(
    ListBudgetsResponse.parse(
      budgets.map((b) => ({
        groupId: b.groupId,
        amountUsd: b.amountUsd,
        updatedAt: b.updatedAt.toISOString(),
      })),
    ),
  );
});

router.put("/groups/:groupId/budget", async (req, res): Promise<void> => {
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

router.delete("/groups/:groupId/budget", async (req, res): Promise<void> => {
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

router.get("/admins", async (_req, res): Promise<void> => {
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

router.post("/admins", async (req, res): Promise<void> => {
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

router.delete("/admins/:adminId", async (req, res): Promise<void> => {
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

router.get("/alerts", async (req, res): Promise<void> => {
  const parsed = ListAlertsQueryParams.safeParse(req.query);
  const limit = parsed.success && parsed.data.limit ? parsed.data.limit : 100;
  const alerts = await db
    .select()
    .from(alertsTable)
    .orderBy(desc(alertsTable.sentAt))
    .limit(limit);
  res.json(ListAlertsResponse.parse(alerts.map(alertToJson)));
});

router.post("/alerts/check", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  try {
    const result = await runCheck(true);
    res.json(
      RunAlertCheckResponse.parse({
        checkedGroups: result.checkedGroups,
        alertsSent: result.alerts.filter((a) => a.status === "sent").length,
        alerts: result.alerts.map(alertToJson),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "manual check failed");
    res.status(503).json({ error: getApiHealth().error ?? "Check failed" });
  }
});

router.get("/status", async (_req, res): Promise<void> => {
  const health = getApiHealth();
  res.json(
    GetStatusResponse.parse({
      enterpriseApiConfigured: isConfigured(),
      enterpriseApiOk: health.ok,
      enterpriseApiError: health.error,
      emailConfigured: isEmailConfigured(),
      checkerIntervalMinutes: CHECK_INTERVAL_MINUTES,
      lastCheckAt: getLastCheckAt()?.toISOString() ?? null,
    }),
  );
});

export default router;
