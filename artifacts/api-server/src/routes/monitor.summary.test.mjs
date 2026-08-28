/**
 * Regression tests for the /summary endpoint's cross-workspace rollup.
 * Verifies that /summary independently queues member-usage fetches and
 * reflects combined spend correctly, without requiring /groups to be called first.
 * Includes an extra workspace (no custom groups) to exercise cross-workspace attribution.
 */
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { eq, inArray } from "drizzle-orm";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import {
  __setDirectoryCacheForTests,
  __setAccountUsageForTests,
  __setMemberUsageForTests,
  __setProjectUsageForTests,
  __setProjectInfoForTests,
  __setWsSpendForTests,
  __setBillingPeriodForTests,
  resolvePaceUsageRange,
  resolveRange,
} from "../lib/enterprise.ts";
import {
  db,
  groupBudgetsTable,
  groupTeamsTable,
  teamBudgetsTable,
  alertsTable,
  groupRosterSnapshotDaysTable,
  groupRosterSnapshotsTable,
} from "@workspace/db";

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

function setProjectSpend(alpha, beta, alphaResidual = 0) {
  const seed = (groupId, spend, residual = 0) => {
    __setProjectUsageForTests(groupId, RANGE, {
      fetchedAt: Date.now(),
      totalCostUsd: spend + residual,
      byProject: new Map(
        spend > 0
          ? [[`${groupId}-project`, {
              projectId: `${groupId}-project`,
              totalCostUsd: spend,
              metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: spend }],
            }]]
          : [],
      ),
    });
  };
  seed("sg-alpha", alpha, alphaResidual);
  seed("sg-beta", beta);
}

function clearProjectSpend() {
  __setProjectUsageForTests("sg-alpha", RANGE, null);
  __setProjectUsageForTests("sg-beta", RANGE, null);
}

function setAccountUsage(totalCostUsd, unattributableTotalCostUsd = 0) {
  __setAccountUsageForTests(RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd,
    attributableTotalCostUsd: totalCostUsd - unattributableTotalCostUsd,
    unattributableTotalCostUsd,
  });
}

let server;
let baseUrl;

test.before(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key";
  // Roster snapshot days are written by the server's scheduled snapshot job and
  // persist across test runs. Any completed day causes partitionTrendBucket to
  // split the current-month trend bucket into per-day historical components that
  // the trend tests don't pre-seed data for, making the last bucket incomplete.
  // Clear them here so all trend buckets remain live (rosterDate: null) during
  // this suite.
  await db.delete(groupRosterSnapshotsTable);
  await db.delete(groupRosterSnapshotDaysTable);
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
  __setWsSpendForTests("ws-main", RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);
  __setAccountUsageForTests(RANGE, null);
  clearProjectSpend();
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
  __setWsSpendForTests("ws-main", RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);
  clearProjectSpend();

  const json = await req("/summary");
  assert.equal(json.isComplete, false, "should be incomplete while caches are cold");
  assert.equal(json.totalSpendUsd, 0);
  assert.equal(json.accountUsageTotalSpendUsd, null);
  assert.equal(json.reconciliationSpendUsd, null);
  assert.equal(json.totalGroups, 2);
});

// ── Warm Comcast caches only (extra workspace still pending) ───────────────────────

test("summary is not complete when extra-workspace data is still pending", async () => {
  // alice: $30 in Alpha, $20 in Beta (de-duped); carol: $10 in Alpha; bob: $15 in Beta.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, null); // extra ws still loading
  setProjectSpend(60, 15);
  setAccountUsage(75);

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
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5], ["dave", 8]]));
  setProjectSpend(85, 15, 8);
  setAccountUsage(108, 3);

  const json = await req("/summary");
  assert.equal(json.isComplete, true, "should be complete once all caches are warm");
  assert.equal(json.totalSpendUsd, 108,
    "alice=$70 (Alpha) + carol=$15 (Alpha) + bob=$15 (Beta) + dave=$8 (ungrouped) = $108");
  assert.equal(json.accountUsageTotalSpendUsd, 108);
  assert.equal(json.accountUsageAttributableSpendUsd, 105);
  assert.equal(json.accountUsageUnattributableSpendUsd, 3);
  assert.equal(json.reconciliationSpendUsd, 0,
    "real and synthetic rows fully reconcile to the account anchor");
});

test("account headline and visible reconciliation row sum to unfiltered gross usage", async () => {
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta", RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5], ["dave", 8]]));
  setProjectSpend(85, 15, 8);
  setAccountUsage(120, 15);

  const json = await req("/summary");
  assert.equal(json.isComplete, true);
  assert.equal(json.memberBasedTotalSpendUsd, 108);
  assert.equal(json.reconciliationSpendUsd, 12);
  assert.equal(json.totalSpendUsd, 120);
  assert.equal(
    json.memberBasedTotalSpendUsd + json.reconciliationSpendUsd,
    json.accountUsageTotalSpendUsd,
    "canonical rows plus the explicit residual must equal the gross account anchor",
  );
});

test("summary deduplication: alice counted only once across groups", async () => {
  // Re-run with the same warm fixture to confirm no cross-group double-counting.
  // alice's $30 Alpha + $20 Beta Comcast is summed once ($50) then attributed to Alpha.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5], ["dave", 8]]));
  setProjectSpend(85, 15, 8);
  setAccountUsage(108);

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
  const res = await fetch(`${baseUrl}/api/export/users.csv?groupIds=sg-alpha,sg-beta`, {
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

test("project export identifies stable creator attribution and non-AI residuals", async () => {
  __setProjectUsageForTests("sg-alpha", RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 60,
    byProject: new Map([["owned", {
      projectId: "owned",
      totalCostUsd: 60,
      metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: 20 }],
    }]]),
  });
  __setProjectUsageForTests("sg-beta", RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 90,
    byProject: new Map([
      ["owned", {
        projectId: "owned",
        totalCostUsd: 80,
        metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: 20 }],
      }],
      ["former", { projectId: "former", totalCostUsd: 10, metrics: [] }],
    ]),
  });
  __setProjectInfoForTests("ws-main", new Map([
    ["owned", { title: "Owned", creatorId: "alice" }],
    ["former", { title: "Former", creatorId: "former-creator" }],
  ]));
  try {
    const res = await fetch(`${baseUrl}/api/projects/export`, {
      headers: { "x-test-user": "acct" },
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split(/\r?\n/);
    const unquote = (value) => value.trim().replace(/^"|"$/g, "").replace(/""/g, '"');
    const header = lines[0].split(",").map(unquote);
    const rows = lines.slice(1).map((line) => Object.fromEntries(
      line.split(",").map(unquote).map((value, index) => [header[index], value]),
    ));
    const owned = rows.find((row) => row["Project ID"] === "owned");
    assert.equal(owned["Creator Is Current Member"], "Yes");
    assert.equal(owned["Attributed Group"], "Alpha");
    assert.equal(owned["Attributed Non-AI ($)"], "60.0000");
    assert.equal(owned["Unattributed Non-AI Residual ($)"], "0.0000");
    const former = rows.find((row) => row["Project ID"] === "former");
    assert.equal(former["Creator Is Current Member"], "No");
    assert.equal(former["Attributed Group"], "");
    assert.equal(former["Attributed Non-AI ($)"], "0.0000");
    assert.equal(former["Unattributed Non-AI Residual ($)"], "10.0000");
  } finally {
    __setProjectInfoForTests("ws-main", null);
    setProjectSpend(0, 0);
  }
});

