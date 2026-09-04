export type DirectoryRole = 'admin' | 'member' | 'viewer' | 'guest' | 'unsuffixed';

export const ROLE_PRIORITY: Record<DirectoryRole, number> = {
  admin: 0,
  member: 1,
  viewer: 2,
  guest: 3,
  unsuffixed: 4,
};

export function normalizeRole(role: unknown): DirectoryRole {
  if (typeof role !== 'string') return 'unsuffixed';
  const normalized = role.trim().toLowerCase();
  return normalized in ROLE_PRIORITY ? normalized as DirectoryRole : 'unsuffixed';
}

export function roleLabel(role: unknown): string {
  const normalized = normalizeRole(role);
  return normalized === 'unsuffixed'
    ? 'Group'
    : `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

export function higherRole(a: unknown, b: unknown): DirectoryRole {
  const normalizedA = normalizeRole(a);
  const normalizedB = normalizeRole(b);
  return ROLE_PRIORITY[normalizedA] <= ROLE_PRIORITY[normalizedB] ? normalizedA : normalizedB;
}

export interface GroupLike {
  groupId: string;
  workspaceId: string;
  workspaceName?: string | null;
  name: string;
  familyKey: string;
  familyName: string;
  role?: string | null;
  isLegacy: boolean;
  teamName: string | null;
  memberCount: number | null;
  spendLoaded: boolean;
  spendUsd: number | null;
  budgetUsd?: number | null;
  budgetSource?: string | null;
  remainingUsd?: number | null;
  percentUsed?: number | null;
  thresholdsFired?: number[];
  rollupMemberCount?: number;
  rollupSpendLoaded?: boolean;
  rollupSpendUsd?: number;
  rawMemberSpendUsd?: number | null;
  rawMemberSpendLoaded?: boolean;
  spendUpdatedAt?: string | null;
}

export interface GroupCluster {
  clusterKey: string;
  baseName: string;
  workspaceId: string;
  workspaceName: string | null | undefined;
  teamName: string | null;
  groupIds: string[];
  groupRoles: Record<string, string>;
  memberCount: number;
  spendUsd: number;
  spendLoaded: boolean;
  isLegacy: boolean;
  isSingleGroup: boolean;
  groups: GroupLike[];
  singleGroup?: GroupLike;
}

export interface LogicalGroupScope {
  scopeId: string;
  displayName: string;
  workspaceId: string;
  workspaceName: string | null | undefined;
  groupIds: string[];
}

export function buildLogicalGroupScopes<T extends {
  groupId: string;
  workspaceId: string;
  workspaceName?: string | null;
  familyKey: string;
  familyName: string;
  role?: string | null;
}>(groups: T[]): LogicalGroupScope[] {
  const families = new Map<string, T[]>();
  for (const group of groups) {
    const key = `${group.workspaceId}::${group.familyKey}`;
    const family = families.get(key) ?? [];
    family.push(group);
    families.set(key, family);
  }

  const scopes = [...families.entries()].map(([scopeId, family]) => {
    family.sort((a, b) =>
      ROLE_PRIORITY[normalizeRole(a.role)] - ROLE_PRIORITY[normalizeRole(b.role)] ||
      a.groupId.localeCompare(b.groupId)
    );
    return {
      scopeId,
      displayName: family[0]!.familyName,
      workspaceId: family[0]!.workspaceId,
      workspaceName: family[0]!.workspaceName,
      groupIds: family.map((group) => group.groupId),
    };
  });
  const duplicateNames = new Map<string, number>();
  scopes.forEach((scope) => {
    const key = scope.displayName.toLocaleLowerCase();
    duplicateNames.set(key, (duplicateNames.get(key) ?? 0) + 1);
  });
  return scopes
    .map((scope) => ({
      ...scope,
      displayName: (duplicateNames.get(scope.displayName.toLocaleLowerCase()) ?? 0) > 1
        ? `${scope.displayName} · ${scope.workspaceName || scope.workspaceId}`
        : scope.displayName,
    }))
    .sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }) ||
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.scopeId.localeCompare(b.scopeId)
    );
}

export function sumAttributedRollup(groups: Array<{
  rollupMemberCount?: number;
  rollupSpendLoaded?: boolean;
  rollupSpendUsd?: number;
}>): { memberCount: number; spendUsd: number; spendLoaded: boolean } {
  let memberCount = 0;
  let spendUsd = 0;
  let spendLoaded = true;
  for (const group of groups) {
    memberCount += group.rollupMemberCount ?? 0;
    spendUsd += group.rollupSpendUsd ?? 0;
    if (!group.rollupSpendLoaded) spendLoaded = false;
  }
  return { memberCount, spendUsd, spendLoaded };
}

export function buildGroupClusters(groups: GroupLike[]): GroupCluster[] {
  const families = new Map<string, GroupLike[]>();
  for (const group of groups) {
    const key = `${group.workspaceId}::${group.familyKey}`;
    const family = families.get(key) ?? [];
    family.push({ ...group, role: normalizeRole(group.role) });
    families.set(key, family);
  }
  return [...families.entries()]
    .map(([clusterKey, family]) => {
      family.sort((a, b) =>
        ROLE_PRIORITY[normalizeRole(a.role)] - ROLE_PRIORITY[normalizeRole(b.role)] ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
      const first = family[0]!;
      const totals = sumAttributedRollup(family);
      return {
        clusterKey,
        baseName: first.familyName,
        workspaceId: first.workspaceId,
        workspaceName: first.workspaceName,
        teamName: first.teamName,
        groupIds: family.map((group) => group.groupId),
        groupRoles: Object.fromEntries(
          family.map((group) => [group.groupId, normalizeRole(group.role)]),
        ),
        memberCount: totals.memberCount,
        spendUsd: totals.spendUsd,
        spendLoaded: totals.spendLoaded,
        isLegacy: family.every((group) => group.isLegacy),
        isSingleGroup: family.length === 1,
        groups: family,
        singleGroup: family.length === 1 ? first : undefined,
      };
    })
    .sort((a, b) =>
      a.baseName.localeCompare(b.baseName, undefined, { sensitivity: 'base' }) ||
      a.clusterKey.localeCompare(b.clusterKey)
    );
}

export function roleBadgeClass(role: unknown): string {
  switch (normalizeRole(role)) {
    case 'admin':
      return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'member':
      return 'bg-cyan-100 text-cyan-800 border-cyan-300';
    case 'viewer':
      return 'bg-slate-100 text-slate-600 border-slate-300';
    default:
      return 'bg-slate-100 text-slate-500 border-slate-200';
  }
}