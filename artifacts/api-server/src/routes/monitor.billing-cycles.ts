import { Router, type IRouter } from "express";
import {
  GetBillingCycleComparisonQueryParams,
  GetBillingCycleComparisonResponse,
} from "@workspace/api-zod";
import { db, teamLimitTargetsTable } from "@workspace/db";
import { getRosterHistory } from "../lib/history";
import {
  billingCycleWindows,
  buildBillingCyclePoints,
  isFutureOnlyComparisonSelection,
  selectedComparisonWindows,
  type DailyComparisonValue,
} from "../lib/billing-cycle-comparison";
import {
  computeHistoricalSnapshotUsageRollups,
} from "../lib/usage-rollup";
import { readUsageSnapshot } from "../lib/usage-store";
import {
  USAGE_DATA_CUTOFF_ISO,
  UsageWindowError,
} from "../lib/usage-window";
import { qualifiedGroupSpendComponents } from "../services/scoped-accounting";
import {
  getBillingPeriodMetadata,
  getDirectory,
  isAccountWide,
  readProjectMetadata,
  targetTeamForGroup,
  windowFromQuery,
  visibleGroupMembers,
  visibleGroups,
  visibleRosterMembers,
} from "./monitor.shared";

const router: IRouter = Router();
const DAY_MS = 86_400_000;

export function ownAuthorizedTeamGroups<
  T extends { id: string; teamName: string | null },
>(
  allGroups: readonly T[],
  authorizedGroupIds: ReadonlySet<string>,
  ownGroupIds: ReadonlySet<string>,
): T[] {
  const ownTeamNames = new Set(
    allGroups
      .filter((group) => ownGroupIds.has(group.id))
      .map((group) => group.teamName)
      .filter((name): name is string => name !== null),
  );
  return allGroups.filter((group) =>
    authorizedGroupIds.has(group.id) &&
    group.teamName !== null &&
    ownTeamNames.has(group.teamName));
}

function activePersonalWorkspaceIds(
  dir: Awaited<ReturnType<typeof getDirectory>>,
  userId: string,
): Set<string> {
  return new Set(
    [...(dir.members.get(userId)?.workspaces ?? [])]
      .filter(([, membership]) => !membership.isDisabled)
      .map(([workspaceId]) => workspaceId),
  );
}

function observedWorkspaceCount(
  snapshot: Awaited<ReturnType<typeof readUsageSnapshot>>,
  date: string,
  workspaceIds: ReadonlySet<string>,
): number {
  const failed = new Set(snapshot.coverage.failedWorkspaceDays
    .filter((item) => item.usageDate === date)
    .map((item) => item.workspaceId));
  const observed = snapshot.dailyWorkspaces?.get(date);
  return [...workspaceIds].filter((id) =>
    observed?.has(id) === true && !failed.has(id)).length;
}

export function personalDailyComparison(
  snapshot: Awaited<ReturnType<typeof readUsageSnapshot>>,
  date: string,
  workspaceIds: ReadonlySet<string>,
  userId: string,
): DailyComparisonValue {
  const observed = observedWorkspaceCount(snapshot, date, workspaceIds);
  let spendUsd = 0;
  let metricsComplete = true;
  for (const workspaceId of workspaceIds) {
    const entry = snapshot.dailyMembers?.get(date)?.get(workspaceId)?.get(userId);
    // This intentionally reads the uncapped member observation, exactly like
    // dashboardPersonalLimits. Canonical workspace reconciliation applies to
    // team accounting, not an individual's Agent-limit consumption.
    spendUsd += entry?.aiCostUsd ?? 0;
    if (entry !== undefined && entry.agentMetricsComplete !== true) {
      metricsComplete = false;
    }
  }
  return {
    knownSpendUsd: observed > 0 ? spendUsd : null,
    complete: workspaceIds.size > 0 &&
      observed === workspaceIds.size &&
      metricsComplete,
  };
}

export function hasImmutableTeamRoster(
  date: string,
  currentUtcDay: string,
  groupIds: readonly string[],
  completedDays: ReadonlySet<string>,
  membersByDate: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
): boolean {
  if (date >= currentUtcDay) return true;
  if (!completedDays.has(date)) return false;
  const day = membersByDate.get(date);
  return day !== undefined && groupIds.every((groupId) => day.has(groupId));
}

