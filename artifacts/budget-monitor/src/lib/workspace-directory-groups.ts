import type { DirectoryGroup } from '@workspace/api-client-react';

export interface DirectoryFamily {
  familyKey: string;
  familyName: string;
  isLegacy: boolean;
  groups: DirectoryGroup[];
}

export interface DirectoryTeam {
  teamName: string | null;
  families: DirectoryFamily[];
}

export interface DirectoryWorkspaceGroup {
  workspaceId: string;
  workspaceName: string;
  teams: DirectoryTeam[];
}

const alphabetical = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'base' });
const roleOrder: Record<string, number> = {
  admin: 0,
  member: 1,
  viewer: 2,
  guest: 3,
  unsuffixed: 4,
};

export function buildDirectoryHierarchy(
  groups: readonly DirectoryGroup[],
  options: { showLegacy?: boolean; search?: string } = {},
): DirectoryWorkspaceGroup[] {
  const query = options.search?.trim().toLocaleLowerCase() ?? '';
  const visible = groups.filter((group) => {
    if (!options.showLegacy && group.isLegacy) return false;
    return !query || [
      group.workspaceName,
      group.teamName,
      group.familyName,
      group.groupName,
      group.role,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
  const workspaces = new Map<string, DirectoryWorkspaceGroup>();

  for (const group of visible) {
    let workspace = workspaces.get(group.workspaceId);
    if (!workspace) {
      workspace = { workspaceId: group.workspaceId, workspaceName: group.workspaceName, teams: [] };
      workspaces.set(group.workspaceId, workspace);
    }
    let team = workspace.teams.find((item) => item.teamName === group.teamName);
    if (!team) {
      team = { teamName: group.teamName, families: [] };
      workspace.teams.push(team);
    }
    let family = team.families.find((item) => item.familyKey === group.familyKey);
    if (!family) {
      family = {
        familyKey: group.familyKey,
        familyName: group.familyName,
        isLegacy: group.isLegacy,
        groups: [],
      };
      team.families.push(family);
    }
    family.groups.push(group);
  }

  return [...workspaces.values()]
    .map((workspace) => ({
      ...workspace,
      teams: workspace.teams
        .map((team) => ({
          ...team,
          families: team.families
            .map((family) => ({
              ...family,
              groups: [...family.groups].sort(
                (a, b) =>
                  (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99) ||
                  alphabetical(a.groupName, b.groupName),
              ),
            }))
            .sort((a, b) => alphabetical(a.familyName, b.familyName) || alphabetical(a.familyKey, b.familyKey)),
        }))
        .sort((a, b) => alphabetical(a.teamName ?? 'Unassigned', b.teamName ?? 'Unassigned')),
    }))
    .sort((a, b) => alphabetical(a.workspaceName, b.workspaceName) || alphabetical(a.workspaceId, b.workspaceId));
}