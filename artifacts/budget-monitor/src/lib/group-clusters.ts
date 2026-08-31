/**
 * Utilities for collapsing Admin / Member / Viewer / Guests sub-groups
 * into a single "cluster" row on the dashboard.
 *
 * Groups are considered cluster-able when:
 *   1. Their name ends with a recognised role suffix (e.g. " - Admin", "-Admins")
 *   2. At least one other group in the same team section shares the same
 *      (workspaceId, baseName) pair.
 *
 * Single-group or un-suffixed groups are left as-is (isSingleGroup = true).
 */

// Matches "- Admin", " - Admins", "-Members", "- Viewer", " - Guests", etc.
const ROLE_SUFFIX_RE = /\s*-\s*(Admins?|Members?|Viewers?|Guests?)$/i;

export const ROLE_PRIORITY: Record<string, number> = {
  Admin: 0,
  Member: 1,
  Viewer: 2,
  Guest: 3,
};

export function normalizeRole(raw: string): string {
  const r = raw.toLowerCase();
  if (r.startsWith('admin')) return 'Admin';
  if (r.startsWith('member')) return 'Member';
  if (r.startsWith('viewer')) return 'Viewer';
  return 'Guest';
}

/** Returns baseName + role if the group name ends with a role suffix; null otherwise. */
export function parseRoleSuffix(name: string): { baseName: string; role: string } | null {
  const match = ROLE_SUFFIX_RE.exec(name);
  if (!match) return null;
  return {
    baseName: name.slice(0, name.length - match[0].length),
    role: normalizeRole(match[1]!),
  };
}

/** Returns the highest-privilege role between two role strings. */
export function higherRole(a: string, b: string): string {
  return (ROLE_PRIORITY[a] ?? 99) <= (ROLE_PRIORITY[b] ?? 99) ? a : b;
}

export interface GroupLike {
  groupId: string;
  workspaceId: string;
  workspaceName?: string | null;
  name: string;
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
  /** Sum of current members' workspace spend for this group (null while loading). */
  rawMemberSpendUsd?: number | null;
  rawMemberSpendLoaded?: boolean;
  spendUpdatedAt?: string | null;
}

export interface GroupCluster {
  /** Unique key: `${workspaceId}::${baseName}` for multi-group, or groupId for single */
  clusterKey: string;
  baseName: string;
  workspaceId: string;
  workspaceName: string | null | undefined;
  teamName: string | null;
  /** IDs of constituent sub-groups */
  groupIds: string[];
  /** groupId → sub-group role (Admin / Member / Viewer / Guest) */
  groupRoles: Record<string, string>;
  /** Deduplicated members attributed across sub-groups. */
  memberCount: number;
  spendUsd: number;
  spendLoaded: boolean;
  /** True when there is only one group — render identically to a normal group row */
  isSingleGroup: boolean;
  /** Populated only when isSingleGroup = true */
  singleGroup?: GroupLike;
}

export function sumAttributedRollup(groups: Array<{
  rollupMemberCount?: number;
  rollupSpendLoaded?: boolean;
  rollupSpendUsd?: number;
}>): {
  memberCount: number;
  spendUsd: number;
  spendLoaded: boolean;
} {
  let memberCount = 0;
  let spendUsd = 0;
  let spendLoaded = true;
  for (const group of groups) {
    memberCount += group.rollupMemberCount ?? 0;
    spendUsd += group.rollupSpendUsd ?? 0;
    if (!group.rollupSpendLoaded) {
      spendLoaded = false;
    }
  }
  return { memberCount, spendUsd, spendLoaded };
}

/**
 * Groups a flat list of groups (already filtered to one team section) into clusters.
 * Returns one entry per visual row that should be rendered.
 */
export function buildGroupClusters(groups: GroupLike[]): GroupCluster[] {
  // Count how many groups share each (workspaceId, baseName)
  const baseCount = new Map<string, number>();
  for (const g of groups) {
    const p = parseRoleSuffix(g.name);
    if (!p) continue;
    const k = `${g.workspaceId}::${p.baseName}`;
    baseCount.set(k, (baseCount.get(k) ?? 0) + 1);
  }

  const clusterGroups = new Map<string, GroupLike[]>();
  const clusterRoles = new Map<string, Record<string, string>>();
  const clusterBaseNames = new Map<string, string>();
  const standalone: GroupLike[] = [];

  for (const g of groups) {
    const p = parseRoleSuffix(g.name);
    if (!p) {
      standalone.push(g);
      continue;
    }
    const k = `${g.workspaceId}::${p.baseName}`;
    if ((baseCount.get(k) ?? 0) < 2) {
      // No sibling with same base name → treat as standalone
      standalone.push(g);
      continue;
    }
    const list = clusterGroups.get(k) ?? [];
    list.push(g);
    clusterGroups.set(k, list);
    clusterBaseNames.set(k, p.baseName);
    const roles = clusterRoles.get(k) ?? {};
    roles[g.groupId] = p.role;
    clusterRoles.set(k, roles);
  }

  const result: GroupCluster[] = [];

  // Single-group entries preserve the dashboard-selected spend model. The
  // caller maps this to project-attributed spend (with member spend only as a
  // loading fallback), so substituting rawMemberSpendUsd here would silently
  // undo project accounting for ordinary groups inside team sections.
  for (const g of standalone) {
    result.push({
      clusterKey: g.groupId,
      baseName: g.name,
      workspaceId: g.workspaceId,
      workspaceName: g.workspaceName,
      teamName: g.teamName,
      groupIds: [g.groupId],
      groupRoles: {},
      memberCount: g.memberCount ?? 0,
      spendUsd: g.spendUsd ?? 0,
      spendLoaded: g.spendLoaded,
      isSingleGroup: true,
      singleGroup: g,
    });
  }

  // Multi-group cluster entries
  for (const [key, groupList] of clusterGroups) {
    const baseName = clusterBaseNames.get(key)!;
    const roles = clusterRoles.get(key)!;

    const { memberCount, spendUsd, spendLoaded } = sumAttributedRollup(groupList);

    const first = groupList[0]!;
    result.push({
      clusterKey: key,
      baseName,
      workspaceId: first.workspaceId,
      workspaceName: first.workspaceName,
      teamName: first.teamName,
      groupIds: groupList.map((g) => g.groupId),
      groupRoles: roles,
      memberCount,
      spendUsd,
      spendLoaded,
      isSingleGroup: false,
    });
  }

  // Keep each workspace's rows together, then sort groups alphabetically
  // within that workspace. Stable identifiers make duplicate labels
  // deterministic.
  result.sort((a, b) =>
    (a.workspaceName ?? '').localeCompare(b.workspaceName ?? '')
    || a.workspaceId.localeCompare(b.workspaceId)
    || a.baseName.localeCompare(b.baseName)
    || a.clusterKey.localeCompare(b.clusterKey),
  );

  return result;
}

/** Role → Tailwind badge colour classes */
export function roleBadgeClass(role: string): string {
  switch (role) {
    case 'Admin':
      return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'Member':
      return 'bg-cyan-100 text-cyan-800 border-cyan-300';
    case 'Viewer':
      return 'bg-slate-100 text-slate-600 border-slate-300';
    default:
      return 'bg-slate-100 text-slate-500 border-slate-200';
  }
}
