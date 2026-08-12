import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDedupedMemberCounts,
  computeDedupedUsageRollup,
} from "./usage-rollup.ts";

const groups = [
  { id: "z-group", workspaceId: "workspace-1", name: "Zeta" },
  { id: "a-group", workspaceId: "workspace-1", name: "Alpha" },
];

test("counts overlapping members once using deterministic first-group attribution", () => {
  const result = computeDedupedUsageRollup(
    groups,
    new Map([
      ["z-group", { byUser: new Map([["shared", 12], ["z-only", 8]]) }],
      ["a-group", { byUser: new Map([["shared", 12], ["a-only", 5]]) }],
    ]),
  );

  assert.equal(result.totalSpendUsd, 25);
  assert.equal(result.totalMemberCount, 3);
  assert.deepEqual(result.byGroup.get("a-group"), {
    spendUsd: 17,
    memberCount: 2,
    byUser: new Map([["shared", 12], ["a-only", 5]]),
  });
  assert.deepEqual(result.byGroup.get("z-group"), {
    spendUsd: 8,
    memberCount: 1,
    byUser: new Map([["z-only", 8]]),
  });
  assert.equal(result.isComplete, true);
});

test("is independent of the incoming group order", () => {
  const usage = new Map([
    ["z-group", { byUser: new Map([["shared", 12]]) }],
    ["a-group", { byUser: new Map([["shared", 12]]) }],
  ]);

  const forward = computeDedupedUsageRollup(groups, usage);
  const reversed = computeDedupedUsageRollup([...groups].reverse(), usage);

  assert.deepEqual([...forward.byGroup], [...reversed.byGroup]);
  assert.equal(forward.totalSpendUsd, reversed.totalSpendUsd);
});

test("reports incomplete member usage without treating missing groups as loaded", () => {
  const result = computeDedupedUsageRollup(
    groups,
    new Map([["a-group", { byUser: new Map([["a-only", 5]]) }]]),
  );

  assert.equal(result.pendingCount, 1);
  assert.equal(result.isComplete, false);
  assert.deepEqual(result.byGroup.get("z-group"), { spendUsd: 0, memberCount: 0, byUser: new Map() });
});

test("deduplicates overlapping users even when their groups roll up to different teams", () => {
  const result = computeDedupedUsageRollup(
    [
      { id: "team-b-group", workspaceId: "workspace-1", name: "Beta" },
      { id: "team-a-group", workspaceId: "workspace-1", name: "Alpha" },
    ],
    new Map([
      ["team-a-group", { byUser: new Map([["shared", 40], ["a-only", 10]]) }],
      ["team-b-group", { byUser: new Map([["shared", 40], ["b-only", 20]]) }],
    ]),
  );

  const teamA = result.byGroup.get("team-a-group");
  const teamB = result.byGroup.get("team-b-group");
  assert.equal(result.totalSpendUsd, 70);
  assert.equal((teamA?.spendUsd ?? 0) + (teamB?.spendUsd ?? 0), result.totalSpendUsd);
  assert.deepEqual(teamA, {
    spendUsd: 50,
    memberCount: 2,
    byUser: new Map([["shared", 40], ["a-only", 10]]),
  });
  assert.deepEqual(teamB, {
    spendUsd: 20,
    memberCount: 1,
    byUser: new Map([["b-only", 20]]),
  });
});

test("retains per-group spend that cannot be attributed to a member", () => {
  const result = computeDedupedUsageRollup(
    groups,
    new Map([
      [
        "z-group",
        {
          byUser: new Map([["shared", 12], ["z-only", 8]]),
          unattributableTotalCostUsd: 3,
        },
      ],
      [
        "a-group",
        {
          byUser: new Map([["shared", 12], ["a-only", 5]]),
          unattributableTotalCostUsd: 3,
        },
      ],
    ]),
  );

  assert.equal(result.totalSpendUsd, 31);
  assert.deepEqual(result.byGroup.get("a-group"), {
    spendUsd: 20,
    memberCount: 2,
    byUser: new Map([["shared", 12], ["a-only", 5]]),
  });
  assert.deepEqual(result.byGroup.get("z-group"), {
    spendUsd: 11,
    memberCount: 1,
    byUser: new Map([["z-only", 8]]),
  });
});

test("counts directory members once even when they have no usage", () => {
  const counts = computeDedupedMemberCounts(
    groups,
    new Map([
      ["z-group", ["shared", "z-only", "zero-spend"]],
      ["a-group", ["shared", "a-only"]],
    ]),
  );

  assert.equal(counts.get("a-group"), 2);
  assert.equal(counts.get("z-group"), 2);
});