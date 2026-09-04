import { db, teamBudgetsTable, teamLimitTargetsTable } from "@workspace/db";
import {
  collisionSafeFamilyTeamName,
  FAMILY_TEAM_OVERRIDES,
} from "@workspace/db/seed-teams";
import { and, eq } from "drizzle-orm";

export interface EnterpriseWorkspace {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
}
export interface EnterpriseGroup {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
}
export interface EnterpriseMember {
  userId: string;
  username: string;
  email: string;
  name: string | null;
  isAccountAdmin: boolean;
  workspaces: Map<string, { role: string; isDisabled: boolean }>;
}
export type DirectoryRole = "admin" | "member" | "viewer" | "guest" | "unsuffixed";
export interface CanonicalRoleGroup {
  id: string;
  name: string;
  workspaceId: string;
  familyId: string;
  familyKey: string;
  familyName: string;
  role: DirectoryRole;
  isLegacy: boolean;
  teamName: string | null;
  members: Map<string, EnterpriseMember>;
}
export interface CanonicalFamily {
  id: string;
  key: string;
  name: string;
  workspaceId: string;
  isLegacy: boolean;
  teamName: string | null;
  roleGroups: Map<DirectoryRole, CanonicalRoleGroup>;
}
export interface CanonicalWorkspace {
  id: string;
  name: string;
  workspace: EnterpriseWorkspace | null;
  families: Map<string, CanonicalFamily>;
}
export interface CanonicalAccountDirectory {
  workspaces: Map<string, CanonicalWorkspace>;
  familiesById: Map<string, CanonicalFamily>;
  roleGroupsById: Map<string, CanonicalRoleGroup>;
}
export interface CanonicalTeamTarget {
  workspaceId: string;
  groupId: string;
  teamName: string;
  assignmentSource: "unconfirmed" | "automatic" | "manual";
}
export interface CanonicalEffectiveTeams {
  byFamilyId: Map<string, string | null>;
  byRoleGroupId: Map<string, string | null>;
}
export interface FamilyMapping {
  workspaceId: string;
  familyKey: string;
  familyName: string;
  teamName: string | null;
  isLegacy: boolean;
}

export const LEGACY_WORKSPACE_ID = "1awqan";
const FAMILY_ROLE_SUFFIX = /\s*-\s*(admins?|members?|viewers?|guests?)\s*$/i;

export function normalizeFamilyKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseDirectoryGroupName(name: string): {
  familyKey: string;
  familyName: string;
  role: DirectoryRole;
} {
  let value = name.trim().replace(/^az-replit\s*-\s*/i, "");
  const match = value.match(FAMILY_ROLE_SUFFIX);
  let role: DirectoryRole = "unsuffixed";
  if (match) {
    const raw = match[1]!.toLowerCase();
    role = raw.startsWith("admin")
      ? "admin"
      : raw.startsWith("member")
        ? "member"
        : raw.startsWith("viewer")
          ? "viewer"
          : "guest";
    value = value.slice(0, match.index).trim();
  }
  const familyName = value.replace(/\s+/g, " ").trim();
  return { familyKey: normalizeFamilyKey(familyName), familyName, role };
}

