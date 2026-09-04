import type {
  UsageSnapshot,
} from "./usage-store";

export interface RollupGroup {
  id: string;
  workspaceId: string;
  name: string;
}

export interface RollupProjectInfo {
  creatorId: string | null;
}

export interface SnapshotProjectAttribution {
  /** Workspace-qualified project key -> owning group ID. */
  projectToGroup: Map<string, string>;
  spendByGroup: Map<string, number>;
  creatorByProject: Map<string, string | null>;
  aiSpendByProject: Map<string, number>;
  nonAiSpendByProject: Map<string, number>;
  unattributedSpendUsd: number;
  totalSpendUsd: number;
  pendingCount: number;
  isComplete: boolean;
}

export function projectAttributionKey(
  workspaceId: string,
  projectId: string,
): string {
  return `${workspaceId}\u0000${projectId}`;
}

export interface SnapshotUsageRollup extends DedupedUsageRollup {
  byWorkspace: Map<string, number>;
  accountTotalUsd: number;
  accountReconciliationSpendUsd: number;
  aiSpendByUser: Map<string, number>;
  nonAiSpendByUser: Map<string, number>;
  aiSpendByGroup: Map<string, Map<string, number>>;
  nonAiSpendByGroup: Map<string, Map<string, number>>;
  residualSpendByGroup: Map<string, number>;
  residualSpendUsd: number;
  projectAttribution: SnapshotProjectAttribution;
}

export interface SnapshotRollupInput {
  snapshot: UsageSnapshot;
  groups: readonly RollupGroup[];
  membersByGroup: ReadonlyMap<string, readonly string[]>;
  projectInfoByWorkspace: ReadonlyMap<
    string,
    ReadonlyMap<string, RollupProjectInfo>
  >;
}

