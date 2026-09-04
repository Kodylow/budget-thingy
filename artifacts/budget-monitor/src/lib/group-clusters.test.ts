// @ts-nocheck
import { test, expect } from "vitest";
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
  expect(total).toEqual({ memberCount: 3, spendUsd: 70, spendLoaded: true });
  expect(total.spendUsd).not.toBe(roleGroups.reduce((sum, group) => sum + group.spendUsd, 0));
});

test("collapsed role cluster agrees with the attributed team/footer rollup", () => {
  const [cluster] = buildGroupClusters(roleGroups);
  const total = sumAttributedRollup(roleGroups);
  expect(cluster.isSingleGroup).toBe(false);
  expect(cluster.memberCount).toBe(total.memberCount);
  expect(cluster.spendUsd).toBe(total.spendUsd);
  expect(cluster.spendLoaded).toBe(true);
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

  expect(group.isSingleGroup).toBe(true);
  expect(group.spendUsd).toBe(42);
  expect(group.spendLoaded).toBe(true);
});

test("attributed totals remain pending until every member rollup is loaded", () => {
  const total = sumAttributedRollup([
    roleGroups[0],
    { ...roleGroups[1], rollupSpendLoaded: false, rollupSpendUsd: 12 },
  ]);
  expect(total.spendLoaded).toBe(false);
  expect(total.spendUsd).toBe(62);
});

test("logical preview scopes combine role siblings but preserve standalone groups", () => {
  const scopes = buildLogicalGroupScopes([
    ...roleGroups,
    { ...base, groupId: "viewer", name: "Project - Viewer" },
    { ...base, groupId: "standalone", name: "Standalone" },
  ]);

  expect(scopes.map((scope) => ({
    displayName: scope.displayName,
    groupIds: scope.groupIds,
  }))).toEqual([
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

  expect(scopes.length).toBe(2);
  expect(scopes.map((scope) => scope.displayName)).toEqual([
    "Project · Other",
    "Project · Workspace",
  ]);
  expect(scopes.map((scope) => scope.groupIds)).toEqual([
    ["other-admin", "other-member"],
    ["admin", "member"],
  ]);
});

test("a lone role-suffixed group remains a standalone preview choice", () => {
  const [scope] = buildLogicalGroupScopes([roleGroups[0]]);
  expect(scope.scopeId).toBe("admin");
  expect(scope.displayName).toBe("Project - Admin");
  expect(scope.groupIds).toEqual(["admin"]);
});