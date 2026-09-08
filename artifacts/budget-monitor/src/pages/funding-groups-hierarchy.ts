export type FundingGroupOrigin = 'inferred' | 'explicit' | 'unmapped';

export type FundingGroup = {
  workspaceId: string;
  workspaceName: string;
  groupId: string;
  groupName: string;
  teamName: string | null;
  origin: FundingGroupOrigin;
  isHidden: boolean;
};

export type FundingGroupInventory = {
  revision: string;
  groups: FundingGroup[];
  teams: Array<{ teamName: string; isHidden: boolean }>;
  freshness: {
    status: string;
    dataAsOf: string | null;
    error: string | null;
  };
};

export const fundingGroupKey = (group: Pick<FundingGroup, 'workspaceId' | 'groupId'>) =>
  `${group.workspaceId}:${group.groupId}`;

export function matchesFundingGroupSearch(group: FundingGroup, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [group.teamName, group.workspaceName, group.groupName]
    .some(label => label?.toLocaleLowerCase().includes(normalized));
}

export function buildFundingHierarchy(
  groups: FundingGroup[],
  visibleTeamNames: string[],
  query: string,
  includeHidden = false,
) {
  const visibleTeams = new Set(visibleTeamNames);
  const matched = groups.filter(group =>
    (includeHidden || !group.isHidden) &&
    matchesFundingGroupSearch(group, query) &&
    (group.teamName === null || visibleTeams.has(group.teamName)));

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const byTeam = new Map(visibleTeamNames.map(teamName => [
    teamName,
    matched.filter(group => group.teamName === teamName),
  ]));
  const teams = visibleTeamNames.filter(teamName =>
    !normalizedQuery
    || teamName.toLocaleLowerCase().includes(normalizedQuery)
    || (byTeam.get(teamName)?.length ?? 0) > 0);

  return {
    unmapped: matched.filter(group => group.teamName === null),
    teams,
    byTeam,
  };
}