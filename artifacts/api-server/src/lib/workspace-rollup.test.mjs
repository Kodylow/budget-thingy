import assert from "node:assert/strict";
import test from "node:test";

import {
  __setMemberUsageForTests,
  __setWsSpendForTests,
  getDedupedUsageRollup,
} from "./enterprise.ts";

const RANGE = "custom:workspace-rollup-unit";
const groups = [
  { id: "beta", workspaceId: "ws-main", name: "Beta", type: "custom" },
  { id: "alpha", workspaceId: "ws-main", name: "Alpha", type: "custom" },
];
const groupMembers = new Map([
  ["alpha", ["shared"]],
  ["beta", ["shared"]],
]);
const directoryMembers = new Map([
  ["shared", {
    userId: "shared",
    username: "shared",
    email: "shared@example.com",
    name: "Shared",
    isAccountAdmin: false,
    workspaces: new Map([
      ["ws-main", { role: "member", isDisabled: false }],
      ["ws-extra", { role: "member", isDisabled: false }],
    ]),
  }],
  ["ungrouped", {
    userId: "ungrouped",
    username: "ungrouped",
    email: "ungrouped@example.com",
    name: "Ungrouped",
    isAccountAdmin: false,
    workspaces: new Map([["ws-main", { role: "member", isDisabled: false }]]),
  }],
]);

test.after(() => {
  __setMemberUsageForTests("alpha", RANGE, null);
  __setMemberUsageForTests("beta", RANGE, null);
  __setWsSpendForTests("ws-main", RANGE, null);
  __setWsSpendForTests("ws-extra", RANGE, null);
});

test("uses exact workspace-user identity and retains synthetic workspace usage", () => {
  // Serialized group observations drift, but the complete workspace payload is
  // authoritative for the one (ws-main, shared) observation.
  __setMemberUsageForTests("alpha", RANGE, new Map([["shared", 30]]));
  __setMemberUsageForTests("beta", RANGE, new Map([["shared", 20]]));
  __setWsSpendForTests(
    "ws-main",
    RANGE,
    new Map([["shared", 35], ["ungrouped", 7]]),
    { unattributableTotalCostUsd: 3 },
  );
  // The equal $35 value in another workspace is a distinct observation.
  __setWsSpendForTests("ws-extra", RANGE, new Map([["shared", 35]]));

  const result = getDedupedUsageRollup(
    groups,
    RANGE,
    new Set(["ws-main", "ws-extra"]),
    groupMembers,
    directoryMembers,
  );

  assert.equal(result.isComplete, true);
  assert.equal(result.totalSpendUsd, 80);
  assert.deepEqual(result.byGroup.get("alpha")?.byUser, new Map([["shared", 35]]));
  assert.equal(result.byGroup.get("beta")?.spendUsd, 0);
  assert.deepEqual(result.ungroupedByWorkspace.get("ws-main"), {
    spendUsd: 10,
    memberCount: 1,
    byUser: new Map([["ungrouped", 7]]),
  });
  assert.deepEqual(result.ungroupedByWorkspace.get("ws-extra"), {
    spendUsd: 35,
    memberCount: 1,
    byUser: new Map([["shared", 35]]),
  });
});