import { Router, type IRouter } from "express";
import { GetOrgBudgetOverviewResponse } from "@workspace/api-zod";
import { isAccountWide } from "../lib/authz";
import {
  buildBudgetTrackingPoints,
  buildScopedAccounting,
  prepareScopedAccounting,
  qualifiedGroupSpendComponents,
  qualifiedRollupTotals,
  reportingSemanticsForGroups,
} from "../services/scoped-accounting";
import {
  fixedTeamBudgetPeriodAsOf,
} from "../lib/usage-window";
import {
  assertStableReportingUsageGeneration,
  ReportingUsageTransitionError,
  REPORTING_USAGE_RETRY_AFTER_SECONDS,
} from "../lib/reporting-usage-transition";
import { getConfigurationSnapshot } from "../lib/configuration-snapshot";
import { projectAttributionKey } from "../lib/usage-rollup";
import type {
  ProjectMetadataSnapshot,
} from "../lib/project-metadata";
import type {
  ProjectUsageTotal,
} from "../lib/usage-store";
import type {
  SnapshotUsageRollup,
} from "../lib/usage-rollup";
import type { Authorization } from "../lib/authz";
import type { SpendRow } from "../services/scoped-accounting";

const router: IRouter = Router();
let nowForOrgInsights = () => new Date();

