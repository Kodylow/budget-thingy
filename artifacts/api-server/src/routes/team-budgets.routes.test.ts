// @ts-nocheck
import { test, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  groupTeamsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetsTable,
} from "@workspace/db";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import {
  __setAccountUsageForTests,
  __setDirectoryCacheForTests,
  __setMemberUsageForTests,
  __setProjectUsageForTests,
  __setWsSpendForTests,
} from "../lib/enterprise.ts";
import { setTeamBudgetDirectoryFetcherForTests } from "../lib/team-budgets.ts";

const RANGE = "billing:from-cutoff";
const PREFIX = "__task158_route__";
const ASSIGNED = `${PREFIX} Assigned`;
const BUDGET_ONLY = `${PREFIX} Budget Only`;
const ORIGINAL_ONLY = `${PREFIX} Original Only`;
const HIDDEN = `${PREFIX} Hidden`;
const GROUP_NAME = `${PREFIX} Group`;
const GROUP_ID = `${PREFIX}-group`;

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
    workspaces: new Map([["task158-ws", {
      id: "task158-ws",
      name: "Task 158",
      slug: "task-158",
      memberCount: 2,
    }]]),
    groups: [{
      id: GROUP_ID,
      workspaceId: "task158-ws",
      name: GROUP_NAME,
      type: "custom",
    }],
    members: new Map([
      ["task158-account", member("task158-account", true)],
      ["task158-workspace", member("task158-workspace", false, {
        "task158-ws": { role: "admin", isDisabled: false },
      })],
      ["task158-plain", member("task158-plain", false, {
        "task158-ws": { role: "member", isDisabled: false },
      })],
    ]),
    groupMembers: new Map([[GROUP_ID, ["task158-workspace", "task158-plain"]]]),
  });
  const { resolveAuthorization } = await import("../lib/authz.ts");
  setAuthorizationResolver((userId) => {
    if (userId === "task158-delegate") {
      return Promise.resolve({ role: "account_delegate", workspaceIds: [] });
    }
    if (userId === "task158-editor") {
      return Promise.resolve({ role: "account_editor", workspaceIds: [] });
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
  await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
    ASSIGNED,
    BUDGET_ONLY,
    ORIGINAL_ONLY,
    HIDDEN,
  ]));
  await db.delete(groupTeamsTable).where(eq(groupTeamsTable.groupName, GROUP_NAME));
  await db.insert(teamBudgetsTable).values([
    { teamName: ASSIGNED, amountUsd: 100, originalAmountUsd: 100 },
    { teamName: BUDGET_ONLY, amountUsd: 50, originalAmountUsd: 50 },
    { teamName: ORIGINAL_ONLY, amountUsd: 75, originalAmountUsd: 75 },
    { teamName: HIDDEN, amountUsd: 1000, originalAmountUsd: 1000, isHidden: true },
  ]);
  await db.insert(groupTeamsTable).values({ groupName: GROUP_NAME, teamName: ASSIGNED });
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

  __setMemberUsageForTests(GROUP_ID, RANGE, new Map([
    ["task158-workspace", 15],
    ["task158-plain", 5],
  ]));
  __setWsSpendForTests("task158-ws", RANGE, new Map([
    ["task158-workspace", 15],
    ["task158-plain", 5],
  ]));
  __setProjectUsageForTests(GROUP_ID, RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 20,
    byProject: new Map([["task158-project", {
      projectId: "task158-project",
      totalCostUsd: 20,
      metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: 20 }],
    }]]),
  });
  __setAccountUsageForTests(RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 20,
    attributableTotalCostUsd: 20,
    unattributableTotalCostUsd: 0,
  });

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
  __setMemberUsageForTests(GROUP_ID, RANGE, null);
  __setWsSpendForTests("task158-ws", RANGE, null);
  __setProjectUsageForTests(GROUP_ID, RANGE, null);
  __setAccountUsageForTests(RANGE, null);
  await db.delete(teamBudgetAdjustmentsTable).where(inArray(
    teamBudgetAdjustmentsTable.sourceRecordId,
    [`${PREFIX}-assigned`, `${PREFIX}-budget-only`, `${PREFIX}-hidden`],
  ));
  await db.delete(groupTeamsTable).where(eq(groupTeamsTable.groupName, GROUP_NAME));
  await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
    ASSIGNED,
    BUDGET_ONLY,
    ORIGINAL_ONLY,
    HIDDEN,
  ]));
  delete process.env.REPLIT_ENTERPRISE_API_KEY;
});

