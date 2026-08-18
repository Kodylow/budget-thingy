/**
 * Regression tests for /users/activity cross-group spend totals.
 * Locks in:
 *  - Spend is summed ADDITIVELY across every group the user belongs to,
 *    including same-named groups in different workspaces (no name-based dedup —
 *    each groupId has its own independent usage API data).
 *  - The displayed group/team is the one where the user spent the MOST
 *    (their primary cost center), not the first group in sort order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import {
  __setDirectoryCacheForTests,
  __setMemberUsageForTests,
  __setWsSpendForTests,
} from "../lib/enterprise.ts";

const RANGE = "billing:from-cutoff";

function m(userId, isAccountAdmin, workspaces = {}) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.com`,
    name: userId,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

// Two same-named groups ("Admins") in DIFFERENT workspaces — genuinely
// independent groups with independent spend data.
// denise is in both, plus a third group in ws-1.
const groups = [
  { id: "sg-admins-ws1", workspaceId: "ws-1", name: "Admins", type: "custom" },
  { id: "sg-devs-ws1",   workspaceId: "ws-1", name: "Devs",   type: "custom" },
  { id: "sg-admins-ws2", workspaceId: "ws-2", name: "Admins", type: "custom" },
];
const members = new Map([
  ["acct",   m("acct",   true)],
  ["denise", m("denise", false, {
    "ws-1":     { role: "admin",  isDisabled: false },
    "ws-2":     { role: "member", isDisabled: false },
    "ws-extra": { role: "member", isDisabled: false },
  })],
  ["eve",    m("eve",    false, { "ws-1": { role: "member", isDisabled: false } })],
  // dave is ONLY in the extra workspace (no custom group membership at all).
  ["dave",   m("dave",   false, { "ws-extra": { role: "member", isDisabled: false } })],
]);

let server;
let baseUrl;

test.before(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key";
  __setDirectoryCacheForTests({
    workspaces: new Map([
      ["ws-1",     { id: "ws-1",     name: "One",   slug: "one",   memberCount: 3 }],
      ["ws-2",     { id: "ws-2",     name: "Two",   slug: "two",   memberCount: 1 }],
      // ws-extra has NO custom groups — its spend flows in via extra-workspace data.
      ["ws-extra", { id: "ws-extra", name: "Extra", slug: "extra", memberCount: 2 }],
    ]),
    groups,
    members,
    groupMembers: new Map([
      ["sg-admins-ws1", ["denise"]],
      ["sg-devs-ws1",   ["denise", "eve"]],
      ["sg-admins-ws2", ["denise"]],
    ]),
  });
  const { resolveAuthorization } = await import("../lib/authz.ts");
  setAuthorizationResolver((userId) => resolveAuthorization(userId));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const uid = req.headers["x-test-user"];
    req.isAuthenticated = function () { return this.user != null; };
    if (uid) req.user = { id: String(uid) };
    next();
  });
  app.use("/api", monitorRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const g of groups) __setMemberUsageForTests(g.id, RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);
  __setDirectoryCacheForTests(null);
  setAuthorizationResolver(null);
  delete process.env.REPLIT_ENTERPRISE_API_KEY;
  server?.close();
});

async function activity(user = "acct") {
  const res = await fetch(`${baseUrl}/api/users/activity`, {
    headers: { "x-test-user": user },
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("same-named groups in different workspaces are summed additively (no name dedup), plus extra-workspace spend", async () => {
  __setMemberUsageForTests("sg-admins-ws1", RANGE, new Map([["denise", 100]]));
  __setMemberUsageForTests("sg-devs-ws1",   RANGE, new Map([["denise", 50], ["eve", 20]]));
  __setMemberUsageForTests("sg-admins-ws2", RANGE, new Map([["denise", 700]]));
  // ws-extra has no custom groups; denise spent $25 there, dave $40.
  __setWsSpendForTests("ws-extra", RANGE, new Map([["denise", 25], ["dave", 40]]));

  const json = await activity();
  assert.equal(json.isComplete, true);

  const denise = json.users.find((u) => u.username === "denise");
  assert.ok(denise, "denise must appear");
  // 100 (Admins ws-1) + 50 (Devs ws-1) + 700 (Admins ws-2) + 25 (extra ws) = 875.
  // A name-based dedup would have dropped one of the two "Admins" amounts.
  assert.equal(denise.spendUsd, 875,
    "spend must sum across ALL groups incl. same-named ones plus extra-workspace spend");
  // Displayed group = highest-spend group (Admins in ws-2, $700).
  assert.equal(denise.groupName, "Admins");
  // workspaceRole reflects the attributed (highest-spend) group's workspace: ws-2 member.
  assert.equal(denise.workspaceRole, "member");

  const eve = json.users.find((u) => u.username === "eve");
  assert.equal(eve.spendUsd, 20);
  assert.equal(eve.groupName, "Devs");

  // dave has NO custom group — extra-workspace spend still shows for account admins.
  const dave = json.users.find((u) => u.username === "dave");
  assert.ok(dave, "ungrouped extra-workspace user must appear for account admins");
  assert.equal(dave.spendUsd, 40, "ungrouped user's extra-workspace spend must be included");
  assert.equal(dave.groupName, "");
});

test("user with $0 in first-sorted group still shows full total; zero-spend user keeps membership attribution", async () => {
  __setMemberUsageForTests("sg-admins-ws1", RANGE, new Map([["denise", 0]]));
  __setMemberUsageForTests("sg-devs-ws1",   RANGE, new Map([["denise", 30], ["eve", 0]]));
  __setMemberUsageForTests("sg-admins-ws2", RANGE, new Map());
  __setWsSpendForTests("ws-extra", RANGE, new Map());

  const json = await activity();
  const denise = json.users.find((u) => u.username === "denise");
  assert.equal(denise.spendUsd, 30);
  assert.equal(denise.groupName, "Devs", "highest-spend group wins display");

  // eve has $0 everywhere — keeps her first-membership group attribution.
  const eve = json.users.find((u) => u.username === "eve");
  assert.equal(eve.spendUsd, 0);
  assert.equal(eve.groupName, "Devs");
});