test("project export uses canonical group-ID tie breaking for equal project observations", async () => {
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups: [groups[1], groups[0]],
    members,
    groupMembers: new Map([
      ["sg-alpha", ["alice", "carol"]],
      ["sg-beta", ["alice", "bob"]],
    ]),
  });
  __setProjectUsageForTests("sg-alpha", RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 50,
    byProject: new Map([["tied", {
      projectId: "tied",
      totalCostUsd: 50,
      metrics: [{ id: "ai-alpha", name: "AI", category: "ai", costUsd: 10 }],
    }]]),
  });
  __setProjectUsageForTests("sg-beta", RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 50,
    byProject: new Map([["tied", {
      projectId: "tied",
      totalCostUsd: 50,
      metrics: [{ id: "ai-beta", name: "AI", category: "ai", costUsd: 20 }],
    }]]),
  });
  __setProjectInfoForTests("ws-main", new Map([
    ["tied", { title: "Tied", creatorId: "alice" }],
  ]));
  try {
    const res = await fetch(`${baseUrl}/api/projects/export`, {
      headers: { "x-test-user": "acct" },
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split(/\r?\n/);
    const unquote = (value) => value.trim().replace(/^"|"$/g, "").replace(/""/g, '"');
    const header = lines[0].split(",").map(unquote);
    const row = lines.slice(1)
      .map((line) => Object.fromEntries(line.split(",").map(unquote).map((value, index) => [header[index], value])))
      .find((candidate) => candidate["Project ID"] === "tied");
    assert.equal(row["AI ($)"], "10.0000");
    assert.equal(row["Attributed Non-AI ($)"], "40.0000");
  } finally {
    __setProjectInfoForTests("ws-main", null);
    setProjectSpend(0, 0);
    restoreDir();
  }
});

test("cluster project ties are deterministic in either cluster group order", async () => {
  __setProjectUsageForTests("sg-alpha", RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 50,
    byProject: new Map([["cluster-tied", {
      projectId: "cluster-tied",
      totalCostUsd: 50,
      metrics: [{ id: "ai-alpha", name: "Alpha AI", category: "ai", costUsd: 10 }],
    }]]),
  });
  __setProjectUsageForTests("sg-beta", RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 50,
    byProject: new Map([["cluster-tied", {
      projectId: "cluster-tied",
      totalCostUsd: 50,
      metrics: [{ id: "ai-beta", name: "Beta AI", category: "ai", costUsd: 20 }],
    }]]),
  });
  __setProjectInfoForTests("ws-main", new Map([
    ["cluster-tied", { title: "Cluster Tied", creatorId: "alice" }],
  ]));
  try {
    const requestOrder = async (clusterKey) => {
      const res = await fetch(`${baseUrl}/api/clusters/${clusterKey}/projects`, {
        headers: { "x-test-user": "acct" },
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const alphaFirst = await requestOrder("sg-alpha,sg-beta");
    const betaFirst = await requestOrder("sg-beta,sg-alpha");
    assert.deepEqual(betaFirst, alphaFirst);
    assert.equal(alphaFirst.projects.length, 1);
    assert.deepEqual(alphaFirst.projects[0].metrics, [
      { id: "ai-alpha", name: "Alpha AI", category: "ai", costUsd: 10 },
    ]);
    assert.equal(alphaFirst.projects[0].aiSpendUsd, 10);
    assert.equal(alphaFirst.projects[0].nonAiSpendUsd, 40);
    assert.equal(alphaFirst.projects[0].creatorId, "alice");
    assert.equal(alphaFirst.projects[0].creatorName, "alice");
    assert.equal(alphaFirst.projects[0].creatorIsCurrentMember, true);
  } finally {
    __setProjectInfoForTests("ws-main", null);
    setProjectSpend(0, 0);
  }
});

test("CSV: users always have group/team even on a cold cache (zero spend)", async () => {
  // Cold cache: neither authoritative workspace usage nor fallback member usage loaded.
  // Every grouped member must still appear with their group/team.
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, null);
  __setWsSpendForTests("ws-main", RANGE, null);
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
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 30], ["bob", 15], ["carol", 0]]));
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

  // The authoritative ws-main observation counts alice once, regardless of
  // overlapping group payloads, and the extra workspace remains additive.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 30], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 5]]));
  setProjectSpend(40, 15);

  const rows = await getCsv();
  const alice = rows.find((r) => r["Username"] === "alice");
  assert.ok(alice, "alice must appear in CSV");
  // alice's group must be Alpha (not Beta) regardless of directory order
  assert.equal(alice["Group"], "Alpha", `alice must be attributed to Alpha; got ${alice["Group"]}`);
  // Canonical user attribution includes member-grouped AI; the ungrouped
  // extra-workspace observation remains in the explicit workspace residual.
  assert.equal(alice["Spend (USD)"], "30.00", `alice spend must be $30; got ${alice["Spend (USD)"]}`);

  restoreDir();
});

// ── Zero-spend-in-earlier-group regression ────────────────────────────────────────
// alice: $0 Comcast spend in Alpha (first group), $10 in Beta, $5 extra-ws.
// Correct combined = $15 attributed to Alpha. Earlier bug: Alpha claimed alice with
// $5 (extra-ws only), discarding her $10 Beta Comcast spend.

test("/groups and /summary: user with $0 in first group gets full combined spend attributed there", async () => {
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 0], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 10], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 5]]));
  setProjectSpend(25, 15);
  setAccountUsage(40);

  const grpJson = await req("/groups");
  const alpha = grpJson.groups.find((g) => g.groupId === "sg-alpha");
  const beta  = grpJson.groups.find((g) => g.groupId === "sg-beta");
  assert.equal(alpha.spendLoaded, true, "Alpha must be loaded");
  assert.equal(beta.spendLoaded, true, "Beta must be loaded");
  // Alpha owns ws-main usage only: alice($10) + carol($10) = $20.
  assert.equal(alpha.spendUsd, 20, "Alpha workspace spend: alice $10 + carol $10");
  // Beta: bob($15), alice attributed to Alpha
  assert.equal(beta.spendUsd, 15, "Beta combined: bob $15 (alice attributed to Alpha)");
  const noGroup = grpJson.groups.find((g) => g.groupId === "synthetic:no-group:ws-extra");
  assert.equal(noGroup.name, "No group");
  assert.equal(noGroup.spendUsd, 5, "extra-workspace spend is explicit, not injected into Alpha");

  const sumJson = await req("/summary");
  assert.equal(sumJson.isComplete, true);
  // Summary: alice$15 + carol$10 + bob$15 = $40
  assert.equal(sumJson.totalSpendUsd, 40, "Summary total: alice $15 + carol $10 + bob $15");
});

test("CSV: user with $0 in first group gets full combined spend in CSV row for that group", async () => {
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 0], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 10], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 5]]));

  const rows = await getCsv();
  const alice = rows.find((r) => r["Username"] === "alice");
  assert.ok(alice, "alice must appear in CSV");
  // Canonical stable attribution assigns overlapping members to Alpha.
  assert.equal(alice["Group"], "Alpha");
  // Extra-workspace spend without a custom-group project remains residual.
  assert.equal(alice["Spend (USD)"], "10.00", `alice spend must be $10; got ${alice["Spend (USD)"]}`);
});

// ── Dedup correctness: shared user + missing earlier group ─────────────────────────

test("/groups: complete workspace usage remains authoritative when group usage is missing", async () => {
  // The workspace payload and directory membership are sufficient for exact
  // attribution even when an earlier group's filtered usage payload is missing.
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map());

  const json = await req("/groups");
  const beta = json.groups.find((g) => g.groupId === "sg-beta");
  assert.ok(beta, "Beta must appear in /groups response");
  assert.equal(beta.spendLoaded, true);
  assert.equal(beta.spendUsd, 15);
  assert.equal(json.isComplete, true);
  assert.equal(json.pendingCount, 0);
});

