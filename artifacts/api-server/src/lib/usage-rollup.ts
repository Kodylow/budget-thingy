export interface RollupGroup {
  id: string;
  workspaceId: string;
  name: string;
}

export interface RollupMemberUsage {
  byUser: ReadonlyMap<string, number>;
  /**
   * Cost within this group's API filter that could not be assigned to a member.
   * It cannot participate in member deduplication, so it remains with the group.
   */
  unattributableTotalCostUsd?: number;
}

export interface DedupedGroupRollup {
  spendUsd: number;
  memberCount: number;
  /** Per-user attributed spend for this group (combined Comcast + extra-workspace spend,
   *  deduped: a user only appears here if this is their first group in stable sort order). */
  byUser: ReadonlyMap<string, number>;
}

export interface DedupedUsageRollup {
  byGroup: Map<string, DedupedGroupRollup>;
  totalSpendUsd: number;
  totalMemberCount: number;
  pendingCount: number;
  isComplete: boolean;
}

function orderGroups(groups: RollupGroup[]): RollupGroup[] {
  return [...groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
}

export function computeDedupedMemberCounts(
  groups: RollupGroup[],
  membersByGroup: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const seenUsers = new Set<string>();
  for (const group of orderGroups(groups)) {
    let count = 0;
    for (const userId of membersByGroup.get(group.id) ?? []) {
      if (seenUsers.has(userId)) continue;
      seenUsers.add(userId);
      count += 1;
    }
    counts.set(group.id, count);
  }
  return counts;
}

/**
 * Attributes each user to exactly one custom group for rolled-up totals.
 *
 * Groups are ordered by workspace, case-insensitive name, then stable group ID.
 * If a user appears in multiple custom groups, the first group in that order owns
 * their usage. Raw per-group API totals remain separate and are not changed.
 */
export function computeDedupedUsageRollup(
  groups: RollupGroup[],
  usageByGroup: ReadonlyMap<string, RollupMemberUsage>,
): DedupedUsageRollup {
  const ordered = orderGroups(groups);
  const byGroup = new Map<string, DedupedGroupRollup>();
  const seenUsers = new Set<string>();
  let totalSpendUsd = 0;
  let pendingCount = 0;

  for (const group of ordered) {
    const rollupByUser = new Map<string, number>();
    const rollup: DedupedGroupRollup = { spendUsd: 0, memberCount: 0, byUser: rollupByUser };
    byGroup.set(group.id, rollup);
    const usage = usageByGroup.get(group.id);
    if (!usage) {
      pendingCount += 1;
      continue;
    }
    const unattributableSpendUsd = usage.unattributableTotalCostUsd ?? 0;
    rollup.spendUsd += unattributableSpendUsd;
    totalSpendUsd += unattributableSpendUsd;
    for (const [userId, spendUsd] of usage.byUser) {
      if (seenUsers.has(userId)) continue;
      seenUsers.add(userId);
      rollup.spendUsd += spendUsd;
      rollup.memberCount += 1;
      rollupByUser.set(userId, spendUsd);
      totalSpendUsd += spendUsd;
    }
  }

  return {
    byGroup,
    totalSpendUsd,
    totalMemberCount: seenUsers.size,
    pendingCount,
    isComplete: pendingCount === 0,
  };
}
