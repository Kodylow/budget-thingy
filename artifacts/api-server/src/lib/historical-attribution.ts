import type { EnterpriseGroup } from "./enterprise";

export interface HistoricalWorkspaceUsage {
  byUser: ReadonlyMap<string, number>;
  unattributableTotalCostUsd: number;
}

export interface HistoricalAttribution {
  spendByGroup: Map<string, number>;
  totalSpendUsd: number;
  isComplete: boolean;
}

export function mergeHistoricalGroupSpend(
  primaryGroupIds: readonly string[],
  mergeMap: ReadonlyMap<string, readonly string[]>,
  spendByGroup: ReadonlyMap<string, number>,
): Map<string, number> {
  return new Map(primaryGroupIds.map((primaryGroupId) => [
    primaryGroupId,
    (mergeMap.get(primaryGroupId) ?? [primaryGroupId]).reduce(
      (sum, sourceId) => sum + (spendByGroup.get(sourceId) ?? 0),
      0,
    ),
  ]));
}

/**
 * Attribute one UTC day's workspace-authoritative member usage with that day's
 * immutable roster. Overlapping members are owned by the first group in the
 * same stable ordering used by the live canonical rollup.
 */
export function attributeHistoricalDay(
  groups: readonly EnterpriseGroup[],
  membersByGroup: ReadonlyMap<string, readonly string[]>,
  workspaceIds: ReadonlySet<string>,
  usageByWorkspace: ReadonlyMap<string, HistoricalWorkspaceUsage>,
): HistoricalAttribution {
  const ordered = [...groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const spendByGroup = new Map(ordered.map((group) => [group.id, 0]));
  let totalSpendUsd = 0;
  let isComplete = true;

  for (const workspaceId of [...workspaceIds].sort()) {
    const usage = usageByWorkspace.get(workspaceId);
    if (!usage) {
      isComplete = false;
      continue;
    }
    totalSpendUsd += usage.unattributableTotalCostUsd;
    const workspaceGroups = ordered.filter((group) => group.workspaceId === workspaceId);
    for (const [userId, spendUsd] of usage.byUser) {
      totalSpendUsd += spendUsd;
      const owner = workspaceGroups.find((group) =>
        (membersByGroup.get(group.id) ?? []).includes(userId)
      );
      if (owner) {
        spendByGroup.set(owner.id, (spendByGroup.get(owner.id) ?? 0) + spendUsd);
      }
    }
  }

  return { spendByGroup, totalSpendUsd, isComplete };
}

export interface TrendComponent {
  startDate: string;
  endDate: string;
  rosterDate: string | null;
}

export function membersForUsageDay(
  usageDate: string,
  currentUtcDay: string,
  currentMembersByGroup: ReadonlyMap<string, readonly string[]>,
  completedRosterDays: ReadonlySet<string>,
  rosterMembersByDate: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >,
): ReadonlyMap<string, readonly string[]> {
  if (usageDate < currentUtcDay && completedRosterDays.has(usageDate)) {
    return rosterMembersByDate.get(usageDate) ?? new Map();
  }
  return currentMembersByGroup;
}

function nextUtcDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Split a trend bucket only where immutable daily rosters exist. Uncovered
 * historical dates stay coalesced so pre-snapshot trends retain the old,
 * rate-efficient behavior. The current UTC day is always live.
 */
export function partitionTrendBucket(
  startDate: string,
  endDate: string,
  completedRosterDays: ReadonlySet<string>,
  currentUtcDay: string,
): TrendComponent[] {
  const result: TrendComponent[] = [];
  let uncoveredStart: string | null = null;
  let day = startDate;
  while (day <= endDate) {
    const useRoster = day < currentUtcDay && completedRosterDays.has(day);
    if (useRoster) {
      if (uncoveredStart) {
        const previous = new Date(`${day}T00:00:00.000Z`);
        previous.setUTCDate(previous.getUTCDate() - 1);
        result.push({
          startDate: uncoveredStart,
          endDate: previous.toISOString().slice(0, 10),
          rosterDate: null,
        });
        uncoveredStart = null;
      }
      result.push({ startDate: day, endDate: day, rosterDate: day });
    } else {
      uncoveredStart ??= day;
    }
    day = nextUtcDay(day);
  }
  if (uncoveredStart) {
    result.push({ startDate: uncoveredStart, endDate, rosterDate: null });
  }
  return result;
}