test("/groups: correct combined spend once all group caches warm", async () => {
  // alice is in Alpha AND Beta: $30 Alpha Comcast + $20 Beta Comcast + $20 extra = $70.
  // Two-phase approach: sum Comcast across all her groups first, then add extra-ws once.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5]]));
  setProjectSpend(85, 15);

  const json = await req("/groups");
  const alpha = json.groups.find((g) => g.groupId === "sg-alpha");
  const beta  = json.groups.find((g) => g.groupId === "sg-beta");
  assert.equal(alpha.spendLoaded, true, "Alpha must be loaded");
  assert.equal(beta.spendLoaded, true, "Beta must be loaded");
  // Alpha: authoritative ws-main values, alice($50) + carol($10) = $60.
  assert.equal(alpha.spendUsd, 60, "Alpha workspace spend: alice $50 + carol $10");
  // Beta: bob ($15, no extra-ws). Alice attributed to Alpha.
  assert.equal(beta.spendUsd, 15, "Beta combined spend: bob $15 (alice attributed to Alpha)");
  assert.equal(
    json.groups.find((g) => g.groupId === "synthetic:no-group:ws-extra")?.spendUsd,
    25,
  );
  assert.equal(json.isComplete, true);
});

test("cluster headline and detail use caller-visible ownership with cluster-local readiness", async () => {
  const customRange = resolveRange("custom", "2026-07-01", "2026-07-31");
  const customQuery = "?rangeType=custom&startDate=2026-07-01&endDate=2026-07-31";
  const unrelated = {
    id: "sg-unrelated",
    workspaceId: "ws-main",
    name: "Aardvark sibling",
    type: "custom",
  };
  const scopedMembers = new Map(members);
  scopedMembers.set("wsadmin", m("wsadmin", false, {
    "ws-main": { role: "admin", isDisabled: false },
  }));
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups: [...groups, unrelated],
    members: scopedMembers,
    groupMembers: new Map([
      ["sg-alpha", ["alice", "carol"]],
      ["sg-beta", ["alice", "bob"]],
      [unrelated.id, ["alice"]],
    ]),
  });
  try {
    __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
    __setMemberUsageForTests("sg-beta", RANGE, new Map([["alice", 20], ["bob", 15]]));
    __setMemberUsageForTests(unrelated.id, RANGE, null);
    __setProjectUsageForTests(unrelated.id, RANGE, null);
    __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
    __setWsSpendForTests("ws-extra", RANGE, new Map());
    setProjectSpend(1, 2);

    const headline = await req("/clusters/sg-alpha,sg-beta/headline");
    assert.equal(
      headline.isComplete,
      true,
      "unrelated cold group detail must not block a requested cluster headline",
    );
    assert.equal(
      headline.spendUsd,
      25,
      "cluster-local readiness must retain caller-visible ownership",
    );

    const detail = await req("/groups/sg-beta?scopeGroupIds=sg-alpha,sg-beta");
    assert.equal(
      detail.isComplete,
      true,
      "unrelated cold group detail must not block requested cluster members",
    );
    assert.equal(detail.membersSpendUsd + detail.unattributedSpendUsd, detail.group.spendUsd);

    __setMemberUsageForTests("sg-beta", RANGE, null);
    const totalOnlyDetail = await req("/groups/sg-beta?scopeGroupIds=sg-alpha,sg-beta");
    assert.equal(
      totalOnlyDetail.isComplete,
      false,
      "the optional AI/non-AI member breakdown remains incomplete",
    );
    assert.equal(
      totalOnlyDetail.group.spendLoaded,
      true,
      "authoritative total member spend is ready with the workspace rollup",
    );
    assert.equal(
      totalOnlyDetail.members.find((member) => member.userId === "bob")?.spendUsd,
      15,
      "total member spend must not wait for the optional breakdown feed",
    );
    assert.equal(
      totalOnlyDetail.membersSpendUsd + totalOnlyDetail.unattributedSpendUsd,
      totalOnlyDetail.group.spendUsd,
    );
    __setProjectUsageForTests("sg-alpha", RANGE, null);
    __setProjectUsageForTests("sg-beta", RANGE, null);
    const totalOnlyHeadline = await req("/clusters/sg-alpha,sg-beta/headline");
    assert.equal(
      totalOnlyHeadline.isComplete,
      true,
      "cluster total readiness must not wait for optional project decomposition",
    );
    assert.equal(totalOnlyHeadline.spendUsd, 25);
    setProjectSpend(1, 2);
    __setMemberUsageForTests("sg-beta", RANGE, new Map([["alice", 20], ["bob", 15]]));

    __setMemberUsageForTests(unrelated.id, RANGE, new Map([["alice", 50]]));
    __setProjectUsageForTests(unrelated.id, RANGE, {
      fetchedAt: Date.now(),
      totalCostUsd: 0,
      byProject: new Map(),
    });
    __setWsSpendForTests("ws-extra", RANGE, new Map());

    const groupsJson = await req("/groups");
    const warmHeadline = await req("/clusters/sg-alpha,sg-beta/headline");
    const warmDetail = await req("/groups/sg-beta?scopeGroupIds=sg-alpha,sg-beta");
    const dashboardClusterSpend = groupsJson.groups
      .filter((group) => ["sg-alpha", "sg-beta"].includes(group.groupId))
      .reduce((sum, group) => sum + group.spendUsd, 0);
    assert.equal(
      dashboardClusterSpend,
      25,
      "the earlier caller-visible sibling owns Alice, so the requested cluster only keeps Carol and Bob",
    );
    assert.equal(warmHeadline.isComplete, true);
    assert.equal(warmHeadline.spendUsd, dashboardClusterSpend);
    assert.equal(warmDetail.isComplete, true);
    assert.equal(
      warmDetail.membersSpendUsd + warmDetail.unattributedSpendUsd,
      warmDetail.group.spendUsd,
      "member rows and residual must exactly reconcile to the dashboard group amount",
    );

    const scopedGroupsJson = await req("/groups", "wsadmin");
    const scopedHeadline = await req(
      "/clusters/sg-alpha,sg-beta/headline",
      "wsadmin",
    );
    const scopedDetail = await req(
      "/groups/sg-beta?scopeGroupIds=sg-alpha,sg-beta",
      "wsadmin",
    );
    const scopedDashboardBeta = scopedGroupsJson.groups.find(
      (candidate) => candidate.groupId === "sg-beta",
    );
    assert.equal(scopedDetail.group.spendUsd, scopedDashboardBeta.spendUsd);
    assert.equal(
      scopedHeadline.spendUsd,
      scopedGroupsJson.groups
        .filter((candidate) => ["sg-alpha", "sg-beta"].includes(candidate.groupId))
        .reduce((sum, candidate) => sum + candidate.spendUsd, 0),
      "workspace-scoped cluster headlines use the same visible ownership scope as their dashboard",
    );
    assert.equal(
      scopedDetail.membersSpendUsd + scopedDetail.unattributedSpendUsd,
      scopedDetail.group.spendUsd,
      "workspace-scoped callers reconcile within their own visible group scope",
    );

    for (const rangeKey of [customRange.key]) {
      __setMemberUsageForTests("sg-alpha", rangeKey, new Map([
        ["alice", 30],
        ["carol", 10],
      ]));
      __setMemberUsageForTests("sg-beta", rangeKey, new Map([
        ["alice", 20],
        ["bob", 15],
      ]));
      __setMemberUsageForTests(unrelated.id, rangeKey, null);
      for (const group of [...groups, unrelated]) {
        __setProjectUsageForTests(group.id, rangeKey, {
          fetchedAt: Date.now(),
          totalCostUsd: 0,
          byProject: new Map(),
        });
      }
      __setWsSpendForTests("ws-main", rangeKey, new Map([
        ["alice", 50],
        ["carol", 10],
        ["bob", 15],
      ]));
      __setWsSpendForTests("ws-extra", rangeKey, new Map());
    }
    const customGroups = await req(`/groups${customQuery}`);
    const customHeadline = await req(
      `/clusters/sg-alpha,sg-beta/headline${customQuery}`,
    );
    const customAlpha = await req(
      `/groups/sg-alpha${customQuery}&scopeGroupIds=sg-alpha,sg-beta`,
    );
    const customBeta = await req(
      `/groups/sg-beta${customQuery}&scopeGroupIds=sg-alpha,sg-beta`,
    );
    assert.equal(customHeadline.isComplete, true);
    assert.equal(customAlpha.isComplete, true);
    assert.equal(customBeta.isComplete, true);
    const customDashboardClusterSpend = customGroups.groups
      .filter((candidate) => ["sg-alpha", "sg-beta"].includes(candidate.groupId))
      .reduce((sum, candidate) => sum + candidate.spendUsd, 0);
    assert.equal(customHeadline.spendUsd, customDashboardClusterSpend);
    assert.equal(
      customAlpha.membersSpendUsd +
        customAlpha.unattributedSpendUsd +
        customBeta.membersSpendUsd +
        customBeta.unattributedSpendUsd,
      customHeadline.spendUsd,
      "custom-range cluster member rows and residuals reconcile to the dashboard",
    );
  } finally {
    __setMemberUsageForTests(unrelated.id, RANGE, null);
    __setProjectUsageForTests(unrelated.id, RANGE, null);
    for (const group of [...groups, unrelated]) {
      __setMemberUsageForTests(group.id, customRange.key, null);
      __setProjectUsageForTests(group.id, customRange.key, null);
    }
    __setWsSpendForTests("ws-main", customRange.key, null);
    __setWsSpendForTests("ws-extra", customRange.key, null);
    __setWsSpendForTests("ws-extra", RANGE, new Map());
    restoreDir();
  }
});

