import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { inArray } from "drizzle-orm";
import { alertsTable, db, groupBudgetsTable } from "@workspace/db";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import { __setDirectoryCacheForTests } from "../lib/enterprise.ts";

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
]);

let server;
let baseUrl;

test.before(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key"; // marks isConfigured()
  __setDirectoryCacheForTests({ groups, members });

  // Inject the real resolution logic but against the seeded directory. Using
  // the actual resolver keeps the test faithful to production behavior.
  const { resolveAuthorization } = await import("../lib/authz.ts");
  setAuthorizationResolver((userId) => resolveAuthorization(userId));
  await db.insert(groupBudgetsTable).values([
    { groupId: "g-ws1-a", amountUsd: 100 },
    { groupId: "g-ws2-a", amountUsd: 200 },
  ]).onConflictDoNothing();
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
  __setDirectoryCacheForTests(null);
  setAuthorizationResolver(null);
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
  const ids = json.groups.map((g) => g.groupId).sort();
  assert.deepEqual(ids, ["g-ws1-a", "g-ws2-a"]);
});

test("workspace admin only sees in-scope groups", async () => {
  const { status, json } = await req("/groups", { user: "ws1admin" });
  assert.equal(status, 200);
  const ids = json.groups.map((g) => g.groupId);
  assert.deepEqual(ids, ["g-ws1-a"]);
});

test("summary totalGroups reflects the scoped group set", async () => {
  const acct = await req("/summary", { user: "acct" });
  assert.equal(acct.json.totalGroups, 2);
  const ws1 = await req("/summary", { user: "ws1admin" });
  assert.equal(ws1.json.totalGroups, 1);
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

test("workspace admin alerts are scoped and recipient addresses are redacted", async () => {
  const { status, json } = await req("/alerts", { user: "ws1admin" });
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].groupId, "g-ws1-a");
  assert.deepEqual(json[0].recipients, []);
});

test("workspace admin is denied account-only recipient list (403)", async () => {
  const { status } = await req("/admins", { user: "ws1admin" });
  assert.equal(status, 403);
});

test("workspace admin is denied system status (403)", async () => {
  const { status } = await req("/status", { user: "ws1admin" });
  assert.equal(status, 403);
});

test("workspace admin is denied team budgets (403)", async () => {
  const { status } = await req("/teams/budgets", { user: "ws1admin" });
  assert.equal(status, 403);
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