export interface HistoricalSnapshotRollupInput
  extends Omit<SnapshotRollupInput, "membersByGroup" | "snapshot"> {
  snapshot: UsageSnapshot;
  currentUtcDay: string;
  currentMembersByGroup: ReadonlyMap<string, readonly string[]>;
  completedRosterDays: ReadonlySet<string>;
  rosterMembersByDate: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >;
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
  /** All-metric attributed usage by user, with each user-workspace pair counted
   * once and distinct workspaces summed. This is the canonical per-user value
   * for detail, activity, cluster, and export surfaces. */
  byUser: Map<string, number>;
  /** Workspace usage that cannot be assigned to a custom group in that workspace. */
  ungroupedByWorkspace: Map<string, DedupedGroupRollup>;
  /** Users whose spend was structurally assigned across workspace boundaries.
   * Canonical member attribution uses this to retain the complete workspace
   * amount when the destination group's member-usage API only contains the
   * source-workspace portion. */
  crossWorkspaceAttributedUsersByGroup?: ReadonlyMap<string, ReadonlySet<string>>;
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

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function addUserSpend(
  rollup: DedupedGroupRollup,
  userId: string,
  spendUsd: number,
): void {
  const byUser = rollup.byUser as Map<string, number>;
  if (!byUser.has(userId)) {
    (rollup as { memberCount: number }).memberCount += 1;
  }
  byUser.set(userId, (byUser.get(userId) ?? 0) + spendUsd);
  (rollup as { spendUsd: number }).spendUsd += spendUsd;
}

function scopedWorkspaceIds(snapshot: UsageSnapshot): string[] {
  if (snapshot.workspaceIds) return [...snapshot.workspaceIds].sort();
  return [...new Set([
    ...snapshot.members.keys(),
    ...snapshot.projects.keys(),
    ...snapshot.workspaces.keys(),
  ])].sort();
}

/**
 * Pure canonical accounting over one immutable Postgres usage snapshot.
 *
 * Workspace totals are authoritative. Agent spend follows a member only when
 * that user belongs to a directory group in the same workspace. Project
 * non-Agent spend follows the project creator using the same stable group
 * ownership. Everything else is retained in the workspace's synthetic
 * unattributed bucket, so group + unattributed always reconciles to workspace.
 */
export function computeSnapshotUsageRollup(
  input: SnapshotRollupInput,
): SnapshotUsageRollup {
  const { snapshot, membersByGroup, projectInfoByWorkspace } = input;
  const ordered = orderGroups([...input.groups]);
  const groupsByWorkspace = new Map<string, RollupGroup[]>();
  const ownerByWorkspaceUser = new Map<string, Map<string, RollupGroup>>();
  const byGroup = new Map<string, DedupedGroupRollup>();
  const aiSpendByGroup = new Map<string, Map<string, number>>();
  const nonAiSpendByGroup = new Map<string, Map<string, number>>();
  for (const group of ordered) {
    const workspaceGroups = groupsByWorkspace.get(group.workspaceId) ?? [];
    workspaceGroups.push(group);
    groupsByWorkspace.set(group.workspaceId, workspaceGroups);
    byGroup.set(group.id, { spendUsd: 0, memberCount: 0, byUser: new Map() });
    aiSpendByGroup.set(group.id, new Map());
    nonAiSpendByGroup.set(group.id, new Map());
  }
  for (const [workspaceId, workspaceGroups] of groupsByWorkspace) {
    const owners = new Map<string, RollupGroup>();
    for (const group of workspaceGroups) {
      for (const userId of membersByGroup.get(group.id) ?? []) {
        if (!owners.has(userId)) owners.set(userId, group);
      }
    }
    ownerByWorkspaceUser.set(workspaceId, owners);
  }

  const byUser = new Map<string, number>();
  const aiSpendByUser = new Map<string, number>();
  const nonAiSpendByUser = new Map<string, number>();
  const ungroupedByWorkspace = new Map<string, DedupedGroupRollup>();
  const byWorkspace = new Map<string, number>();
  const residualSpendByGroup = new Map(ordered.map((group) => [group.id, 0]));
  const projectToGroup = new Map<string, string>();
  const projectSpendByGroup = new Map<string, number>();
  const creatorByProject = new Map<string, string | null>();
  const aiSpendByProject = new Map<string, number>();
  const nonAiSpendByProject = new Map<string, number>();
  let projectUnattributedSpendUsd = 0;
  let projectPendingCount = 0;
  let reconciliationPendingCount = 0;
  let totalMemberCount = 0;
  let residualSpendUsd = 0;

  for (const workspaceId of scopedWorkspaceIds(snapshot)) {
    const owners = ownerByWorkspaceUser.get(workspaceId) ?? new Map();
    const ungrouped: DedupedGroupRollup = {
      spendUsd: 0,
      memberCount: 0,
      byUser: new Map(),
    };
    const authoritativeWorkspaceSpendUsd =
      snapshot.workspaces.get(workspaceId)?.totalCostUsd;
    let allocatedWorkspaceSpendUsd = 0;
    let observedWorkspaceSpendUsd = 0;
    const allocatable = (observedSpendUsd: number): number => {
      observedWorkspaceSpendUsd += observedSpendUsd;
      if (authoritativeWorkspaceSpendUsd === undefined) {
        allocatedWorkspaceSpendUsd += observedSpendUsd;
        return observedSpendUsd;
      }
      const allocated = Math.min(
        observedSpendUsd,
        Math.max(0, authoritativeWorkspaceSpendUsd - allocatedWorkspaceSpendUsd),
      );
      allocatedWorkspaceSpendUsd += allocated;
      return allocated;
    };

    const memberEntries = [
      ...(snapshot.members.get(workspaceId)?.entries() ?? []),
    ].sort(([a], [b]) => a.localeCompare(b));
    for (const [userId, usage] of memberEntries) {
      const observedAiSpendUsd = Math.max(
        0,
        Math.min(usage.totalCostUsd, usage.aiCostUsd),
      );
      const aiSpendUsd = allocatable(observedAiSpendUsd);
      const owner = owners.get(userId);
      if (owner) {
        addUserSpend(byGroup.get(owner.id)!, userId, aiSpendUsd);
        add(aiSpendByGroup.get(owner.id)!, userId, aiSpendUsd);
        add(aiSpendByUser, userId, aiSpendUsd);
        add(byUser, userId, aiSpendUsd);
        totalMemberCount += 1;
      } else if (aiSpendUsd !== 0) {
        addUserSpend(ungrouped, userId, aiSpendUsd);
      }
    }

    const projectInfo = projectInfoByWorkspace.get(workspaceId);
    const projectEntries = [
      ...(snapshot.projects.get(workspaceId)?.entries() ?? []),
    ].sort(([a], [b]) => a.localeCompare(b));
    for (const [projectId, usage] of projectEntries) {
      const projectKey = projectAttributionKey(workspaceId, projectId);
      const aiSpendUsd = Math.max(0, Math.min(usage.totalCostUsd, usage.aiCostUsd));
      const nonAiSpendUsd = Math.max(0, usage.totalCostUsd - aiSpendUsd);
      aiSpendByProject.set(projectKey, aiSpendUsd);
      nonAiSpendByProject.set(projectKey, nonAiSpendUsd);
      const info = projectInfo?.get(projectId);
      const creatorId = info?.creatorId ?? null;
      creatorByProject.set(projectKey, creatorId);
      const owner = creatorId === null ? undefined : owners.get(creatorId);
      const attributedNonAiSpendUsd = allocatable(nonAiSpendUsd);
      if (owner) {
        projectToGroup.set(projectKey, owner.id);
        add(projectSpendByGroup, owner.id, usage.totalCostUsd);
        addUserSpend(byGroup.get(owner.id)!, creatorId!, attributedNonAiSpendUsd);
        add(nonAiSpendByGroup.get(owner.id)!, creatorId!, attributedNonAiSpendUsd);
        add(nonAiSpendByUser, creatorId!, attributedNonAiSpendUsd);
        add(byUser, creatorId!, attributedNonAiSpendUsd);
      } else {
        projectUnattributedSpendUsd += usage.totalCostUsd;
        (ungrouped as { spendUsd: number }).spendUsd += attributedNonAiSpendUsd;
      }
      if (!info && nonAiSpendUsd > 1e-9) projectPendingCount += 1;
    }

    const workspaceSpendUsd =
      authoritativeWorkspaceSpendUsd ?? allocatedWorkspaceSpendUsd;
    byWorkspace.set(workspaceId, workspaceSpendUsd);
    const reconciliationResidual = workspaceSpendUsd -
      allocatedWorkspaceSpendUsd;
    if (reconciliationResidual > 1e-9) {
      (ungrouped as { spendUsd: number }).spendUsd += reconciliationResidual;
    }
    if (
      authoritativeWorkspaceSpendUsd !== undefined &&
      observedWorkspaceSpendUsd - authoritativeWorkspaceSpendUsd > 1e-9
    ) {
      reconciliationPendingCount += 1;
    }
    residualSpendUsd += ungrouped.spendUsd;
    if (ungrouped.memberCount > 0 || ungrouped.spendUsd !== 0) {
      ungroupedByWorkspace.set(workspaceId, ungrouped);
    }
  }

  const totalSpendUsd = [...byWorkspace.values()].reduce((sum, value) => sum + value, 0);
  const snapshotComplete =
    snapshot.status !== "partial" &&
    snapshot.status !== "empty" &&
    snapshot.coverage.failedWorkspaceDays.length === 0 &&
    snapshot.coverage.missingWorkspaceDays.length === 0 &&
    snapshot.coverage.missingAccountDays.length === 0;
  const pendingCount =
    snapshot.coverage.failedWorkspaceDays.length +
    snapshot.coverage.missingWorkspaceDays.length +
    snapshot.coverage.missingAccountDays.length +
    reconciliationPendingCount +
    projectPendingCount;
  const projectTotalSpendUsd = [...snapshot.projects.values()]
    .flatMap((projects) => [...projects.values()])
    .reduce((sum, project) => sum + project.totalCostUsd, 0);

  return {
    byGroup,
    byUser,
    ungroupedByWorkspace,
    totalSpendUsd,
    totalMemberCount,
    pendingCount,
    isComplete:
      snapshotComplete &&
      projectPendingCount === 0 &&
      reconciliationPendingCount === 0,
    byWorkspace,
    accountTotalUsd: snapshot.accountTotalUsd,
    accountReconciliationSpendUsd: snapshot.accountTotalUsd - totalSpendUsd,
    aiSpendByUser,
    nonAiSpendByUser,
    aiSpendByGroup,
    nonAiSpendByGroup,
    residualSpendByGroup,
    residualSpendUsd,
    projectAttribution: {
      projectToGroup,
      spendByGroup: projectSpendByGroup,
      creatorByProject,
      aiSpendByProject,
      nonAiSpendByProject,
      unattributedSpendUsd: projectUnattributedSpendUsd,
      totalSpendUsd: projectTotalSpendUsd,
      pendingCount: projectPendingCount,
      isComplete: projectPendingCount === 0,
    },
  };
}

export function usageSnapshotForDay(
  snapshot: UsageSnapshot,
  usageDate: string,
): UsageSnapshot {
  if (
    !snapshot.dailyMembers ||
    !snapshot.dailyProjects ||
    !snapshot.dailyWorkspaces
  ) {
    throw new Error("Daily rollups require a snapshot loaded with daily members");
  }
  const daily = snapshot.daily.get(usageDate);
  const workspaces = snapshot.dailyWorkspaces.get(usageDate) ?? new Map();
  const workspaceIds = scopedWorkspaceIds(snapshot);
  const failedWorkspaceDays = snapshot.coverage.failedWorkspaceDays.filter(
    (failed) => failed.usageDate === usageDate,
  );
  const failedWorkspaceIds = new Set(
    failedWorkspaceDays.map((failed) => failed.workspaceId),
  );
  const missingWorkspaceDays = workspaceIds
    .filter((workspaceId) =>
      !workspaces.has(workspaceId) && !failedWorkspaceIds.has(workspaceId))
    .map((workspaceId) => ({ workspaceId, usageDate }));
  const hasAccountDay = snapshot.accountDays.has(usageDate);
  const missingAccountDays = hasAccountDay ? [] : [usageDate];
  const totalExpected = workspaceIds.length + 1;
  const presentWorkspaceDays = [...workspaces.keys()].filter(
    (workspaceId) => !failedWorkspaceIds.has(workspaceId),
  ).length;
  const totalPresent = presentWorkspaceDays + (hasAccountDay ? 1 : 0);
  const isPartial =
    failedWorkspaceDays.length > 0 ||
    missingWorkspaceDays.length > 0 ||
    missingAccountDays.length > 0;
  return {
    ...snapshot,
    window: {
      start: `${usageDate}T00:00:00.000Z`,
      end: `${nextUtcDay(usageDate)}T00:00:00.000Z`,
    },
    members: snapshot.dailyMembers.get(usageDate) ?? new Map(),
    projects: snapshot.dailyProjects.get(usageDate) ?? new Map(),
    workspaces,
    daily: new Map(daily ? [[usageDate, daily]] : []),
    accountTotalUsd: daily?.accountTotalUsd ?? 0,
    status: isPartial
      ? "partial"
      : snapshot.status === "stale"
      ? "stale"
      : "complete",
    coverage: {
      requestedDays: 1,
      requestedWorkspaceDays: workspaceIds.length,
      presentWorkspaceDays,
      failedWorkspaceDays,
      missingWorkspaceDays,
      presentAccountDays: hasAccountDay ? 1 : 0,
      missingAccountDays,
      ratio: totalExpected === 0 ? 1 : totalPresent / totalExpected,
    },
  };
}

/**
 * Roll up every day independently so historical membership is never inferred
 * from another date. Completed past days use their immutable roster; uncovered
 * dates and the current UTC day use the live directory.
 */
export function computeHistoricalSnapshotUsageRollups(
  input: HistoricalSnapshotRollupInput,
): Map<string, SnapshotUsageRollup> {
  const result = new Map<string, SnapshotUsageRollup>();
  const start = input.snapshot.window.start.slice(0, 10);
  const exclusiveEnd = input.snapshot.window.end.slice(0, 10);
  for (let usageDate = start; usageDate < exclusiveEnd; usageDate = nextUtcDay(usageDate)) {
    const membersByGroup =
      usageDate < input.currentUtcDay &&
      input.completedRosterDays.has(usageDate)
        ? input.rosterMembersByDate.get(usageDate) ?? new Map()
        : input.currentMembersByGroup;
    result.set(usageDate, computeSnapshotUsageRollup({
      snapshot: usageSnapshotForDay(input.snapshot, usageDate),
      groups: input.groups,
      membersByGroup,
      projectInfoByWorkspace: input.projectInfoByWorkspace,
    }));
  }
  return result;
}

function nextUtcDay(day: string): string {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
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
  const byUser = new Map<string, number>();
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
      byUser.set(userId, spendUsd);
      totalSpendUsd += spendUsd;
    }
  }

  return {
    byGroup,
    byUser,
    ungroupedByWorkspace: new Map(),
    totalSpendUsd,
    totalMemberCount: seenUsers.size,
    pendingCount,
    isComplete: pendingCount === 0,
  };
}
