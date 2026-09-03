import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGroupClusters,
  buildLogicalGroupScopes,
  sumAttributedRollup,
} from "./group-clusters.ts";

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

test("logical preview scopes combine role siblings but preserve standalone groups", () => {
  const scopes = buildLogicalGroupScopes([
    ...roleGroups,
    { ...base, groupId: "viewer", name: "Project - Viewer" },
    { ...base, groupId: "standalone", name: "Standalone" },
  ]);

  assert.deepEqual(scopes.map((scope) => ({
    displayName: scope.displayName,
    groupIds: scope.groupIds,
  })), [
    {
      displayName: "Project",
      groupIds: ["admin", "member", "viewer"],
    },
    {
      displayName: "Standalone",
      groupIds: ["standalone"],
    },
  ]);
});

test("logical preview scopes never combine same-name families across workspaces", () => {
  const scopes = buildLogicalGroupScopes([
    ...roleGroups,
    { ...roleGroups[0], workspaceId: "other", workspaceName: "Other", groupId: "other-admin" },
    { ...roleGroups[1], workspaceId: "other", workspaceName: "Other", groupId: "other-member" },
  ]);

  assert.equal(scopes.length, 2);
  assert.deepEqual(scopes.map((scope) => scope.displayName), [
    "Project · Other",
    "Project · Workspace",
  ]);
  assert.deepEqual(scopes.map((scope) => scope.groupIds), [
    ["other-admin", "other-member"],
    ["admin", "member"],
  ]);
});

test("a lone role-suffixed group remains a standalone preview choice", () => {
  const [scope] = buildLogicalGroupScopes([roleGroups[0]]);
  assert.equal(scope.scopeId, "admin");
  assert.equal(scope.displayName, "Project - Admin");
  assert.deepEqual(scope.groupIds, ["admin"]);
});