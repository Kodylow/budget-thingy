import assert from "node:assert/strict";
import test from "node:test";

import {
  __setMemberUsageForTests,
  __setWsSpendForTests,
  __setProjectUsageForTests,
  __setProjectInfoForTests,
  getDedupedUsageRollup,
  getCanonicalUsage,
} from "./enterprise.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const RANGE = "custom:comcast-rollup-unit";

// Three workspaces:
//   ws-comcast  ("Comcast")         — main workspace holding all AZ-Replit groups
//   ws-fw       ("Freewheel")       — extra workspace, no custom groups
//   ws-tl       ("Talent Learning") — extra workspace, no custom groups
const workspaces = new Map([
  ["ws-comcast", { name: "Comcast" }],
  ["ws-fw",      { name: "Freewheel" }],
  ["ws-tl",      { name: "Talent Learning" }],
]);

// Comcast-workspace groups (Admin before Member in stable sort)
const fwAdmin  = { id: "fw-admin",  workspaceId: "ws-comcast", name: "AZ-Replit – Freewheel – Admin",        type: "custom" };
const fwMember = { id: "fw-member", workspaceId: "ws-comcast", name: "AZ-Replit – Freewheel – Member",       type: "custom" };
const tlAdmin  = { id: "tl-admin",  workspaceId: "ws-comcast", name: "AZ-Replit – Talent Learning – Admin",  type: "custom" };
const tlMember = { id: "tl-member", workspaceId: "ws-comcast", name: "AZ-Replit – Talent Learning – Member", type: "custom" };

const allGroups = [fwAdmin, fwMember, tlAdmin, tlMember];

const groupMembers = new Map([
  ["fw-admin",  ["dave"]],
  ["fw-member", []],
  ["tl-admin",  ["dave"]],
  ["tl-member", []],
]);

test.after(() => {
  __setMemberUsageForTests("fw-admin",  RANGE, null);
  __setMemberUsageForTests("fw-member", RANGE, null);
  __setMemberUsageForTests("tl-admin",  RANGE, null);
  __setMemberUsageForTests("tl-member", RANGE, null);
  __setWsSpendForTests("ws-comcast", RANGE, null);
  __setWsSpendForTests("ws-fw",      RANGE, null);
  __setWsSpendForTests("ws-tl",      RANGE, null);
});

