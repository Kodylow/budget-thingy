/**
 * Regression tests for the /summary endpoint's cross-workspace rollup.
 * Verifies that /summary independently queues member-usage fetches and
 * reflects combined spend correctly, without requiring /groups to be called first.
 * Includes an extra workspace (no custom groups) to exercise cross-workspace attribution.
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

// Two groups in the main workspace.
// "alice" is in both groups (dedup: first group Alpha wins for her combined spend).
// "bob" is in Beta only (Comcast).
// "carol" is in Alpha only and also has spend in the extra workspace.
// "dave" is in the extra workspace only (no custom group — not counted in summary rollup).
const RANGE = "billing:from-cutoff";

const groups = [
  { id: "sg-alpha", workspaceId: "ws-main", name: "Alpha", type: "custom" },
  { id: "sg-beta",  workspaceId: "ws-main", name: "Beta",  type: "custom" },
];
const members = new Map([
  ["acct",  m("acct",  true)],
  ["alice", m("alice", false, {
    "ws-main":  { role: "member", isDisabled: false },
    "ws-extra": { role: "member", isDisabled: false },
  })],
  ["bob",   m("bob",   false, { "ws-main":  { role: "member", isDisabled: false } })],
  ["carol", m("carol", false, {
    "ws-main":  { role: "member", isDisabled: false },
    "ws-extra": { role: "member", isDisabled: false },
  })],
  ["dave",  m("dave",  false, { "ws-extra": { role: "member", isDisabled: false } })],
]);
const wsExtra = new Map([
  ["ws-main",  { id: "ws-main",  name: "Main",  slug: "main",  memberCount: 4 }],
  ["ws-extra", { id: "ws-extra", name: "Extra", slug: "extra", memberCount: 2 }],
]);

let server;
let baseUrl;

test.before(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key";
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups,
    members,
    groupMembers: new Map([
      ["sg-alpha", ["alice", "carol"]],
      ["sg-beta",  ["alice", "bob"]],
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
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);
  __setDirectoryCacheForTests(null);
  setAuthorizationResolver(null);
  delete process.env.REPLIT_ENTERPRISE_API_KEY;
  server?.close();
});

async function req(path, user = "acct") {
  const res = await fetch(`${baseUrl}/api${path}`, {
    headers: { "x-test-user": user },
  });
  return res.json();
}

// ── Cold cache ────────────────────────────────────────────────────────────────────

test("summary returns isComplete:false and zero spend with empty usage caches", async () => {
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);

  const json = await req("/summary");
  assert.equal(json.isComplete, false, "should be incomplete while caches are cold");
  assert.equal(json.totalSpendUsd, 0);
  assert.equal(json.totalGroups, 2);
});

// ── Warm Comcast caches only (extra workspace still pending) ───────────────────────

test("summary is not complete when extra-workspace data is still pending", async () => {
  // alice: $30 in Alpha, $20 in Beta (de-duped); carol: $10 in Alpha; bob: $15 in Beta.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, null); // extra ws still loading

  const json = await req("/summary");
  // isComplete must be false while extra ws is pending (ws-extra has no cached data).
  assert.equal(json.isComplete, false, "isComplete must be false while extra-workspace is pending");
  // Comcast-only total (both groups loaded): alice($30 Alpha+$20 Beta=50) + carol($10) + bob($15) = $75.
  assert.equal(json.totalSpendUsd, 75);
});

// ── Fully warm: Comcast + extra workspace ─────────────────────────────────────────

test("summary reflects combined deduped spend once all caches are warm", async () => {
  // Comcast: alice $30 (Alpha) + $20 (Beta) = $50 total; carol $10 (Alpha); bob $15 (Beta).
  // Extra ws: alice +$20, carol +$5, dave +$8.
  // Combined deduped:
  //   alice: ($30+$20) Comcast + $20 extra = $70, attributed to Alpha
  //   carol: $10 Comcast + $5 extra = $15, attributed to Alpha
  //   bob:   $15 Comcast + $0 extra = $15, attributed to Beta
  //   dave:  $0 Comcast + $8 extra = $8, ungrouped
  // Total: $70+$15+$15+$8 = $108
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5], ["dave", 8]]));

  const json = await req("/summary");
  assert.equal(json.isComplete, true, "should be complete once all caches are warm");
  assert.equal(json.totalSpendUsd, 108,
    "alice=$70 (Alpha) + carol=$15 (Alpha) + bob=$15 (Beta) + dave=$8 (ungrouped) = $108");
});

test("summary deduplication: alice counted only once across groups", async () => {
  // Re-run with the same warm fixture to confirm no cross-group double-counting.
  // alice's $30 Alpha + $20 Beta Comcast is summed once ($50) then attributed to Alpha.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5], ["dave", 8]]));

  const json = await req("/summary");
  // If alice were double-counted (alpha+beta+extra twice): (30+20)*2+20+10+5+15+8 = 158. Correct: 108.
  assert.equal(json.totalSpendUsd, 108, "alice must not be double-counted across groups");
});

// ── CSV attribution ordering: must match dashboard stable sort ─────────────────────

function restoreDir() {
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups,
    members,
    groupMembers: new Map([
      ["sg-alpha", ["alice", "carol"]],
      ["sg-beta",  ["alice", "bob"]],
    ]),
  });
}

async function getCsv() {
  const res = await fetch(`${baseUrl}/api/export/users.csv`, {
    headers: { "x-test-user": "acct" },
  });
  assert.equal(res.status, 200);
  const csv = await res.text();
  // All cells are double-quote-escaped; strip surrounding quotes for easy access.
  const unquote = (s) => s.trim().replace(/^"|"$/g, "").replace(/""/g, '"');
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(",").map(unquote);
  return lines.slice(1).map((l) => {
    const cols = l.split(",");
    return Object.fromEntries(header.map((h, i) => [h, unquote(cols[i] ?? "")]));
  });
}

test("CSV: users always have group/team even on a cold cache (zero spend)", async () => {
  // Cold cache: member usage not loaded, extra ws not loaded.
  // Every grouped member must still appear with their group/team.
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);

  const rows = await getCsv();
  const alice = rows.find((r) => r["Username"] === "alice");
  assert.ok(alice, "alice must appear in CSV");
  assert.equal(alice["Group"], "Alpha", "alice group must be Alpha on cold cache");
  assert.equal(alice["Spend (USD)"], "0.00", "alice spend must be 0.00 on cold cache");

  const bob = rows.find((r) => r["Username"] === "bob");
  assert.ok(bob, "bob must appear in CSV");
  assert.equal(bob["Group"], "Beta", "bob group must be Beta on cold cache");
});

test("CSV: zero-spend group members have group/team attribution after cache warm", async () => {
  // carol is in Alpha but has $0 Comcast spend and $0 extra-ws spend.
  // She must still appear with Group=Alpha, not blank.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30]])); // carol not in map
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map());

  const rows = await getCsv();
  const carol = rows.find((r) => r["Username"] === "carol");
  assert.ok(carol, "carol must appear in CSV");
  assert.equal(carol["Group"], "Alpha", "carol must be attributed to Alpha even with $0 spend");
  assert.equal(carol["Spend (USD)"], "0.00", "carol spend is $0 — she has no Comcast or extra-ws spend");
});

test("CSV attribution matches dashboard even when API returns groups in reverse order", async () => {
  // Seed directory with groups in REVERSE stable-sort order (Beta before Alpha).
  // The stable sort is workspaceId → name → id, so Alpha sorts before Beta.
  // A naïve CSV that iterates dir.groups as-is would attribute alice to Beta.
  // The correct answer (matching the dashboard) is Alpha.
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups: [
      { id: "sg-beta",  workspaceId: "ws-main", name: "Beta",  type: "custom" },  // REVERSED
      { id: "sg-alpha", workspaceId: "ws-main", name: "Alpha", type: "custom" },
    ],
    members,
    groupMembers: new Map([
      ["sg-alpha", ["alice", "carol"]],
      ["sg-beta",  ["alice", "bob"]],
    ]),
  });

  // alice: $30 in Alpha, $20 in Beta; she should be attributed to Alpha (sorts first).
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 5]]));

  const rows = await getCsv();
  const alice = rows.find((r) => r["Username"] === "alice");
  assert.ok(alice, "alice must appear in CSV");
  // alice's group must be Alpha (not Beta) regardless of directory order
  assert.equal(alice["Group"], "Alpha", `alice must be attributed to Alpha; got ${alice["Group"]}`);
  // alice's Comcast: $30 (Alpha) + $20 (Beta) = $50. Extra-ws: $5. Combined: $55.
  assert.equal(alice["Spend (USD)"], "55.00", `alice spend must be $55; got ${alice["Spend (USD)"]}`);

  restoreDir();
});

// ── Zero-spend-in-earlier-group regression ────────────────────────────────────────
// alice: $0 Comcast spend in Alpha (first group), $10 in Beta, $5 extra-ws.
// Correct combined = $15 attributed to Alpha. Earlier bug: Alpha claimed alice with
// $5 (extra-ws only), discarding her $10 Beta Comcast spend.

test("/groups and /summary: user with $0 in first group gets full combined spend attributed there", async () => {
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 0], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 5]]));

  const grpJson = await req("/groups");
  const alpha = grpJson.groups.find((g) => g.groupId === "sg-alpha");
  const beta  = grpJson.groups.find((g) => g.groupId === "sg-beta");
  assert.equal(alpha.spendLoaded, true, "Alpha must be loaded");
  assert.equal(beta.spendLoaded, true, "Beta must be loaded");
  // Alpha: alice($0+$10+$5=15) + carol($10) = $25
  assert.equal(alpha.spendUsd, 25, "Alpha combined: alice $15 + carol $10");
  // Beta: bob($15), alice attributed to Alpha
  assert.equal(beta.spendUsd, 15, "Beta combined: bob $15 (alice attributed to Alpha)");

  const sumJson = await req("/summary");
  assert.equal(sumJson.isComplete, true);
  // Summary: alice$15 + carol$10 + bob$15 = $40
  assert.equal(sumJson.totalSpendUsd, 40, "Summary total: alice $15 + carol $10 + bob $15");
});

test("CSV: user with $0 in first group gets full combined spend in CSV row for that group", async () => {
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 0], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 5]]));

  const rows = await getCsv();
  const alice = rows.find((r) => r["Username"] === "alice");
  assert.ok(alice, "alice must appear in CSV");
  assert.equal(alice["Group"], "Alpha", "alice must be attributed to Alpha (sorts first)");
  // alice: $0 (Alpha) + $10 (Beta) Comcast + $5 extra = $15
  assert.equal(alice["Spend (USD)"], "15.00", `alice spend must be $15; got ${alice["Spend (USD)"]}`);
});

// ── Dedup correctness: shared user + missing earlier group ─────────────────────────

test("/groups: spendLoaded stays false while earlier-group member usage is missing", async () => {
  // Beta loads first; alice is shared. Alpha sorts before Beta so alice SHOULD be
  // attributed to Alpha — but Alpha's usage is missing, so the rollup is incomplete.
  // spendLoaded must remain false for Beta (and all groups) until Alpha loads.
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map());

  const json = await req("/groups");
  const beta = json.groups.find((g) => g.groupId === "sg-beta");
  assert.ok(beta, "Beta must appear in /groups response");
  assert.equal(beta.spendLoaded, false,
    "Beta.spendLoaded must be false: Alpha's member usage missing so alice's dedup attribution is provisional");
  assert.equal(beta.spendUsd, null, "spendUsd must be null while rollup is incomplete");
  assert.equal(json.isComplete, false, "top-level isComplete must be false");
});

test("/groups: correct combined spend once all group caches warm", async () => {
  // alice is in Alpha AND Beta: $30 Alpha Comcast + $20 Beta Comcast + $20 extra = $70.
  // Two-phase approach: sum Comcast across all her groups first, then add extra-ws once.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5]]));

  const json = await req("/groups");
  const alpha = json.groups.find((g) => g.groupId === "sg-alpha");
  const beta  = json.groups.find((g) => g.groupId === "sg-beta");
  assert.equal(alpha.spendLoaded, true, "Alpha must be loaded");
  assert.equal(beta.spendLoaded, true, "Beta must be loaded");
  // Alpha: alice($30+$20 Comcast + $20 extra = $70) + carol($10 + $5 extra = $15) = $85
  assert.equal(alpha.spendUsd, 85, "Alpha combined spend: alice $70 + carol $15");
  // Beta: bob ($15, no extra-ws). Alice attributed to Alpha.
  assert.equal(beta.spendUsd, 15, "Beta combined spend: bob $15 (alice attributed to Alpha)");
  assert.equal(json.isComplete, true);
});

// ── Documented behavior: ungrouped members ─────────────────────────────────────────

test("extra-workspace spend for ungrouped members IS included in summary total (reconciles with CSV)", async () => {
  // dave has $8 in ws-extra but no custom group.
  // The summary includes his spend so it reconciles with the CSV export (which always
  // iterates all enterprise members). carol=$10, bob=$15, dave=$8 → $33.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["dave", 8]]));

  const json = await req("/summary");
  assert.equal(json.isComplete, true);
  // carol=$10 (Alpha) + bob=$15 (Beta) + dave=$8 (ungrouped, extra-ws) = $33.
  assert.equal(json.totalSpendUsd, 33,
    "dave has no custom group but his extra-workspace spend must be counted in the summary total");
});

test("detail: direct cold-cache request queues all scoped groups so rollup eventually completes", async () => {
  // Simulate a direct drill-down with empty caches. The handler must queue member
  // usage for all scoped groups (not just the selected one) so rollup.isComplete
  // can become true without the admin first visiting /groups or /summary.
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);

  // First request: caches cold — spendLoaded must be false (rollup not complete).
  const cold = await req("/groups/sg-beta");
  assert.equal(cold.isComplete, false, "detail is incomplete while member usage caches are cold");
  assert.equal(cold.group.spendLoaded, false, "group card spendLoaded must be false on cold cache");

  // Warm all caches as the background queue would do after the first request.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20]]));

  // Second request: caches warm — spendLoaded must be true and spend correct.
  const warm = await req("/groups/sg-beta");
  assert.equal(warm.isComplete, true, "detail must be complete once all caches are warm");
  assert.equal(warm.group.spendLoaded, true, "group card spendLoaded must be true once complete");
  // Beta's spend: only bob ($15); alice is attributed to Alpha.
  assert.equal(warm.group.spendUsd, 15, "Beta spend = bob $15; alice attributed to Alpha");
});
