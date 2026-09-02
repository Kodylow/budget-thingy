import assert from "node:assert/strict";
import test from "node:test";
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

test.before(async () => {
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
      sourceRecordId: `${PREFIX}-assigned`,
      sourceTeamName: ASSIGNED,
      teamName: ASSIGNED,
      amountUsd: 25,
      submissionPeriod: "2026-01",
      matchState: "accepted",
    },
    {
      sourceRecordId: `${PREFIX}-budget-only`,
      sourceTeamName: BUDGET_ONLY,
      teamName: BUDGET_ONLY,
      amountUsd: 10,
      submissionPeriod: "2026-02",
      matchState: "accepted",
    },
    {
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

test.after(async () => {
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
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, "task158-plain")).status, 403);
    assert.equal((await request(path, "task158-workspace")).status, 403);
    assert.equal((await request(path, "task158-account")).status, 200);
  }
});

test("upstream status and retry reject delegates and editors", async () => {
  assert.equal(
    (await request("/admin/team-budgets/history", "task158-delegate")).status,
    200,
  );
  for (const user of ["task158-delegate", "task158-editor"]) {
    assert.equal(
      (await request("/admin/team-budgets/sync", user)).status,
      403,
    );
    assert.equal(
      (await request("/admin/team-budgets/reconcile", user, "POST")).status,
      403,
    );
  }
});

test("only a true account admin can retry upstream budget reconciliation", async () => {
  assert.equal(
    (await request("/admin/team-budgets/reconcile", undefined, "POST")).status,
    401,
  );
  assert.equal(
    (await request("/admin/team-budgets/reconcile", "task158-workspace", "POST")).status,
    403,
  );
  const accountAdmin = await request(
    "/admin/team-budgets/reconcile",
    "task158-account",
    "POST",
  );
  assert.equal(accountAdmin.status, 200);
  assert.ok(Array.isArray(accountAdmin.json.teams));
});

test("history orders months and excludes hidden teams while retaining separate records", async () => {
  const { status, json } = await request("/admin/team-budgets/history", "task158-account");
  assert.equal(status, 200);
  assert.ok(!json.teams.some((team) => team.teamName === HIDDEN));

  const assigned = json.teams.find((team) => team.teamName === ASSIGNED);
  const budgetOnly = json.teams.find((team) => team.teamName === BUDGET_ONLY);
  assert.deepEqual(
    {
      original: assigned.originalAmountUsd,
      effective: assigned.effectiveAmountUsd,
      periods: assigned.adjustments.map((adjustment) => adjustment.submissionPeriod),
    },
    { original: 100, effective: 125, periods: ["2026-01"] },
  );
  assert.deepEqual(
    {
      original: budgetOnly.originalAmountUsd,
      effective: budgetOnly.effectiveAmountUsd,
      periods: budgetOnly.adjustments.map((adjustment) => adjustment.submissionPeriod),
    },
    { original: 50, effective: 60, periods: ["2026-02"] },
  );
});

test("effective totals agree across pool, group, and summary surfaces", async () => {
  const [pools, groups, summary] = await Promise.all([
    request("/teams/budgets", "task158-account"),
    request("/groups", "task158-account"),
    request("/summary", "task158-account"),
  ]);
  assert.equal(pools.status, 200);
  assert.equal(groups.status, 200);
  assert.equal(summary.status, 200);

  const assignedPool = pools.json.budgets.find((budget) => budget.teamName === ASSIGNED);
  const budgetOnlyPool = pools.json.budgets.find((budget) => budget.teamName === BUDGET_ONLY);
  const originalOnlyPool = pools.json.budgets.find((budget) => budget.teamName === ORIGINAL_ONLY);
  assert.equal(assignedPool.amountUsd, 125);
  assert.equal(budgetOnlyPool.amountUsd, 60);
  assert.equal(originalOnlyPool.amountUsd, 75);
  assert.deepEqual(budgetOnlyPool.workspaceIds, []);
  assert.deepEqual(originalOnlyPool.workspaceIds, []);
  assert.ok(!pools.json.budgets.some((budget) => budget.teamName === HIDDEN));

  const assignedGroup = groups.json.groups.find((group) => group.groupId === GROUP_ID);
  assert.equal(assignedGroup.teamName, ASSIGNED);
  assert.equal(groups.json.teamBudgets[ASSIGNED], 125);
  assert.equal(groups.json.teamBudgets[BUDGET_ONLY], 60);
  assert.equal(groups.json.teamBudgets[ORIGINAL_ONLY], 75);
  assert.equal(groups.json.teamBudgets[HIDDEN], undefined);

  const positiveVisiblePoolTotal = pools.json.budgets.reduce(
    (sum, budget) => sum + Math.max(0, budget.amountUsd),
    0,
  );
  assert.equal(
    summary.json.totalBudgetUsd,
    positiveVisiblePoolTotal,
    "summary must count every visible team pool exactly once, including budget-only rows",
  );
  assert.equal(summary.json.totalRemainingUsd, positiveVisiblePoolTotal - 20);
});

test("workspace admins see assigned effective pools but not account budget-only rows", async () => {
  const { status, json } = await request("/teams/budgets", "task158-workspace");
  assert.equal(status, 200);
  assert.equal(json.budgets.find((budget) => budget.teamName === ASSIGNED)?.amountUsd, 125);
  assert.ok(!json.budgets.some((budget) => budget.teamName === BUDGET_ONLY));
  assert.ok(!json.budgets.some((budget) => budget.teamName === ORIGINAL_ONLY));
  assert.ok(!json.budgets.some((budget) => budget.teamName === HIDDEN));
});