// ---------------------------------------------------------------------------
// Test 1: Comcast-only user — no re-attribution
// ---------------------------------------------------------------------------
test("Comcast-only user stays in their Comcast group with no re-homing", () => {
  __setWsSpendForTests("ws-comcast", RANGE, new Map([["dave", 50]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map());
  __setWsSpendForTests("ws-tl",      RANGE, new Map());
  __setMemberUsageForTests("fw-admin",  RANGE, new Map([["dave", 50]]));
  __setMemberUsageForTests("fw-member", RANGE, new Map());
  __setMemberUsageForTests("tl-admin",  RANGE, new Map());
  __setMemberUsageForTests("tl-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    allGroups,
    RANGE,
    new Set(["ws-comcast", "ws-fw", "ws-tl"]),
    groupMembers,
    undefined,
    workspaces,
  );

  assert.equal(result.totalSpendUsd, 50, "total unchanged");
  // Dave has no non-Comcast spend → stays in fw-admin
  assert.equal(result.byGroup.get("fw-admin")?.spendUsd, 50);
  assert.deepEqual(result.byGroup.get("fw-admin")?.byUser, new Map([["dave", 50]]));
  assert.equal(result.byGroup.get("tl-admin")?.spendUsd, 0);
  assert.equal(result.ungroupedByWorkspace.size, 0);
  assert.equal(result.isComplete, true);
});

// ---------------------------------------------------------------------------
// Test 2: Comcast + one extra workspace
//   • Extra-workspace spend stays ungrouped in ws-fw (attributed to the
//     workspace where it occurred, not moved to fw-admin)
//   • Comcast spend stays in fw-admin (primary = Freewheel, same group → no-op)
// ---------------------------------------------------------------------------
test("User with Comcast + one extra workspace: extra spend stays ungrouped, Comcast stays in matched group", () => {
  // Dave: $20 in Comcast WS (→ fw-admin), $40 in Freewheel WS (→ ungrouped)
  __setWsSpendForTests("ws-comcast", RANGE, new Map([["dave", 20]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map([["dave", 40]]));
  __setWsSpendForTests("ws-tl",      RANGE, new Map());
  __setMemberUsageForTests("fw-admin",  RANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("fw-member", RANGE, new Map());
  __setMemberUsageForTests("tl-admin",  RANGE, new Map());
  __setMemberUsageForTests("tl-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    allGroups,
    RANGE,
    new Set(["ws-comcast", "ws-fw", "ws-tl"]),
    groupMembers,
    undefined,
    workspaces,
  );

  assert.equal(result.totalSpendUsd, 60, "total spend = comcast + freewheel");
  assert.equal(result.byUser.get("dave"), 60, "global byUser correct");

  // Comcast spend stays in fw-admin (primary = Freewheel → same group, no move)
  assert.equal(result.byGroup.get("fw-admin")?.spendUsd, 20, "fw-admin: Comcast spend only");
  assert.deepEqual(result.byGroup.get("fw-admin")?.byUser, new Map([["dave", 20]]));
  assert.equal(result.byGroup.get("tl-admin")?.spendUsd, 0);

  // Freewheel spend stays ungrouped in ws-fw (attributed to the workspace where it occurred)
  assert.equal(result.ungroupedByWorkspace.has("ws-fw"), true, "ws-fw has ungrouped spend");
  assert.equal(result.ungroupedByWorkspace.get("ws-fw")?.byUser.get("dave"), 40);

  assert.equal(result.isComplete, true);
});

// ---------------------------------------------------------------------------
// Test 3: Comcast + two extra workspaces — Comcast spend re-homed to primary
//   • Extra-workspace spend stays ungrouped in each respective workspace
//   • Comcast spend moves to the Comcast group matching the primary workspace
// ---------------------------------------------------------------------------
test("Comcast spend is re-homed to the Comcast group matching the primary non-Comcast workspace", () => {
  // Dave: $20 Comcast, $40 Freewheel, $60 T&L → T&L is primary (highest actual WS spend)
  __setWsSpendForTests("ws-comcast", RANGE, new Map([["dave", 20]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map([["dave", 40]]));
  __setWsSpendForTests("ws-tl",      RANGE, new Map([["dave", 60]]));
  __setMemberUsageForTests("fw-admin",  RANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("fw-member", RANGE, new Map());
  __setMemberUsageForTests("tl-admin",  RANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("tl-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    allGroups,
    RANGE,
    new Set(["ws-comcast", "ws-fw", "ws-tl"]),
    groupMembers,
    undefined,
    workspaces,
  );

  // Total must be conserved: 20 + 40 + 60 = 120
  assert.equal(result.totalSpendUsd, 120, "total spend conserved");
  assert.equal(result.byUser.get("dave"), 120, "global byUser conserved");

  // Comcast spend ($20) moves from fw-admin to tl-admin (T&L is primary)
  assert.equal(result.byGroup.get("fw-admin")?.spendUsd, 0, "fw-admin: Comcast spend re-homed away");
  assert.equal(result.byGroup.get("tl-admin")?.spendUsd, 20, "tl-admin: re-homed Comcast spend");
  assert.deepEqual(result.byGroup.get("tl-admin")?.byUser, new Map([["dave", 20]]));

  // Extra-workspace spend stays ungrouped in each workspace (attributed where it occurred)
  assert.equal(result.ungroupedByWorkspace.get("ws-fw")?.byUser.get("dave"), 40, "Freewheel spend ungrouped in ws-fw");
  assert.equal(result.ungroupedByWorkspace.get("ws-tl")?.byUser.get("dave"), 60, "T&L spend ungrouped in ws-tl");

  assert.equal(result.isComplete, true);
});

// ---------------------------------------------------------------------------
// Test 4: Admin-over-Member precedence preserved in Comcast group attribution
// ---------------------------------------------------------------------------
test("Admin group wins over Member group when attributing Comcast workspace spend", () => {
  const membersWithBoth = new Map([
    ["fw-admin",  ["dave"]],
    ["fw-member", ["dave"]],  // Dave is also in Member group
    ["tl-admin",  []],
    ["tl-member", []],
  ]);

  __setWsSpendForTests("ws-comcast", RANGE, new Map([["dave", 20]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map([["dave", 40]]));
  __setWsSpendForTests("ws-tl",      RANGE, new Map());
  __setMemberUsageForTests("fw-admin",  RANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("fw-member", RANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("tl-admin",  RANGE, new Map());
  __setMemberUsageForTests("tl-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    allGroups,
    RANGE,
    new Set(["ws-comcast", "ws-fw", "ws-tl"]),
    membersWithBoth,
    undefined,
    workspaces,
  );

  // Dave's Comcast spend must land in fw-admin (Admin wins over Member)
  // Primary = Freewheel ($40) → same group as current → no re-homing
  assert.equal(result.byGroup.get("fw-admin")?.spendUsd, 20, "Admin group holds Comcast spend");
  assert.deepEqual(result.byGroup.get("fw-admin")?.byUser, new Map([["dave", 20]]));
  assert.equal(result.byGroup.get("fw-member")?.spendUsd, 0, "Member group gets no Comcast spend");

  // Freewheel spend stays ungrouped
  assert.equal(result.ungroupedByWorkspace.get("ws-fw")?.byUser.get("dave"), 40);
  assert.equal(result.totalSpendUsd, 60, "total conserved");
});

// ---------------------------------------------------------------------------
// Test 5: Total spend is conserved across all scenarios (no dollars created/lost)
// ---------------------------------------------------------------------------
test("total spend is conserved when re-homing Comcast spend across multiple users", () => {
  // alice: in fw-admin; Comcast $10, Freewheel $30
  //   → primary = Freewheel (only non-Comcast ws) → Comcast stays in fw-admin
  // bob:   in fw-admin + tl-admin; Comcast $15, Freewheel $20, T&L $40
  //   → primary = T&L ($40 > $20) → Comcast $15 moves from fw-admin to tl-admin
  const multiGroupMembers = new Map([
    ["fw-admin",  ["alice", "bob"]],
    ["fw-member", []],
    ["tl-admin",  ["bob"]],
    ["tl-member", []],
  ]);

  __setWsSpendForTests("ws-comcast", RANGE, new Map([["alice", 10], ["bob", 15]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map([["alice", 30], ["bob", 20]]));
  __setWsSpendForTests("ws-tl",      RANGE, new Map([["bob",   40]]));
  __setMemberUsageForTests("fw-admin",  RANGE, new Map([["alice", 10], ["bob", 15]]));
  __setMemberUsageForTests("fw-member", RANGE, new Map());
  __setMemberUsageForTests("tl-admin",  RANGE, new Map([["bob", 15]]));
  __setMemberUsageForTests("tl-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    allGroups,
    RANGE,
    new Set(["ws-comcast", "ws-fw", "ws-tl"]),
    multiGroupMembers,
    undefined,
    workspaces,
  );

  const expectedTotal = 10 + 15 + 30 + 20 + 40; // 115
  assert.equal(result.totalSpendUsd, expectedTotal, "total spend conserved");
  assert.equal(result.byUser.get("alice"), 40,  "alice byUser: 10 + 30");
  assert.equal(result.byUser.get("bob"),   75,  "bob byUser: 15 + 20 + 40");

  // fw-admin: alice $10 (Comcast, no re-homing); bob $15 → re-homed away → $0 remaining
  // Bob's Comcast spend ($15) moves out, so fw-admin has only alice's $10
  assert.equal(result.byGroup.get("fw-admin")?.spendUsd, 10, "fw-admin: alice Comcast only after bob re-homed");
  assert.deepEqual(result.byGroup.get("fw-admin")?.byUser, new Map([["alice", 10]]));

  // tl-admin: bob's Comcast $15 re-homed here (T&L is bob's primary)
  assert.equal(result.byGroup.get("tl-admin")?.spendUsd, 15, "tl-admin: bob re-homed Comcast");
  assert.deepEqual(result.byGroup.get("tl-admin")?.byUser, new Map([["bob", 15]]));

  // Extra-workspace spend stays ungrouped
  const fwUngrouped = result.ungroupedByWorkspace.get("ws-fw");
  assert.equal(fwUngrouped?.byUser.get("alice"), 30, "alice Freewheel spend ungrouped");
  assert.equal(fwUngrouped?.byUser.get("bob"),   20, "bob Freewheel spend ungrouped");
  assert.equal(result.ungroupedByWorkspace.get("ws-tl")?.byUser.get("bob"), 40, "bob T&L spend ungrouped");

  // Grand total reconciles
  assert.equal(
    (result.byGroup.get("fw-admin")?.spendUsd ?? 0) +
    (result.byGroup.get("tl-admin")?.spendUsd ?? 0) +
    (fwUngrouped?.spendUsd ?? 0) +
    (result.ungroupedByWorkspace.get("ws-tl")?.spendUsd ?? 0),
    expectedTotal,
    "group + ungrouped sums to total",
  );
});

// ---------------------------------------------------------------------------
// Test 3b: Re-homing works even when user is NOT a member of the destination group
// ---------------------------------------------------------------------------
test("Comcast spend is re-homed to destination group even without explicit membership there", () => {
  // dave: in fw-admin (Comcast group), but NOT in tl-admin via groupMembers.
  // T&L workspace has more spend → tl-admin should be the re-homing target anyway.
  const noTlMembership = new Map([
    ["fw-admin",  ["dave"]],
    ["fw-member", []],
    ["tl-admin",  []],     // dave NOT listed here
    ["tl-member", []],
  ]);

  __setWsSpendForTests("ws-comcast", RANGE, new Map([["dave", 20]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map([["dave", 40]]));
  __setWsSpendForTests("ws-tl",      RANGE, new Map([["dave", 60]]));
  __setMemberUsageForTests("fw-admin",  RANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("fw-member", RANGE, new Map());
  __setMemberUsageForTests("tl-admin",  RANGE, new Map());  // no member usage either
  __setMemberUsageForTests("tl-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    allGroups,
    RANGE,
    new Set(["ws-comcast", "ws-fw", "ws-tl"]),
    noTlMembership,
    undefined,
    workspaces,
  );

  assert.equal(result.totalSpendUsd, 120, "total conserved");
  // Comcast spend ($20) must move to tl-admin even though dave is not a member there
  assert.equal(result.byGroup.get("fw-admin")?.spendUsd, 0,
    "fw-admin: Comcast spend re-homed away");
  assert.equal(result.byGroup.get("tl-admin")?.spendUsd, 20,
    "tl-admin receives re-homed Comcast spend without requiring membership");
  assert.deepEqual(result.byGroup.get("tl-admin")?.byUser, new Map([["dave", 20]]));
  // Extra-workspace spend stays ungrouped
  assert.equal(result.ungroupedByWorkspace.get("ws-fw")?.byUser.get("dave"), 40);
  assert.equal(result.ungroupedByWorkspace.get("ws-tl")?.byUser.get("dave"), 60);
});

// ---------------------------------------------------------------------------
// Test 3c: Workspaces with shared name prefix do NOT cross-match
// ---------------------------------------------------------------------------
test("Workspaces sharing a leading word do not cross-match into wrong Comcast groups", () => {
  // "Talent" workspace and "Talent & Learning" workspace both start with "Talent".
  // Old prefix matching would send "Talent" spend to the T&L group — exact matching fixes this.
  const talentGroup = {
    id: "talent-admin", workspaceId: "ws-comcast",
    name: "AZ-Replit – Talent – Admin", type: "custom",
  };
  const talentLearningGroup = {
    id: "tl-admin-exact", workspaceId: "ws-comcast",
    name: "AZ-Replit – Talent Learning – Admin", type: "custom",
  };

  const wsMap = new Map([
    ["ws-comcast",  { name: "Comcast" }],
    ["ws-talent",   { name: "Talent" }],           // exact: "talent"
    ["ws-tl-exact", { name: "Talent & Learning" }], // exact: "talent learning"
  ]);
  const groups4 = [talentGroup, talentLearningGroup];
  const gm4 = new Map([
    ["talent-admin",   ["dave"]],
    ["tl-admin-exact", []],
  ]);

  __setWsSpendForTests("ws-comcast",  RANGE, new Map([["dave", 10]]));
  __setWsSpendForTests("ws-talent",   RANGE, new Map([["dave", 30]]));
  __setWsSpendForTests("ws-tl-exact", RANGE, new Map([["dave", 50]]));
  __setMemberUsageForTests("talent-admin",   RANGE, new Map([["dave", 10]]));
  __setMemberUsageForTests("tl-admin-exact", RANGE, new Map());

  const result = getDedupedUsageRollup(
    groups4,
    RANGE,
    new Set(["ws-comcast", "ws-talent", "ws-tl-exact"]),
    gm4,
    undefined,
    wsMap,
  );

  assert.equal(result.totalSpendUsd, 90, "total conserved");

  // ws-talent ("Talent") must match ONLY talent-admin, not tl-admin-exact
  // ws-tl-exact ("Talent & Learning") must match ONLY tl-admin-exact
  // dave is in talent-admin (Comcast ws attribution), primary = ws-tl-exact ($50 > $30)
  // → Comcast spend ($10) re-homes from talent-admin to tl-admin-exact
  assert.equal(result.byGroup.get("talent-admin")?.spendUsd, 0,
    "talent-admin: Comcast spend re-homed to T&L group (higher primary)");
  assert.equal(result.byGroup.get("tl-admin-exact")?.spendUsd, 10,
    "tl-admin-exact: receives re-homed Comcast spend");

  // Extra-workspace spend stays ungrouped in each workspace
  assert.equal(result.ungroupedByWorkspace.get("ws-talent")?.byUser.get("dave"), 30,
    "Talent workspace spend is ungrouped (correct workspace, not T&L)");
  assert.equal(result.ungroupedByWorkspace.get("ws-tl-exact")?.byUser.get("dave"), 50,
    "T&L workspace spend is ungrouped");

  // Clean up extra caches used only in this test
  __setWsSpendForTests("ws-talent",   RANGE, null);
  __setWsSpendForTests("ws-tl-exact", RANGE, null);
  __setMemberUsageForTests("talent-admin",   RANGE, null);
  __setMemberUsageForTests("tl-admin-exact", RANGE, null);
});

test("parent workspace spend follows the user's matching Comcast child-team membership", () => {
  const strategicLiftAdmin = {
    id: "strategic-lift-admin",
    workspaceId: "ws-comcast",
    name: "AZ-Replit - Strategic Development LIFT Labs - Admin",
    type: "custom",
  };
  const strategicLiftMember = {
    id: "strategic-lift-member",
    workspaceId: "ws-comcast",
    name: "AZ-Replit - Strategic Development LIFT Labs - Member",
    type: "custom",
  };
  const strategicMosaicAdmin = {
    id: "strategic-mosaic-admin",
    workspaceId: "ws-comcast",
    name: "AZ-Replit - Strategic Development Mosaic - Admin",
    type: "custom",
  };
  const strategicMosaicMember = {
    id: "strategic-mosaic-member",
    workspaceId: "ws-comcast",
    name: "AZ-Replit - Strategic Development Mosaic - Member",
    type: "custom",
  };
  const strategicPreprod = {
    id: "strategic-preprod",
    workspaceId: "ws-strategic",
    name: "AZ-Replit - PREPROD-Admins",
    type: "custom",
  };
  const strategicGroups = [
    strategicLiftAdmin,
    strategicLiftMember,
    strategicMosaicAdmin,
    strategicMosaicMember,
    strategicPreprod,
  ];
  const strategicWorkspaces = new Map([
    ["ws-comcast", { name: "Comcast" }],
    ["ws-strategic", { name: "Strategic Development" }],
  ]);
  const strategicMembers = new Map([
    ["strategic-lift-admin", ["katie"]],
    ["strategic-lift-member", ["denise", "allison"]],
    ["strategic-mosaic-admin", []],
    ["strategic-mosaic-member", []],
    ["strategic-preprod", ["denise", "katie", "allison"]],
  ]);

  __setWsSpendForTests("ws-comcast", RANGE, new Map([
    ["denise", 0],
    ["katie", 0],
    ["allison", 0],
  ]));
  __setWsSpendForTests("ws-strategic", RANGE, new Map([
    ["denise", 1900],
    ["katie", 207],
    ["allison", 139],
  ]));
  for (const group of strategicGroups) {
    __setMemberUsageForTests(group.id, RANGE, new Map());
  }
  __setMemberUsageForTests("strategic-preprod", RANGE, new Map([
    ["denise", 1900],
    ["katie", 207],
    ["allison", 139],
  ]));

  const result = getDedupedUsageRollup(
    strategicGroups,
    RANGE,
    new Set(["ws-comcast", "ws-strategic"]),
    strategicMembers,
    undefined,
    strategicWorkspaces,
  );

  assert.equal(result.totalSpendUsd, 2246, "total spend is conserved");
  assert.equal(
    result.byGroup.get("strategic-lift-admin")?.byUser.get("katie"),
    207,
    "Katie's Strategic Development spend follows her LIFT Labs Admin membership",
  );
  assert.equal(
    result.byGroup.get("strategic-lift-member")?.byUser.get("denise"),
    1900,
    "Denise's Strategic Development spend follows her LIFT Labs Member membership",
  );
  assert.equal(
    result.byGroup.get("strategic-lift-member")?.byUser.get("allison"),
    139,
    "Allison's Strategic Development spend follows her LIFT Labs Member membership",
  );
  assert.equal(
    result.ungroupedByWorkspace.get("ws-strategic")?.spendUsd ?? 0,
    0,
    "no matched LIFT Labs spend remains unattributed",
  );
  assert.equal(result.byGroup.get("strategic-mosaic-admin")?.spendUsd, 0);
  assert.equal(result.byGroup.get("strategic-mosaic-member")?.spendUsd, 0);
  assert.equal(
    result.byGroup.get("strategic-preprod")?.spendUsd,
    0,
    "incidental PREPROD membership does not override explicit LIFT Labs ownership",
  );

  const canonical = getCanonicalUsage(
    strategicGroups,
    RANGE,
    new Set(["ws-comcast", "ws-strategic"]),
    strategicMembers,
    undefined,
    undefined,
    strategicWorkspaces,
  );
  assert.equal(
    canonical.byGroup.get("strategic-lift-admin")?.byUser.get("katie"),
    207,
    "canonical group detail retains Katie's full parent-workspace spend",
  );
  assert.equal(
    canonical.byGroup.get("strategic-lift-member")?.byUser.get("denise"),
    1900,
    "canonical group detail retains Denise's full parent-workspace spend",
  );
  assert.equal(
    canonical.byGroup.get("strategic-lift-member")?.byUser.get("allison"),
    139,
    "canonical group detail retains Allison's full parent-workspace spend",
  );
});

// ---------------------------------------------------------------------------
// Test 6b: Workspace admins are attributed to the matching Comcast group
//   even without explicit group membership.
// ---------------------------------------------------------------------------
test("workspace admin of extra workspace is attributed to the matching Comcast group", () => {
  // denise is an ADMIN of ws-lift-labs but has no Comcast group membership.
  // carol is a regular MEMBER of ws-lift-labs — stays ungrouped.
  const liftAdmin = { id: "lift-admin", workspaceId: "ws-comcast", name: "AZ-Replit – Freewheel – Admin", type: "custom" };
  const liftMember = { id: "lift-member", workspaceId: "ws-comcast", name: "AZ-Replit – Freewheel – Member", type: "custom" };
  const wsLift = new Map([
    ["ws-comcast",   { name: "Comcast" }],
    ["ws-lift-labs", { name: "Freewheel" }],   // maps to Freewheel Comcast groups
  ]);

  const denise = {
    userId: "denise", username: "denise", email: "d@x.com", name: "denise",
    isAccountAdmin: false,
    workspaces: new Map([
      ["ws-comcast",   { role: "member", isDisabled: false }],
      ["ws-lift-labs", { role: "admin",  isDisabled: false }],
    ]),
  };
  const carol = {
    userId: "carol", username: "carol", email: "c@x.com", name: "carol",
    isAccountAdmin: false,
    workspaces: new Map([
      ["ws-lift-labs", { role: "member", isDisabled: false }],
    ]),
  };

  const groups2 = [liftAdmin, liftMember];
  const gm2 = new Map([["lift-admin", []], ["lift-member", []]]);   // no explicit members

  __setWsSpendForTests("ws-comcast",   RANGE, new Map([["denise", 0]]));   // denise in Comcast, $0
  __setWsSpendForTests("ws-lift-labs", RANGE, new Map([["denise", 60], ["carol", 30]]));
  __setMemberUsageForTests("lift-admin",  RANGE, new Map());
  __setMemberUsageForTests("lift-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    groups2,
    RANGE,
    new Set(["ws-comcast", "ws-lift-labs"]),
    gm2,
    new Map([["denise", denise], ["carol", carol]]),
    wsLift,
  );

  assert.equal(result.totalSpendUsd, 90, "total conserved");

  // Denise (workspace admin of ws-lift-labs) → lift-admin group
  assert.equal(result.byGroup.get("lift-admin")?.spendUsd, 60, "admin spend in Comcast group");
  assert.equal(result.byGroup.get("lift-admin")?.byUser.get("denise"), 60);

  // Carol (regular member of ws-lift-labs) → ungrouped
  assert.equal(result.ungroupedByWorkspace.get("ws-lift-labs")?.byUser.get("carol"), 30,
    "regular member spend stays ungrouped");

  // Denise must NOT appear in ungrouped
  assert.equal(result.ungroupedByWorkspace.get("ws-lift-labs")?.byUser.has("denise"), false,
    "admin not in ungrouped");
});

test("workspace admin spend accumulates correctly when appearing in both Comcast and extra workspaces", () => {
  // denise: admin of ws-lift-labs (→ Freewheel Comcast group)
  //   Comcast WS spend $20  +  LIFT Labs WS spend $40  =  $60 total in lift-admin
  const liftAdmin = { id: "lift-admin", workspaceId: "ws-comcast", name: "AZ-Replit – Freewheel – Admin", type: "custom" };
  const wsLift = new Map([
    ["ws-comcast",   { name: "Comcast" }],
    ["ws-lift-labs", { name: "Freewheel" }],
  ]);
  const denise = {
    userId: "denise", username: "denise", email: "d@x.com", name: "denise",
    isAccountAdmin: false,
    workspaces: new Map([
      ["ws-comcast",   { role: "member", isDisabled: false }],
      ["ws-lift-labs", { role: "admin",  isDisabled: false }],
    ]),
  };

  const groups3 = [liftAdmin];
  const gm3 = new Map([["lift-admin", []]]);

  __setWsSpendForTests("ws-comcast",   RANGE, new Map([["denise", 20]]));
  __setWsSpendForTests("ws-lift-labs", RANGE, new Map([["denise", 40]]));
  __setMemberUsageForTests("lift-admin", RANGE, new Map([["denise", 20]]));

  const result = getDedupedUsageRollup(
    groups3,
    RANGE,
    new Set(["ws-comcast", "ws-lift-labs"]),
    gm3,
    new Map([["denise", denise]]),
    wsLift,
  );

  assert.equal(result.totalSpendUsd, 60, "total conserved");
  // Comcast spend ($20) + LIFT Labs spend ($40) both land in lift-admin
  assert.equal(result.byGroup.get("lift-admin")?.spendUsd, 60,
    "Comcast and extra-WS spend accumulate in admin group");
  assert.equal(result.byGroup.get("lift-admin")?.byUser.get("denise"), 60);
  assert.equal(result.byGroup.get("lift-admin")?.memberCount, 1, "denise counted once");
  assert.equal(result.ungroupedByWorkspace.size, 0, "nothing ungrouped");
  assert.equal(result.byUser.get("denise"), 60, "global byUser correct");
});

// ---------------------------------------------------------------------------
// Test 6c: Workspace admin in an extra workspace that ALSO has custom groups
//   Admin has no explicit Comcast group membership. The extra workspace has its
//   own custom group (e.g. an unrelated engineering team). The admin's spend
//   from the extra workspace and from the Comcast workspace must both accumulate
//   in the matching Comcast group regardless of the custom group's presence.
// ---------------------------------------------------------------------------
test("workspace admin in extra workspace with custom groups: both WS amounts accumulate in Comcast group", () => {
  // Freewheel workspace has its own custom group "fw-custom".
  // Alice is an admin of the Freewheel workspace, NOT a member of fw-custom.
  // She IS a member of "fw-comcast-admin" (via Comcast workspace).
  // Wait — actually the review says she has no explicit Comcast group membership either.
  // So: Alice is an admin of ws-fw, NOT in any groupMembers list.
  const fwComcastAdmin = {
    id: "fw-comcast-admin", workspaceId: "ws-comcast",
    name: "AZ-Replit – Freewheel – Admin", type: "custom",
  };
  const fwCustomGroup = {
    id: "fw-custom", workspaceId: "ws-fw",
    name: "Freewheel Engineering", type: "custom",
  };

  const wsWithCustom = new Map([
    ["ws-comcast", { name: "Comcast" }],
    ["ws-fw",      { name: "Freewheel" }],
  ]);

  const alice = {
    userId: "alice", username: "alice", email: "a@x.com", name: "alice",
    isAccountAdmin: false,
    workspaces: new Map([
      ["ws-comcast", { role: "member", isDisabled: false }],
      ["ws-fw",      { role: "admin",  isDisabled: false }],
    ]),
  };
  const bob = {
    userId: "bob", username: "bob", email: "b@x.com", name: "bob",
    isAccountAdmin: false,
    workspaces: new Map([
      ["ws-fw", { role: "member", isDisabled: false }],
    ]),
  };

  const groups5 = [fwComcastAdmin, fwCustomGroup];
  // bob is a member of the custom group; alice is NOT in any group
  const gm5 = new Map([
    ["fw-comcast-admin", []],
    ["fw-custom",        ["bob"]],
  ]);

  __setWsSpendForTests("ws-comcast", RANGE, new Map([["alice", 20]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map([["alice", 40], ["bob", 10]]));
  __setMemberUsageForTests("fw-comcast-admin", RANGE, new Map());
  __setMemberUsageForTests("fw-custom",        RANGE, new Map([["bob", 5]]));

  const result = getDedupedUsageRollup(
    groups5,
    RANGE,
    new Set(["ws-comcast", "ws-fw"]),
    gm5,
    new Map([["alice", alice], ["bob", bob]]),
    wsWithCustom,
  );

  assert.equal(result.totalSpendUsd, 70, "total conserved");

  // Alice: fw-ws ($40) + comcast ($20) both land in fw-comcast-admin
  assert.equal(result.byGroup.get("fw-comcast-admin")?.spendUsd, 60,
    "alice: fw + comcast spend in fw-comcast-admin");
  assert.equal(result.byGroup.get("fw-comcast-admin")?.byUser.get("alice"), 60,
    "alice byUser in fw-comcast-admin");
  assert.equal(result.byGroup.get("fw-comcast-admin")?.memberCount, 1, "alice counted once");

  // Alice must NOT appear in ungrouped (bucket may be absent entirely if all users are attributed)
  assert.equal(result.ungroupedByWorkspace.get("ws-fw")?.byUser.has("alice") ?? false, false,
    "alice not in ungrouped");

  // Bob is in fw-custom (regular member)
  assert.equal(result.byGroup.get("fw-custom")?.spendUsd, 10,
    "bob in fw-custom");
  assert.equal(result.byGroup.get("fw-custom")?.byUser.get("bob"), 10);

  // Clean up
  __setWsSpendForTests("ws-comcast", RANGE, null);
  __setWsSpendForTests("ws-fw",      RANGE, null);
  __setMemberUsageForTests("fw-comcast-admin", RANGE, null);
  __setMemberUsageForTests("fw-custom",        RANGE, null);
});

// ---------------------------------------------------------------------------
// Test 7: No workspaces map → no Comcast re-attribution (backward compat)
// ---------------------------------------------------------------------------
test("extra-workspace spend stays in ungrouped when no workspaces map is provided", () => {
  __setWsSpendForTests("ws-comcast", RANGE, new Map([["dave", 20]]));
  __setWsSpendForTests("ws-fw",      RANGE, new Map([["dave", 40]]));
  __setWsSpendForTests("ws-tl",      RANGE, new Map());
  __setMemberUsageForTests("fw-admin",  RANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("fw-member", RANGE, new Map());
  __setMemberUsageForTests("tl-admin",  RANGE, new Map());
  __setMemberUsageForTests("tl-member", RANGE, new Map());

  const result = getDedupedUsageRollup(
    allGroups,
    RANGE,
    new Set(["ws-comcast", "ws-fw", "ws-tl"]),
    groupMembers,
    undefined,
    // No workspaces parameter → backward-compat: no Comcast re-attribution
  );

  // Dave's Freewheel spend stays ungrouped (old behavior)
  assert.equal(result.ungroupedByWorkspace.has("ws-fw"), true);
  assert.equal(result.ungroupedByWorkspace.get("ws-fw")?.byUser.get("dave"), 40);
  // fw-admin holds Comcast spend
  assert.equal(result.byGroup.get("fw-admin")?.spendUsd, 20);
  assert.equal(result.totalSpendUsd, 60);
});

// ---------------------------------------------------------------------------
// Canonical attribution: re-homed user with non-AI project spend
//   dave: in fw-admin (Comcast), primary WS = ws-tl (higher spend).
//   Comcast spend ($20) re-homed to tl-admin.
//   dave is also the creator of a project whose non-AI spend ($30) should
//   follow canonical ownership into tl-admin, not stay in the zero-capacity
//   fw-admin.
// ---------------------------------------------------------------------------
test("canonical non-AI project spend follows rollup ownership after Comcast re-homing", () => {
  const CRANGE = "custom:comcast-canonical-nonai";
  const wsId = "ws-comcast-canon";
  const fwWsId = "ws-fw-canon";
  const tlWsId = "ws-tl-canon";

  const fwGrp = { id: "fw-admin-canon", workspaceId: wsId, name: "AZ-Replit – Freewheel – Admin",       type: "custom" };
  const tlGrp = { id: "tl-admin-canon", workspaceId: wsId, name: "AZ-Replit – Talent Learning – Admin", type: "custom" };

  const wsMap2 = new Map([
    [wsId,   { name: "Comcast" }],
    [fwWsId, { name: "Freewheel" }],
    [tlWsId, { name: "Talent Learning" }],
  ]);
  const gm = new Map([["fw-admin-canon", ["dave"]], ["tl-admin-canon", []]]);

  // Comcast: dave $20 (AI). Extra: FW $10, TL $40.
  __setWsSpendForTests(wsId,   CRANGE, new Map([["dave", 20]]));
  __setWsSpendForTests(fwWsId, CRANGE, new Map([["dave", 10]]));
  __setWsSpendForTests(tlWsId, CRANGE, new Map([["dave", 40]]));

  // Per-group AI spend from Comcast API
  __setMemberUsageForTests("fw-admin-canon", CRANGE, new Map([["dave", 20]]));
  __setMemberUsageForTests("tl-admin-canon", CRANGE, new Map());

  // Project: dave created "proj-a" with $30 non-AI spend, tracked under fw-admin
  __setProjectUsageForTests("fw-admin-canon", CRANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 20,
    byProject: new Map([["proj-a", { projectId: "proj-a", totalCostUsd: 20, metrics: [] }]]),
  });
  __setProjectUsageForTests("tl-admin-canon", CRANGE, {
    fetchedAt: Date.now(),
    totalCostUsd: 30,
    byProject: new Map([["proj-a", { projectId: "proj-a", totalCostUsd: 30, metrics: [] }]]),
  });
  __setProjectInfoForTests(wsId, new Map([["proj-a", { title: "Proj A", creatorId: "dave" }]]));

  const canonical = getCanonicalUsage(
    [fwGrp, tlGrp],
    CRANGE,
    new Set([wsId, fwWsId, tlWsId]),
    gm,
    undefined,
    undefined,
    wsMap2,
  );

  // After re-homing: fw-admin-canon.spendUsd = 0, tl-admin-canon.spendUsd = 20 (Comcast spend)
  // dave's canonical owner = tl-admin-canon (rollup says so)
  // AI spend: min(20, capacity_tl) = 20 → byUser[dave] ≥ 20
  const tlByUser = canonical.byGroup.get("tl-admin-canon")?.byUser;
  assert.ok(tlByUser?.has("dave"), "dave attributed to tl-admin-canon in canonical byUser");
  const fwByUser = canonical.byGroup.get("fw-admin-canon")?.byUser;
  assert.equal(fwByUser?.has("dave") ?? false, false,
    "dave not in fw-admin-canon after re-homing");

  // Non-AI: project winner is tl-admin (higher project total). dave is creator.
  // canonical non-AI owner = tl-admin (rollup-first). Amount lands in tl-admin.
  const daveTlSpend = canonical.byGroup.get("tl-admin-canon")?.byUser.get("dave") ?? 0;
  assert.ok(daveTlSpend > 0, `tl-admin-canon has dave's spend (${daveTlSpend})`);

  // Totals must be conserved
  const totalAttributed = [...canonical.byUser.values()].reduce((s, v) => s + v, 0);
  assert.ok(
    Math.abs(totalAttributed + canonical.residualSpendUsd - canonical.totalSpendUsd) < 1e-6,
    "canonical totals conserved",
  );

  // Clean up
  __setWsSpendForTests(wsId,   CRANGE, null);
  __setWsSpendForTests(fwWsId, CRANGE, null);
  __setWsSpendForTests(tlWsId, CRANGE, null);
  __setMemberUsageForTests("fw-admin-canon", CRANGE, null);
  __setMemberUsageForTests("tl-admin-canon", CRANGE, null);
  __setProjectUsageForTests("fw-admin-canon", CRANGE, null);
  __setProjectUsageForTests("tl-admin-canon", CRANGE, null);
  __setProjectInfoForTests(wsId, null);
});

// ---------------------------------------------------------------------------
// memberCount: zero-first-contribution regression
//   Workspace admin has Comcast $0 spend then extra-workspace $60 spend.
//   They should be counted exactly once in memberCount.
// ---------------------------------------------------------------------------
test("memberCount is not double-incremented when first Comcast contribution is $0", () => {
  const liftA = { id: "lift-admin-mc", workspaceId: "ws-comcast", name: "AZ-Replit – LIFT Labs – Admin",  type: "custom" };
  const wsLiftMc = new Map([
    ["ws-comcast",    { name: "Comcast" }],
    ["ws-lift-mc",    { name: "LIFT Labs" }],
  ]);
  const deniseMc = {
    userId: "denise-mc", username: "d-mc", email: "d@mc.com", name: "d-mc",
    isAccountAdmin: false,
    workspaces: new Map([
      ["ws-comcast",  { role: "member", isDisabled: false }],
      ["ws-lift-mc",  { role: "admin",  isDisabled: false }],
    ]),
  };

  // Comcast: $0 for denise-mc (so her first target contribution is $0)
  __setWsSpendForTests("ws-comcast", "mc-range", new Map([["denise-mc", 0]]));
  // LIFT Labs: $60
  __setWsSpendForTests("ws-lift-mc", "mc-range", new Map([["denise-mc", 60]]));
  __setMemberUsageForTests("lift-admin-mc", "mc-range", new Map());

  const result = getDedupedUsageRollup(
    [liftA],
    "mc-range",
    new Set(["ws-comcast", "ws-lift-mc"]),
    new Map([["lift-admin-mc", []]]),
    new Map([["denise-mc", deniseMc]]),
    wsLiftMc,
  );

  assert.equal(result.byGroup.get("lift-admin-mc")?.memberCount, 1,
    "denise-mc counted exactly once despite $0 first contribution");
  assert.equal(result.byGroup.get("lift-admin-mc")?.spendUsd, 60, "spend = $60");

  // Clean up
  __setWsSpendForTests("ws-comcast", "mc-range", null);
  __setWsSpendForTests("ws-lift-mc", "mc-range", null);
  __setMemberUsageForTests("lift-admin-mc", "mc-range", null);
});