router.get("/spend/billing-cycles", async (req, res): Promise<void> => {
  const query = GetBillingCycleComparisonQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const legacyRequest = Object.keys(req.query).length === 0;
  const billing = getBillingPeriodMetadata();
  let cycles;
  try {
    const selection = legacyRequest ? null : windowFromQuery(query.data);
    if (
      selection &&
      isFutureOnlyComparisonSelection(selection.window.start)
    ) {
      res.status(400).json({
        error: "Selected comparison range starts after the current date",
      });
      return;
    }
    const selectedDays = selection
      ? (Date.parse(selection.window.end) - Date.parse(selection.window.start)) /
        DAY_MS
      : 0;
    if (selectedDays > 400) {
      res.status(400).json({ error: "Comparison ranges are limited to 400 days" });
      return;
    }
    cycles = legacyRequest
      ? billing.isFallback
        ? null
        : billingCycleWindows(billing.start, billing.end)
      : query.data.rangeType === "billing" && billing.isFallback
        ? null
        : selectedComparisonWindows({
          rangeType: query.data.rangeType ?? "full-term",
          selectedStart: selection!.window.start,
          selectedEndExclusive: selection!.window.end,
          billingStart: billing.start,
          billingEnd: billing.end,
        });
  } catch (error) {
    if (error instanceof UsageWindowError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!cycles) {
    res.status(503).json({
      error: "Verified billing-cycle metadata is unavailable",
    });
    return;
  }

  try {
    const [dir, assignments] = await Promise.all([
      getDirectory(),
      db.select().from(teamLimitTargetsTable),
    ]);
    const authz = req.authz!;
    const selectedWorkspaceId = query.data.workspaceId ?? null;
    const scopedGroups = visibleGroups(authz, dir.groups)
      .filter((group) =>
        selectedWorkspaceId === null ||
        group.workspaceId === selectedWorkspaceId);
    const groupsWithTeams = dir.groups.map((group) => ({
      ...group,
      teamName: targetTeamForGroup(group, dir.account, assignments) ?? null,
    }));
    const ownGroupIds = new Set(
      dir.groups
        .filter((group) =>
          (selectedWorkspaceId === null ||
            group.workspaceId === selectedWorkspaceId) &&
          dir.groupMembers.get(group.id)?.includes(authz.userId))
        .map((group) => group.id),
    );
    // This is deliberately the same intersection as /teams/budgets?scope=own:
    // membership establishes "own", while scopedGroups enforces authorization.
    const teamGroups = ownAuthorizedTeamGroups(
      groupsWithTeams,
      new Set(scopedGroups.map((group) => group.id)),
      ownGroupIds,
    ).filter((group) =>
      selectedWorkspaceId === null ||
      group.workspaceId === selectedWorkspaceId);
    const allPersonalWorkspaceIds = activePersonalWorkspaceIds(dir, authz.userId);
    const personalWorkspaceIds = selectedWorkspaceId === null
      ? allPersonalWorkspaceIds
      : allPersonalWorkspaceIds.has(selectedWorkspaceId)
        ? new Set([selectedWorkspaceId])
        : new Set<string>();
    const teamWorkspaceIds = new Set(teamGroups.map((group) => group.workspaceId));
    const workspaceIds = new Set([
      ...personalWorkspaceIds,
      ...teamWorkspaceIds,
    ]);
    const earliest = new Date(Math.max(
      Date.parse(cycles[2]!.start),
      Date.parse(USAGE_DATA_CUTOFF_ISO),
    )).toISOString();
    const tomorrow = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() + 1,
    )).toISOString();
    const requestedEnd = legacyRequest
      ? billing.end
      : cycles.reduce(
        (latest, cycle) =>
          cycle.endExclusive > latest ? cycle.endExclusive : latest,
        cycles[0]!.endExclusive,
      );
    const readEnd = requestedEnd < tomorrow ? requestedEnd : tomorrow;
    const [snapshot, projectMetadata] = await Promise.all([
      readUsageSnapshot({
        window: { start: earliest, end: readEnd },
        workspaceIds,
        includeDailyMembers: true,
        includeAccountAnchor: false,
      }),
      readProjectMetadata(workspaceIds),
    ]);
    const roster = await getRosterHistory(
      teamGroups.map((group) => group.id),
      earliest.slice(0, 10),
      new Date(Date.parse(readEnd) - DAY_MS).toISOString().slice(0, 10),
    );
    const today = new Date().toISOString().slice(0, 10);
    const daily = computeHistoricalSnapshotUsageRollups({
      snapshot,
      groups: teamGroups,
      currentUtcDay: today,
      currentMembersByGroup: visibleGroupMembers(authz, dir.groupMembers),
      internalUserIds: dir.internalUserIds,
      completedRosterDays: roster.completedDays,
      rosterMembersByDate: visibleRosterMembers(authz, roster.membersByDate),
      projectInfoByWorkspace: projectMetadata.attributionByWorkspace,
    });
    const personalByDate = new Map<string, DailyComparisonValue>();
    const teamByDate = new Map<string, DailyComparisonValue>();
    for (const [date, rollup] of daily) {
      personalByDate.set(date, personalDailyComparison(
        snapshot, date, personalWorkspaceIds, authz.userId));

      const teamObserved = observedWorkspaceCount(snapshot, date, teamWorkspaceIds);
      const immutableRoster = hasImmutableTeamRoster(
        date,
        today,
        teamGroups.map((group) => group.id),
        roster.completedDays,
        roster.membersByDate,
      );
      teamByDate.set(date, {
        knownSpendUsd: teamObserved > 0 && immutableRoster
          ? qualifiedGroupSpendComponents(rollup, authz, teamGroups).spendUsd
          : null,
        complete: teamGroups.length > 0 &&
          immutableRoster &&
          teamGroups.every((group) => dir.groupMembers.has(group.id)) &&
          teamObserved === teamWorkspaceIds.size &&
          rollup.isComplete,
      });
    }

    res.json(GetBillingCycleComparisonResponse.parse({
      cycles: cycles.map((cycle) => ({
        key: cycle.key,
        label: cycle.label,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        ...buildBillingCyclePoints(
          cycle, personalByDate, teamByDate, today),
      })),
      teamScope: selectedWorkspaceId === null && isAccountWide(authz)
        ? "complete"
        : "partial",
      hasTeams: teamGroups.length > 0,
    }));
  } catch (error) {
    req.log.error({ err: error }, "stored billing-cycle comparison failed");
    res.status(503).json({ error: "Billing-cycle comparison unavailable" });
  }
});

export default router;