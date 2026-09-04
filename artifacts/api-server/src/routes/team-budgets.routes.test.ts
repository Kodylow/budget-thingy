// @ts-nocheck
import { test, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  teamLimitTargetsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetAllocationAuditsTable,
  teamBudgetsTable,
  usageMemberDayTable,
  usageProjectDayTable,
  usageWorkspaceDayTable,
} from "@workspace/db";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import { __setDirectoryCacheForTests } from "../lib/enterprise.ts";
import { setTeamBudgetDirectoryFetcherForTests } from "../lib/team-budgets.ts";
import { invalidateUsageSnapshotMemo } from "../lib/usage-store.ts";
const PREFIX = "__task158_route__";
const ASSIGNED = `${PREFIX} Assigned`;
const BUDGET_ONLY = `${PREFIX} Budget Only`;
const ORIGINAL_ONLY = `${PREFIX} Original Only`;
const HIDDEN = `${PREFIX} Hidden`;
const GROUP_NAME = `${PREFIX} Group`;
const GROUP_ID = `${PREFIX}-group`;
const SECOND_GROUP_ID = `${PREFIX}-group-2`;
const SHARED_PROJECT_ID = `${PREFIX}-shared-project`;
const USAGE_DATE = new Date().toISOString().slice(0, 10);

function member(userId, isAccountAdmin, workspaces = {}) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.com`,
    name: userId,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

let server;
let baseUrl;

beforeAll(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key";
  __setDirectoryCacheForTests({
    workspaces: new Map([
      ["task158-ws", {
        id: "task158-ws",
        name: "Task 158",
        slug: "task-158",
        memberCount: 2,
      }],
      ["task158-ws-2", {
        id: "task158-ws-2",
        name: "Task 158 Two",
        slug: "task-158-two",
        memberCount: 1,
      }],
    ]),
    groups: [
      {
        id: GROUP_ID,
        workspaceId: "task158-ws",
        name: GROUP_NAME,
        type: "custom",
      },
      {
        id: SECOND_GROUP_ID,
        workspaceId: "task158-ws-2",
        name: `${GROUP_NAME} Two`,
        type: "custom",
      },
    ],
    members: new Map([
      ["task158-account", member("task158-account", true)],
      ["task158-workspace", member("task158-workspace", false, {
        "task158-ws": { role: "admin", isDisabled: false },
      })],
      ["task158-plain", member("task158-plain", false, {
        "task158-ws": { role: "member", isDisabled: false },
      })],
      ["task158-creator-2", member("task158-creator-2", false, {
        "task158-ws-2": { role: "member", isDisabled: false },
      })],
    ]),
    groupMembers: new Map([
      [GROUP_ID, ["task158-workspace", "task158-plain"]],
      [SECOND_GROUP_ID, ["task158-creator-2"]],
    ]),
  });
  const { resolveAuthorization } = await import("../lib/authz.ts");
  setAuthorizationResolver((userId) => {
    if (userId === "task158-delegate") {
      return Promise.resolve({
        role: "account", roles: ["account"], userId, workspaceIds: [],
        teamNames: [], groupIds: [], userIds: [userId], isTrueAccountAdmin: false,
        capabilities: {
          canManageAccess: true, canEditAllocations: true,
          canWriteGroupLimits: false, canWriteUserLimitsIn: ["task158-ws"],
        },
      });
    }
    if (userId === "task158-editor") {
      return Promise.resolve({
        role: "account", roles: ["account"], userId, workspaceIds: [],
        teamNames: [], groupIds: [], userIds: [userId], isTrueAccountAdmin: false,
        capabilities: {
          canManageAccess: true, canEditAllocations: true,
          canWriteGroupLimits: false, canWriteUserLimitsIn: ["task158-ws"],
        },
      });
    }
    return resolveAuthorization(userId);
  });
  setTeamBudgetDirectoryFetcherForTests(async () => ({
    allGroups: [{
      id: GROUP_ID,
      workspaceId: "task158-ws",
      name: GROUP_NAME,
      type: "custom",
    }],
  }));

  await db.delete(teamBudgetAdjustmentsTable).where(inArray(
    teamBudgetAdjustmentsTable.sourceRecordId,
    [`${PREFIX}-assigned`, `${PREFIX}-budget-only`, `${PREFIX}-hidden`],
  ));
  await db.delete(teamBudgetAllocationAuditsTable).where(inArray(
    teamBudgetAllocationAuditsTable.teamName,
    [ASSIGNED, BUDGET_ONLY, ORIGINAL_ONLY, HIDDEN],
  ));
  await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
    ASSIGNED,
    BUDGET_ONLY,
    ORIGINAL_ONLY,
    HIDDEN,
  ]));
  await db.delete(teamLimitTargetsTable).where(eq(teamLimitTargetsTable.groupId, GROUP_ID));
  const usageWorkspaceIds = ["task158-ws", "task158-ws-2"];
  await db.delete(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, usageWorkspaceIds));
  await db.delete(apiProjectMetadataTable)
    .where(inArray(apiProjectMetadataTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageMemberDayTable)
    .where(inArray(usageMemberDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageProjectDayTable)
    .where(inArray(usageProjectDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageWorkspaceDayTable)
    .where(inArray(usageWorkspaceDayTable.workspaceId, usageWorkspaceIds));
  await db.insert(teamBudgetsTable).values([
    { teamName: ASSIGNED, amountUsd: 100, originalAmountUsd: 100 },
    { teamName: BUDGET_ONLY, amountUsd: 50, originalAmountUsd: 50 },
    { teamName: ORIGINAL_ONLY, amountUsd: 75, originalAmountUsd: 75 },
    { teamName: HIDDEN, amountUsd: 1000, originalAmountUsd: 1000, isHidden: true },
  ]);
  await db.insert(teamLimitTargetsTable).values({
    workspaceId: "task158-ws",
    groupId: GROUP_ID,
    groupName: GROUP_NAME,
    teamName: ASSIGNED,
  });
  await db.insert(usageMemberDayTable).values([
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      userId: "task158-workspace",
      totalCostUsd: 15,
      aiCostUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
    },
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      userId: "task158-plain",
      totalCostUsd: 5,
      aiCostUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
    },
  ]);
  await db.insert(usageWorkspaceDayTable).values([
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      totalCostUsd: 20,
      memberAttributableUsd: 20,
      memberUnattributableUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
      status: "complete",
    },
    {
      workspaceId: "task158-ws-2",
      usageDate: USAGE_DATE,
      totalCostUsd: 13,
      memberAttributableUsd: 13,
      memberUnattributableUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
      status: "complete",
    },
  ]);
  await db.insert(usageProjectDayTable).values([
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      projectId: SHARED_PROJECT_ID,
      totalCostUsd: 20,
      metricsJson: [],
      fetchedAt: new Date(),
    },
    {
      workspaceId: "task158-ws-2",
      usageDate: USAGE_DATE,
      projectId: SHARED_PROJECT_ID,
      totalCostUsd: 13,
      metricsJson: [],
      fetchedAt: new Date(),
    },
  ]);
  await db.insert(apiProjectMetadataTable).values([
    {
      workspaceId: "task158-ws",
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project One",
      creatorId: "task158-workspace",
      fetchedAt: new Date(),
    },
    {
      workspaceId: "task158-ws-2",
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project Two",
      creatorId: "task158-creator-2",
      fetchedAt: new Date(),
    },
  ]);
  await db.insert(apiProjectMetadataStateTable).values(
    usageWorkspaceIds.map((workspaceId) => ({
      workspaceId,
      status: "success",
      completedAt: new Date(),
    })),
  );
  invalidateUsageSnapshotMemo();
  await db.insert(teamBudgetAdjustmentsTable).values([
    {
      source: `${PREFIX}-source`,
      sourceRecordId: `${PREFIX}-assigned`,
      sourceTeamName: ASSIGNED,
      teamName: ASSIGNED,
      amountUsd: 25,
      submissionPeriod: "2026-01",
      matchState: "accepted",
    },
    {
      source: `${PREFIX}-source`,
      sourceRecordId: `${PREFIX}-budget-only`,
      sourceTeamName: BUDGET_ONLY,
      teamName: BUDGET_ONLY,
      amountUsd: 10,
      submissionPeriod: "2026-02",
      matchState: "accepted",
    },
    {
      source: `${PREFIX}-source`,
      sourceRecordId: `${PREFIX}-hidden`,
      sourceTeamName: HIDDEN,
      teamName: HIDDEN,
      amountUsd: 500,
      submissionPeriod: "2026-03",
      matchState: "accepted",
    },
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.headers["x-test-user"];
    req.isAuthenticated = function () { return this.user != null; };
    if (userId) req.user = { id: String(userId) };
    next();
  });
  app.use("/api", monitorRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server?.close();
  setAuthorizationResolver(null);
  setTeamBudgetDirectoryFetcherForTests(null);
  __setDirectoryCacheForTests(null);
  const usageWorkspaceIds = ["task158-ws", "task158-ws-2"];
  await db.delete(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, usageWorkspaceIds));
  await db.delete(apiProjectMetadataTable)
    .where(inArray(apiProjectMetadataTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageMemberDayTable)
    .where(inArray(usageMemberDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageProjectDayTable)
    .where(inArray(usageProjectDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageWorkspaceDayTable)
    .where(inArray(usageWorkspaceDayTable.workspaceId, usageWorkspaceIds));
  invalidateUsageSnapshotMemo();
  await db.delete(teamBudgetAdjustmentsTable).where(inArray(
    teamBudgetAdjustmentsTable.sourceRecordId,
    [`${PREFIX}-assigned`, `${PREFIX}-budget-only`, `${PREFIX}-hidden`],
  ));
  await db.delete(teamBudgetAllocationAuditsTable).where(inArray(
    teamBudgetAllocationAuditsTable.teamName,
    [ASSIGNED, BUDGET_ONLY, ORIGINAL_ONLY, HIDDEN],
  ));
  await db.delete(teamLimitTargetsTable).where(eq(teamLimitTargetsTable.groupId, GROUP_ID));
  await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
    ASSIGNED,
    BUDGET_ONLY,
    ORIGINAL_ONLY,
    HIDDEN,
  ]));
  delete process.env.REPLIT_ENTERPRISE_API_KEY;
});

async function request(path, user, method = "GET", body = undefined) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return {
    status: response.status,
    json,
  };
}

test("budget audit and sync status reject workspace-scoped users", async () => {
  for (const path of ["/admin/team-budgets/history", "/admin/team-budgets/sync"]) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, "task158-plain")).status).toBe(403);
    expect((await request(path, "task158-workspace")).status).toBe(403);
    expect((await request(path, "task158-account")).status).toBe(200);
  }
});

test("sync status identifies the approval-only Finance Approval feed", async () => {
  const { status, json } = await request("/teams/budgets", "task158-workspace");
  expect(status).toBe(200);
  expect(json.sourceTable).toBe("Replit Finance Approval");
  expect(json.requiredApprovalStatus).toBe("Approved");
});

test("history orders months and exposes hidden teams only to true admins", async () => {
  const { status, json } = await request("/teams/budgets", "task158-workspace");
  expect(status).toBe(200);
  expect(json.teams.find((team) => team.teamName === HIDDEN)).toMatchObject({
    isHidden: true,
    originalAmountUsd: 1000,
  });
  const delegate = await request("/admin/team-budgets/history", "task158-delegate");
  expect(delegate.status).toBe(200);
  expect(delegate.json.teams.some((team) => team.teamName === HIDDEN)).toBe(false);

  const assigned = json.teams.find((team) => team.teamName === ASSIGNED);
  const budgetOnly = json.teams.find((team) => team.teamName === BUDGET_ONLY);
  expect(assigned).toMatchObject({
    originalAmountUsd: 100,
    effectiveAmountUsd: 125,
    monthlyLimitUsd: 10.42,
    monthlyLimitSource: "derived",
  });
  expect(assigned.adjustments.map((row) => row.submissionPeriod)).toEqual(["2026-01"]);
  expect(budgetOnly.effectiveAmountUsd).toBe(60);
});

test("true admins atomically edit annual allocations and visibility with newest-first audit", async () => {
  const allocationPath =
    `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/allocation`;
  const visibilityPath =
    `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/visibility`;

  expect((await request(allocationPath, "task158-delegate", "PATCH", {
    annualAllocationUsd: 240,
  })).status).toBe(403);
  expect((await request(allocationPath, "task158-account", "PATCH", {
    annualAllocationUsd: -1,
  })).status).toBe(400);
  expect((await request(allocationPath, "task158-account", "PATCH", {
    annualAllocationUsd: 240,
    unexpected: true,
  })).status).toBe(400);

  const allocation = await request(allocationPath, "task158-account", "PATCH", {
    annualAllocationUsd: 240,
  });
  expect(allocation.status).toBe(200);
  expect(allocation.json).toMatchObject({
    originalAmountUsd: 240,
    effectiveAmountUsd: 265,
    annualAllocationUsd: 265,
    monthlyLimitUsd: 22.08,
    isHidden: false,
  });

  const visibility = await request(visibilityPath, "task158-account", "PATCH", {
    isHidden: true,
  });
  expect(visibility.status).toBe(200);
  expect(visibility.json.isHidden).toBe(true);

  const audit = await request("/admin/team-budgets/audit", "task158-account");
  expect(audit.status).toBe(200);
  expect(audit.json.changes.filter((change) => change.teamName === ASSIGNED).slice(0, 2))
    .toEqual([
      expect.objectContaining({
        field: "isHidden",
        oldValue: false,
        newValue: true,
        actor: "task158-account",
      }),
      expect.objectContaining({
        field: "annualAllocationUsd",
        oldValue: 100,
        newValue: 240,
        actor: "task158-account",
      }),
    ]);
  expect((await request("/admin/team-budgets/audit", "task158-delegate")).status).toBe(403);

  const concurrent = await Promise.all([
    request(allocationPath, "task158-account", "PATCH", { annualAllocationUsd: 300 }),
    request(allocationPath, "task158-account", "PATCH", { annualAllocationUsd: 400 }),
  ]);
  expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
  const concurrentAudit = await request("/admin/team-budgets/audit", "task158-account");
  const allocationChanges = concurrentAudit.json.changes
    .filter((change) =>
      change.teamName === ASSIGNED && change.field === "annualAllocationUsd"
    )
    .slice(0, 2);
  expect(allocationChanges[1].oldValue).toBe(240);
  expect(allocationChanges[0].oldValue).toBe(allocationChanges[1].newValue);
  expect(new Set(allocationChanges.map((change) => change.newValue))).toEqual(
    new Set([300, 400]),
  );

  await request(visibilityPath, "task158-account", "PATCH", { isHidden: false });
  await request(allocationPath, "task158-account", "PATCH", { annualAllocationUsd: 100 });
});

test("effective totals agree across pool, group, and summary surfaces", async () => {
  const [pools, groups, summary] = await Promise.all([
    request("/teams/budgets", "task158-account"),
    request("/groups", "task158-account"),
    request("/summary", "task158-account"),
  ]);
  expect(pools.status).toBe(200);
  expect(groups.status).toBe(200);
  expect(summary.status).toBe(200);

  const assignedPool = pools.json.budgets.find((budget) => budget.teamName === ASSIGNED);
  const budgetOnlyPool = pools.json.budgets.find((budget) => budget.teamName === BUDGET_ONLY);
  const originalOnlyPool = pools.json.budgets.find((budget) => budget.teamName === ORIGINAL_ONLY);
  expect(assignedPool.amountUsd).toBe(125);
  expect(budgetOnlyPool.amountUsd).toBe(60);
  expect(originalOnlyPool.amountUsd).toBe(75);
  expect(budgetOnlyPool.workspaceIds).toEqual([]);
  expect(originalOnlyPool.workspaceIds).toEqual([]);
  expect(!pools.json.budgets.some((budget) => budget.teamName === HIDDEN)).toBeTruthy();

  const assignedGroup = groups.json.groups.find((group) => group.groupId === GROUP_ID);
  expect(assignedGroup.teamName).toBe(ASSIGNED);
  expect(groups.json.teamBudgets[ASSIGNED]).toBe(125);
  expect(groups.json.teamBudgets[BUDGET_ONLY]).toBe(60);
  expect(groups.json.teamBudgets[ORIGINAL_ONLY]).toBe(75);
  expect(groups.json.teamBudgets[HIDDEN]).toBe(undefined);

  const positiveVisiblePoolTotal = pools.json.budgets.reduce(
    (sum, budget) => sum + Math.max(0, budget.amountUsd),
    0,
  );
  expect(summary.json.totalBudgetUsd, "summary must count every visible team pool exactly once, including budget-only rows").toBe(positiveVisiblePoolTotal);
  expect(summary.json.totalRemainingUsd).toBe(positiveVisiblePoolTotal - 20);
});

test("project detail survives restart and isolates duplicate IDs by workspace", async () => {
  invalidateUsageSnapshotMemo();
  const [first, second, cluster, projectExport, activity] = await Promise.all([
    request(`/groups/${GROUP_ID}/projects`, "task158-account"),
    request(`/groups/${SECOND_GROUP_ID}/projects`, "task158-account"),
    request(
      `/clusters/${GROUP_ID},${SECOND_GROUP_ID}/projects`,
      "task158-account",
    ),
    request("/projects/export", "task158-account"),
    request("/users/activity", "task158-account"),
  ]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.json.titlesComplete).toBe(true);
  expect(second.json.titlesComplete).toBe(true);
  expect(first.json.unattributedSpendUsd).toBe(0);
  expect(second.json.unattributedSpendUsd).toBe(0);
  expect(first.json.projects).toEqual([
    expect.objectContaining({
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project One",
      creatorId: "task158-workspace",
      creatorIsCurrentMember: true,
      totalCostUsd: 20,
    }),
  ]);
  expect(second.json.projects).toEqual([
    expect.objectContaining({
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project Two",
      creatorId: "task158-creator-2",
      creatorIsCurrentMember: true,
      totalCostUsd: 13,
    }),
  ]);
  expect(cluster.status).toBe(200);
  expect(cluster.json.projects).toHaveLength(2);
  expect(cluster.json.projects.map((project) => ({
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    totalCostUsd: project.totalCostUsd,
  })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
    { projectId: SHARED_PROJECT_ID, workspaceId: "task158-ws", totalCostUsd: 20 },
    { projectId: SHARED_PROJECT_ID, workspaceId: "task158-ws-2", totalCostUsd: 13 },
  ]);
  expect(projectExport.status).toBe(200);
  expect(projectExport.json.raw).toContain("Persisted Project One");
  expect(projectExport.json.raw).toContain("Persisted Project Two");
  expect(activity.status).toBe(200);
  expect(activity.json.usageHealth).toEqual(expect.objectContaining({
    status: expect.any(String),
    coverage: expect.objectContaining({ ratio: expect.any(Number) }),
  }));
});

test("project export neutralizes formula-leading metadata", async () => {
  const formula = "=HYPERLINK(\"https://attacker.invalid\",\"Open\")";
  await db.update(apiProjectMetadataTable)
    .set({ title: formula })
    .where(eq(apiProjectMetadataTable.workspaceId, "task158-ws"));
  try {
    const projectExport = await request("/projects/export", "task158-account");
    expect(projectExport.status).toBe(200);
    expect(projectExport.json.raw).toContain(
      "\"'=HYPERLINK(\"\"https://attacker.invalid\"\",\"\"Open\"\")\"",
    );
    expect(projectExport.json.raw).not.toContain(
      "\"=HYPERLINK(\"\"https://attacker.invalid\"\",\"\"Open\"\")\"",
    );
  } finally {
    await db.update(apiProjectMetadataTable)
      .set({ title: "Persisted Project One" })
      .where(eq(apiProjectMetadataTable.workspaceId, "task158-ws"));
  }
});

test("workspace admins see assigned effective pools but not account budget-only rows", async () => {
  const { status, json } = await request("/teams/budgets", "task158-workspace");
  expect(status).toBe(200);
  expect(json.budgets.find((budget) => budget.teamName === ASSIGNED)?.amountUsd).toBe(125);
  expect(!json.budgets.some((budget) => budget.teamName === BUDGET_ONLY)).toBeTruthy();
  expect(!json.budgets.some((budget) => budget.teamName === ORIGINAL_ONLY)).toBeTruthy();
  expect(!json.budgets.some((budget) => budget.teamName === HIDDEN)).toBeTruthy();
});

test("true admins can edit and reset monthly team and target limits", async () => {
  const path = `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/limit`;
  expect((await request(path, "task158-workspace", "PATCH", {
    monthlyLimitUsd: 9,
  })).status).toBe(403);
  let response = await request(path, "task158-account", "PATCH", {
    monthlyLimitUsd: 9,
  });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({
    monthlyLimitUsd: 9,
    monthlyLimitSource: "manual",
  });
  response = await request(path, "task158-account", "PATCH", {
    monthlyLimitUsd: null,
  });
  expect(response.json).toMatchObject({
    monthlyLimitUsd: 10.42,
    monthlyLimitSource: "derived",
  });

  const targetPath =
    `/admin/team-budgets/targets/task158-ws/${encodeURIComponent(GROUP_ID)}`;
  response = await request(targetPath, "task158-account", "PATCH", {
    monthlyLimitUsd: 4.5,
  });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({
    teamName: ASSIGNED,
    workspaceId: "task158-ws",
    groupId: GROUP_ID,
    monthlyLimitUsd: 4.5,
    targetAmountUsd: 4.5,
  });
  response = await request(targetPath, "task158-account", "PATCH", {
    monthlyLimitUsd: null,
  });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({
    monthlyLimitUsd: null,
    targetAmountUsd: 10.42,
  });
});

test("apply validates an exact explicit selection", async () => {
  expect((await request("/admin/team-budgets/apply", "task158-account", "POST", {
    all: false,
  })).status).toBe(400);
  expect((await request("/admin/team-budgets/apply", "task158-account", "POST", {
    all: true,
    teamNames: [ASSIGNED],
  })).status).toBe(400);
});
