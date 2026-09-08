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
    const response = {
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      asOf: period.asOf,
      complete,
      reporting: reportingSemanticsForGroups(
        result.daily,
        result.usage.groups,
      ),
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