export function __setOrgInsightsNowForTests(now: (() => Date) | null): void {
  nowForOrgInsights = now ?? (() => new Date());
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

export function budgetAvailability(
  allocationUsd: number | null,
  spendUsd: number | null,
): { remainingUsd: number | null; percentUsed: number | null } {
  if (allocationUsd === null || spendUsd === null) {
    return { remainingUsd: null, percentUsed: null };
  }
  return {
    remainingUsd: round(allocationUsd - spendUsd),
    percentUsed: allocationUsd > 0
      ? round(spendUsd / allocationUsd * 100)
      : null,
  };
}

export function fundedBudgetAvailability(
  teams: ReadonlyArray<{
    allocationUsd: number | null;
    remainingUsd: number | null;
  }>,
) {
  const fundedTeams = teams.filter((team) => team.allocationUsd !== null);
  const resolvedTeams = fundedTeams.filter((team) => team.remainingUsd !== null);
  return {
    remainingUsd: resolvedTeams.length === 0 ? null : round(resolvedTeams.reduce(
      (sum, team) => sum + team.remainingUsd!, 0)),
    teamsOverBudget: resolvedTeams.length === 0 ? null : resolvedTeams.filter(
      (team) => team.remainingUsd! < 0).length,
    fundedTeamCount: fundedTeams.length,
    resolvedTeamCount: resolvedTeams.length,
    unresolvedTeamCount: fundedTeams.length - resolvedTeams.length,
  };
}

export function unassignedDetailObservation(input: {
  accountSpendUsd: number | null;
  workspaceIds: ReadonlySet<string>;
  coverage: {
    requestedDays: number;
    requestedWorkspaceDays: number;
    presentWorkspaceDays: number;
    failedWorkspaceDays: readonly unknown[];
    missingWorkspaceDays: readonly unknown[];
    presentAccountDays: number;
    missingAccountDays: readonly unknown[];
  };
}): "complete" | "partial" | "unavailable" {
  if (input.accountSpendUsd === null || input.workspaceIds.size === 0 ||
      input.coverage.presentWorkspaceDays === 0) return "unavailable";
  return input.coverage.presentWorkspaceDays ===
      input.coverage.requestedWorkspaceDays &&
      input.coverage.presentAccountDays === input.coverage.requestedDays &&
      input.coverage.failedWorkspaceDays.length === 0 &&
      input.coverage.missingWorkspaceDays.length === 0 &&
      input.coverage.missingAccountDays.length === 0
    ? "complete"
    : "partial";
}

type UnassignedDetailRow = {
  id: string;
  groupName: string | null;
  source: "unmapped_group" | "no_group" | "unresolved_difference";
  spendUsd: number;
};

export function buildUnassignedDetail(input: {
  accountSpendUsd: number | null;
  authz: Authorization;
  daily: ReadonlyMap<string, SnapshotUsageRollup>;
  groups: readonly { id: string; name: string; workspaceId: string }[];
  workspaceNames?: ReadonlyMap<string, string | null>;
  poolRows: readonly SpendRow[];
  observation: "complete" | "partial" | "unavailable";
}) {
  if (input.accountSpendUsd === null || input.observation === "unavailable") {
    return { observation: "unavailable" as const, workspaces: [] };
  }

  const teamRows = input.poolRows.filter((row) => row.id.startsWith("pool:team:"));
  const targetUnits = Math.round(round(
    input.accountSpendUsd -
      teamRows.reduce((sum, row) => sum + row.spendUsd, 0),
  ) * 1e8);
  const groupById = new Map(input.groups.map((group) => [group.id, group]));
  const unmappedGroupIds = new Set(input.poolRows
    .filter((row) => row.id.startsWith("pool:group:"))
    .flatMap((row) => row.sourceGroupIds ?? []));
  const candidates: Array<{
    workspaceId: string | null;
    workspaceName: string | null;
    rawSpendUsd: number;
    row: Omit<UnassignedDetailRow, "spendUsd">;
  }> = [];

  for (const groupId of [...unmappedGroupIds].sort()) {
    const group = groupById.get(groupId);
    if (!group) continue;
    const rawSpendUsd = [...input.daily.values()].reduce((sum, rollup) =>
      sum + qualifiedGroupSpendComponents(rollup, input.authz, [group]).spendUsd, 0);
    if (Math.abs(rawSpendUsd) < 0.5e-8) continue;
    candidates.push({
      workspaceId: group.workspaceId,
      workspaceName: input.workspaceNames?.get(group.workspaceId) ??
        input.poolRows.find((row) =>
          row.workspaceId === group.workspaceId)?.workspaceName ?? null,
      rawSpendUsd,
      row: {
        id: `group:${group.workspaceId}:${group.id}`,
        groupName: group.name,
        source: "unmapped_group",
      },
    });
  }
  for (const pool of input.poolRows.filter((row) =>
    row.id.startsWith("pool:unbudgeted:") && Math.abs(row.spendUsd) >= 0.5e-8)) {
    candidates.push({
      workspaceId: pool.workspaceId,
      workspaceName: pool.workspaceName,
      rawSpendUsd: pool.spendUsd,
      row: {
        id: `no-group:${pool.workspaceId}`,
        groupName: null,
        source: "no_group",
      },
    });
  }

  const locatedRawUnits = Math.round(
    candidates.reduce((sum, item) => sum + item.rawSpendUsd, 0) * 1e8);
  const roundingToleranceUnits = teamRows.length + 1;
  const locatedTargetUnits =
    Math.abs(targetUnits - locatedRawUnits) <= roundingToleranceUnits
      ? targetUnits
      : locatedRawUnits;
  const rows = candidates.map((item) => ({
    ...item,
    units: Math.round(item.rawSpendUsd * 1e8),
  }));
  if (rows.length > 0) {
    rows.sort((a, b) => b.rawSpendUsd - a.rawSpendUsd ||
      a.row.id.localeCompare(b.row.id));
    rows[0]!.units += locatedTargetUnits -
      rows.reduce((sum, item) => sum + item.units, 0);
  }

  const byWorkspace = new Map<string, {
    workspaceId: string | null;
    workspaceName: string | null;
    rows: UnassignedDetailRow[];
  }>();
  const add = (
    workspaceId: string | null,
    workspaceName: string | null,
    row: UnassignedDetailRow,
  ) => {
    const key = workspaceId ?? "\0";
    const workspace = byWorkspace.get(key) ?? {
      workspaceId,
      workspaceName,
      rows: [],
    };
    workspace.rows.push(row);
    byWorkspace.set(key, workspace);
  };
  for (const item of rows) {
    if (item.units === 0) continue;
    add(item.workspaceId, item.workspaceName, {
      ...item.row,
      spendUsd: item.units / 1e8,
    });
  }
  const unresolvedUnits = targetUnits - locatedTargetUnits;
  if (unresolvedUnits !== 0 || (rows.length === 0 && targetUnits !== 0)) {
    add(null, null, {
      id: "unresolved-difference",
      groupName: null,
      source: "unresolved_difference",
      spendUsd: (rows.length === 0 ? targetUnits : unresolvedUnits) / 1e8,
    });
  }

  const workspaces = [...byWorkspace.values()].map((workspace) => {
    workspace.rows.sort((a, b) => b.spendUsd - a.spendUsd ||
      a.id.localeCompare(b.id));
    return {
      ...workspace,
      spendUsd: round(workspace.rows.reduce((sum, row) => sum + row.spendUsd, 0)),
    };
  }).sort((a, b) => b.spendUsd - a.spendUsd ||
    (a.workspaceName ?? a.workspaceId ?? "").localeCompare(
      b.workspaceName ?? b.workspaceId ?? ""));
  return { observation: input.observation, workspaces };
}

export function projectCoverageGaps(input: {
  dailyProjects: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<string, ProjectUsageTotal>>
  >;
  dailyRollups: ReadonlyMap<string, SnapshotUsageRollup>;
  metadata: ProjectMetadataSnapshot;
  teamByGroupId: ReadonlyMap<string, string>;
}): {
  byTeamDay: Set<string>;
  unknownWorkspaceDay: Set<string>;
} {
  const byTeamDay = new Set<string>();
  const unknownWorkspaceDay = new Set<string>();
  for (const [date, byWorkspace] of input.dailyProjects) {
    const rollup = input.dailyRollups.get(date);
    for (const [workspaceId, projects] of byWorkspace) {
      const attribution =
        input.metadata.attributionByWorkspace?.get(workspaceId);
      const currentCatalog = input.metadata.byWorkspace.get(workspaceId);
      for (const [projectId, usage] of projects) {
        const retainedCandidate = attribution?.get(projectId);
        const creatorId = retainedCandidate
          ? retainedCandidate.creatorId
          : currentCatalog?.get(projectId)?.creatorId ?? null;
        if (usage.totalCostUsd - usage.aiCostUsd <= 1e-9) continue;
        const projectKey = projectAttributionKey(workspaceId, projectId);
        const groupId = rollup?.projectAttribution.projectToGroup.get(projectKey);
        const teamId = groupId ? input.teamByGroupId.get(groupId) : undefined;
        if (teamId) {
          byTeamDay.add(`${teamId}\0${date}`);
        } else if (
          !creatorId ||
          !rollup?.projectAttribution.creatorByProject.get(projectKey)
        ) {
          // Ownership is genuinely unknown. Any team sharing this workspace
          // could own the spend, so none may claim complete coverage.
          unknownWorkspaceDay.add(`${workspaceId}\0${date}`);
        }
        // A known creator with no canonical group is honestly unassigned and
        // cannot make a funded team's line incomplete.
      }
    }
  }
  return { byTeamDay, unknownWorkspaceDay };
}

router.get("/org-insights", async (req, res): Promise<void> => {
  const authz = req.authz!;
  if (!authz.capabilities.canViewAccountUsage ||
      !isAccountWide(authz)) {
    res.status(403).json({ error: "Account-wide usage access required" });
    return;
  }
  if (Object.keys(req.query).length > 0) {
    res.status(400).json({
      error: "This report has a fixed account-wide scope and allocation term",
    });
    return;
  }

  try {
    assertStableReportingUsageGeneration();
    const now = nowForOrgInsights();
    const period = fixedTeamBudgetPeriodAsOf(now);
    const query = {
      rangeType: "custom",
      startDate: period.periodStart,
      endDate: period.asOf ?? period.periodStart,
      viewScope: "all_authorized",
    };
    const prepared = await prepareScopedAccounting(
      authz, query, undefined, req.configurationSnapshot);
    const result = await buildScopedAccounting(
      authz, query, undefined, prepared);
    const currentConfiguration = await getConfigurationSnapshot();
    assertStableReportingUsageGeneration(prepared.usageGeneration);
    if (currentConfiguration.revision !== prepared.allocationRevision) {
      res.status(503).json({
        error: "Committed accounting inputs changed while composing report",
        retryable: true,
      });
      return;
    }

    const workspaceUnavailable = new Set([
      ...result.usage.snapshot.coverage.failedWorkspaceDays,
      ...result.usage.snapshot.coverage.missingWorkspaceDays,
    ].map((item) => `${item.workspaceId}\0${item.usageDate}`));
    const groupsById = new Map(result.usage.groups.map((group) => [group.id, group]));
    const teamRows = result.poolRows.filter((row) =>
      row.id.startsWith("pool:team:"));
    const teamByGroupId = new Map(teamRows.flatMap((row) =>
      (row.sourceGroupIds ?? []).map((groupId) => [groupId, row.id] as const)));
    const projectGaps = projectCoverageGaps({
      dailyProjects: result.usage.snapshot.dailyProjects ?? new Map(),
      dailyRollups: result.daily,
      metadata: result.usage.projectMetadata,
      teamByGroupId,
    });
    const teams = teamRows.map((row) => {
      const sourceGroups = (row.sourceGroupIds ?? [])
        .map((id) => groupsById.get(id))
        .filter((group): group is NonNullable<typeof group> => group !== undefined);
      const sourceWorkspaceIds = new Set(
        sourceGroups.map((group) => group.workspaceId));
      const reporting = reportingSemanticsForGroups(result.daily, sourceGroups);
      const dailySpend = new Map<string, number>();
      const unavailableDays = new Set<string>();
      for (const [date, rollup] of result.daily) {
        const missingWorkspaceCount = [...sourceWorkspaceIds].filter(
          (workspaceId) =>
            workspaceUnavailable.has(`${workspaceId}\0${date}`),
        ).length;
        if (sourceWorkspaceIds.size > 0 &&
            missingWorkspaceCount === sourceWorkspaceIds.size) {
          unavailableDays.add(date);
        } else {
          dailySpend.set(date, round(
            qualifiedGroupSpendComponents(
              rollup, authz, sourceGroups,
            ).spendUsd));
        }
      }
      // The canonical pool already distinguishes observed assigned usage from
      // unavailable usage. Its committed empty assignment is recorded zero;
      // requiring a workspace here incorrectly discards that valid balance.
      // An absent source list or unresolved source ID is not an empty assignment.
      const hasUsageScope = row.usageObserved &&
        row.sourceGroupIds !== undefined &&
        sourceGroups.length === row.sourceGroupIds.length;
      const complete = period.asOf !== null &&
        hasUsageScope &&
        reporting.comparisonsVerified &&
        row.allocationUsd !== null;
      const spendUsd = period.asOf !== null && hasUsageScope
        ? row.spendUsd
        : null;
      const availability = budgetAvailability(row.allocationUsd, spendUsd);
      return {
        id: row.id,
        name: row.name,
        allocationUsd: row.allocationUsd,
        spendUsd,
        ...availability,
        complete,
        reporting,
        points: period.asOf === null
          ? []
          : hasUsageScope
          ? buildBudgetTrackingPoints(
              result.period.start,
              result.period.endExclusive,
              dailySpend,
              unavailableDays,
            )
          : buildBudgetTrackingPoints(
              result.period.start,
              result.period.endExclusive,
              new Map(),
              new Set([...result.daily.keys()]),
            ),
      };
    });
    const usageObserved = period.asOf !== null &&
      result.usage.snapshot.accountDays.size > 0;
    const accountSpendUsd = usageObserved ? result.accounting.eligibleSpendUsd : null;
    const accountDailySpend = new Map<string, number>();
    const accountUnavailableDays = new Set<string>();
    for (const [date, rollup] of result.daily) {
      const unavailableWorkspaceCount = [...result.usage.workspaceIds].filter(
        (workspaceId) =>
          workspaceUnavailable.has(`${workspaceId}\0${date}`),
      ).length;
      if (!usageObserved || result.usage.workspaceIds.size === 0 ||
          unavailableWorkspaceCount === result.usage.workspaceIds.size) {
        accountUnavailableDays.add(date);
      } else {
        accountDailySpend.set(
          date,
          qualifiedRollupTotals(rollup, authz, result.usage.groups)
            .eligibleSpendUsd,
        );
      }
    }
    const accountPoints = period.asOf === null
      ? []
      : buildBudgetTrackingPoints(
          result.period.start,
          result.period.endExclusive,
          accountDailySpend,
          accountUnavailableDays,
        );
    // Unresolved team inputs may withhold that team's balance, but must not
    // reclassify its already-recorded assigned charges as unassigned.
    const knownTeamSpend = teamRows.reduce(
      (sum, team) => sum + team.spendUsd, 0);
    const fundedTeams = teams.filter((team) => team.allocationUsd !== null);
    const fundedAvailability = fundedBudgetAvailability(teams);
    const complete = teams.length > 0 &&
      result.metadata.status === "complete" &&
      teams.every((team) => team.complete);
    const unassignedSpendUsd = accountSpendUsd === null
      ? null
      : round(accountSpendUsd - knownTeamSpend);
    const accountReporting = reportingSemanticsForGroups(
      result.daily,
      result.usage.groups,
    );
    const unassignedDetail = buildUnassignedDetail({
      accountSpendUsd,
      authz,
      daily: result.daily,
      groups: result.usage.groups,
      workspaceNames: new Map([...result.dir.workspaces].map(
        ([id, workspace]) => [id, workspace.name])),
      poolRows: result.poolRows,
      observation: unassignedDetailObservation({
        accountSpendUsd,
        workspaceIds: result.usage.workspaceIds,
        coverage: result.usage.snapshot.coverage,
      }),
    });
    const response = {
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      asOf: period.asOf,
      complete,
      reporting: accountReporting,
      qualification: [
        "Amounts are allocation-eligible committed usage. Remaining includes funded teams only, excluding unfunded residual and unassigned account spend.",
        ...(period.asOf === null
          ? ["Usage is unavailable before the allocation term starts."]
          : []),
        ...(teams.some((team) =>
          team.reporting.rosterAttributionBasis === "current_membership")
          ? ["Missing historical rosters use current membership, not verified historical membership."]
          : []),
        ...(teams.some((team) =>
          team.reporting.acquisitionCoverage === "partial")
          ? ["Usage coverage is partial; missing facts are not zero."]
          : []),
        ...(teams.some((team) =>
          team.reporting.creatorAttributionBasis ===
            "current_catalog_observation" ||
          team.reporting.creatorAttributionBasis === "mixed")
          ? ["Some creator attribution uses current project metadata, not verified historical ownership."]
          : []),
        ...(projectGaps.byTeamDay.size > 0
          ? ["Project metadata is incomplete for affected teams."]
          : []),
        ...(projectGaps.unknownWorkspaceDay.size > 0
          ? ["Some project ownership is unknown."]
          : []),
        ...result.metadata.qualifications,
      ].join(" "),
      summary: {
        accountSpendUsd,
        teamAllocationUsd: fundedTeams.length > 0
          ? round(fundedTeams.reduce(
              (sum, team) => sum + team.allocationUsd!, 0))
          : null,
        ...fundedAvailability,
        unassignedSpendUsd,
      },
      accountPoints,
      unassignedDetail,
      teams,
    };
    res.json(GetOrgBudgetOverviewResponse.parse(response));
  } catch (error) {
    if (error instanceof ReportingUsageTransitionError) {
      res.locals.reportingUsageRefreshing = true;
      res.setHeader("Retry-After", String(REPORTING_USAGE_RETRY_AFTER_SECONDS));
      res.status(503).json({ error: error.message, code: error.code });
      return;
    }
    res.status(503).json({
      error: error instanceof Error ? error.message : "Stored accounting unavailable",
    });
  }
});

export default router;
