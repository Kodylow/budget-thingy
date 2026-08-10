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
  getProjectInfo,
  hasProjectInfo,
  getDedupedUsageRollup,
  getDedupedMemberCounts,
  resolveRange,
  isBadRangeError,
  SPEND_DATA_CUTOFF_ISO,
  type UsageRange,
  type EnterpriseGroup,
  type ProjectUsageMetric,
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

    // Reconciliation: sum of project rows vs. group total.
    // Anchor to groupSpend.spendUsd (the same figure shown in the header stat card)
    // so the project table total always matches the group's reported spend.
    // Fall back to projectUsage.totalCostUsd only when the plain-group spend
    // hasn't loaded yet.
    const projectsSum = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
    const groupTotal = groupSpend?.spendUsd ?? projectUsage?.totalCostUsd ?? 0;
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

router.get("/clusters/:clusterKey/projects", async (req, res): Promise<void> => {
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
    const rawKey = String(req.params["clusterKey"]);
    const groupIds = rawKey.split(",").map((id) => id.trim()).filter(Boolean);
    if (groupIds.length === 0) {
      res.status(400).json({ error: "No group IDs in cluster key" });
      return;
    }

    const dir = await getDirectory();
    const groups = groupIds
      .map((id) => dir.groups.find((g) => g.id === id))
      .filter((g): g is EnterpriseGroup => g !== undefined);

    if (groups.length === 0) {
      res.status(404).json({ error: "No matching groups found" });
      return;
    }

    // Queue fetches (high priority)
    const workspaceIds = new Set(groups.map((g) => g.workspaceId));
    for (const g of groups) queueProjectUsageFetch(g, range, 0);
    for (const wsId of workspaceIds) queueProjectTitlesFetch(wsId, 0);

    // Member set — union of all members across constituent groups
    const memberSet = new Set<string>();
    for (const g of groups) {
      for (const userId of dir.groupMembers.get(g.id) ?? []) {
        memberSet.add(userId);
      }
    }

    // Collect unique projects across all sub-groups; de-dup by taking max totalCostUsd entry.
    // When the same project appears in multiple sub-group responses (because the creator is in
    // multiple sub-groups), we pick the entry with the highest reported total rather than summing,
    // which would inflate the figure.
    const projectMap = new Map<
      string,
      { entry: { projectId: string; totalCostUsd: number; metrics: ProjectUsageMetric[] }; workspaceId: string }
    >();
    let allGroupsLoaded = true;

    for (const g of groups) {
      const usage = getProjectUsage(g.id, range.key);
      if (!usage) {
        allGroupsLoaded = false;
        continue;
      }
      for (const entry of usage.byProject.values()) {
        const existing = projectMap.get(entry.projectId);
        if (!existing || entry.totalCostUsd > existing.entry.totalCostUsd) {
          projectMap.set(entry.projectId, { entry, workspaceId: g.workspaceId });
        }
      }
    }

    // Project info (creatorId) availability — needed for exact attribution
    const projectInfoLoaded = Array.from(workspaceIds).every((wsId) => hasProjectInfo(wsId));

    // Attribute projects by creator membership
    const attributed: {
      projectId: string;
      title: string | null;
      totalCostUsd: number;
      metrics: ProjectUsageMetric[];
    }[] = [];
    let unattributedSpendUsd = 0;

    for (const { entry, workspaceId } of projectMap.values()) {
      const info = getProjectInfo(workspaceId, entry.projectId);
      const creatorId = info?.creatorId ?? null;
      if (creatorId !== null && memberSet.has(creatorId)) {
        attributed.push({
          projectId: entry.projectId,
          title: info?.title ?? null,
          totalCostUsd: entry.totalCostUsd,
          metrics: entry.metrics,
        });
      } else {
        unattributedSpendUsd += entry.totalCostUsd;
      }
    }

    attributed.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    res.json(
      GetGroupProjectsResponse.parse({
        projects: attributed,
        unattributedSpendUsd,
        isComplete: allGroupsLoaded && projectInfoLoaded,
      }),
    );
  } catch (err) {
    if (isBadRangeError(err)) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, "getClusterProjects failed");
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

// ---------- Trends: bucketed spend over time ----------

interface TrendBucket {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
}

function generateMonthlyBuckets(): TrendBucket[] {
  const cutoff = new Date(SPEND_DATA_CUTOFF_ISO);
  const now = new Date();
  const buckets: TrendBucket[] = [];

  let monthStart = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1));
  while (monthStart <= now) {
    const y = monthStart.getUTCFullYear();
    const m = monthStart.getUTCMonth();

    const bucketStartMs = Math.max(monthStart.getTime(), cutoff.getTime());
    const lastDayOfMonth = new Date(Date.UTC(y, m + 1, 0)).getTime();
    const bucketEndMs = Math.min(lastDayOfMonth, now.getTime());

    const startDate = new Date(bucketStartMs).toISOString().slice(0, 10);
    const endDate = new Date(bucketEndMs).toISOString().slice(0, 10);

    if (startDate < endDate) {
      const mo = monthStart.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      const yr = String(y).slice(2);
      buckets.push({ key: `custom:${startDate}:${endDate}`, label: `${mo} '${yr}`, startDate, endDate });
    }

    monthStart = new Date(Date.UTC(y, m + 1, 1));
  }
  return buckets;
}