export function buildCanonicalAccountDirectory(input: {
  workspaces: ReadonlyMap<string, EnterpriseWorkspace>;
  groups: readonly EnterpriseGroup[];
  groupMembers: ReadonlyMap<string, readonly string[]>;
  members: ReadonlyMap<string, EnterpriseMember>;
  mappings?: readonly FamilyMapping[];
}): CanonicalAccountDirectory {
  const mappingByIdentity = new Map(
    (input.mappings ?? []).map((row) => [`${row.workspaceId}\0${row.familyKey}`, row]),
  );
  const identitiesByKey = new Map<string, Set<string>>();
  for (const group of input.groups) {
    if (group.workspaceId === LEGACY_WORKSPACE_ID) continue;
    const key = parseDirectoryGroupName(group.name).familyKey;
    const identities = identitiesByKey.get(key) ?? new Set();
    identities.add(`${group.workspaceId}\0${key}`);
    identitiesByKey.set(key, identities);
  }
  const nonlegacyTeams = new Map<string, string>();
  for (const group of input.groups) {
    if (group.workspaceId === LEGACY_WORKSPACE_ID) continue;
    const parsed = parseDirectoryGroupName(group.name);
    const identity = `${group.workspaceId}\0${parsed.familyKey}`;
    const mapped = mappingByIdentity.get(identity)?.teamName;
    nonlegacyTeams.set(
      identity,
      FAMILY_TEAM_OVERRIDES.get(parsed.familyKey) ??
        (mapped && normalizeFamilyKey(mapped) !== parsed.familyKey
          ? mapped
          : collisionSafeFamilyTeamName(
              parsed.familyName,
              group.workspaceId,
              (identitiesByKey.get(parsed.familyKey)?.size ?? 0) > 1,
            )),
    );
  }
  const teamsByKey = new Map<string, Set<string>>();
  for (const [identity, team] of nonlegacyTeams) {
    const key = identity.split("\0")[1]!;
    const teams = teamsByKey.get(key) ?? new Set();
    teams.add(team);
    teamsByKey.set(key, teams);
  }
  const workspaces = new Map<string, CanonicalWorkspace>(
    [...input.workspaces].map(([id, workspace]) => [
      id,
      { id, name: workspace.name, workspace, families: new Map() },
    ]),
  );
  const familiesById = new Map<string, CanonicalFamily>();
  const roleGroupsById = new Map<string, CanonicalRoleGroup>();
  for (const group of input.groups) {
    const parsed = parseDirectoryGroupName(group.name);
    const identity = `${group.workspaceId}\0${parsed.familyKey}`;
    const isLegacy = group.workspaceId === LEGACY_WORKSPACE_ID;
    const inherited = teamsByKey.get(parsed.familyKey);
    const teamName = isLegacy
      ? FAMILY_TEAM_OVERRIDES.get(parsed.familyKey) ??
        (inherited?.size === 1 ? [...inherited][0]! : null)
      : nonlegacyTeams.get(identity)!;
    let workspace = workspaces.get(group.workspaceId);
    if (!workspace) {
      const raw = input.workspaces.get(group.workspaceId) ?? null;
      workspace = {
        id: group.workspaceId,
        name: raw?.name ?? group.workspaceId,
        workspace: raw,
        families: new Map(),
      };
      workspaces.set(group.workspaceId, workspace);
    }
    let family = workspace.families.get(parsed.familyKey);
    if (!family) {
      family = {
        id: `${group.workspaceId}:${parsed.familyKey}`,
        key: parsed.familyKey,
        name: mappingByIdentity.get(identity)?.familyName ?? parsed.familyName,
        workspaceId: group.workspaceId,
        isLegacy,
        teamName,
        roleGroups: new Map(),
      };
      workspace.families.set(parsed.familyKey, family);
      familiesById.set(family.id, family);
    }
    const roleGroup: CanonicalRoleGroup = {
      id: group.id,
      name: group.name,
      workspaceId: group.workspaceId,
      familyId: family.id,
      familyKey: family.key,
      familyName: family.name,
      role: parsed.role,
      isLegacy,
      teamName: family.teamName,
      members: new Map(
        (input.groupMembers.get(group.id) ?? []).flatMap((id) => {
          const member = input.members.get(id);
          return member ? [[id, member] as const] : [];
        }),
      ),
    };
    family.roleGroups.set(parsed.role, roleGroup);
    roleGroupsById.set(group.id, roleGroup);
  }
  return { workspaces, familiesById, roleGroupsById };
}