test("same-name migration aliases reconcile groups, summary pools, and cluster headline", async () => {
  // Concurrent test files (history-rosters) may write snapshot days after our
  // test.before clears them, causing partitionTrendBucket to produce unseeded
  // historical components. Clear defensively at the start of each trend-sensitive test.
  await db.delete(groupRosterSnapshotsTable);
  await db.delete(groupRosterSnapshotDaysTable);
  const primary = {
    id: "merge-primary",
    workspaceId: "ws-main",
    name: "AZ-Replit – Main",
    type: "custom",
  };
  const hidden = { ...primary, id: "merge-hidden", workspaceId: "ws-extra" };
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups: [hidden, primary],
    members,
    groupMembers: new Map([
      [primary.id, ["carol"]],
      [hidden.id, ["dave"]],
    ]),
  });
  await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, [primary.id, hidden.id]));
  await db.insert(groupBudgetsTable).values({ groupId: hidden.id, amountUsd: 100 });
  const [storedAlert] = await db.insert(alertsTable).values({
    groupId: primary.id,
    groupName: primary.name,
    entityType: "group",
    entityId: primary.id,
    entityName: primary.name,
    workspaceIds: ["ws-main", "ws-extra"],
    threshold: 50,
    spendUsd: 10,
    budgetUsd: 100,
    recipients: ["snapshot@example.com"],
    status: "sent",
  }).returning();
  __setMemberUsageForTests(primary.id, RANGE, new Map([["carol", 45]]));
  __setMemberUsageForTests(hidden.id, RANGE, new Map([["dave", 35]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["carol", 45]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["dave", 35]]));
  for (const group of [primary, hidden]) {
    __setProjectUsageForTests(group.id, RANGE, {
      fetchedAt: Date.now(),
      totalCostUsd: 1,
      byProject: new Map([[`${group.id}-project`, {
        projectId: `${group.id}-project`,
        totalCostUsd: 1,
        metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: 1 }],
      }]]),
    });
  }
  const aliasTrendRanges = [];
  const now = new Date();
  let trendCursor = new Date(Date.UTC(2026, 4, 20));
  while (trendCursor < now) {
    const year = trendCursor.getUTCFullYear();
    const month = trendCursor.getUTCMonth();
    const end = new Date(Math.min(Date.UTC(year, month + 1, 0), now.getTime()));
    const trendRange = resolveRange(
      "custom",
      trendCursor.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
    );
    aliasTrendRanges.push(trendRange);
    __setMemberUsageForTests(primary.id, trendRange.key, new Map([["carol", 45]]));
    __setMemberUsageForTests(hidden.id, trendRange.key, new Map([["dave", 35]]));
    __setWsSpendForTests("ws-main", trendRange.key, new Map([["carol", 45]]));
    __setWsSpendForTests("ws-extra", trendRange.key, new Map([["dave", 35]]));
    trendCursor = new Date(Date.UTC(year, month + 1, 1));
  }
  try {
    const groupsJson = await req("/groups");
    assert.equal(groupsJson.groups.filter((group) => !group.isSynthetic).length, 1);
    assert.equal(groupsJson.groups[0].groupId, primary.id);
    assert.equal(groupsJson.groups[0].spendUsd, 80);
    assert.equal(groupsJson.groups[0].budgetUsd, 100);
    assert.equal(groupsJson.groups[0].percentUsed, 80);

    const summary = await req("/summary");
    assert.equal(summary.totalGroups, 1);
    assert.equal(summary.totalRemainingUsd, 20);
    assert.equal(summary.groupsOver75, 1);
    assert.equal(summary.groupsOver100, 0);

    const headline = await req(
      `/clusters/${primary.id},${hidden.id}/headline`,
    );
    assert.equal(headline.spendUsd, 80, "primary and alias in a cluster must count one merged pool");

    const trends = await req(
      `/trends?granularity=month&groupIds=${primary.id}&groupIds=${hidden.id}`,
    );
    const groupSeries = trends.series.filter((series) => series.type === "group");
    assert.equal(groupSeries.length, 1, "same-name aliases must emit one primary trend series");
    assert.equal(groupSeries[0].name, primary.name);
    assert.deepEqual(groupSeries[0].data, trends.buckets.map(() => 80));
    assert.equal(
      groupSeries[0].data.at(-1),
      groupsJson.groups[0].spendUsd,
      "trend, /groups, and cluster headline must use the same merged spend",
    );
    assert.equal(groupSeries[0].data.at(-1), headline.spendUsd);

    const alertHistory = await req("/alerts");
    const current = alertHistory.find((alert) => alert.id === storedAlert.id);
    assert.equal(current.spendUsd, 10, "stored alert spend remains its send-time snapshot");
    assert.equal(current.currentSpendUsd, 80);
    assert.equal(current.currentPercentUsed, 80);
    assert.equal(current.currentUsageComplete, true);

    await db.insert(groupBudgetsTable).values({ groupId: primary.id, amountUsd: 200 });
    const primaryWins = await req("/groups");
    assert.equal(primaryWins.groups[0].budgetUsd, 200, "primary budget must win over alias budget");
    assert.equal(primaryWins.groups[0].percentUsed, 40);
  } finally {
    await db.delete(alertsTable).where(eq(alertsTable.id, storedAlert.id));
    await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, [primary.id, hidden.id]));
    __setMemberUsageForTests(primary.id, RANGE, null);
    __setMemberUsageForTests(hidden.id, RANGE, null);
    __setProjectUsageForTests(primary.id, RANGE, null);
    __setProjectUsageForTests(hidden.id, RANGE, null);
    for (const trendRange of aliasTrendRanges) {
      __setMemberUsageForTests(primary.id, trendRange.key, null);
      __setMemberUsageForTests(hidden.id, trendRange.key, null);
      __setWsSpendForTests("ws-main", trendRange.key, null);
      __setWsSpendForTests("ws-extra", trendRange.key, null);
    }
    restoreDir();
  }
});

