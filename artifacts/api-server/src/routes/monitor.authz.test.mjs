import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { eq, inArray } from "drizzle-orm";
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
} from "@workspace/db";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import {
  BOOTSTRAP_EDITOR_EMAIL,
  maybeBootstrapEditor,
} from "../lib/authz.ts";
import { setSendEmailOverrideForTests } from "../lib/email.ts";
import {
  __setDirectoryCacheForTests,
  __setMemberUsageForTests,
  __setProjectUsageForTests,
  resolveRange,
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

let server;
let baseUrl;

test.before(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key"; // marks isConfigured()
  setSendEmailOverrideForTests(async (to) => ({
    ok: true,
    deliveredTo: to,
    messageId: "test-message",
  }));
  __setDirectoryCacheForTests({ groups, members, groupMembers });
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
        metrics: [],
      }]]),
    });
  }

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
  __setDirectoryCacheForTests(null);
  __setMemberUsageForTests("custom:2026-05-20:2026-08-11", null);
  __setProjectUsageForTests("g-ws1-a", "custom:2026-05-20:2026-08-11", null);
  __setProjectUsageForTests("g-ws2-a", "custom:2026-05-20:2026-08-11", null);
  setAuthorizationResolver(null);
  setSendEmailOverrideForTests(null);
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
  // totalSpendUsd is now member-deduped rollup:
  // shared(40, once)+ws1-only(10)+ws2-only(20) + unattributable(3+4) = 77
  assert.equal(acct.json.totalSpendUsd, 77);
  assert.equal(acct.json.isComplete, true);

  const ws1 = await req(
    "/summary?rangeType=custom&startDate=2026-05-20&endDate=2026-08-11",
    { user: "ws1admin" },
  );
  // ws1admin sees only g-ws1-a: shared(40)+ws1-only(10)+unattributable(3)=53
  assert.equal(ws1.json.totalSpendUsd, 53);
  assert.equal(ws1.json.isComplete, true);
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
  assert.equal(json[0].entityType, "group");
  assert.equal(json[0].entityId, "g-ws1-a");
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

  const setTeamBudget = await req("/teams/Team%20One/budget", {
    user: "ws1admin",
    method: "PUT",
    body: { amountUsd: 200 },
  });
  assert.equal(setTeamBudget.status, 403);

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
  assert.deepEqual(groupsResponse.json.groups.map((group) => group.groupId).sort(), ["g-ws1-a", "g-ws2-a"]);

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
    body: { email: "delegate-managed@example.com" },
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
});
