// @ts-nocheck
/**
 * Regression tests for /users/activity cross-group spend totals.
 * Locks in:
 *  - Spend uses the canonical workspace-aware by-user map: every user-workspace
 *    pair is counted once and distinct workspaces are summed.
 *  - Groups in DIFFERENT workspaces are always independent: "Admins" in ws-1
 *    and "Admins" in ws-2 are separate pools and are always summed.
 *  - The displayed group/team is the one where the user has the MOST single-group
 *    spend (their primary cost center), not the first group in sort order.
 */

import { test, expect, beforeAll, afterAll } from "vitest";
import express from "express";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import {
  __setDirectoryCacheForTests,
  __setMemberUsageForTests,
  __setProjectUsageForTests,
  __setProjectInfoForTests,
  __setWsSpendForTests,
} from "../lib/enterprise.ts";

const RANGE = "billing:from-cutoff";
const CUSTOM_RANGE = "custom:2026-06-01:2026-06-30";
const READINESS_RANGE = "custom:2026-07-01:2026-07-31";

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

beforeAll(async () => {
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

afterAll(async () => {
  for (const g of groups) {
    __setMemberUsageForTests(g.id, RANGE, null);
    __setMemberUsageForTests(g.id, CUSTOM_RANGE, null);
    __setMemberUsageForTests(g.id, READINESS_RANGE, null);
  }
  __setWsSpendForTests("ws-1", RANGE, null);
  __setWsSpendForTests("ws-2", RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);
  __setWsSpendForTests("ws-1", CUSTOM_RANGE, null);
  __setWsSpendForTests("ws-2", CUSTOM_RANGE, null);
  __setWsSpendForTests("ws-extra", CUSTOM_RANGE, null);
  __setWsSpendForTests("ws-1", READINESS_RANGE, null);
  __setWsSpendForTests("ws-2", READINESS_RANGE, null);
  __setWsSpendForTests("ws-extra", READINESS_RANGE, null);
  for (const group of groups) __setProjectUsageForTests(group.id, READINESS_RANGE, null);
  __setProjectInfoForTests("ws-1", null);
  __setDirectoryCacheForTests(null);
  setAuthorizationResolver(null);
  delete process.env.REPLIT_ENTERPRISE_API_KEY;
  server?.close();
});

async function activity(user = "acct", query = "") {
  const res = await fetch(`${baseUrl}/api/users/activity${query}`, {
    headers: { "x-test-user": user },
  });
  expect(res.status).toBe(200);
  return res.json();
}

test("per-user API and CSV wait for member usage after workspace and project inputs are ready", async () => {
  __setWsSpendForTests("ws-1", READINESS_RANGE, new Map([["denise", 60]]));
  __setWsSpendForTests("ws-2", READINESS_RANGE, new Map([["denise", 40]]));
  __setWsSpendForTests("ws-extra", READINESS_RANGE, new Map());
  __setProjectUsageForTests("sg-admins-ws1", READINESS_RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 20,
    byProject: new Map([["hosting", {
      projectId: "hosting",
      totalCostUsd: 20,
      metrics: [],
    }]]),
  });
  for (const groupId of ["sg-devs-ws1", "sg-admins-ws2"]) {
    __setProjectUsageForTests(groupId, READINESS_RANGE, {
      fetchedAt: Date.now(),
      totalCostUsd: 0,
      byProject: new Map(),
    });
  }
  __setProjectInfoForTests("ws-1", new Map([
    ["hosting", { title: "Hosting", creatorId: "denise" }],
  ]));
  for (const group of groups) {
    __setMemberUsageForTests(group.id, READINESS_RANGE, null);
  }
  const query = "?groupIds=sg-admins-ws1,sg-devs-ws1,sg-admins-ws2&rangeType=custom&startDate=2026-07-01&endDate=2026-07-31";

  const coldActivity = await activity("acct", query);
  expect(coldActivity.isComplete).toBe(false);
  const coldCsv = await fetch(`${baseUrl}/api/export/users.csv${query}`, {
    headers: { "x-test-user": "acct" },
  });
  expect(coldCsv.status).toBe(200);
  expect(coldCsv.headers.get("x-export-complete")).toBe("false");

  __setMemberUsageForTests("sg-admins-ws1", READINESS_RANGE, new Map([["denise", 40]]));
  __setMemberUsageForTests("sg-devs-ws1", READINESS_RANGE, new Map());
  __setMemberUsageForTests("sg-admins-ws2", READINESS_RANGE, new Map([["denise", 40]]));

  const warmActivity = await activity("acct", query);
  expect(warmActivity.isComplete).toBe(true);
  const denise = warmActivity.users.find((user) => user.username === "denise");
  expect(denise.aiSpendUsd).toBe(80);
  expect(denise.nonAiSpendUsd).toBe(20);
  expect(denise.spendUsd).toBe(100);

  const warmCsv = await fetch(`${baseUrl}/api/export/users.csv${query}`, {
    headers: { "x-test-user": "acct" },
  });
  expect(warmCsv.status).toBe(200);
  expect(warmCsv.headers.get("x-export-complete")).toBe("true");
  const csvRows = parseCsv(await warmCsv.text());
  const csvDenise = csvRows.find((row) => row.Username === "denise");
  expect(csvDenise["AI Spend (USD)"]).toBe("80.00");
  expect(csvDenise["Hosting / Non-AI Spend (USD)"]).toBe("20.00");
  expect(csvDenise["Spend (USD)"]).toBe("100.00");
});

test("canonical by-user totals count each workspace once and sum distinct workspaces", async () => {
  __setMemberUsageForTests("sg-admins-ws1", RANGE, new Map([["denise", 100]]));
  __setMemberUsageForTests("sg-devs-ws1",   RANGE, new Map([["denise", 50], ["eve", 20]]));
  __setMemberUsageForTests("sg-admins-ws2", RANGE, new Map([["denise", 700]]));
  __setWsSpendForTests("ws-1", RANGE, new Map([["denise", 100], ["eve", 20]]));
  __setWsSpendForTests("ws-2", RANGE, new Map([["denise", 700]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["denise", 25], ["dave", 40]]));

  const json = await activity();
  expect(json.isComplete).toBe(true);

  const denise = json.users.find((u) => u.username === "denise");
  expect(denise, "denise must appear").toBeTruthy();
  // ws-1 is one authoritative observation despite overlapping groups.
  // ws-2: 700
  // Extra-workspace spend without a custom-group project remains in the
  // explicit workspace residual rather than being assigned to Denise.
  expect(denise.spendUsd, "spend = deduplicated member-grouped AI: ws-1=100 + ws-2=700").toBe(800);
  // Displayed group = highest single-group spend (Admins in ws-2, $700).
  expect(denise.groupName).toBe("Admins");
  // workspaceRole reflects the attributed (highest-spend) group's workspace: ws-2 member.
  expect(denise.workspaceRole).toBe("member");

  const eve = json.users.find((u) => u.username === "eve");
  expect(eve.spendUsd).toBe(20);
  expect(eve.groupName).toBe("Devs");

  // Dave has no custom group, so his extra-workspace amount remains in the
  // explicit workspace residual instead of canonical per-user attribution.
  const dave = json.users.find((u) => u.username === "dave");
  expect(dave, "ungrouped extra-workspace user must appear for account admins").toBeTruthy();
  expect(dave.spendUsd).toBe(0);
  expect(dave.groupName).toBe("");
});

test("user with $0 in first-sorted group still shows full total; zero-spend user keeps membership attribution", async () => {
  __setMemberUsageForTests("sg-admins-ws1", RANGE, new Map([["denise", 0]]));
  __setMemberUsageForTests("sg-devs-ws1",   RANGE, new Map([["denise", 30], ["eve", 0]]));
  __setMemberUsageForTests("sg-admins-ws2", RANGE, new Map());
  __setWsSpendForTests("ws-1", RANGE, new Map([["denise", 30], ["eve", 0]]));
  __setWsSpendForTests("ws-2", RANGE, new Map());
  __setWsSpendForTests("ws-extra", RANGE, new Map());

  const json = await activity();
  const denise = json.users.find((u) => u.username === "denise");
  expect(denise.spendUsd).toBe(30);
  expect(denise.groupName, "canonical stable attribution supplies display metadata").toBe("Admins");

  // eve has $0 everywhere — keeps her first-membership group attribution.
  const eve = json.users.find((u) => u.username === "eve");
  expect(eve.spendUsd).toBe(0);
  expect(eve.groupName).toBe("Devs");
});

function parseCsv(csv) {
  const unquote = (value) => value.trim().replace(/^"|"$/g, "").replace(/""/g, '"');
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(unquote);
  return lines.slice(1).map((line) => {
    const columns = line.split(",").map(unquote);
    return Object.fromEntries(headers.map((header, index) => [header, columns[index] ?? ""]));
  });
}

test("selected custom range has API, group-detail, cluster-source, and CSV parity with equal cross-workspace spend", async () => {
  // Equal dollar values in distinct workspaces are separate observations and
  // must both survive; the extra workspace proves account-wide completeness.
  __setWsSpendForTests("ws-1", CUSTOM_RANGE, new Map([["denise", 40], ["eve", 5]]));
  __setWsSpendForTests("ws-2", CUSTOM_RANGE, new Map([["denise", 40]]));
  __setWsSpendForTests("ws-extra", CUSTOM_RANGE, new Map([["denise", 15], ["dave", 7]]));
  __setMemberUsageForTests("sg-admins-ws1", CUSTOM_RANGE, new Map([["denise", 40]]));
  __setMemberUsageForTests("sg-devs-ws1", CUSTOM_RANGE, new Map([["eve", 5]]));
  __setMemberUsageForTests("sg-admins-ws2", CUSTOM_RANGE, new Map([["denise", 40]]));

  const query = "?groupIds=sg-admins-ws1,sg-devs-ws1,sg-admins-ws2&rangeType=custom&startDate=2026-06-01&endDate=2026-06-30";
  const activityJson = await activity("acct", query);
  expect(activityJson.isComplete).toBe(true);
  const activityDenise = activityJson.users.find((user) => user.username === "denise");
  expect(activityDenise.spendUsd, "equal AI values in separate grouped workspaces are both retained").toBe(80);

  const detailRes = await fetch(`${baseUrl}/api/groups/sg-admins-ws1${query}`, {
    headers: { "x-test-user": "acct" },
  });
  expect(detailRes.status).toBe(200);
  const detail = await detailRes.json();
  const detailDenise = detail.members.find((member) => member.username === "denise");
  expect(detailDenise.spendUsd).toBe(activityDenise.spendUsd);
  // Cluster member tables merge these same group-detail member rows.
  expect(detailDenise.spendUsd).toBe(80);

  const csvRes = await fetch(`${baseUrl}/api/export/users.csv${query}`, {
    headers: { "x-test-user": "acct" },
  });
  expect(csvRes.status).toBe(200);
  expect(csvRes.headers.get("x-usage-range")).toBe(CUSTOM_RANGE);
  const csvRows = parseCsv(await csvRes.text());
  const csvDenise = csvRows.find((row) => row.Username === "denise");
  expect(Number(csvDenise["Spend (USD)"])).toBe(activityDenise.spendUsd);

  // The billing range remains independent from the custom selection.
  const billingJson = await activity();
  expect(billingJson.users.find((user) => user.username === "denise").spendUsd).not.toBe(activityDenise.spendUsd);
});