test("trends use canonical workspace rollups for every bucket", async () => {
  // Same concurrent-file isolation as the alias trend test above.
  await db.delete(groupRosterSnapshotsTable);
  await db.delete(groupRosterSnapshotDaysTable);
  const now = new Date();
  let cursor = new Date(Date.UTC(2026, 4, 20));
  while (cursor < now) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const end = new Date(Math.min(Date.UTC(year, month + 1, 0), now.getTime()));
    const range = resolveRange(
      "custom",
      cursor.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
    );
    __setMemberUsageForTests("sg-alpha", range.key, new Map([["alice", 30], ["carol", 10]]));
    __setMemberUsageForTests("sg-beta", range.key, new Map([["alice", 20], ["bob", 15]]));
    __setWsSpendForTests("ws-main", range.key, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
    __setWsSpendForTests("ws-extra", range.key, new Map());
    __setProjectUsageForTests("sg-alpha", range.key, {
      fetchedAt: Date.now(),
      totalCostUsd: 0,
      byProject: new Map(),
    });
    __setProjectUsageForTests("sg-beta", range.key, {
      fetchedAt: Date.now(),
      totalCostUsd: 0,
      byProject: new Map(),
    });
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }

  const trends = await req("/trends?granularity=month&groupIds=sg-alpha&groupIds=sg-beta");
  assert.equal(trends.isComplete, true);
  const alpha = trends.series.find((series) => series.type === "group" && series.name === "Alpha");
  const beta = trends.series.find((series) => series.type === "group" && series.name === "Beta");
  assert.deepEqual(alpha.data, trends.buckets.map(() => 60));
  assert.deepEqual(beta.data, trends.buckets.map(() => 15));
});

test("five team route percentages reconcile with the checker canonical fixture", async () => {
  const expectedSpend = [55, 65, 80, 95, 120];
  const teamNames = expectedSpend.map((_, index) => `Route-Team-${index + 1}`);
  const routeGroups = expectedSpend.map((_, index) => ({
    id: `route-five-g${index + 1}`,
    workspaceId: index % 2 === 0 ? "ws-main" : "ws-extra",
    name: `Route Five Group ${index + 1}`,
    type: "custom",
  }));
  const routeMembers = new Map(members);
  expectedSpend.forEach((_, index) => {
    const workspaceId = routeGroups[index].workspaceId;
    routeMembers.set(
      `route-five-u${index + 1}`,
      m(`route-five-u${index + 1}`, false, {
        [workspaceId]: { role: "member", isDisabled: false },
      }),
    );
  });
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups: routeGroups,
    members: routeMembers,
    groupMembers: new Map(routeGroups.map((group, index) => [
      group.id,
      ["alice", `route-five-u${index + 1}`], // overlapping directory membership
    ])),
  });
  await db.insert(groupTeamsTable).values(routeGroups.map((group, index) => ({
    groupName: group.name,
    teamName: teamNames[index],
  })));
  await db.insert(teamBudgetsTable).values(teamNames.map((teamName) => ({
    teamName,
    amountUsd: 100,
  })));
  for (const [index, group] of routeGroups.entries()) {
    const userId = `route-five-u${index + 1}`;
    __setMemberUsageForTests(group.id, RANGE, new Map([[userId, expectedSpend[index]]]));
    __setProjectUsageForTests(group.id, RANGE, {
      fetchedAt: Date.now(),
      totalCostUsd: 1,
      byProject: new Map([[`${group.id}-project`, {
        projectId: `${group.id}-project`,
        totalCostUsd: 1,
        metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: 1 }],
      }]]),
    });
  }
  __setWsSpendForTests(
    "ws-main",
    RANGE,
    new Map(routeGroups
      .map((group, index) => [group, index])
      .filter(([group]) => group.workspaceId === "ws-main")
      .map(([, index]) => [`route-five-u${index + 1}`, expectedSpend[index]])),
  );
  __setWsSpendForTests(
    "ws-extra",
    RANGE,
    new Map(routeGroups
      .map((group, index) => [group, index])
      .filter(([group]) => group.workspaceId === "ws-extra")
      .map(([, index]) => [`route-five-u${index + 1}`, expectedSpend[index]])),
  );
  try {
    const groupsJson = await req("/groups");
    const routePairs = teamNames.map((teamName) => {
      const spendUsd = groupsJson.teamRawSpend[teamName].spendUsd;
      return { teamName, spendUsd, percentUsed: spendUsd };
    });
    assert.deepEqual(
      routePairs,
      teamNames.map((teamName, index) => ({
        teamName,
        spendUsd: expectedSpend[index],
        percentUsed: expectedSpend[index],
      })),
      "all five route team spend/percent pairs must match the checker fixture",
    );

    const summary = await req("/summary");
    assert.equal(summary.groupsOver50, 5);
    assert.equal(summary.groupsOver75, 3);
    assert.equal(summary.groupsOver90, 2);
    assert.equal(summary.groupsOver100, 1);
    assert.equal(summary.totalRemainingUsd, 85);
  } finally {
    await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, routeGroups.map((group) => group.name)));
    await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, teamNames));
    for (const group of routeGroups) {
      __setMemberUsageForTests(group.id, RANGE, null);
      __setProjectUsageForTests(group.id, RANGE, null);
    }
    restoreDir();
  }
});

test("/groups retains ungrouped members and no-user charges with stable workspace attribution", async () => {
  const extendedMembers = new Map(members);
  extendedMembers.set("erin", m("erin", false, {
    "ws-main": { role: "member", isDisabled: false },
  }));
  __setDirectoryCacheForTests({
    workspaces: wsExtra,
    groups: [...groups].reverse(),
    members: extendedMembers,
    groupMembers: new Map([
      ["sg-alpha", ["alice", "carol"]],
      ["sg-beta", ["alice", "bob"]],
    ]),
  });
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta", RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests(
    "ws-main",
    RANGE,
    new Map([["alice", 35], ["carol", 10], ["bob", 15], ["erin", 7]]),
    { unattributableTotalCostUsd: 3 },
  );
  __setWsSpendForTests(
    "ws-extra",
    RANGE,
    new Map([["alice", 35], ["dave", 8]]),
    { unattributableTotalCostUsd: 2 },
  );
  setProjectSpend(45, 15);
  setAccountUsage(115, 5);

  try {
    const json = await req("/groups");
    assert.equal(json.isComplete, true);
    assert.equal(json.groups.find((g) => g.groupId === "sg-alpha")?.spendUsd, 45,
      "workspace payload wins over drifting 30/20 group observations and Alpha wins stable attribution");
    assert.equal(json.groups.find((g) => g.groupId === "sg-beta")?.spendUsd, 15);

    const mainNoGroup = json.groups.find(
      (g) => g.groupId === "synthetic:no-group:ws-main",
    );
    assert.equal(mainNoGroup.name, "No group");
    assert.equal(mainNoGroup.memberCount, 1);
    assert.equal(mainNoGroup.spendUsd, 10, "erin $7 plus $3 no-user workspace spend");

    const extraNoGroup = json.groups.find(
      (g) => g.groupId === "synthetic:no-group:ws-extra",
    );
    assert.equal(extraNoGroup.spendUsd, 45,
      "equal $35 observations in separate workspaces are both retained, plus dave and no-user spend");

    const summary = await req("/summary");
    assert.equal(summary.totalSpendUsd, 115);
    assert.equal(summary.memberBasedTotalSpendUsd, 115);
    assert.equal(summary.reconciliationSpendUsd, 0);
  } finally {
    restoreDir();
  }
});