async function request(path, user, method = "GET") {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: user ? { "x-test-user": user } : {},
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
  const { status, json } = await request("/admin/team-budgets/sync", "task158-account");
  expect(status).toBe(200);
  expect(json.sourceTable).toBe("Replit Finance Approval");
  expect(json.requiredApprovalStatus).toBe("Approved");
});

test("upstream status and retry reject delegates and editors", async () => {
  expect((await request("/admin/team-budgets/history", "task158-delegate")).status).toBe(200);
  for (const user of ["task158-delegate", "task158-editor"]) {
    expect((await request("/admin/team-budgets/sync", user)).status).toBe(403);
    expect((await request("/admin/team-budgets/reconcile", user, "POST")).status).toBe(403);
  }
});

test("only a true account admin can retry upstream budget reconciliation", async () => {
  expect((await request("/admin/team-budgets/reconcile", undefined, "POST")).status).toBe(401);
  expect((await request("/admin/team-budgets/reconcile", "task158-workspace", "POST")).status).toBe(403);
  let rejectDirectory;
  const pendingDirectory = new Promise((_resolve, reject) => {
    rejectDirectory = reject;
  });
  setTeamBudgetDirectoryFetcherForTests(() => pendingDirectory);
  const startedAt = Date.now();
  const accountAdmin = await request(
    "/admin/team-budgets/reconcile",
    "task158-account",
    "POST",
  );
  expect(accountAdmin.status).toBe(200);
  expect(Array.isArray(accountAdmin.json.teams)).toBeTruthy();
  expect(Date.now() - startedAt < 1_000, "retry response must not await Enterprise").toBeTruthy();

  rejectDirectory(new Error("forced delayed directory failure"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  setTeamBudgetDirectoryFetcherForTests(async () => ({
    allGroups: [{
      id: GROUP_ID,
      workspaceId: "task158-ws",
      name: GROUP_NAME,
      type: "custom",
    }],
  }));
});

test("history orders months and excludes hidden teams while retaining separate records", async () => {
  const { status, json } = await request("/admin/team-budgets/history", "task158-account");
  expect(status).toBe(200);
  expect(!json.teams.some((team) => team.teamName === HIDDEN)).toBeTruthy();

  const assigned = json.teams.find((team) => team.teamName === ASSIGNED);
  const budgetOnly = json.teams.find((team) => team.teamName === BUDGET_ONLY);
  expect({
      original: assigned.originalAmountUsd,
      effective: assigned.effectiveAmountUsd,
      periods: assigned.adjustments.map((adjustment) => adjustment.submissionPeriod),
    }).toEqual({ original: 100, effective: 125, periods: ["2026-01"] });
  expect({
      original: budgetOnly.originalAmountUsd,
      effective: budgetOnly.effectiveAmountUsd,
      periods: budgetOnly.adjustments.map((adjustment) => adjustment.submissionPeriod),
    }).toEqual({ original: 50, effective: 60, periods: ["2026-02"] });
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

test("workspace admins see assigned effective pools but not account budget-only rows", async () => {
  const { status, json } = await request("/teams/budgets", "task158-workspace");
  expect(status).toBe(200);
  expect(json.budgets.find((budget) => budget.teamName === ASSIGNED)?.amountUsd).toBe(125);
  expect(!json.budgets.some((budget) => budget.teamName === BUDGET_ONLY)).toBeTruthy();
  expect(!json.budgets.some((budget) => budget.teamName === ORIGINAL_ONLY)).toBeTruthy();
  expect(!json.budgets.some((budget) => budget.teamName === HIDDEN)).toBeTruthy();
});