function generateWeeklyBuckets(): TrendBucket[] {
  const cutoff = new Date(SPEND_DATA_CUTOFF_ISO);
  const now = new Date();
  const buckets: TrendBucket[] = [];

  let weekStart = new Date(cutoff.getTime());
  while (weekStart < now) {
    const weekEndMs = Math.min(weekStart.getTime() + 6 * 86_400_000, now.getTime());
    const startDate = weekStart.toISOString().slice(0, 10);
    const endDate = new Date(weekEndMs).toISOString().slice(0, 10);

    if (startDate < endDate) {
      const mo = String(weekStart.getUTCMonth() + 1).padStart(2, "0");
      const d = String(weekStart.getUTCDate()).padStart(2, "0");
      buckets.push({ key: `custom:${startDate}:${endDate}`, label: `${mo}/${d}`, startDate, endDate });
    }

    weekStart = new Date(weekStart.getTime() + 7 * 86_400_000);
  }
  return buckets;
}

router.get("/trends", async (req, res): Promise<void> => {
  const granularity =
    typeof req.query["granularity"] === "string" && req.query["granularity"] === "week"
      ? "week"
      : "month";

  const buckets = granularity === "week" ? generateWeeklyBuckets() : generateMonthlyBuckets();

  if (!isConfigured()) {
    res.json({ granularity, buckets, groups: [], isComplete: true, loadedCount: 0, totalCount: 0 });
    return;
  }

  let dir;
  try {
    dir = await getDirectory();
  } catch (err) {
    req.log.error({ err }, "trends directory fetch failed");
    res.status(503).json({ error: "Directory unavailable" });
    return;
  }

  const groupTeams = await db.select().from(groupTeamsTable);
  const teamNameMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  let loadedCount = 0;
  const totalCount = dir.groups.length * buckets.length;

  for (const group of dir.groups) {
    for (const bucket of buckets) {
      let range: UsageRange;
      try {
        range = resolveRange("custom", bucket.startDate, bucket.endDate);
      } catch {
        continue;
      }
      const cached = getSpend(group.id, range.key);
      if (cached) {
        loadedCount++;
      } else {
        queueGroupSpendFetch(group, 1, false, undefined, range);
      }
    }
  }

  const groups = dir.groups.map((g) => {
    const teamName = teamNameMap.get(g.name) ?? null;
    const spendByBucket: Record<string, number | null> = {};
    for (const bucket of buckets) {
      let range: UsageRange;
      try {
        range = resolveRange("custom", bucket.startDate, bucket.endDate);
      } catch {
        spendByBucket[bucket.key] = null;
        continue;
      }
      const spend = getSpend(g.id, range.key);
      spendByBucket[bucket.key] = spend != null ? spend.spendUsd : null;
    }
    return { groupId: g.id, name: g.name, teamName, spendByBucket };
  });

  res.json({ granularity, buckets, groups, isComplete: loadedCount >= totalCount, loadedCount, totalCount });
});

// ── GET /export/users.csv ─────────────────────────────────────────────────────
// Returns a CSV of users with confirmed agent spend > 0 over the billing period.
// Each user appears once (first custom group wins). Groups whose per-member
// usage hasn't loaded yet are skipped; they are queued so a retry will include them.
router.get("/export/users.csv", async (req, res) => {
  let dir: Awaited<ReturnType<typeof getDirectory>>;
  try {
    dir = await getDirectory();
  } catch (err) {
    req.log.error({ err }, "export directory fetch failed");
    res.status(503).json({ error: "Directory unavailable" });
    return;
  }

  const billingRange = resolveRange("billing");
  const groupTeams = await db.select().from(groupTeamsTable);
  const teamNameMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  let groupsLoaded = 0;
  const totalGroups = dir.groups.length;

  // Deduplicate: each user attributed to their first group (same rule as dashboard)
  const seen = new Set<string>();
  const rows: { email: string; name: string; username: string; group: string; team: string; spendUsd: number }[] = [];

  for (const group of dir.groups) {
    const memberUsage = getMemberUsage(group.id, billingRange.key);
    if (!memberUsage) {
      // Queue fetch for next time; skip this group now (can't confirm activity)
      queueMemberUsageFetch(group, billingRange, 1);
      continue;
    }
    groupsLoaded++;

    const memberIds = dir.groupMembers.get(group.id) ?? [];
    const teamName = teamNameMap.get(group.name) ?? "";

    for (const userId of memberIds) {
      const spendUsd = memberUsage.byUser.get(userId) ?? 0;
      if (spendUsd <= 0) continue; // not active this period

      if (seen.has(userId)) continue;
      seen.add(userId);

      const m = dir.members.get(userId);
      if (!m) continue;

      rows.push({
        email: m.email,
        name: m.name ?? "",
        username: m.username,
        group: group.name,
        team: teamName,
        spendUsd,
      });
    }
  }

  // Sort by spend descending
  rows.sort((a, b) => b.spendUsd - a.spendUsd);

  // Build CSV
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["Email", "Name", "Username", "Group", "Team", "Spend (USD)"].map(escape).join(",");
  const lines = rows.map((r) =>
    [r.email, r.name, r.username, r.group, r.team, r.spendUsd.toFixed(2)].map(escape).join(","),
  );

  const isComplete = groupsLoaded === totalGroups;
  const csv = [header, ...lines].join("\r\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="active-users-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.setHeader("X-Groups-Loaded", String(groupsLoaded));
  res.setHeader("X-Groups-Total", String(totalGroups));
  res.setHeader("X-Export-Complete", String(isComplete));
  res.send(csv);
});

export default router;