// ── Documented behavior: ungrouped members ─────────────────────────────────────────

test("unmatched project spend is included in the project-based summary total", async () => {
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["dave", 8]]));
  setProjectSpend(10, 15, 8);
  setAccountUsage(33);

  const json = await req("/summary");
  assert.equal(json.isComplete, true);
  assert.equal(json.totalSpendUsd, 33,
    "attributed projects plus unmatched project spend must reconcile to the summary total");
});

test("detail: direct cold-cache request queues all scoped groups so rollup eventually completes", async () => {
  // Simulate a direct drill-down with empty caches. The handler must queue member
  // usage for all scoped groups (not just the selected one) so rollup.isComplete
  // can become true without the admin first visiting /groups or /summary.
  __setMemberUsageForTests("sg-alpha", RANGE, null);
  __setMemberUsageForTests("sg-beta",  RANGE, null);
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20]]));
  setProjectSpend(0, 0);

  // Workspace and project inputs are ready, but creator-attributed member
  // splits must remain incomplete until every member-usage payload arrives.
  const cold = await req("/groups/sg-beta");
  assert.equal(cold.isComplete, false, "detail is incomplete while member usage caches are cold");
  assert.equal(
    cold.group.spendLoaded,
    true,
    "authoritative total spend is ready even while the optional breakdown is cold",
  );
  assert.equal(
    cold.members.find((member) => member.userId === "bob")?.spendUsd,
    15,
    "workspace-derived member totals remain visible on a cold breakdown cache",
  );

  // Warm all caches as the background queue would do after the first request.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  // Second request: member inputs are now warm — spendLoaded is final.
  const warm = await req("/groups/sg-beta");
  assert.equal(warm.isComplete, true, "detail must be complete once all caches are warm");
  assert.equal(warm.group.spendLoaded, true, "group card spendLoaded must be true once complete");
  // Beta's spend: only bob ($15); alice is attributed to Alpha.
  assert.equal(warm.group.spendUsd, 15, "Beta spend = bob $15; alice attributed to Alpha");
});

// ── teamRawSpend: provisional spendUsd available before spendLoaded is true ──────────
//
// teamRawSpend.spendUsd is the current deduped rollup estimate for a team — it
// is always emitted (non-null, 0 before any group loads) so the dashboard can
// display it as a provisional figure during loading. spendLoaded=true means the
// value is final; spendLoaded=false means it may still change as other groups load.
//
// This allows the dashboard to show "$40.00 (loading)" instead of "—" for teams
// whose own groups have already contributed data to the rollup.

test("/groups teamRawSpend: spendUsd populates provisionally while spendLoaded stays false", async () => {
  // OT-Alpha → Team A, OT-Beta → Team B. Alice is in both groups.
  // Phase 2 of the dedup rollup attributes alice to Alpha (sorts first), so
  // Team A's provisional value changes once Beta loads: $40 → $60.
  // spendLoaded stays false until both groups load (global dedup requirement).
  const TEAM_A = "OT-Team-A";
  const TEAM_B = "OT-Team-B";
  setOtDir();
  await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
  await db.insert(groupTeamsTable).values([
    { groupName: OT_G1.name, teamName: TEAM_A },
    { groupName: OT_G2.name, teamName: TEAM_B },
  ]);
  // Seed zero project spend so projectAttribution.isComplete is true for both steps.
  seedOtProject(OT_G1.id, 0);
  seedOtProject(OT_G2.id, 0);
  try {
    // Step 1: Alpha loaded, Beta pending.
    // Rollup Phase 1 only sees Alpha: alice=$30, carol=$10.
    // Team A provisional: alice($30) + carol($10) = $40.
    // Team B provisional: $0 (Beta pending, no byGroup entry yet).
    __setMemberUsageForTests(OT_G1.id, RANGE, new Map([["alice", 30], ["carol", 10]]));
    __setMemberUsageForTests(OT_G2.id, RANGE, null);
    __setWsSpendForTests("ws-main", RANGE, null);

    const partial = await req("/groups");
    const teamA_partial = partial.teamRawSpend?.[TEAM_A];
    const teamB_partial = partial.teamRawSpend?.[TEAM_B];
    assert.ok(teamA_partial, "teamRawSpend must include Team A");
    assert.ok(teamB_partial, "teamRawSpend must include Team B");
    assert.equal(partial.isComplete, false, "isComplete must be false while Beta is pending");
    assert.equal(
      teamA_partial.spendLoaded, false,
      "Team A spendLoaded must be false: rollup is not globally complete",
    );
    assert.equal(
      teamA_partial.spendUsd, 40,
      "Team A spendUsd is the provisional rollup estimate: alice $30 + carol $10 = $40",
    );
    assert.equal(
      teamB_partial.spendLoaded, false,
      "Team B spendLoaded must be false: Beta's member usage is pending",
    );
    assert.equal(
      teamB_partial.spendUsd, 0,
      "Team B spendUsd is $0 while Beta is pending",
    );

    // Step 2: Both loaded. Phase 1 combines alice's spend ($30 Alpha + $20 Beta = $50);
    // Phase 2 attributes the $50 to Alpha (first in sort order). carol ($10) goes
    // to Alpha; bob ($15) is Beta-only.
    __setMemberUsageForTests(OT_G2.id, RANGE, new Map([["alice", 20], ["bob", 15]]));
    __setWsSpendForTests(
      "ws-main",
      RANGE,
      new Map([["alice", 50], ["carol", 10], ["bob", 15]]),
    );

    const full = await req("/groups");
    const teamA_full = full.teamRawSpend?.[TEAM_A];
    const teamB_full = full.teamRawSpend?.[TEAM_B];
    assert.equal(full.isComplete, true, "isComplete must be true once both groups are loaded");
    assert.equal(teamA_full.spendLoaded, true, "Team A must be loaded once rollup is complete");
    assert.equal(teamA_full.spendUsd, 60, "Team A final: alice $50 (combined) + carol $10 = $60");
    assert.equal(teamB_full.spendLoaded, true, "Team B must be loaded once rollup is complete");
    assert.equal(teamB_full.spendUsd, 15, "Team B final: bob $15 (alice attributed to Alpha)");
  } finally {
    await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
    __setMemberUsageForTests(OT_G1.id, RANGE, null);
    __setMemberUsageForTests(OT_G2.id, RANGE, null);
    __setWsSpendForTests("ws-main", RANGE, null);
    restoreOtDir();
  }
});

// ── Over-threshold counts and totalRemainingUsd reconciliation ─────────────────────
// These tests use distinct group IDs ("sg-ot-*") and group names ("OT-*") that
// are not shared with any other test file, avoiding DB conflicts when test files
// run concurrently in separate worker threads.

