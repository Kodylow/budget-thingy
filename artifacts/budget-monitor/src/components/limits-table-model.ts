export type LiveLimitTargetType =
  | 'workspace_default_user_limit'
  | 'workspace_group_limit'
  | 'workspace_user_limit';

export type LiveLimitValueState = 'explicit' | 'inherited' | 'unavailable' | 'none';

export interface LiveLimitIdentity {
  workspaceId: string;
  type: LiveLimitTargetType;
  targetId: string;
}

export interface LiveLimitDraft extends LiveLimitIdentity {
  amountUsd: number | null;
}

export interface LimitsRosterMember {
  userId: string;
  groupIds: string[];
  eligible: boolean;
  isInternal: boolean;
  isDisabled: boolean;
}

export interface LimitsRosterGroup {
  groupId: string;
  name: string;
}

export interface LimitsRosterWorkspace<M extends LimitsRosterMember = LimitsRosterMember, G extends LimitsRosterGroup = LimitsRosterGroup> {
  workspaceId: string;
  workspaceName: string;
  groups: G[];
  members: M[];
  canWrite?: boolean;
  billingPeriod?: { start: string; end: string };
}

export interface LimitsFundingMapping {
  workspaceId: string;
  groupId: string;
  teamName: string | null;
}

export interface LimitsPersonRef<M extends LimitsRosterMember = LimitsRosterMember> {
  workspaceId: string;
  workspaceName: string;
  member: M;
  canWrite: boolean;
}

export interface LimitsGroupNode<M extends LimitsRosterMember = LimitsRosterMember, G extends LimitsRosterGroup = LimitsRosterGroup> {
  workspaceId: string;
  workspaceName: string;
  group: G;
  members: LimitsPersonRef<M>[];
  billingPeriod?: { start: string; end: string };
  canWrite: boolean;
}

export interface LimitsTeamNode<M extends LimitsRosterMember = LimitsRosterMember, G extends LimitsRosterGroup = LimitsRosterGroup> {
  key: string;
  name: string;
  groups: LimitsGroupNode<M, G>[];
  ungroupedPeople: LimitsPersonRef<M>[];
}

export function limitTargetKey(target: LiveLimitIdentity): string {
  return `${target.workspaceId}\0${target.type}\0${target.targetId}`;
}

export function dedupeLimitDrafts(drafts: LiveLimitDraft[]): LiveLimitDraft[] {
  const byIdentity = new Map<string, LiveLimitDraft>();
  drafts.forEach(draft => byIdentity.set(limitTargetKey(draft), draft));
  return [...byIdentity.values()];
}

export function positiveUsdAmount(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function personTargetKey(workspaceId: string, userId: string): string {
  return limitTargetKey({
    workspaceId,
    type: 'workspace_user_limit',
    targetId: userId,
  });
}

export function buildLimitsTeamHierarchy<
  M extends LimitsRosterMember,
  G extends LimitsRosterGroup,
>(
  workspaces: LimitsRosterWorkspace<M, G>[],
  mappings: LimitsFundingMapping[],
): LimitsTeamNode<M, G>[] {
  const mappingByGroup = new Map(mappings.map(mapping => [
    `${mapping.workspaceId}\0${mapping.groupId}`,
    mapping.teamName,
  ]));
  const teams = new Map<string, LimitsTeamNode<M, G>>();
  const getTeam = (name: string) => {
    const key = name === 'Unmapped groups' ? '__unmapped__' : name;
    let team = teams.get(key);
    if (!team) {
      team = { key, name, groups: [], ungroupedPeople: [] };
      teams.set(key, team);
    }
    return team;
  };

  for (const workspace of workspaces) {
    const knownGroupIds = new Set(workspace.groups.map(group => group.groupId));
    for (const group of workspace.groups) {
      const teamName = mappingByGroup.get(`${workspace.workspaceId}\0${group.groupId}`) ?? 'Unmapped groups';
      getTeam(teamName ?? 'Unmapped groups').groups.push({
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        group,
        billingPeriod: workspace.billingPeriod,
        canWrite: workspace.canWrite !== false,
        members: workspace.members
          .filter(member => member.groupIds.includes(group.groupId))
          .map(member => ({ workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName, member, canWrite: workspace.canWrite !== false })),
      });
    }
    const noKnownGroup = workspace.members.filter(member =>
      member.groupIds.length === 0 || member.groupIds.every(groupId => !knownGroupIds.has(groupId)));
    getTeam('Unmapped groups').ungroupedPeople.push(...noKnownGroup.map(member => ({
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      member,
      canWrite: workspace.canWrite !== false,
    })));
  }
  return [...teams.values()]
    .filter(team => team.groups.length > 0 || team.ungroupedPeople.length > 0)
    .sort((a, b) => a.key === '__unmapped__' ? 1 : b.key === '__unmapped__' ? -1 : a.name.localeCompare(b.name));
}

export function selectableTeamPersonKeys(team: LimitsTeamNode): string[] {
  const keys = new Set<string>();
  const people = [
    ...team.groups.flatMap(group => group.members),
    ...team.ungroupedPeople,
  ];
  people.forEach(({ workspaceId, member, canWrite }) => {
    if (canWrite && member.eligible && !member.isInternal && !member.isDisabled) {
      keys.add(personTargetKey(workspaceId, member.userId));
    }
  });
  return [...keys];
}

export function describeLimitValue(
  state: LiveLimitValueState,
  amountUsd: number | null,
): string {
  if (state === 'unavailable') return 'Unavailable';
  if (state === 'none') return 'No configured limit';
  if (amountUsd == null) return state === 'inherited' ? 'Inherited · amount unavailable' : 'Configured · amount unavailable';
  return `${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amountUsd)} / month`;
}