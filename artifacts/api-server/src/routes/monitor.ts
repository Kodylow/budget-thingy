import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  groupBudgetsTable,
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
  ListAdminsResponse,
  AddAdminBody,
  AddAdminResponse,
  DeleteAdminResponse,
  ListAlertsQueryParams,
  ListAlertsResponse,
  RunAlertCheckResponse,
  GetStatusResponse,
} from "@workspace/api-zod";
import {
  isConfigured,
  getApiHealth,
  getDirectory,
  getSpend,
  getBillingPeriod,
  pendingUsageCount,
  queueGroupSpendFetch,
  refreshAllGroupSpends,
} from "../lib/enterprise";
import { isEmailConfigured } from "../lib/email";
import {
  runCheck,
  getFiredThresholds,
  getLastCheckAt,
  CHECK_INTERVAL_MINUTES,
} from "../lib/checker";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

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
  try {
    const dir = await getDirectory();
    // Make sure fetches are queued for anything stale (background priority).
    void refreshAllGroupSpends(1).catch(() => undefined);

    const budgets = await db.select().from(groupBudgetsTable);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const period = getBillingPeriod();

    let pendingCount = 0;
    const groups = await Promise.all(
      dir.groups.map(async (g) => {
        const spend = getSpend(g.id);
        if (!spend) pendingCount += 1;
        const budgetUsd = budgetMap.get(g.id) ?? null;
        const fired =
          spend && budgetUsd != null
            ? await getFiredThresholds(g.id, spend.periodStart)
            : [];
        return {
          groupId: g.id,
          workspaceId: g.workspaceId,
          workspaceName: dir.workspaces.get(g.workspaceId)?.name ?? null,
          name: g.name,
          type: g.type,
          memberCount: dir.memberCounts.get(g.id) ?? null,
          spendLoaded: !!spend,
          spendUsd: spend?.spendUsd ?? null,
          spendUpdatedAt: spend ? new Date(spend.fetchedAt).toISOString() : null,
          budgetUsd,
          percentUsed:
            spend && budgetUsd != null && budgetUsd > 0
              ? (spend.spendUsd / budgetUsd) * 100
              : null,
          thresholdsFired: fired,
        };
      }),
    );

    res.json(
      ListGroupsResponse.parse({
        groups,
        isComplete: pendingCount === 0,
        pendingCount,
        billingPeriodLabel: period.label,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "listGroups failed");
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
  const period = getBillingPeriod();
  const budgets = await db.select().from(groupBudgetsTable);
  const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));

  let totalGroups = 0;
  let totalSpendUsd = 0;
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
        const spend = getSpend(g.id);
        if (!spend) {
          pending += 1;
          continue;
        }
        totalSpendUsd += spend.spendUsd;
        const budget = budgetMap.get(g.id);
        if (budget && budget > 0) {
          const pct = (spend.spendUsd / budget) * 100;
          if (pct >= 50) over50 += 1;
          if (pct >= 75) over75 += 1;
          if (pct >= 90) over90 += 1;
          if (pct >= 100) over100 += 1;
        }
      }
    } catch (err) {
      req.log.error({ err }, "summary directory fetch failed");
    }
  }

  const allAlerts = await db.select().from(alertsTable);
  const periodStart = period.start ? new Date(period.start) : null;
  const alertsSentThisPeriod = allAlerts.filter(
    (a) => a.status === "sent" && (!periodStart || a.sentAt >= periodStart),
  ).length;

  res.json(
    GetSummaryResponse.parse({
      totalGroups,
      budgetedGroups: budgets.length,
      totalSpendUsd,
      totalBudgetUsd: budgets.reduce((s, b) => s + b.amountUsd, 0),
      groupsOver50: over50,
      groupsOver75: over75,
      groupsOver90: over90,
      groupsOver100: over100,
      alertsSentThisPeriod,
      billingPeriodLabel: period.label,
      isComplete: pending === 0,
    }),
  );
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

// referenced to avoid unused import when pendingUsageCount is only used elsewhere
void pendingUsageCount;

export default router;
