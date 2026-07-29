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
  source: "app" | "platform" | null;
}

function effectiveGroupBudget(
  appBudget: number | undefined,
  group: EnterpriseGroup,
  platformGroupLimits: Map<string, Map<string, number>>,
): EffectiveBudget {
  if (appBudget != null) return { amountUsd: appBudget, source: "app" };
  const platform = platformGroupLimits.get(group.workspaceId)?.get(group.id);
  if (platform != null) return { amountUsd: platform, source: "platform" };
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

    const [budgets, groupTeams] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(groupTeamsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const groupTeamMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));
    const billing = getBillingPeriod();

    let pendingCount = 0;
    const groups = await Promise.all(
      dir.groups.map(async (g) => {
        const spend = getSpend(g.id, range.key);
        if (!spend) pendingCount += 1;
        const budget = effectiveGroupBudget(budgetMap.get(g.id), g, dir.budgets.groupLimits);
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
          spendLoaded: !!spend,
          spendUsd: spend?.spendUsd ?? null,
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
        isComplete: pendingCount === 0,
        pendingCount,
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

    // Ensure both the group total and per-member usage are queued (high priority).
    queueGroupSpendFetch(group, 0, false, undefined, range);
    queueMemberUsageFetch(group, range, 0);

    const spend = getSpend(group.id, range.key);
    const memberUsage = getMemberUsage(group.id, range.key);
    const [budgets, groupTeamsRows] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(groupTeamsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const groupTeamMap = new Map(groupTeamsRows.map((gt) => [gt.groupName, gt.teamName]));
    const budget = effectiveGroupBudget(budgetMap.get(group.id), group, dir.budgets.groupLimits);
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingSpend = getSpend(group.id, "billing:from-cutoff");
    const fired =
      billingSpend && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingSpend.periodStart)
        : [];

    const userIds = dir.groupMembers.get(group.id) ?? [];
    const wsUserLimits = dir.budgets.userLimits.get(group.workspaceId);
    const wsDefault = dir.budgets.workspaceDefaults.get(group.workspaceId);

    const members = userIds.map((userId) => {
      const m = dir.members.get(userId);
      const ws = m?.workspaces.get(group.workspaceId);
      const userLimit = wsUserLimits?.get(userId);
      const allocated = userLimit ?? wsDefault ?? null;
      const budgetSource =
        userLimit != null ? "user_limit" : wsDefault != null ? "workspace_default" : null;
      const spendLoaded = !!memberUsage;
      const spendUsd = memberUsage ? (memberUsage.byUser.get(userId) ?? 0) : null;
      return {
        userId,
        username: m?.username ?? null,
        email: m?.email ?? null,
        name: m?.name ?? null,
        role: ws?.role ?? null,
        isDisabled: ws?.isDisabled ?? null,
        allocatedBudgetUsd: allocated,
        budgetSource,
        spendLoaded,
        spendUsd,
        remainingUsd:
          spendLoaded && allocated != null && spendUsd != null ? allocated - spendUsd : null,
        percentUsed:
          spendLoaded && allocated != null && allocated > 0 && spendUsd != null
            ? (spendUsd / allocated) * 100
            : null,
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
          spendLoaded: !!spend,
          spendUsd: spend?.spendUsd ?? null,
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
  const budgets = await db.select().from(groupBudgetsTable);
  const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));

  let totalGroups = 0;
  let totalSpendUsd = 0;
  let totalBudgetUsd = 0;
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
        const budget = effectiveGroupBudget(budgetMap.get(g.id), g, dir.budgets.groupLimits);
        if (budget.amountUsd != null && budget.amountUsd > 0) {
          budgetedGroups += 1;
          totalBudgetUsd += budget.amountUsd;
        }
        const spend = getSpend(g.id, range.key);
        if (!spend) {
          pending += 1;
          continue;
        }
        totalSpendUsd += spend.spendUsd;
        if (budget.amountUsd != null && budget.amountUsd > 0) {
          totalRemainingUsd += budget.amountUsd - spend.spendUsd;
          const pct = (spend.spendUsd / budget.amountUsd) * 100;
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
