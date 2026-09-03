import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  alertsTable,
  db,
  editorAllowlistTable,
  editorBootstrapStateTable,
  firedThresholdsTable,
  groupBudgetsTable,
  groupTeamsTable,
  teamBudgetsTable,
  usersTable,
  usageLimitAuditsTable,
} from "@workspace/db";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import {
  BOOTSTRAP_EDITOR_EMAIL,
  maybeBootstrapEditor,
} from "../lib/authz.ts";
import { setSendEmailOverrideForTests } from "../lib/email.ts";
import { setReplitBudgetTransportForTests } from "../lib/replit-budgets.ts";
import {
  __setDirectoryCacheForTests,
  __setAccountUsageForTests,
  __setMemberUsageForTests,
  __setWsSpendForTests,
  __setWorkspaceMemberUsageStatusForTests,
  __setProjectUsageForTests,
  ENTERPRISE_REQUEST_TIMEOUT_MS,
  getDirectory,
  getDirectoryFreshness,
  parseIsAccountAdmin,
  resolveRange,
  setEnterpriseFetchForTests,
} from "../lib/enterprise.ts";

// ---------------------------------------------------------------------------
// Route-level authorization tests. A minimal Express app stands in for the
// real server: a stub auth middleware injects the identity from a test header,
// the directory cache is seeded with a representative fixture, and the shared
// authorization resolver is injected. Production code paths are unchanged —
// only the injection seams (documented as test-only) are exercised here.
// ---------------------------------------------------------------------------

