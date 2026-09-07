import type { Authorization } from "./authz";
import type { UsageSnapshot } from "./usage-store";
import type { SnapshotUsageRollup } from "./usage-rollup";
import {
  qualifiedRollupTotals,
  qualifiedUserSpendByWorkspace,
} from "../services/scoped-accounting";

const DAY_MS = 86_400_000;

export interface DashboardInsightsUsage {
  authz: Authorization;
  groups: readonly { id: string; workspaceId: string }[];
  workspaceIds: ReadonlySet<string>;
  snapshot: UsageSnapshot;
  rollup: SnapshotUsageRollup;
}

export interface DashboardInsightsDirectory {
  members: ReadonlyMap<string, {
    name?: string | null;
    username?: string | null;
  }>;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

function dayRange(start: string, endExclusive: string): string[] {
  const startMs = Date.parse(start);
  const endMs = Date.parse(endExclusive);
  return Array.from(
    { length: Math.max(0, (endMs - startMs) / DAY_MS) },
    (_, index) => new Date(startMs + index * DAY_MS).toISOString().slice(0, 10),
  );
}

function coverageForDay(snapshot: UsageSnapshot, day: string): boolean {
  if (snapshot.coverage.missingWorkspaceDays.some((item) =>
    item.usageDate === day)) return false;
  if (snapshot.coverage.failedWorkspaceDays.some((item) =>
    item.usageDate === day)) return false;
  return !snapshot.includesAccountAnchor ||
    !snapshot.coverage.missingAccountDays.includes(day);
}

function hasKnownDay(
  daily: ReadonlyMap<string, SnapshotUsageRollup>,
  day: string,
): boolean {
  return daily.has(day);
}

function totalsForWindow(
  usage: DashboardInsightsUsage,
  daily: ReadonlyMap<string, SnapshotUsageRollup>,
  start: string,
  endExclusive: string,
) {
  const days = dayRange(start, endExclusive);
  const known = days.filter((day) => hasKnownDay(daily, day));
  const totals = known.map((day) =>
    qualifiedRollupTotals(daily.get(day)!, usage.authz, usage.groups));
  return {
    days,
    known,
    complete: days.length > 0 && days.every((day) =>
      coverageForDay(usage.snapshot, day) && hasKnownDay(daily, day)),
    spendUsd: totals.length === 0 ? null : round(totals.reduce(
      (sum, item) => sum + item.reportedSpendUsd, 0)),
    agentSpendUsd: totals.length === 0 ? null : round(totals.reduce(
      (sum, item) => sum + item.agentSpendUsd, 0)),
  };
}

function calendarMonth(year: number, month: number) {
  return {
    start: new Date(Date.UTC(year, month, 1)).toISOString(),
    endExclusive: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

export function dashboardInsightsReadWindow(
  selectedStart: string,
  now = new Date(),
  cutoff: string,
): { startDate: string; endDate: string } {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1);
  const selectedStartMs = Date.parse(selectedStart);
  const selectedDays = Math.max(
    1,
    Math.ceil((Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
    ) - selectedStartMs) / DAY_MS),
  );
  const priorStart = selectedStartMs - selectedDays * DAY_MS;
  const start = Math.max(Date.parse(cutoff), Math.min(monthStart, priorStart));
  return {
    startDate: new Date(start).toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
  };
}

export function buildDashboardInsights(input: {
  selected: DashboardInsightsUsage;
  selectedDaily: ReadonlyMap<string, SnapshotUsageRollup>;
  expanded: DashboardInsightsUsage;
  expandedDaily: ReadonlyMap<string, SnapshotUsageRollup>;
  directory: DashboardInsightsDirectory;
  period: { start: string; endExclusive: string };
  now?: Date;
  cutoff: string;
  projectAttributionComplete: boolean;
}) {
  const now = input.now ?? new Date();
  const selected = totalsForWindow(
    input.selected, input.selectedDaily, input.period.start, input.period.endExclusive);
  const userByWorkspace = qualifiedUserSpendByWorkspace(
    input.selectedDaily,
    input.selected.authz,
    input.selected.groups,
    input.selected.workspaceIds,
  );
  const users = new Map<string, number>();
  for (const workspaceUsers of userByWorkspace.values()) {
    for (const [userId, amount] of workspaceUsers) {
      users.set(userId, (users.get(userId) ?? 0) + amount.agent + amount.other);
    }
  }
  const active = [...users].filter(([, amount]) => amount > 0);
  const activeUsers = selected.known.length === 0 ? null : active.length;
  const selectedDays = [...input.selectedDaily]
    .filter(([day]) =>
      day >= input.period.start.slice(0, 10) &&
      day < input.period.endExclusive.slice(0, 10))
    .map(([day, rollup]) => ({
      date: day,
      spendUsd: qualifiedRollupTotals(
        rollup, input.selected.authz, input.selected.groups).reportedSpendUsd,
    }))
    .filter((item) => item.spendUsd > 0);
  const busiest = selectedDays.sort((a, b) =>
    b.spendUsd - a.spendUsd || a.date.localeCompare(b.date))[0];

  const duration = Date.parse(input.period.endExclusive) -
    Date.parse(input.period.start);
  const previousStartMs = Date.parse(input.period.start) - duration;
  const previousStart = new Date(previousStartMs).toISOString();
  const previous = previousStartMs < Date.parse(input.cutoff)
    ? null
    : totalsForWindow(
      input.expanded,
      input.expandedDaily,
      previousStart,
      input.period.start,
    );
  const previousPeriodSpendUsd =
    previous?.complete ? previous.spendUsd : null;
  const changePercent = previousPeriodSpendUsd !== null &&
      previousPeriodSpendUsd > 0 && selected.complete && selected.spendUsd !== null
    ? round((selected.spendUsd - previousPeriodSpendUsd) /
      previousPeriodSpendUsd * 100)
    : null;

  const currentMonth = now.getUTCMonth();
  const currentYear = now.getUTCFullYear();
  const todayEnd = new Date(Date.UTC(
    currentYear, currentMonth, now.getUTCDate() + 1)).toISOString();
  const monthly = Array.from({ length: 6 }, (_, index) => {
    const month = calendarMonth(currentYear, currentMonth - 5 + index);
    const observedStart = new Date(Math.max(
      Date.parse(month.start), Date.parse(input.cutoff))).toISOString();
    const observedEnd = new Date(Math.min(
      Date.parse(month.endExclusive), Date.parse(todayEnd))).toISOString();
    const outsideCoverage = Date.parse(month.start) < Date.parse(input.cutoff);
    const futureOnly = Date.parse(observedEnd) <= Date.parse(observedStart);
    const totals = futureOnly ? null : totalsForWindow(
      input.expanded, input.expandedDaily, observedStart, observedEnd);
    const observedDaily = new Map([...input.expandedDaily].filter(([day]) =>
      day >= observedStart.slice(0, 10) && day < observedEnd.slice(0, 10)));
    const monthlyUserByWorkspace = qualifiedUserSpendByWorkspace(
      observedDaily,
      input.expanded.authz,
      input.expanded.groups,
      input.expanded.workspaceIds,
    );
    const monthlyUsers = new Map<string, number>();
    for (const workspaceUsers of monthlyUserByWorkspace.values()) {
      for (const [userId, amount] of workspaceUsers) {
        monthlyUsers.set(
          userId,
          (monthlyUsers.get(userId) ?? 0) + amount.agent + amount.other,
        );
      }
    }
    const isPartial = outsideCoverage ||
      Date.parse(month.endExclusive) > Date.parse(todayEnd) ||
      !!totals && !totals.complete;
    const isMissing = outsideCoverage || !totals || totals.known.length === 0 ||
      !totals.complete;
    return {
      ...month,
      spendUsd: totals?.spendUsd ?? null,
      agentSpendUsd: totals?.agentSpendUsd ?? null,
      otherSpendUsd: totals?.spendUsd === null || totals?.spendUsd === undefined ||
          totals.agentSpendUsd === null
        ? null
        : round(totals.spendUsd - totals.agentSpendUsd),
      activeUsers: !totals || totals.known.length === 0
        ? null
        : [...monthlyUsers.values()].filter((amount) => amount > 0).length,
      isPartial,
      isMissing,
    };
  });

  const projectKeys = new Set([
    ...input.selected.rollup.projectAttribution.aiSpendByProject.keys(),
    ...input.selected.rollup.projectAttribution.nonAiSpendByProject.keys(),
  ].filter((key) => {
    const [workspaceId] = key.split("\u0000");
    if (input.selected.authz.roles.includes("account") ||
        input.selected.authz.workspaceIds.includes(workspaceId!)) return true;
    const groupId =
      input.selected.rollup.projectAttribution.projectToGroup.get(key);
    const creatorId =
      input.selected.rollup.projectAttribution.creatorByProject.get(key);
    if (
      input.selected.authz.roles.length === 1 &&
      input.selected.authz.roles[0] === "member" &&
      input.selected.authz.userIds?.length === 1 &&
      input.selected.authz.userIds[0] === input.selected.authz.userId &&
      creatorId === input.selected.authz.userId
    ) return true;
    return !!groupId && !!creatorId &&
      (input.selected.authz.groupUserIds?.[groupId] ?? []).includes(creatorId);
  }));
  return {
    activeUsers,
    avgSpendPerActiveUserUsd: activeUsers && selected.spendUsd !== null
      ? round(selected.spendUsd / activeUsers)
      : null,
    activeDays: selected.known.length === 0 ? null : selectedDays.length,
    busiestDay: busiest
      ? { date: busiest.date, spendUsd: round(busiest.spendUsd) }
      : null,
    previousPeriodSpendUsd,
    changePercent,
    categories: [
      {
        key: "agent",
        label: "Agent",
        spendUsd: selected.agentSpendUsd,
        activeUsers: selected.known.length === 0
          ? null
          : [...users.keys()].filter((userId) =>
            [...userByWorkspace.values()].some((workspaceUsers) =>
              (workspaceUsers.get(userId)?.agent ?? 0) > 0)).length,
      },
      {
        key: "other_services",
        label: "Other services",
        spendUsd: selected.spendUsd === null || selected.agentSpendUsd === null
          ? null
          : round(selected.spendUsd - selected.agentSpendUsd),
        activeUsers: selected.known.length === 0
          ? null
          : [...users.keys()].filter((userId) =>
            [...userByWorkspace.values()].some((workspaceUsers) =>
              (workspaceUsers.get(userId)?.other ?? 0) > 0)).length,
      },
    ],
    monthly,
    topSpenders: active.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([id, spendUsd]) => {
        const member = input.directory.members.get(id);
        return {
          id,
          name: member?.name ?? member?.username ?? id,
          spendUsd: round(spendUsd),
        };
      }),
    projectCount: input.projectAttributionComplete ? projectKeys.size : null,
  };
}