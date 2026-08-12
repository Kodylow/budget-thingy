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