// Isolated fixture for over-threshold tests — unique IDs & names
const OT_G1 = { id: "sg-ot-1", workspaceId: "ws-main", name: "OT-Alpha", type: "custom" };
const OT_G2 = { id: "sg-ot-2", workspaceId: "ws-main", name: "OT-Beta",  type: "custom" };
const OT_WS  = new Map([["ws-main", { id: "ws-main", name: "Main", slug: "main", memberCount: 3 }]]);
const OT_MEMBERS = new Map([
  ["acct",  m("acct",  true)],
  ["alice", m("alice", false, { "ws-main": { role: "member", isDisabled: false } })],
  ["bob",   m("bob",   false, { "ws-main": { role: "member", isDisabled: false } })],
  ["carol", m("carol", false, { "ws-main": { role: "member", isDisabled: false } })],
]);

function setOtDir() {
  __setDirectoryCacheForTests({
    workspaces: OT_WS,
    groups:     [OT_G1, OT_G2],
    members:    OT_MEMBERS,
    groupMembers: new Map([
      [OT_G1.id, ["alice", "carol"]],
      [OT_G2.id, ["alice", "bob"]],
    ]),
  });
}

function restoreOtDir() {
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

function seedOtProject(groupId, spend, residual = 0) {
  __setProjectUsageForTests(groupId, RANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: spend + residual,
    byProject: new Map(
      spend > 0
        ? [[`${groupId}-proj`, {
            projectId: `${groupId}-proj`,
            totalCostUsd: spend,
            metrics: [{ id: "ai", name: "AI", category: "ai", costUsd: spend }],
          }]]
        : [],
    ),
  });
}
function clearOtProject() {
  __setProjectUsageForTests(OT_G1.id, RANGE, null);
  __setProjectUsageForTests(OT_G2.id, RANGE, null);
}

test("closed weekly and monthly trend totals reconcile with the identical canonical custom range", async () => {
  const TEAM = "OT-Trend-Team";
  const startDate = "2026-06-03";
  const endDate = "2026-07-04";
  const headlineRange = resolveRange("custom", startDate, endDate);
  const monthlyFixtures = [
    ["2026-06-03", "2026-06-30", 40],
    ["2026-07-01", "2026-07-04", 35],
  ];
  const weeklyFixtures = [
    ["2026-06-03", "2026-06-07", 10],
    ["2026-06-08", "2026-06-14", 20],
    ["2026-06-15", "2026-06-21", 15],
    ["2026-06-22", "2026-06-28", 20],
    ["2026-06-29", "2026-07-04", 10],
  ];
  const seededRangeKeys = new Set();
  const seedCanonicalRange = (range, total) => {
    seededRangeKeys.add(range.key);
    const alice = total * 0.6;
    const carol = total * 0.2;
    const bob = total * 0.2;
    __setMemberUsageForTests(OT_G1.id, range.key, new Map([["alice", alice], ["carol", carol]]));
    __setMemberUsageForTests(OT_G2.id, range.key, new Map([["alice", alice], ["bob", bob]]));
    __setWsSpendForTests("ws-main", range.key, new Map([["alice", alice], ["carol", carol], ["bob", bob]]));
  };

  setOtDir();
  await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
  await db.insert(groupTeamsTable).values([
    { groupName: OT_G1.name, teamName: TEAM },
    { groupName: OT_G2.name, teamName: TEAM },
  ]);
  seedCanonicalRange(headlineRange, 75);
  __setAccountUsageForTests(headlineRange.key, {
    fetchedAt: Date.now(),
    totalCostUsd: 75,
    attributableTotalCostUsd: 75,
    unattributableTotalCostUsd: 0,
  });
  for (const [start, end, total] of [...monthlyFixtures, ...weeklyFixtures]) {
    seedCanonicalRange(resolveRange("custom", start, end), total);
  }

  try {
    const summary = await req(
      `/summary?rangeType=custom&startDate=${startDate}&endDate=${endDate}`,
    );
    assert.equal(summary.isComplete, true);
    assert.equal(summary.totalSpendUsd, 75);

    for (const granularity of ["week", "month"]) {
      const trends = await req(
        `/trends?granularity=${granularity}&rangeType=custom&startDate=${startDate}&endDate=${endDate}`,
      );
      assert.equal(trends.isComplete, true);
      assert.ok(trends.bucketRanges.every((bucket) => bucket.isPartial === false));
      assert.equal(
        trends.totals.reduce((sum, value) => sum + value, 0),
        summary.totalSpendUsd,
        `${granularity} bucket totals must equal the canonical headline`,
      );
      const team = trends.series.find((series) => series.type === "team" && series.name === TEAM);
      assert.ok(team, `${granularity} response must contain the selected team`);
      assert.deepEqual(
        team.data,
        trends.totals,
        "overlapping alice membership must be deduped before team buckets are emitted",
      );
    }
  } finally {
    await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
    for (const rangeKey of seededRangeKeys) {
      __setMemberUsageForTests(OT_G1.id, rangeKey, null);
      __setMemberUsageForTests(OT_G2.id, rangeKey, null);
      __setWsSpendForTests("ws-main", rangeKey, null);
    }
    __setAccountUsageForTests(headlineRange.key, null);
    restoreOtDir();
  }
});

test("summary: unassigned group over 75% shows in groupsOver75 and totalRemainingUsd reconciles", async () => {
  // OT-Alpha ($100 budget) at 80% utilisation → over-75. OT-Beta has no budget.
  // $10 residual (unattributed) project spend must NOT reduce remaining.
  setOtDir();
  await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, [OT_G1.id, OT_G2.id]));
  await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
  await db.insert(groupBudgetsTable).values({ groupId: OT_G1.id, amountUsd: 100 });
  seedOtProject(OT_G1.id, 5, 10);  // deliberately divergent project attribution
  seedOtProject(OT_G2.id, 0);       // OT-Beta no spend
  __setMemberUsageForTests(OT_G1.id, RANGE, new Map([["carol", 80]]));
  __setMemberUsageForTests(OT_G2.id, RANGE, new Map());
  __setWsSpendForTests("ws-main", RANGE, new Map([["carol", 80]]));
  setAccountUsage(90);
  try {
    const json = await req("/summary");
    assert.equal(json.groupsOver75, 1, "OT-Alpha at 80% must count as over-75");
    assert.equal(json.groupsOver100, 0, "OT-Alpha at 80% must not count as over-100");
    assert.equal(json.totalBudgetUsd, 100, "totalBudgetUsd = OT-Alpha group budget only");
    assert.equal(json.totalRemainingUsd, 20, "remaining = $100 − $80; unattributed $10 excluded");
  } finally {
    await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, [OT_G1.id, OT_G2.id]));
    clearOtProject();
    restoreOtDir();
  }
});

test("summary: team pool over 100% is counted once and unattributed spend excluded from remaining", async () => {
  // OT-Alpha and OT-Beta both assigned to one team with a $100 budget.
  // Attributed spend $110 (>100% of budget) + $10 unattributed residual.
  const TEAM = "OT-Test-Team";
  setOtDir();
  await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, [OT_G1.id, OT_G2.id]));
  await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
  await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, TEAM));
  await db.insert(groupTeamsTable).values([
    { groupName: OT_G1.name, teamName: TEAM },
    { groupName: OT_G2.name, teamName: TEAM },
  ]);
  await db.insert(teamBudgetsTable).values({ teamName: TEAM, amountUsd: 100 });
  seedOtProject(OT_G1.id, 60, 10); // OT-Alpha $60 + $10 unattributed residual
  seedOtProject(OT_G2.id, 50);     // OT-Beta $50 → team total $110
  __setMemberUsageForTests(OT_G1.id, RANGE, new Map([["alice", 60], ["carol", 0]]));
  __setMemberUsageForTests(OT_G2.id, RANGE, new Map([["alice", 50], ["bob", 0]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 110], ["bob", 0], ["carol", 0]]));
  setAccountUsage(120);
  try {
    const json = await req("/summary");
    assert.equal(json.groupsOver75, 1, "team pool at 110% must count as over-75");
    assert.equal(json.groupsOver100, 1, "team pool at 110% must count as over-100");
    assert.equal(json.totalBudgetUsd, 100, "team pool counted once, not once per group");
    assert.equal(json.totalRemainingUsd, -10, "remaining = $100 − $110 = −$10; unattributed $10 excluded");
  } finally {
    await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
    await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, TEAM));
    clearOtProject();
    restoreOtDir();
  }
});

