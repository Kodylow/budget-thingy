import assert from "node:assert/strict";
import test from "node:test";

import { groupDirectoryByWorkspace } from "./workspace-directory-groups.ts";

test("groups directory rows by workspace and sorts workspace and group names", () => {
  const result = groupDirectoryByWorkspace([
    { groupId: "g3", groupName: "Zulu", workspaceId: "w2", workspaceName: "Beta" },
    { groupId: "g2", groupName: "bravo", workspaceId: "w1", workspaceName: "alpha" },
    { groupId: "g1", groupName: "Alpha", workspaceId: "w1", workspaceName: "alpha" },
  ]);

  assert.deepEqual(
    result.map((workspace) => ({
      name: workspace.workspaceName,
      groups: workspace.groups.map((group) => group.groupName),
    })),
    [
      { name: "alpha", groups: ["Alpha", "bravo"] },
      { name: "Beta", groups: ["Zulu"] },
    ],
  );
});

test("grouping does not mutate API response order", () => {
  const groups = [
    { groupId: "g2", groupName: "Zulu", workspaceId: "w1", workspaceName: "Alpha" },
    { groupId: "g1", groupName: "Alpha", workspaceId: "w1", workspaceName: "Alpha" },
  ];
  groupDirectoryByWorkspace(groups);
  assert.deepEqual(groups.map((group) => group.groupId), ["g2", "g1"]);
});