import type { DirectoryGroup } from '@workspace/api-client-react';

export interface DirectoryWorkspaceGroup {
  workspaceId: string;
  workspaceName: string;
  groups: DirectoryGroup[];
}

const alphabetical = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'base' });

export function groupDirectoryByWorkspace(
  groups: readonly DirectoryGroup[],
): DirectoryWorkspaceGroup[] {
  const byWorkspace = new Map<string, DirectoryWorkspaceGroup>();

  for (const group of groups) {
    const existing = byWorkspace.get(group.workspaceId);
    if (existing) {
      existing.groups.push(group);
    } else {
      byWorkspace.set(group.workspaceId, {
        workspaceId: group.workspaceId,
        workspaceName: group.workspaceName,
        groups: [group],
      });
    }
  }

  return [...byWorkspace.values()]
    .map((workspace) => ({
      ...workspace,
      groups: [...workspace.groups].sort(
        (a, b) => alphabetical(a.groupName, b.groupName) || alphabetical(a.groupId, b.groupId),
      ),
    }))
    .sort(
      (a, b) =>
        alphabetical(a.workspaceName, b.workspaceName) ||
        alphabetical(a.workspaceId, b.workspaceId),
    );
}