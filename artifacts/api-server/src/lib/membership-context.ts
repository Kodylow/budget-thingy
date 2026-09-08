import type { ConfigurationSnapshot } from "./configuration-snapshot";
import {
  buildCanonicalAccountDirectory,
  buildCanonicalEffectiveTeams,
  isCustomGroup,
  type DirectoryCache,
} from "./enterprise";
import { canonicalTeamPoolId } from "../services/scoped-accounting";

export interface MembershipContext {
  defaultWorkspaceId: string | null;
  workspaces: {
    workspaceId: string;
    workspaceName: string;
    isPreferred: boolean;
    budgetTeams: {
      poolId: string;
      teamName: string;
      groups: { groupId: string; groupName: string }[];
    }[];
    unmappedGroups: { groupId: string; groupName: string }[];
  }[];
  qualification: string | null;
}

/**
 * Builds the personal workspace/team selector exclusively from the effective
 * identity's active directory memberships and the committed configuration.
 * Administrative authorization is intentionally not an input.
 */
export function buildMembershipContext(
  userId: string,
  directory: DirectoryCache,
  configuration: ConfigurationSnapshot,
): MembershipContext {
  const member = directory.members.get(userId);
  const activeWorkspaceIds = new Set(
    [...(member?.workspaces ?? [])]
      .filter(([, membership]) => !membership.isDisabled)
      .map(([workspaceId]) => workspaceId),
  );
  const account = buildCanonicalAccountDirectory({
    workspaces: directory.workspaces,
    groups: directory.allGroups,
    groupMembers: directory.groupMembers,
    members: directory.members,
    mappings: configuration.familyTeamMappings,
  });
  const effectiveTeams = buildCanonicalEffectiveTeams(
    account,
    configuration.teamLimitTargets,
    configuration.fundingGroupOverrides,
  );
  const visibleTeams = new Set(
    configuration.teamBudgets
      .filter((team) => !team.isHidden)
      .map((team) => team.teamName),
  );
  const overridesByIdentity = new Map(
    configuration.fundingGroupOverrides.map((override) => [
      `${override.workspaceId}\0${override.groupId}`,
      override,
    ]),
  );

  // A persisted target plus a visible budget is the canonical assertion that a
  // family is an allocated budget team. Automatic targets are committed
  // canonical mappings too; excluding them would discard the normal seeded and
  // directory-reconciled targets used by the reporting endpoints.
  const officialTargetsByFamilyAndTeam = new Map<string, Set<string>>();
  for (const target of configuration.teamLimitTargets) {
    const targetGroup = account.roleGroupsById.get(target.groupId);
    if (
      !targetGroup ||
      targetGroup.workspaceId !== target.workspaceId ||
      !visibleTeams.has(target.teamName)
    ) continue;
    const key = `${targetGroup.familyKey}\0${target.teamName}`;
    const targets = officialTargetsByFamilyAndTeam.get(key) ?? new Set<string>();
    targets.add(target.workspaceId);
    officialTargetsByFamilyAndTeam.set(key, targets);
  }

  const groupsByWorkspaceAndTeam = new Map<string, Map<string, {
    groupId: string;
    groupName: string;
  }[]>>();
  const unmappedByWorkspace = new Map<string, {
    groupId: string;
    groupName: string;
  }[]>();
  const applicableTargetWorkspaceIds = new Set<string>();

  for (const group of directory.allGroups) {
    if (
      !activeWorkspaceIds.has(group.workspaceId) ||
      !(directory.groupMembers.get(group.id) ?? []).includes(userId)
    ) continue;
    const canonical = account.roleGroupsById.get(group.id);
    const override = overridesByIdentity.get(`${group.workspaceId}\0${group.id}`);
    const teamName = isCustomGroup(group)
      ? effectiveTeams.byRoleGroupId.get(group.id) ?? null
      : null;
    const targetWorkspaceIds = override
      ? override.teamName && visibleTeams.has(override.teamName)
        ? new Set([override.workspaceId])
        : undefined
      : canonical && teamName
        ? officialTargetsByFamilyAndTeam.get(
          `${canonical.familyKey}\0${teamName}`,
        )
        : undefined;
    if (!teamName || !targetWorkspaceIds?.size) {
      const groups = unmappedByWorkspace.get(group.workspaceId) ?? [];
      groups.push({ groupId: group.id, groupName: group.name });
      unmappedByWorkspace.set(group.workspaceId, groups);
      continue;
    }
    const byTeam = groupsByWorkspaceAndTeam.get(group.workspaceId) ?? new Map();
    const groups = byTeam.get(teamName) ?? [];
    groups.push({ groupId: group.id, groupName: group.name });
    byTeam.set(teamName, groups);
    groupsByWorkspaceAndTeam.set(group.workspaceId, byTeam);
    for (const workspaceId of targetWorkspaceIds) {
      if (activeWorkspaceIds.has(workspaceId)) {
        applicableTargetWorkspaceIds.add(workspaceId);
      }
    }
  }

  let defaultWorkspaceId: string | null = null;
  const fundedWorkspaceIds = new Set(groupsByWorkspaceAndTeam.keys());
  const displayedWorkspaceIds = fundedWorkspaceIds.size > 0
    ? fundedWorkspaceIds
    : activeWorkspaceIds;
  if (applicableTargetWorkspaceIds.size === 1) {
    defaultWorkspaceId = [...applicableTargetWorkspaceIds][0]!;
  } else if (
    applicableTargetWorkspaceIds.size === 0 &&
    displayedWorkspaceIds.size === 1
  ) {
    defaultWorkspaceId = [...displayedWorkspaceIds][0]!;
  }
  const qualification = defaultWorkspaceId === null && displayedWorkspaceIds.size > 0
    ? "Choose a workspace."
    : null;

  const workspaces = [...displayedWorkspaceIds]
    .map((workspaceId) => ({
      workspaceId,
      workspaceName: directory.workspaces.get(workspaceId)?.name ?? workspaceId,
      isPreferred: workspaceId === defaultWorkspaceId,
      budgetTeams: [...(groupsByWorkspaceAndTeam.get(workspaceId) ?? [])]
        .map(([teamName, groups]) => ({
          poolId: canonicalTeamPoolId(teamName),
          teamName,
          groups: groups.sort((a, b) =>
            a.groupName.localeCompare(b.groupName) ||
            a.groupId.localeCompare(b.groupId)),
        }))
        .sort((a, b) =>
          a.teamName.localeCompare(b.teamName) ||
          a.poolId.localeCompare(b.poolId)),
      unmappedGroups: (unmappedByWorkspace.get(workspaceId) ?? [])
        .sort((a, b) =>
          a.groupName.localeCompare(b.groupName) ||
          a.groupId.localeCompare(b.groupId)),
    }))
    .sort((a, b) =>
      Number(b.isPreferred) - Number(a.isPreferred) ||
      a.workspaceName.localeCompare(b.workspaceName) ||
      a.workspaceId.localeCompare(b.workspaceId));

  return { defaultWorkspaceId, workspaces, qualification };
}