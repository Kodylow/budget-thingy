import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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

test("groups table exposes loading, empty, unavailable, and count states", async () => {
  const source = await readFile(new URL("../pages/workspace-directory.tsx", import.meta.url), "utf8");
  assert.match(source, /groupsLoading/);
  assert.match(source, /No groups found\./);
  assert.match(source, /No groups match that search\./);
  assert.match(source, /Group directory is currently unavailable\./);
  assert.match(source, /directory-group-counts/);
});

test("groups tab can search by group or workspace name", async () => {
  const source = await readFile(new URL("../pages/workspace-directory.tsx", import.meta.url), "utf8");
  assert.match(source, /directory-groups-search/);
  assert.match(source, /Search groups or workspaces/);
  assert.match(source, /group\.groupName\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(source, /group\.workspaceName\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(source, /filteredDirectoryGroups\.length/);
});

test("workspace directory switches between Groups and Members views", async () => {
  const source = await readFile(new URL("../pages/workspace-directory.tsx", import.meta.url), "utf8");
  assert.match(source, /<Tabs defaultValue="members"/);
  assert.match(source, /directory-tab-groups/);
  assert.match(source, /directory-tab-members/);
  assert.ok(
    source.indexOf('directory-tab-members') < source.indexOf('directory-tab-groups'),
    "Members tab should appear before Groups",
  );
  assert.match(source, /<TabsContent value="groups">/);
  assert.match(source, /<TabsContent value="members">/);
});

test("each workspace can be expanded and collapsed independently", async () => {
  const source = await readFile(new URL("../pages/workspace-directory.tsx", import.meta.url), "utf8");
  assert.match(source, /collapsedWorkspaceIds/);
  assert.match(source, /toggleWorkspace/);
  assert.match(source, /aria-expanded=\{isExpanded\}/);
  assert.match(source, /directory-workspace-toggle-/);
  assert.match(source, /isExpanded && workspace\.groups\.map/);
});