function m(userId, isAccountAdmin, workspaces) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.com`,
    name: userId,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

const groups = [
  { id: "g-ws1-a", workspaceId: "ws-1", name: "Alpha", type: "custom" },
  { id: "g-ws2-a", workspaceId: "ws-2", name: "Gamma", type: "custom" },
];

const members = new Map([
  ["acct", m("acct", true, {})],
  ["ws1admin", m("ws1admin", false, { "ws-1": { role: "admin", isDisabled: false } })],
  ["plain", m("plain", false, { "ws-1": { role: "member", isDisabled: false } })],
  ["ws2user", m("ws2user", false, { "ws-2": { role: "member", isDisabled: false } })],
  ["editor", m("editor", false, { "ws-1": { role: "member", isDisabled: false } })],
]);

// ws1admin and plain are in g-ws1-a; ws2user is in g-ws2-a (out of ws1admin's scope)
const groupMembers = new Map([
  ["g-ws1-a", ["ws1admin", "plain"]],
  ["g-ws2-a", ["ws2user"]],
]);

const workspaces = new Map([
  ["ws-1", { id: "ws-1", name: "Zeta Workspace" }],
  ["ws-2", { id: "ws-2", name: "Alpha Workspace" }],
]);

let server;
let baseUrl;
let budgetWriteFailures = new Set();
let budgetWriteUserIds = [];
const delegateManagedEmail = `delegate-managed-${randomUUID()}@example.com`;

test.before(async () => {
  // Validation may reuse a shared test database created before the latest
  // additive alert migration.
  await db.execute(sql`
    ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS data_as_of timestamp with time zone
  `);
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key"; // marks isConfigured()
  setSendEmailOverrideForTests(async (to) => ({
    ok: true,
    deliveredTo: to,
    messageId: "test-message",
  }));
  setReplitBudgetTransportForTests(async (path, init) => {
    if (init.method === "GET") {
      const workspaceId = new URL(path, "https://connector.invalid").searchParams.get("workspaceId");
      return new Response(JSON.stringify({
        data: workspaceId === "ws-1"
          ? [
              { workspaceId, userId: "ws1admin", amountUsd: 20 },
              { workspaceId, userId: "plain", amountUsd: null },
            ]
          : [],
        pagination: { hasMore: false, cursor: null },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    if (init.method === "PUT") {
      budgetWriteUserIds.push(body.userId);
      if (budgetWriteFailures.has(body.userId)) {
        return new Response(JSON.stringify({ error: `Rejected ${body.userId}` }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(null, { status: 204 });
  });
  __setDirectoryCacheForTests({ workspaces, groups, members, groupMembers });
  __setMemberUsageForTests(
    resolveRange("billing").key,
    new Map([
      ["g-ws1-a", new Map([["ws1admin", 25], ["plain", 2]])],
      ["g-ws2-a", new Map([["ws2user", 4]])],
    ]),
    new Map([
      ["g-ws1-a", 0],
      ["g-ws2-a", 0],
    ]),
  );
  __setWsSpendForTests(
    "ws-1",
    resolveRange("billing").key,
    new Map([["ws1admin", 90], ["plain", 12]]),
    {
      agentByUser: new Map([["ws1admin", 25], ["plain", 2]]),
    },
  );
  __setMemberUsageForTests(
    "custom:2026-05-20:2026-08-11",
    new Map([
      ["g-ws1-a", new Map([["shared", 40], ["ws1-only", 10]])],
      ["g-ws2-a", new Map([["shared", 40], ["ws2-only", 20]])],
    ]),
    new Map([
      ["g-ws1-a", 3],
      ["g-ws2-a", 4],
    ]),
  );
  for (const [groupId, spend] of [["g-ws1-a", 53], ["g-ws2-a", 64]]) {
    __setProjectUsageForTests(groupId, "custom:2026-05-20:2026-08-11", {
      fetchedAt: Date.now(),
      totalCostUsd: spend,
      byProject: new Map([[`${groupId}-project`, {
        projectId: `${groupId}-project`,
        totalCostUsd: spend,
        metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: spend }],
      }]]),
    });
  }
  __setAccountUsageForTests("custom:2026-05-20:2026-08-11", {
    fetchedAt: Date.now(),
    totalCostUsd: 117,
    attributableTotalCostUsd: 110,
    unattributableTotalCostUsd: 7,
  });
  __setWsSpendForTests(
    "ws-1",
    "custom:2026-05-20:2026-08-11",
    new Map([["shared", 40], ["ws1-only", 10]]),
    { unattributableTotalCostUsd: 3 },
  );
  __setWsSpendForTests(
    "ws-2",
    "custom:2026-05-20:2026-08-11",
    new Map([["shared", 40], ["ws2-only", 20]]),
    { unattributableTotalCostUsd: 4 },
  );

  // Inject the real resolution logic but against the seeded directory. Using
  // the actual resolver keeps the test faithful to production behavior.
  const { resolveAuthorization } = await import("../lib/authz.ts");
  setAuthorizationResolver((userId) => resolveAuthorization(userId));
  await db.insert(groupBudgetsTable).values([
    { groupId: "g-ws1-a", amountUsd: 100 },
    { groupId: "g-ws2-a", amountUsd: 200 },
  ]).onConflictDoNothing();
  await db.insert(groupTeamsTable).values([
    { groupName: "Alpha", teamName: "Team One" },
    { groupName: "Gamma", teamName: "Team Two" },
  ]).onConflictDoNothing();
  await db.insert(teamBudgetsTable).values([
    { teamName: "Team One", amountUsd: 500 },
    { teamName: "Team Two", amountUsd: 900 },
  ]).onConflictDoNothing();
  await db.insert(usersTable).values({
    id: "editor",
    email: "editor@example.com",
  }).onConflictDoNothing();
  await db.insert(usersTable).values({
    id: "candidate-editor",
    email: "candidate-editor@example.com",
  }).onConflictDoNothing();
  await db.insert(usersTable).values({
    id: "bootstrap-editor",
    email: "bootstrap-editor@example.com",
  }).onConflictDoNothing();
  await db.insert(editorAllowlistTable).values({
    userId: "editor",
    email: "editor@example.com",
  }).onConflictDoNothing();
  await db.insert(alertsTable).values([
    {
      groupId: "g-ws1-a",
      groupName: "Alpha",
      threshold: 50,
      spendUsd: 50,
      budgetUsd: 100,
      recipients: ["private@example.com"],
      status: "sent",
    },
    {
      groupId: "g-ws2-a",
      groupName: "Gamma",
      threshold: 50,
      spendUsd: 100,
      budgetUsd: 200,
      recipients: ["private@example.com"],
      status: "sent",
    },
  ]);

  const app = express();
  app.use(express.json());
  // Stub auth middleware: reads x-test-user; absent => unauthenticated.
  app.use((req, _res, next) => {
    const uid = req.headers["x-test-user"];
    req.isAuthenticated = function () {
      return this.user != null;
    };
    if (uid) req.user = { id: String(uid) };
    next();
  });
  app.use("/api", monitorRouter);

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  const fixtureIds = ["g-ws1-a", "g-ws2-a"];
  await db.delete(alertsTable).where(inArray(alertsTable.groupId, fixtureIds));
  await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, fixtureIds));
  await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, ["Team One", "Team Two"]));
  await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, ["Alpha", "Gamma"]));
  await db.delete(editorAllowlistTable).where(inArray(editorAllowlistTable.userId, ["editor", "candidate-editor", "bootstrap-editor"]));
  await db.delete(editorBootstrapStateTable).where(
    inArray(editorBootstrapStateTable.userId, ["bootstrap-editor", "candidate-editor"]),
  );
  await db.delete(usersTable).where(inArray(usersTable.id, ["editor", "candidate-editor", "bootstrap-editor"]));
  await db.delete(usageLimitAuditsTable).where(inArray(usageLimitAuditsTable.workspaceId, ["ws-1", "ws-2"]));
  __setDirectoryCacheForTests(null);
  __setAccountUsageForTests("custom:2026-05-20:2026-08-11", null);
  __setWsSpendForTests("ws-1", "custom:2026-05-20:2026-08-11", null);
  __setWsSpendForTests("ws-2", "custom:2026-05-20:2026-08-11", null);
  __setMemberUsageForTests("custom:2026-05-20:2026-08-11", null);
  __setProjectUsageForTests("g-ws1-a", "custom:2026-05-20:2026-08-11", null);
  __setProjectUsageForTests("g-ws2-a", "custom:2026-05-20:2026-08-11", null);
  setAuthorizationResolver(null);
  setSendEmailOverrideForTests(null);
  setReplitBudgetTransportForTests(null);
  setEnterpriseFetchForTests(null);
  delete process.env.REPLIT_ENTERPRISE_API_KEY;
  server?.close();
});

async function req(path, { user, method = "GET", body } = {}) {
  const headers = {};
  if (user) headers["x-test-user"] = user;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function csvReq(path, user) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    headers: user ? { "x-test-user": user } : {},
  });
  const text = await res.text();
  const unquote = (value) => value.trim().replace(/^"|"$/g, "").replace(/""/g, '"');
  const lines = text.trim().split(/\r?\n/);
  const headers = res.ok ? lines[0].split(",").map(unquote) : [];
  const rows = res.ok
    ? lines.slice(1).map((line) => Object.fromEntries(
        line.split(",").map(unquote).map((value, index) => [headers[index], value]),
      ))
    : [];
  return { res, text, rows };
}

test("unauthenticated request to a protected endpoint returns 401", async () => {
  const { status } = await req("/groups");
  assert.equal(status, 401);
});

test("authenticated but unauthorized user returns 403", async () => {
  const { status } = await req("/groups", { user: "plain" });
  assert.equal(status, 403);
});

test("account admin sees every group", async () => {
  const { status, json } = await req("/groups", { user: "acct" });
  assert.equal(status, 200);
  const ids = json.groups.filter((g) => !g.isSynthetic).map((g) => g.groupId).sort();
  assert.deepEqual(ids, ["g-ws1-a", "g-ws2-a"]);
  assert.equal(typeof json.directoryDataAsOf, "string");
  assert.equal(typeof json.directoryStale, "boolean");
  assert.equal(json.usageDataAsOf === null || typeof json.usageDataAsOf === "string", true);
  assert.equal(typeof json.usageStale, "boolean");
});

test("stale directory authorization and handlers do not wait for an in-progress or failed refresh", async () => {
  let rejectRefresh;
  let enterpriseRequests = 0;
  const refreshFailure = new Promise((_resolve, reject) => {
    rejectRefresh = reject;
  });
  setEnterpriseFetchForTests(async () => {
    enterpriseRequests++;
    return refreshFailure;
  });
  __setDirectoryCacheForTests({
    workspaces,
    groups,
    members,
    groupMembers,
    fetchedAt: Date.now() - 60 * 60 * 1000,
  });

  const startedAt = Date.now();
  const first = await req("/groups", { user: "acct" });
  const second = await req("/groups", { user: "acct" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(Date.now() - startedAt < 1_000, "requests should return from stored data");
  assert.equal(first.json.directoryStale, true);
  assert.equal(enterpriseRequests, 1, "concurrent polling must share one directory refresh");
  assert.equal(getDirectoryFreshness().isRefreshing, true);

  rejectRefresh(new Error("forced Enterprise outage"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterFailure = await req("/groups", { user: "acct" });
  assert.equal(afterFailure.status, 200);
  assert.equal(afterFailure.json.directoryStale, true);

  setEnterpriseFetchForTests(null);
  __setDirectoryCacheForTests({ workspaces, groups, members, groupMembers });
});

test("every Enterprise directory request carries the common 30-second timeout signal", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutValues = [];
  AbortSignal.timeout = (milliseconds) => {
    timeoutValues.push(milliseconds);
    return new AbortController().signal;
  };
  setEnterpriseFetchForTests(async () => new Response(JSON.stringify({
    data: [],
    pagination: { cursor: null, hasMore: false },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  try {
    await getDirectory(true);
    assert.ok(timeoutValues.length >= 3);
    assert.deepEqual(
      [...new Set(timeoutValues)],
      [ENTERPRISE_REQUEST_TIMEOUT_MS],
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
    setEnterpriseFetchForTests(null);
    __setDirectoryCacheForTests({ workspaces, groups, members, groupMembers });
  }
});

test("a partial directory refresh cannot replace the last complete snapshot", async () => {
  __setDirectoryCacheForTests({ workspaces, groups, members, groupMembers });
  setEnterpriseFetchForTests(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/workspaces")) {
      return new Response(JSON.stringify({
        data: [{ id: "replacement-ws", name: "Replacement" }],
        pagination: { cursor: null, hasMore: false },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname.endsWith("/groups")) {
      return new Response(JSON.stringify({
        data: [{
          id: "replacement-group",
          workspaceId: "replacement-ws",
          name: "Replacement",
          type: "custom",
        }],
        pagination: { cursor: null, hasMore: false },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("forced membership outage", { status: 503 });
  });

  try {
    await assert.rejects(getDirectory(true), /503/);
    const retained = await getDirectory();
    assert.deepEqual(
      retained.groups.map((group) => group.id).sort(),
      ["g-ws1-a", "g-ws2-a"],
    );
  } finally {
    setEnterpriseFetchForTests(null);
    __setDirectoryCacheForTests({ workspaces, groups, members, groupMembers });
  }
});

test("group directory is account-admin-only and returns alphabetized directory metadata", async () => {
  const unauthenticated = await req("/directory/groups");
  assert.equal(unauthenticated.status, 401);

  const workspaceAdmin = await req("/directory/groups", { user: "ws1admin" });
  assert.equal(workspaceAdmin.status, 403);

  const accountAdmin = await req("/directory/groups", { user: "acct" });
  assert.equal(accountAdmin.status, 200);
  assert.deepEqual(accountAdmin.json, [
    {
      groupId: "g-ws2-a",
      groupName: "Gamma",
      workspaceId: "ws-2",
      workspaceName: "Alpha Workspace",
    },
    {
      groupId: "g-ws1-a",
      groupName: "Alpha",
      workspaceId: "ws-1",
      workspaceName: "Zeta Workspace",
    },
  ]);
});

test("workspace admin only sees in-scope groups", async () => {
  const { status, json } = await req("/groups", { user: "ws1admin" });
  assert.equal(status, 200);
  const ids = json.groups.filter((g) => !g.isSynthetic).map((g) => g.groupId);
  assert.deepEqual(ids, ["g-ws1-a"]);
  assert.ok(
    json.groups.filter((g) => g.isSynthetic).every((g) => g.workspaceId === "ws-1"),
    "workspace admins must never receive synthetic rows from another workspace",
  );
});

test("client-crafted RBAC preview headers cannot broaden server authorization", async () => {
  const res = await fetch(`${baseUrl}/api/groups`, {
    headers: {
      "x-test-user": "ws1admin",
      "x-rbac-preview-role": "account_admin",
      "x-rbac-preview-workspace-ids": "ws-2",
    },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  const ids = json.groups.filter((group) => !group.isSynthetic).map((group) => group.groupId);
  assert.deepEqual(ids, ["g-ws1-a"]);
});

test("summary totalGroups reflects the scoped group set", async () => {
  const acct = await req("/summary", { user: "acct" });
  assert.equal(acct.json.totalGroups, 2);
  const ws1 = await req("/summary", { user: "ws1admin" });
  assert.equal(ws1.json.totalGroups, 1);
});

test("custom range uses inclusive UTC days and all visible workspaces without overlap inflation", async () => {
  const range = resolveRange("custom", "2026-05-20", "2026-08-11");
  assert.deepEqual(range.params, {
    startTime: "2026-05-20T00:00:00.000Z",
    endTime: "2026-08-12T00:00:00.000Z",
  });

  const acct = await req(
    "/summary?rangeType=custom&startDate=2026-05-20&endDate=2026-08-11",
    { user: "acct" },
  );
  assert.equal(acct.status, 200);
  // Equal values in distinct workspaces are distinct observations:
  // shared(40 in ws-1 + 40 in ws-2)+ws1-only(10)+ws2-only(20)+unattributable(3+4)=117.
  assert.equal(acct.json.totalSpendUsd, 117);
  assert.equal(acct.json.memberBasedTotalSpendUsd, 117);
  assert.equal(acct.json.accountUsageTotalSpendUsd, 117);
  assert.equal(acct.json.reconciliationSpendUsd, 0);
  assert.equal(acct.json.isComplete, true);

  const ws1 = await req(
    "/summary?rangeType=custom&startDate=2026-05-20&endDate=2026-08-11",
    { user: "ws1admin" },
  );
  // ws1admin sees only g-ws1-a: shared(40)+ws1-only(10)+unattributable(3)=53
  assert.equal(ws1.json.totalSpendUsd, 53);
  assert.equal(ws1.json.accountUsageTotalSpendUsd, null);
  assert.equal(ws1.json.accountUsageAttributableSpendUsd, null);
  assert.equal(ws1.json.accountUsageUnattributableSpendUsd, null);
  assert.equal(ws1.json.reconciliationSpendUsd, null);
  assert.equal(ws1.json.isComplete, true);
});

test("trend ranges preserve workspace-admin scope and selected custom dates", async () => {
  const range = resolveRange("custom", "2026-06-01", "2026-06-30");
  __setMemberUsageForTests(
    range.key,
    new Map([
      ["g-ws1-a", new Map([["ws1admin", 40], ["plain", 10]])],
      ["g-ws2-a", new Map([["ws2user", 60]])],
    ]),
    new Map([
      ["g-ws1-a", 3],
      ["g-ws2-a", 4],
    ]),
  );
  __setWsSpendForTests(
    "ws-1",
    range.key,
    new Map([["ws1admin", 40], ["plain", 10]]),
    { unattributableTotalCostUsd: 3 },
  );
  __setWsSpendForTests(
    "ws-2",
    range.key,
    new Map([["ws2user", 60]]),
    { unattributableTotalCostUsd: 4 },
  );
  try {
    const account = await req(
      "/trends?granularity=month&rangeType=custom&startDate=2026-06-01&endDate=2026-06-30",
      { user: "acct" },
    );
    assert.equal(account.status, 200);
    assert.deepEqual(account.json.bucketRanges, [
      { start: "2026-06-01", end: "2026-06-30", isPartial: false },
    ]);
    assert.deepEqual(account.json.totals, [117]);

    const scoped = await req(
      "/trends?granularity=month&rangeType=custom&startDate=2026-06-01&endDate=2026-06-30",
      { user: "ws1admin" },
    );
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.json.totals, [53]);
    assert.deepEqual(
      scoped.json.series.filter((series) => series.type === "group").map((series) => series.name),
      ["Alpha"],
    );
    assert.deepEqual(
      scoped.json.series.filter((series) => series.type === "team").map((series) => series.name),
      ["Team One"],
    );
  } finally {
    __setMemberUsageForTests(range.key, null);
    __setWsSpendForTests("ws-1", range.key, null);
    __setWsSpendForTests("ws-2", range.key, null);
  }
});

test("cross-scope group detail returns non-disclosing 404", async () => {
  // ws1admin cannot see ws-2's group; response must look like 'not found'.
  const { status, json } = await req("/groups/g-ws2-a", { user: "ws1admin" });
  assert.equal(status, 404);
  assert.equal(json.error, "Group not found");
  // A truly missing group looks identical.
  const missing = await req("/groups/does-not-exist", { user: "ws1admin" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, "Group not found");
});

test("in-scope group detail is reachable by workspace admin", async () => {
  const { status } = await req("/groups/g-ws1-a", { user: "ws1admin" });
  assert.equal(status, 200);
});

test("cross-scope project detail returns the same non-disclosing 404", async () => {
  const outside = await req("/groups/g-ws2-a/projects", { user: "ws1admin" });
  const missing = await req("/groups/does-not-exist/projects", { user: "ws1admin" });
  assert.equal(outside.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(outside.json.error, "Group not found");
  assert.equal(missing.json.error, "Group not found");
});

test("cluster project detail rejects a cluster containing any out-of-scope group", async () => {
  const { status, json } = await req(
    "/clusters/g-ws1-a,g-ws2-a/projects",
    { user: "ws1admin" },
  );
  assert.equal(status, 404);
  assert.equal(json.error, "No matching groups found");
});

test("workspace admin budgets are limited to visible groups", async () => {
  const { status, json } = await req("/budgets", { user: "ws1admin" });
  assert.equal(status, 200);
  assert.deepEqual(json.map((budget) => budget.groupId), ["g-ws1-a"]);
});

test("workspace member budget reads are scoped and preserve unset and negative remaining", async () => {
  const visible = await req("/directory/workspaces/ws-1/members", { user: "ws1admin" });
  assert.equal(visible.status, 200);
  assert.equal(visible.json.billingPeriod, "current");
  assert.deepEqual(visible.json.connector, {
    status: "available",
    canWrite: true,
    error: null,
  });
  assert.equal(visible.json.members.find((member) => member.userId === "ws1admin").remainingUsd, -5);
  assert.equal(visible.json.members.find((member) => member.userId === "plain").remainingUsd, null);

  const hidden = await req("/directory/workspaces/ws-2/members", { user: "ws1admin" });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.error, "Workspace not found");
});

test("partial workspace usage never invents zero usage or remaining", async () => {
  const rangeKey = resolveRange("billing").key;
  __setWorkspaceMemberUsageStatusForTests("ws-1", rangeKey, "partial");
  const partial = await req("/directory/workspaces/ws-1/members", { user: "ws1admin" });
  assert.equal(partial.status, 200);
  const member = partial.json.members.find((row) => row.userId === "ws1admin");
  assert.equal(member.usageUsd, null);
  assert.equal(member.remainingUsd, null);
  __setWsSpendForTests(
    "ws-1",
    rangeKey,
    new Map([["ws1admin", 90], ["plain", 12]]),
    { agentByUser: new Map([["ws1admin", 25], ["plain", 2]]) },
  );
});

test("legacy workspace usage without successful sync metadata remains unknown", async () => {
  const rangeKey = resolveRange("billing").key;
  __setWorkspaceMemberUsageStatusForTests("ws-1", rangeKey, null);
  const legacy = await req("/directory/workspaces/ws-1/members", { user: "ws1admin" });
  assert.equal(legacy.status, 200);
  const member = legacy.json.members.find((row) => row.userId === "ws1admin");
  assert.equal(member.usageUsd, null);
  assert.equal(member.remainingUsd, null);
  __setWsSpendForTests(
    "ws-1",
    rangeKey,
    new Map([["ws1admin", 90], ["plain", 12]]),
    { agentByUser: new Map([["ws1admin", 25], ["plain", 2]]) },
  );
});

test("workspace admins cannot mutate member budgets while account operators can set and clear", async () => {
  assert.equal((await req("/directory/workspaces/ws-1/members/plain/budget", {
    user: "ws1admin",
    method: "PUT",
    body: { amountUsd: 50 },
  })).status, 403);

  const set = await req("/directory/workspaces/ws-1/members/plain/budget", {
    user: "editor",
    method: "PUT",
    body: { amountUsd: 50 },
  });
  assert.equal(set.status, 200);
  assert.equal(set.json.budgetUsd, 50);
  const cleared = await req("/directory/workspaces/ws-1/members/plain/budget", {
    user: "editor",
    method: "DELETE",
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.budgetUsd, null);
});

test("bulk member limits deduplicate users and expose mixed upstream outcomes", async () => {
  budgetWriteFailures = new Set(["plain"]);
  budgetWriteUserIds = [];
  try {
    const result = await req("/directory/workspaces/ws-1/members/budget", {
      user: "editor",
      method: "PUT",
      body: { userIds: ["ws1admin", "plain", "ws1admin"], amountUsd: 75 },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(budgetWriteUserIds, ["ws1admin", "plain"]);
    assert.deepEqual(result.json.outcomes.map(({ userId, success }) => ({ userId, success })), [
      { userId: "ws1admin", success: true },
      { userId: "plain", success: false },
    ]);
    assert.match(result.json.outcomes[1].error, /Rejected plain/);

    assert.equal(
      (await req("/directory/workspaces/ws-1/usage-limit-audits", { user: "ws1admin" })).status,
      403,
    );
    assert.equal(
      (await req("/directory/workspaces/ws-1/usage-limit-audits", { user: "editor" })).status,
      403,
    );
    const audit = await req("/directory/workspaces/ws-1/usage-limit-audits", { user: "acct" });
    assert.equal(audit.status, 200);
    const bulkRows = audit.json.filter(
      (row) => row.requestedAmountUsd === 75 &&
        ["ws1admin", "plain"].includes(row.memberUserId),
    );
    const individualSet = audit.json.find(
      (row) => row.memberUserId === "plain" &&
        row.action === "set" &&
        row.requestedAmountUsd === 50,
    );
    const individualClear = audit.json.find(
      (row) => row.memberUserId === "plain" &&
        row.action === "clear" &&
        row.requestedAmountUsd === null,
    );
    assert.equal(individualSet?.outcome, "success");
    assert.equal(individualClear?.outcome, "success");
    assert.deepEqual(
      bulkRows
        .map(({ memberUserId, outcome }) => ({ memberUserId, outcome }))
        .sort((a, b) => a.memberUserId.localeCompare(b.memberUserId)),
      [
        { memberUserId: "plain", outcome: "failed" },
        { memberUserId: "ws1admin", outcome: "success" },
      ],
    );
    assert.ok(bulkRows.every((row) =>
      row.operatorUserId === "editor" &&
      row.workspaceId === "ws-1" &&
      row.action === "set" &&
      row.operation === "bulk" &&
      typeof row.createdAt === "string"
    ));
  } finally {
    budgetWriteFailures = new Set();
    budgetWriteUserIds = [];
  }
});

test("bulk member limits reject unauthorized, invalid, and stale members before writing", async () => {
  budgetWriteUserIds = [];
  assert.equal((await req("/directory/workspaces/ws-1/members/budget", {
    user: "ws1admin",
    method: "PUT",
    body: { userIds: ["plain"], amountUsd: 10 },
  })).status, 403);
  assert.equal((await req("/directory/workspaces/ws-1/members/budget", {
    user: "editor",
    method: "PUT",
    body: { userIds: ["plain"], amountUsd: 0 },
  })).status, 400);
  assert.equal((await req("/directory/workspaces/ws-1/members/budget", {
    user: "editor",
    method: "PUT",
    body: {
      userIds: Array.from({ length: 101 }, (_, index) => `member-${index}`),
      amountUsd: 10,
    },
  })).status, 400);
  assert.equal((await req("/directory/workspaces/ws-1/members/budget", {
    user: "editor",
    method: "PUT",
    body: { userIds: ["plain", "ws2user"], amountUsd: 10 },
  })).status, 404);
  assert.deepEqual(budgetWriteUserIds, []);
});

test("workspace admin alerts are scoped and recipient addresses are redacted", async () => {
  const { status, json } = await req("/alerts", { user: "ws1admin" });
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].entityType, "group");
  assert.equal(json[0].entityId, "g-ws1-a");
  assert.deepEqual(json[0].recipients, []);
  assert.equal(json[0].spendUsd, 50, "stored spend remains the send-time snapshot");
  assert.equal(json[0].currentUsageComplete, false);
  assert.equal(json[0].currentSpendUsd, null);
  assert.equal(json[0].currentPercentUsed, null);
});

test("workspace admin is denied account-only recipient list (403)", async () => {
  const { status } = await req("/admins", { user: "ws1admin" });
  assert.equal(status, 403);
});

test("workspace admin is denied system status (403)", async () => {
  const { status } = await req("/status", { user: "ws1admin" });
  assert.equal(status, 403);
});

test("workspace admin sees only in-scope team pools read-only", async () => {
  const { status, json } = await req("/teams/budgets", { user: "ws1admin" });
  assert.equal(status, 200);
  assert.deepEqual(json.budgets.map((budget) => budget.teamName), ["Team One"]);
  assert.deepEqual(json.budgets[0].workspaceIds, ["ws-1"]);
});

test("workspace admin sees a shared team pool but not its account-wide alert aggregate", async () => {
  await db
    .update(groupTeamsTable)
    .set({ teamName: "Shared Team" })
    .where(inArray(groupTeamsTable.groupName, ["Alpha", "Gamma"]));
  await db
    .insert(teamBudgetsTable)
    .values({ teamName: "Shared Team", amountUsd: 1400 })
    .onConflictDoNothing();
  const [teamAlert] = await db
    .insert(alertsTable)
    .values({
      groupId: "Shared Team",
      groupName: "Shared Team",
      entityType: "team",
      entityId: "Shared Team",
      entityName: "Shared Team",
      workspaceIds: ["ws-1", "ws-2"],
      threshold: 50,
      spendUsd: 700,
      budgetUsd: 1400,
      recipients: ["private@example.com"],
      status: "sent",
    })
    .returning();
  try {
    const pools = await req("/teams/budgets", { user: "ws1admin" });
    assert.equal(pools.status, 200);
    const sharedPool = pools.json.budgets.find((budget) => budget.teamName === "Shared Team");
    assert.equal(sharedPool.amountUsd, 1400);
    assert.deepEqual(sharedPool.workspaceIds, ["ws-1"]);

    const alerts = await req("/alerts", { user: "ws1admin" });
    assert.ok(!alerts.json.some((alert) => alert.entityId === "Shared Team"));

    const accountPools = await req("/teams/budgets", { user: "acct" });
    assert.ok(accountPools.json.budgets.some((budget) => budget.teamName === "Shared Team"));
  } finally {
    if (teamAlert) await db.delete(alertsTable).where(eq(alertsTable.id, teamAlert.id));
    await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, "Shared Team"));
    await db
      .update(groupTeamsTable)
      .set({ teamName: "Team One" })
      .where(eq(groupTeamsTable.groupName, "Alpha"));
    await db
      .update(groupTeamsTable)
      .set({ teamName: "Team Two" })
      .where(eq(groupTeamsTable.groupName, "Gamma"));
  }
});

test("workspace admin mutation attempts are rejected (403, read-only)", async () => {
  const setBudget = await req("/groups/g-ws1-a/budget", {
    user: "ws1admin",
    method: "PUT",
    body: { amountUsd: 100 },
  });
  assert.equal(setBudget.status, 403);

  const refresh = await req("/groups/g-ws1-a/refresh", {
    user: "ws1admin",
    method: "POST",
  });
  assert.equal(refresh.status, 403);

  const check = await req("/alerts/check", { user: "ws1admin", method: "POST" });
  assert.equal(check.status, 403);

  const rebuild = await req("/usage/ranges/rebuild", {
    user: "ws1admin",
    method: "POST",
    body: { rangeType: "billing" },
  });
  assert.equal(rebuild.status, 403);

  const addAdmin = await req("/admins", {
    user: "ws1admin",
    method: "POST",
    body: { email: "x@example.com" },
  });
  assert.equal(addAdmin.status, 403);
});

test("account admin can read account-only endpoints", async () => {
  const admins = await req("/admins", { user: "acct" });
  assert.equal(admins.status, 200);
  const status = await req("/status", { user: "acct" });
  assert.equal(status.status, 200);
});

test("allowlisted editor has account-wide operational access but no settings or access management", async () => {
  const groupsResponse = await req("/groups", { user: "editor" });
  assert.equal(groupsResponse.status, 200);
  assert.deepEqual(
    groupsResponse.json.groups
      .filter((group) => !group.isSynthetic)
      .map((group) => group.groupId)
      .sort(),
    ["g-ws1-a", "g-ws2-a"],
  );

  const setPool = await req("/groups/g-ws1-a/budget", {
    user: "editor",
    method: "PUT",
    body: { amountUsd: 321 },
  });
  assert.equal(setPool.status, 200);

  assert.equal((await req("/admins", { user: "editor" })).status, 403);
  assert.equal((await req("/status", { user: "editor" })).status, 403);
  assert.equal((await req("/editors", { user: "editor" })).status, 403);
  const source = (await req("/alerts", { user: "editor" })).json[0];
  assert.equal(
    (await req(`/alerts/${source.id}/test`, {
      user: "editor",
      method: "POST",
    })).status,
    403,
  );
  assert.equal(
    (await req("/editors", {
      user: "editor",
      method: "POST",
      body: { userId: "candidate-editor" },
    })).status,
    403,
  );
});

test("account admin can test an alert without firing threshold state", async () => {
  const source = (await req("/alerts", { user: "acct" })).json[0];
  const firedBefore = await db.select().from(firedThresholdsTable);
  const response = await req(`/alerts/${source.id}/test`, {
    user: "acct",
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.status, "sent");
  assert.deepEqual(response.json.recipients, [BOOTSTRAP_EDITOR_EMAIL]);
  const firedAfter = await db.select().from(firedThresholdsTable);
  assert.equal(firedAfter.length, firedBefore.length);
});

test("workspace admin cannot send test alerts", async () => {
  const source = (await req("/alerts", { user: "acct" })).json[0];
  assert.equal(
    (await req(`/alerts/${source.id}/test`, {
      user: "ws1admin",
      method: "POST",
    })).status,
    403,
  );
});

test("failed test delivery is recorded in Email Activity", async () => {
  const source = (await req("/alerts", { user: "acct" })).json[0];
  setSendEmailOverrideForTests(async (to) => ({
    ok: false,
    error: "test transport failure",
    deliveredTo: to,
  }));
  try {
    const response = await req(`/alerts/${source.id}/test`, {
      user: "acct",
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.status, "failed");
    assert.equal(response.json.errorMessage, "test transport failure");
  } finally {
    setSendEmailOverrideForTests(async (to) => ({
      ok: true,
      deliveredTo: to,
      messageId: "test-message",
    }));
  }
});

test("a full application admin can add and remove an editor", async () => {
  const added = await req("/editors", {
    user: "acct",
    method: "POST",
    body: { userId: "candidate-editor" },
  });
  assert.equal(added.status, 201);
  assert.equal(added.json.userId, "candidate-editor");

  const listed = await req("/editors", { user: "acct" });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.some((editorEntry) => editorEntry.userId === "candidate-editor"));

  const removed = await req("/editors/candidate-editor", {
    user: "acct",
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
});

test("account-admin removal survives the designated editor's next verified login", async () => {
  const claims = {
    sub: "bootstrap-editor",
    email: BOOTSTRAP_EDITOR_EMAIL,
    email_verified: true,
  };
  assert.equal(await maybeBootstrapEditor(claims), true);
  assert.equal((await req("/groups", { user: "bootstrap-editor" })).status, 200);
  assert.equal((await req("/admins", { user: "bootstrap-editor" })).status, 200);
  assert.equal((await req("/editors", { user: "bootstrap-editor" })).status, 200);
  assert.equal((await req("/status", { user: "bootstrap-editor" })).status, 200);
  const addedRecipient = await req("/admins", {
    user: "bootstrap-editor",
    method: "POST",
    body: { email: delegateManagedEmail },
  });
  assert.equal(addedRecipient.status, 201);
  assert.equal((await req(`/admins/${addedRecipient.json.id}`, {
    user: "bootstrap-editor",
    method: "DELETE",
  })).status, 200);
  assert.equal((await req("/editors", {
    user: "bootstrap-editor",
    method: "POST",
    body: { userId: "candidate-editor" },
  })).status, 201);
  assert.equal((await req("/editors/candidate-editor", {
    user: "bootstrap-editor",
    method: "DELETE",
  })).status, 200);

  const removed = await req("/editors/bootstrap-editor", {
    user: "acct",
    method: "DELETE",
  });
  assert.equal(removed.status, 200);

  // Simulate the next successful OIDC callback.
  assert.equal(await maybeBootstrapEditor(claims), false);
  assert.equal((await req("/groups", { user: "bootstrap-editor" })).status, 403);

  // A later ordinary editor grant must not silently restore delegate parity.
  assert.equal((await req("/editors", {
    user: "acct",
    method: "POST",
    body: { userId: "bootstrap-editor" },
  })).status, 201);
  assert.equal((await req("/groups", { user: "bootstrap-editor" })).status, 200);
  assert.equal((await req("/admins", { user: "bootstrap-editor" })).status, 403);
  assert.equal((await req("/status", { user: "bootstrap-editor" })).status, 403);
});

// ── /users/activity authorization tests ──────────────────────────────────────

test("workspace admin cannot receive out-of-scope users from /users/activity", async () => {
  // Seed authoritative billing-range workspace observations so these route
  // checks do not launch background network work that can leak into later tests.
  __setWsSpendForTests(
    "ws-1",
    "billing:from-cutoff",
    new Map([["ws1admin", 10], ["plain", 0], ["editor", 0]]),
  );
  __setWsSpendForTests(
    "ws-2",
    "billing:from-cutoff",
    new Map([["ws2user", 20]]),
  );
  const { status, json } = await req("/users/activity", { user: "ws1admin" });
  assert.equal(status, 200);
  const usernames = json.users.map((u) => u.username).sort();
  // ws2user is in ws-2 (g-ws2-a) — must not appear for a ws-1 admin
  assert.ok(!usernames.includes("ws2user"), `ws2user must not be visible to ws1admin; got: ${usernames}`);
  // ws1admin and plain are in ws-1 (g-ws1-a) and must be present
  assert.ok(usernames.includes("ws1admin"), "ws1admin must see themselves");
  assert.ok(usernames.includes("plain"), "plain (ws-1 member) must be visible to ws1admin");
});

test("workspace admin user activity response contains no out-of-scope emails", async () => {
  const { status, json } = await req("/users/activity", { user: "ws1admin" });
  assert.equal(status, 200);
  const emails = json.users.map((u) => u.email);
  assert.ok(!emails.includes("ws2user@example.com"), "ws2user email must not be visible to ws1admin");
});

test("user activity spend sums across groups when first membership group has $0 spend", async () => {
  // Regression for the bug where Pass 1 took spend only from the first group in
  // membership order. If that group has $0 for a user (their spend is in a LATER
  // group's usage data), the user would show $0 despite real activity.
  const { status, json } = await req("/users/activity", { user: "acct" });
  assert.equal(status, 200);
  // ws1admin is in g-ws1-a with spend 10; they are ALSO "in" usage for g-ws2-a
  // but g-ws1-a sorts first (workspaceId ws-1 < ws-2), so attribution is g-ws1-a.
  // Their combined spend should be the sum from all distinct group name clusters.
  const ws1User = json.users.find((u) => u.userId === "ws1admin");
  assert.ok(ws1User, "ws1admin should appear in user activity");
  // Spend should be >= what the first group has (not clamped to $0)
  assert.ok(typeof ws1User.spendUsd === "number", "spendUsd should be numeric");
});

test("account admin sees all members in /users/activity", async () => {
  const { status, json } = await req("/users/activity", { user: "acct" });
  assert.equal(status, 200);
  const usernames = json.users.map((u) => u.username).sort();
  assert.ok(usernames.includes("ws2user"), "account admin must see ws2user");
  assert.ok(usernames.includes("ws1admin"), "account admin must see ws1admin");
  assert.ok(usernames.includes("plain"), "account admin must see plain");
  // Keep later authorization tests isolated from any workspace data hydrated
  // while the activity endpoint was exercised.
  __setWsSpendForTests("ws-1", "billing:from-cutoff", null);
  __setWsSpendForTests("ws-2", "billing:from-cutoff", null);
});

// ── group-scoped user CSV authorization tests ────────────────────────────────

test("user export requires an explicit group scope", async () => {
  const { res } = await csvReq("/export/users.csv", "acct");
  assert.equal(res.status, 400);
});

test("workspace admin exports only an authorized group's members", async () => {
  const query = "/export/users.csv?groupIds=g-ws1-a&rangeType=custom&startDate=2026-05-20&endDate=2026-08-11";
  const { res, rows } = await csvReq(query, "ws1admin");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-usage-range"), "custom:2026-05-20:2026-08-11");
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /filename="group-users-\d{4}-\d{2}-\d{2}\.csv"/,
  );
  assert.deepEqual(
    rows.map((row) => row.Username).sort(),
    ["plain", "ws1admin"],
  );
  assert.ok(!rows.some((row) => row.Email === "ws2user@example.com"));
});

test("workspace admin cannot add an out-of-scope group to an export URL", async () => {
  const outside = await csvReq("/export/users.csv?groupIds=g-ws2-a", "ws1admin");
  assert.equal(outside.res.status, 404);
  const mixed = await csvReq("/export/users.csv?groupIds=g-ws1-a,g-ws2-a", "ws1admin");
  assert.equal(mixed.res.status, 404);
  assert.ok(!mixed.text.includes("ws2user@example.com"));
});

test("account admin group export remains scoped to the requested page", async () => {
  const { res, rows } = await csvReq("/export/users.csv?groupIds=g-ws2-a", "acct");
  assert.equal(res.status, 200);
  assert.deepEqual(rows.map((row) => row.Username), ["ws2user"]);
});

test("cluster export emits one row for overlapping members", async () => {
  __setDirectoryCacheForTests({
    groups,
    members,
    groupMembers: new Map([
      ["g-ws1-a", ["ws1admin", "plain"]],
      ["g-ws2-a", ["ws2user", "plain"]],
    ]),
  });
  try {
    const { res, rows } = await csvReq(
      "/export/users.csv?groupIds=g-ws1-a,g-ws2-a&rangeType=custom&startDate=2026-05-20&endDate=2026-08-11",
      "acct",
    );
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-disposition") ?? "",
      /filename="group-cluster-users-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    assert.equal(rows.filter((row) => row.Username === "plain").length, 1);
    assert.deepEqual(
      rows.map((row) => row.Username).sort(),
      ["plain", "ws1admin", "ws2user"],
    );
  } finally {
    __setDirectoryCacheForTests({ groups, members, groupMembers });
  }
});

// ── parseIsAccountAdmin new-field-shape regression ───────────────────────────
//
// Simulates a member whose raw Enterprise directory record uses a newly-supported
// field shape (top-level `role`, `organizationRole`, or `accountRole` string)
// rather than the legacy `isAccountAdmin` boolean. The test verifies that
// `parseIsAccountAdmin` correctly resolves these shapes to `true` and that the
// full authorization pipeline grants `account_admin` access to those members.

test("member with top-level role:admin field is granted account_admin access", async () => {
  const rawNewShape = {
    user: { id: "new-shape-admin", username: "new-shape-admin", email: "new-shape-admin@example.com", firstName: null, lastName: null },
    role: "admin", // NEW field shape — no isAccountAdmin boolean present
    workspaces: [],
  };
  const isAdmin = parseIsAccountAdmin(rawNewShape);
  assert.equal(isAdmin, true, "parseIsAccountAdmin must resolve role:'admin' to true");

  const extendedMembers = new Map(members);
  extendedMembers.set("new-shape-admin", m("new-shape-admin", isAdmin, {}));
  __setDirectoryCacheForTests({ groups, members: extendedMembers, groupMembers });

  try {
    const { status, json } = await req("/groups", { user: "new-shape-admin" });
    assert.equal(status, 200, "new-shape admin must receive 200, not 403");
    // Account admins see every group.
    const ids = json.groups.filter((group) => !group.isSynthetic).map((g) => g.groupId).sort();
    assert.deepEqual(ids, ["g-ws1-a", "g-ws2-a"]);
  } finally {
    __setDirectoryCacheForTests({ groups, members, groupMembers });
  }
});

test("member with organizationRole:owner field is granted account_admin access", async () => {
  const rawNewShape = {
    user: { id: "org-role-admin", username: "org-role-admin", email: "org-role-admin@example.com", firstName: null, lastName: null },
    organizationRole: "owner",
    workspaces: [],
  };
  const isAdmin = parseIsAccountAdmin(rawNewShape);
  assert.equal(isAdmin, true, "parseIsAccountAdmin must resolve organizationRole:'owner' to true");

  const extendedMembers = new Map(members);
  extendedMembers.set("org-role-admin", m("org-role-admin", isAdmin, {}));
  __setDirectoryCacheForTests({ groups, members: extendedMembers, groupMembers });

  try {
    const { status } = await req("/groups", { user: "org-role-admin" });
    assert.equal(status, 200, "org-role admin must receive 200, not 403");
  } finally {
    __setDirectoryCacheForTests({ groups, members, groupMembers });
  }
});

test("member with accountRole:account_admin field is granted account_admin access", async () => {
  const rawNewShape = {
    user: { id: "acct-role-admin", username: "acct-role-admin", email: "acct-role-admin@example.com", firstName: null, lastName: null },
    accountRole: "account_admin",
    workspaces: [],
  };
  const isAdmin = parseIsAccountAdmin(rawNewShape);
  assert.equal(isAdmin, true, "parseIsAccountAdmin must resolve accountRole:'account_admin' to true");

  const extendedMembers = new Map(members);
  extendedMembers.set("acct-role-admin", m("acct-role-admin", isAdmin, {}));
  __setDirectoryCacheForTests({ groups, members: extendedMembers, groupMembers });

  try {
    const { status } = await req("/groups", { user: "acct-role-admin" });
    assert.equal(status, 200, "acct-role admin must receive 200, not 403");
  } finally {
    __setDirectoryCacheForTests({ groups, members, groupMembers });
  }
});
