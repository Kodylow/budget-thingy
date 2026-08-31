import assert from "node:assert/strict";
import test from "node:test";
import { buildGroupClusters, sumAttributedRollup } from "./group-clusters.ts";

const base = {
  workspaceId: "ws",
  workspaceName: "Workspace",
  teamName: "Team",
  memberCount: 2,
  spendLoaded: true,
  spendUsd: 60,
  rollupSpendLoaded: true,
};

const roleGroups = [
  {
    ...base,
    groupId: "admin",
    name: "Project - Admin",
    rollupMemberCount: 2,
    rollupSpendUsd: 50,
  },
  {
    ...base,
    groupId: "member",
    name: "Project - Member",
    rollupMemberCount: 1,
    rollupSpendUsd: 20,
  },
];

test("team/footer rollup uses attributed values instead of inflated raw group totals", () => {
  const total = sumAttributedRollup(roleGroups);
  assert.deepEqual(total, { memberCount: 3, spendUsd: 70, spendLoaded: true });
  assert.notEqual(total.spendUsd, roleGroups.reduce((sum, group) => sum + group.spendUsd, 0));
});

test("collapsed role cluster agrees with the attributed team/footer rollup", () => {
  const [cluster] = buildGroupClusters(roleGroups);
  const total = sumAttributedRollup(roleGroups);
  assert.equal(cluster.isSingleGroup, false);
  assert.equal(cluster.memberCount, total.memberCount);
  assert.equal(cluster.spendUsd, total.spendUsd);
  assert.equal(cluster.spendLoaded, true);
});

test("standalone team group preserves project spend instead of raw member spend", () => {
  const [group] = buildGroupClusters([{
    ...base,
    groupId: "standalone",
    name: "Standalone Group",
    spendUsd: 42,
    rawMemberSpendUsd: 99,
    rawMemberSpendLoaded: true,
  }]);

  assert.equal(group.isSingleGroup, true);
  assert.equal(group.spendUsd, 42);
  assert.equal(group.spendLoaded, true);
});

test("attributed totals remain pending until every member rollup is loaded", () => {
  const total = sumAttributedRollup([
    roleGroups[0],
    { ...roleGroups[1], rollupSpendLoaded: false, rollupSpendUsd: 12 },
  ]);
  assert.equal(total.spendLoaded, false);
  assert.equal(total.spendUsd, 62);
});

test("dashboard rows group by workspace, then sort by group name", () => {
  const rows = buildGroupClusters([
    { ...base, groupId: "zebra-a", name: "Zebra", workspaceId: "a", workspaceName: "Alpha" },
    { ...base, groupId: "alpha-b", name: "Alpha", workspaceId: "b", workspaceName: "Beta" },
    { ...base, groupId: "alpha-a", name: "Alpha", workspaceId: "a", workspaceName: "Alpha" },
  ]);

  assert.deepEqual(
    rows.map((row) => [row.workspaceName, row.baseName]),
    [
      ["Alpha", "Alpha"],
      ["Alpha", "Zebra"],
      ["Beta", "Alpha"],
    ],
  );
});