export function buildCanonicalEffectiveTeams(
  account: CanonicalAccountDirectory,
  targets: readonly CanonicalTeamTarget[],
): CanonicalEffectiveTeams {
  const targeted = new Map<string, Set<string>>();
  const familyCounts = new Map<string, number>();
  for (const family of account.familiesById.values()) {
    if (!family.isLegacy) familyCounts.set(family.key, (familyCounts.get(family.key) ?? 0) + 1);
  }
  for (const target of targets) {
    const group = account.roleGroupsById.get(target.groupId);
    if (!group || group.workspaceId !== target.workspaceId || target.assignmentSource === "automatic") {
      continue;
    }
    if (
      target.assignmentSource === "unconfirmed" &&
      (familyCounts.get(group.familyKey) ?? 0) > 1 &&
      !FAMILY_TEAM_OVERRIDES.has(group.familyKey) &&
      normalizeFamilyKey(target.teamName) === group.familyKey
    ) continue;
    const names = targeted.get(group.familyId) ?? new Set();
    names.add(target.teamName);
    targeted.set(group.familyId, names);
  }
  const byFamilyId = new Map<string, string | null>();
  for (const family of account.familiesById.values()) {
    if (family.isLegacy) continue;
    const names = targeted.get(family.id);
    byFamilyId.set(family.id, names?.size === 1 ? [...names][0]! : family.teamName);
  }
  for (const family of account.familiesById.values()) {
    if (!family.isLegacy) continue;
    const names = targeted.get(family.id);
    const siblings = new Set(
      [...account.familiesById.values()]
        .filter((candidate) => !candidate.isLegacy && candidate.key === family.key)
        .flatMap((candidate) => byFamilyId.get(candidate.id) ?? []),
    );
    byFamilyId.set(
      family.id,
      names?.size === 1
        ? [...names][0]!
        : siblings.size === 1
          ? [...siblings][0]!
          : FAMILY_TEAM_OVERRIDES.get(family.key) ?? null,
    );
  }
  const byRoleGroupId = new Map<string, string | null>();
  for (const group of account.roleGroupsById.values()) {
    byRoleGroupId.set(group.id, byFamilyId.get(group.familyId) ?? group.teamName);
  }
  return { byFamilyId, byRoleGroupId };
}

export async function persistCanonicalFamilyFinancialRows(
  account: CanonicalAccountDirectory,
): Promise<void> {
  const automaticTargets = await db.select().from(teamLimitTargetsTable)
    .where(eq(teamLimitTargetsTable.assignmentSource, "automatic"));
  for (const family of account.familiesById.values()) {
    if (family.isLegacy || !family.teamName) continue;
    await db.insert(teamBudgetsTable).values({
      teamName: family.teamName,
      originalAmountUsd: 0,
      amountUsd: 0,
    }).onConflictDoNothing({ target: teamBudgetsTable.teamName });
    const memberGroup = family.roleGroups.get("member");
    if (!memberGroup) continue;
    const stale = automaticTargets.filter((target) =>
      target.workspaceId === family.workspaceId &&
      target.groupId !== memberGroup.id &&
      parseDirectoryGroupName(target.groupName).familyKey === family.key
    );
    const carried = stale.length === 1 ? stale[0] : undefined;
    if (carried) {
      await db.delete(teamLimitTargetsTable).where(and(
        eq(teamLimitTargetsTable.workspaceId, carried.workspaceId),
        eq(teamLimitTargetsTable.groupId, carried.groupId),
        eq(teamLimitTargetsTable.assignmentSource, "automatic"),
      ));
    }
    await db.insert(teamLimitTargetsTable).values({
      workspaceId: family.workspaceId,
      groupId: memberGroup.id,
      groupName: memberGroup.name,
      teamName: family.teamName,
      assignmentSource: "automatic",
      monthlyLimitUsd: carried?.monthlyLimitUsd,
      isEnabled: carried?.isEnabled ?? true,
    }).onConflictDoUpdate({
      target: [teamLimitTargetsTable.workspaceId, teamLimitTargetsTable.groupId],
      set: { groupName: memberGroup.name, teamName: family.teamName },
      setWhere: eq(teamLimitTargetsTable.assignmentSource, "automatic"),
    });
  }
}

const BUILT_IN_GROUP_TYPES = new Set(["admin", "member", "guest"]);
export function isCustomGroup(group: EnterpriseGroup): boolean {
  return !BUILT_IN_GROUP_TYPES.has(group.type.toLowerCase());
}