// ── Stat-card loading regression: groupsData available while summary is pending ────
// Verifies that /summary responds within a bounded time under normal conditions so
// the frontend tableTotals fallback is not blocked indefinitely.

test("/summary responds within 5 seconds under normal conditions (stat-card loading regression)", async () => {
  // Warm caches so the handler has data to work with.
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta",  RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5], ["dave", 8]]));
  setProjectSpend(85, 15, 8);
  setAccountUsage(108);

  const start = Date.now();
  const json = await req("/summary");
  const elapsed = Date.now() - start;

  // Must respond (not hang) — stat cards depend on this resolving promptly.
  assert.ok(elapsed < 5000, `summary took ${elapsed}ms — must respond within 5 s`);
  // And must return valid data (not an error body).
  assert.ok(typeof json.totalSpendUsd === "number", "response must include totalSpendUsd");
  assert.ok(typeof json.isComplete === "boolean",   "response must include isComplete");
});

test("summary: team pool + unassigned group remaining reconciles with table model", async () => {
  // OT-Alpha assigned to team (budget $200, spend $100 = 50% — NOT over-75).
  // OT-Beta unassigned (budget $100, spend $80 = 80% — over-75).
  // totalRemainingUsd must equal ($200−$100) + ($100−$80) = $120.
  const TEAM = "OT-Test-Team";
  setOtDir();
  await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, [OT_G1.id, OT_G2.id]));
  await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
  await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, TEAM));
  await db.insert(groupTeamsTable).values({ groupName: OT_G1.name, teamName: TEAM });
  await db.insert(teamBudgetsTable).values({ teamName: TEAM, amountUsd: 200 });
  await db.insert(groupBudgetsTable).values({ groupId: OT_G2.id, amountUsd: 100 });
  seedOtProject(OT_G1.id, 1);   // project attribution must not drive pool math
  seedOtProject(OT_G2.id, 2);
  __setMemberUsageForTests(OT_G1.id, RANGE, new Map([["alice", 100], ["carol", 0]]));
  __setMemberUsageForTests(OT_G2.id, RANGE, new Map([["bob", 80]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 100], ["bob", 80], ["carol", 0]]));
  setAccountUsage(180);
  try {
    const json = await req("/summary");
    assert.equal(json.groupsOver75, 1, "only OT-Beta (80%) is over-75; OT-Alpha team (50%) is not");
    assert.equal(json.groupsOver100, 0, "no pool exceeds 100%");
    assert.equal(json.totalBudgetUsd, 300, "totalBudgetUsd = team $200 + OT-Beta group $100");
    assert.equal(json.totalRemainingUsd, 120, "remaining = ($200−$100) + ($100−$80) = $120");
  } finally {
    await db.delete(groupTeamsTable).where(inArray(groupTeamsTable.groupName, [OT_G1.name, OT_G2.name]));
    await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, TEAM));
    await db.delete(groupBudgetsTable).where(inArray(groupBudgetsTable.groupId, [OT_G1.id, OT_G2.id]));
    clearOtProject();
    restoreOtDir();
  }
});

test("group reporting and pace spend use the later discovered billing start", async () => {
  restoreDir();
  __setMemberUsageForTests("sg-alpha", RANGE, new Map([["alice", 30], ["carol", 10]]));
  __setMemberUsageForTests("sg-beta", RANGE, new Map([["alice", 20], ["bob", 15]]));
  __setWsSpendForTests("ws-main", RANGE, new Map([["alice", 50], ["carol", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-extra", RANGE, new Map([["alice", 20], ["carol", 5], ["dave", 8]]));
  setProjectSpend(85, 15, 8);

  __setBillingPeriodForTests({
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-09-01T00:00:00.000Z",
    fetchedAt: Date.now(),
  });
  const billingRange = resolveRange("billing");
  const paceRange = resolvePaceUsageRange();
  assert.ok(paceRange);
  __setMemberUsageForTests("sg-alpha", billingRange.key, new Map([["alice", 5], ["carol", 1]]));
  __setMemberUsageForTests("sg-beta", billingRange.key, new Map([["alice", 2], ["bob", 3]]));
  __setWsSpendForTests("ws-main", billingRange.key, new Map([["alice", 7], ["carol", 1], ["bob", 3]]));
  __setWsSpendForTests("ws-extra", billingRange.key, new Map([["alice", 4], ["carol", 0.5], ["dave", 1]]));
  __setProjectUsageForTests("sg-alpha", billingRange.key, {
    fetchedAt: Date.now(),
    totalCostUsd: 0,
    byProject: new Map(),
  });
  __setProjectUsageForTests("sg-beta", billingRange.key, {
    fetchedAt: Date.now(),
    totalCostUsd: 0,
    byProject: new Map(),
  });
  __setMemberUsageForTests("sg-alpha", paceRange.key, new Map([["alice", 5], ["carol", 1]]));
  __setMemberUsageForTests("sg-beta", paceRange.key, new Map([["alice", 2], ["bob", 3]]));
  __setWsSpendForTests("ws-main", paceRange.key, new Map([["alice", 7], ["carol", 1], ["bob", 3]]));
  __setWsSpendForTests("ws-extra", paceRange.key, new Map([["alice", 4], ["carol", 0.5], ["dave", 1]]));
  __setProjectUsageForTests("sg-alpha", paceRange.key, {
    fetchedAt: Date.now(),
    totalCostUsd: 0,
    byProject: new Map(),
  });
  __setProjectUsageForTests("sg-beta", paceRange.key, {
    fetchedAt: Date.now(),
    totalCostUsd: 0,
    byProject: new Map(),
  });

  try {
    const json = await req("/groups");
    const alpha = json.groups.find((group) => group.groupId === "sg-alpha");
    const beta = json.groups.find((group) => group.groupId === "sg-beta");
    assert.equal(alpha.rollupSpendUsd, 8, "reporting spend starts with the verified billing window");
    assert.equal(alpha.paceSpendUsd, 8, "pace spend contains only August usage");
    assert.equal(beta.rollupSpendUsd, 3);
    assert.equal(beta.paceSpendUsd, 3);
    assert.equal(alpha.paceSpendLoaded, true);
  } finally {
    __setMemberUsageForTests("sg-alpha", billingRange.key, null);
    __setMemberUsageForTests("sg-beta", billingRange.key, null);
    __setWsSpendForTests("ws-main", billingRange.key, null);
    __setWsSpendForTests("ws-extra", billingRange.key, null);
    __setProjectUsageForTests("sg-alpha", billingRange.key, null);
    __setProjectUsageForTests("sg-beta", billingRange.key, null);
    __setMemberUsageForTests("sg-alpha", paceRange.key, null);
    __setMemberUsageForTests("sg-beta", paceRange.key, null);
    __setWsSpendForTests("ws-main", paceRange.key, null);
    __setWsSpendForTests("ws-extra", paceRange.key, null);
    __setProjectUsageForTests("sg-alpha", paceRange.key, null);
    __setProjectUsageForTests("sg-beta", paceRange.key, null);
    __setBillingPeriodForTests(null);
  }
});
