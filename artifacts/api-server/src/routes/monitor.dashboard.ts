import { Router, type IRouter } from "express";
import {
  GetDashboardQueryParams,
  GetDashboardResponse,
} from "@workspace/api-zod";
import {
  bucketRollupSpend,
  buildScopedAccounting,
  currentCycleLimitMetrics,
  prepareScopedAccounting,
  personalProjectCatalog,
  qualifiedRollupTotals,
} from "../services/scoped-accounting";
import { buildDashboardBuckets } from "../services/dashboard-buckets";
import { UsageWindowError } from "../lib/usage-window";
import {
  dailyUsageRollups,
  getBillingPeriodMetadata,
  usageForRequest,
} from "./monitor.shared";
import {
  buildDashboardProjection,
  type ProjectionBudget,
} from "../lib/dashboard-projection";
import {
  getUsageSnapshotGeneration,
  isUsageGenerationUpdateActive,
  type UsageSnapshot,
} from "../lib/usage-store";
import {
  CONTRACT_TERM_END_EXCLUSIVE_ISO,
  USAGE_DATA_CUTOFF_ISO,
} from "../lib/usage-window";
import {
  buildDashboardInsights,
  dashboardInsightsReadWindow,
} from "../lib/dashboard-insights";

const router: IRouter = Router();
const DAY_MS = 86_400_000;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PLANNING_DAYS = 5 * 366;

export class DashboardGenerationChangedError extends Error {
  constructor() {
    super("Usage generation changed while composing dashboard");
    this.name = "DashboardGenerationChangedError";
  }
}

export function assertDashboardUsageGeneration(
  expected: number,
  rejectActive = false,
): void {
  if ((rejectActive && isUsageGenerationUpdateActive()) ||
      getUsageSnapshotGeneration() !== expected) {
    throw new DashboardGenerationChangedError();
  }
}

let afterAccountingHookForTests: (() => void | Promise<void>) | null = null;

export function __setDashboardAfterAccountingHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  afterAccountingHookForTests = hook;
}

function isUtcDay(value: string): boolean {
  if (!UTC_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

export function dashboardQueryError(query: {
  rangeType?: string;
  startDate?: string;
  endDate?: string;
  projectionHorizon?: string;
  planningEndDate?: string;
}): string | null {
  if (query.projectionHorizon === "planning_end") {
    if (!query.planningEndDate || !isUtcDay(query.planningEndDate)) {
      return "planning_end requires a valid planningEndDate in YYYY-MM-DD format";
    }
    const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const planningEnd = Date.parse(`${query.planningEndDate}T00:00:00.000Z`);
    if (planningEnd < today || planningEnd > today + MAX_PLANNING_DAYS * DAY_MS) {
      return "planningEndDate must be today or within the next five years";
    }
  } else if (query.planningEndDate) {
    return "planningEndDate is only valid with projectionHorizon=planning_end";
  }
  if (query.rangeType !== "custom") return null;
  if (!query.startDate || !query.endDate) {
    return "Custom ranges require startDate and endDate";
  }
  if (!isUtcDay(query.startDate) || !isUtcDay(query.endDate)) {
    return "Custom range dates must be valid UTC dates in YYYY-MM-DD format";
  }
  const start = Date.parse(`${query.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${query.endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return "Custom range startDate must not be after endDate";
  }
  return null;
}

export function dashboardDrillThrough(
  viewScope: string,
  start: string,
  endExclusive: string,
  search?: string,
): string {
  const params = new URLSearchParams({
    view: "groups",
    viewScope,
    rangeType: "custom",
    startDate: start.slice(0, 10),
    endDate: new Date(Date.parse(endExclusive) - DAY_MS).toISOString().slice(0, 10),
  });
  if (search) params.set("search", search);
  return `/spend?${params.toString()}`;
}

function defaultGranularity(start: string, end: string): "day" | "week" | "month" {
  const days = (Date.parse(end) - Date.parse(start)) / DAY_MS;
  return days <= 45 ? "day" : days <= 370 ? "week" : "month";
}

function addUtcDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS)
    .toISOString().slice(0, 10);
}

export function projectionTarget(
  query: { projectionHorizon?: string; planningEndDate?: string },
  periodStart: string,
  now = new Date(),
) {
  const kind = query.projectionHorizon ?? "month_end";
  if (kind === "cycle_end") {
    const billing = getBillingPeriodMetadata();
    const startMs = Date.parse(billing.start);
    const endMs = Date.parse(billing.end);
    const exactUtcDays = Number.isFinite(startMs) && Number.isFinite(endMs) &&
      startMs % DAY_MS === 0 && endMs % DAY_MS === 0;
    return {
      kind,
      start: exactUtcDays ? new Date(startMs).toISOString() : billing.start,
      endExclusive: billing.isFallback || !exactUtcDays
        ? null
        : new Date(endMs).toISOString(),
      verified: !billing.isFallback && exactUtcDays,
    } as const;
  }
  if (kind === "planning_end") {
    return {
      kind,
      start: periodStart,
      endExclusive: query.planningEndDate
        ? `${addUtcDays(query.planningEndDate, 1)}T00:00:00.000Z`
        : null,
      verified: true,
    } as const;
  }
  if (kind === "term_end") {
    return {
      kind,
      start: USAGE_DATA_CUTOFF_ISO,
      endExclusive: CONTRACT_TERM_END_EXCLUSIVE_ISO,
      verified: true,
    } as const;
  }
  if (kind === "year_end") {
    return {
      kind,
      start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString(),
      endExclusive: new Date(
        Date.UTC(now.getUTCFullYear() + 1, 0, 1),
      ).toISOString(),
      verified: true,
    } as const;
  }
  return {
    kind: "month_end" as const,
    start: new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), 1,
    )).toISOString(),
    endExclusive: new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth() + 1, 1,
    )).toISOString(),
    verified: true,
  };
}

export function dashboardRangeType(rangeType?: string): string {
  return rangeType ?? "full-term";
}

function matchingProjectionBudget(
  result: Awaited<ReturnType<typeof buildScopedAccounting>>,
  rangeType: string,
  target: ReturnType<typeof projectionTarget>,
): ProjectionBudget | null {
  if (result.scope.isPersonal) {
    if (rangeType !== "billing" || target.kind !== "cycle_end" ||
        !target.verified || target.start !== result.period.start ||
        result.personalLimits.length !== 1 ||
        result.dir.budgets.observation.status !== "complete") return null;
    const amount = result.personalLimits[0]!.amount;
    return amount === null ? null : {
      amountUsd: amount,
      kind: "personal_agent_limit",
      label: "Current workspace Agent limit",
    };
  }
  if (rangeType !== "full-term" ||
      (target.kind !== "planning_end" && target.kind !== "term_end") ||
      target.start !== result.period.start || result.poolRows.length === 0 ||
      result.accounting.unbudgetedUsd !== 0 ||
      result.accounting.reconciliationUsd !== 0 ||
      result.poolRows.some((row) =>
        row.kind !== "pool" || row.allocationUsd === null)) return null;
  const coveredSpend = result.poolRows.reduce((sum, row) => sum + row.spendUsd, 0);
  if (Math.abs(coveredSpend - result.accounting.eligibleSpendUsd) > 1e-7) return null;
  return {
    amountUsd: result.poolRows.reduce(
      (sum, row) => sum + (row.allocationUsd ?? 0), 0),
    kind: "canonical_allocation",
    label: "Canonical full-term allocation",
  };
}

export function dashboardPersonalLimits(
  result: Awaited<ReturnType<typeof buildScopedAccounting>>,
  snapshot: UsageSnapshot,
  now = new Date(),
) {
  if (!result.scope.isPersonal) return undefined;
  const billing = getBillingPeriodMetadata();
  const startDay = billing.start.slice(0, 10);
  const billingEndDay = billing.end.slice(0, 10);
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
  )).toISOString().slice(0, 10);
  const endDay = billingEndDay < tomorrow ? billingEndDay : tomorrow;
  const dailyMembers = snapshot.dailyMembers;
  const dailyWorkspaces = snapshot.dailyWorkspaces;
  const snapshotCoversCycle = !!dailyMembers && !!dailyWorkspaces &&
    snapshot.window.start.slice(0, 10) <= startDay &&
    snapshot.window.end.slice(0, 10) >= endDay;

  return result.personalLimits.map((limit) => {
    let currentCycleAgentSpendUsd: number | null = snapshotCoversCycle ? 0 : null;
    if (currentCycleAgentSpendUsd !== null) {
      for (
        let day = startDay;
        day < endDay;
        day = addUtcDays(day, 1)
      ) {
        const failed = snapshot.coverage.failedWorkspaceDays.some((item) =>
          item.workspaceId === limit.workspaceId && item.usageDate === day);
        const missing = snapshot.coverage.missingWorkspaceDays.some((item) =>
          item.workspaceId === limit.workspaceId && item.usageDate === day);
        const workspaceObserved =
          dailyWorkspaces!.get(day)?.has(limit.workspaceId) === true;
        const entry =
          dailyMembers!.get(day)?.get(limit.workspaceId)?.get(result.authz.userId);
        if (failed || missing || !workspaceObserved ||
            (entry !== undefined && entry.agentMetricsComplete !== true)) {
          currentCycleAgentSpendUsd = null;
          break;
        }
        currentCycleAgentSpendUsd += entry?.aiCostUsd ?? 0;
      }
    }
    const metrics = currentCycleLimitMetrics(
      limit.amount,
      currentCycleAgentSpendUsd,
    );
    return {
      ...limit,
      workspaceName:
        result.dir.workspaces.get(limit.workspaceId)?.name ?? null,
      currentCycleAgentSpendUsd: currentCycleAgentSpendUsd === null
        ? null
        : Math.round((currentCycleAgentSpendUsd + Number.EPSILON) * 1e8) / 1e8,
      currentCycleRemainingUsd: metrics.remainingUsd,
      currentCyclePercentUsed: metrics.percentUsed,
    };
  });
}

export function dashboardPersonalSpendByWorkspace(
  result: Awaited<ReturnType<typeof buildScopedAccounting>>,
) {
  if (!result.scope.isPersonal) return undefined;
  const startDay = result.period.start.slice(0, 10);
  const endDay = result.period.endExclusive.slice(0, 10);
  const requestedDays = Math.max(
    0,
    (Date.parse(`${endDay}T00:00:00.000Z`) -
      Date.parse(`${startDay}T00:00:00.000Z`)) / DAY_MS,
  );
  return result.personalLimits.map((limit) => {
    let agentSpendUsd = 0;
    let otherServicesUsd = 0;
    let sourceObserved = false;
    for (const rollup of result.daily.values()) {
      const agent = rollup.agentSpendByWorkspaceUser
        ?.get(limit.workspaceId)?.get(result.authz.userId);
      const other = rollup.otherSpendByWorkspaceUser
        ?.get(limit.workspaceId)?.get(result.authz.userId);
      if (agent !== undefined || other !== undefined) sourceObserved = true;
      agentSpendUsd += agent ?? 0;
      otherServicesUsd += other ?? 0;
    }
    const observedDays = [...(result.usage.snapshot.dailyWorkspaces ?? [])]
      .filter(([day, workspaces]) =>
        day >= startDay && day < endDay && workspaces.has(limit.workspaceId))
      .length;
    const failedDays = result.usage.snapshot.coverage.failedWorkspaceDays
      .filter((item) => item.workspaceId === limit.workspaceId).length;
    const missingDays = result.usage.snapshot.coverage.missingWorkspaceDays
      .filter((item) => item.workspaceId === limit.workspaceId).length;
    const usageObserved = sourceObserved || observedDays > 0;
    const coverage = failedDays === 0 && missingDays === 0 &&
        observedDays === requestedDays
      ? "complete" as const
      : usageObserved
        ? "partial" as const
        : "missing" as const;
    const spendUsd = usageObserved
      ? Math.round((
        agentSpendUsd + otherServicesUsd + Number.EPSILON) * 1e8) / 1e8
      : null;
    const workspaceProjects =
      result.usage.snapshot.projects.get(limit.workspaceId);
    const projectMetadata =
      result.usage.projectMetadata.byWorkspace.get(limit.workspaceId);
    const metadataComplete =
      result.usage.projectMetadata.completeWorkspaceIds.has(limit.workspaceId);
    const deploymentMetadataComplete =
      result.usage.projectMetadata.deploymentCompleteWorkspaceIds
        .has(limit.workspaceId);
    const activeProjects = [...(workspaceProjects ?? new Map()).entries()]
      .filter(([, project]) => project.totalCostUsd > 0);
    const projectRowsObserved = workspaceProjects !== undefined;
    const allActiveCreatorsQualified = activeProjects.every(([projectId]) => {
      const metadata = projectMetadata?.get(projectId);
      return metadata?.creatorId != null;
    });
    const activeProjectCountComplete = coverage === "complete" &&
      projectRowsObserved && metadataComplete && allActiveCreatorsQualified;
    const personalActiveProjects = activeProjectCountComplete
      ? activeProjects.filter(([projectId]) =>
        projectMetadata!.get(projectId)!.creatorId === result.authz.userId)
      : null;
    const publishedProjectCountComplete = personalActiveProjects !== null &&
      deploymentMetadataComplete &&
      personalActiveProjects.every(([projectId]) =>
        projectMetadata!.get(projectId)!.hasDeployment != null);
    const projectCountCoverage = publishedProjectCountComplete
      ? "complete" as const
      : projectRowsObserved || projectMetadata
        ? "partial" as const
        : "missing" as const;
    return {
      workspaceId: limit.workspaceId,
      workspaceName:
        result.dir.workspaces.get(limit.workspaceId)?.name ?? null,
      spendUsd,
      agentSpendUsd: usageObserved
        ? Math.round((agentSpendUsd + Number.EPSILON) * 1e8) / 1e8
        : null,
      otherServicesUsd: usageObserved
        ? Math.round((otherServicesUsd + Number.EPSILON) * 1e8) / 1e8
        : null,
      usageObserved,
      coverage,
      observedDays,
      requestedDays,
      activeProjectCount: personalActiveProjects?.length ?? null,
      publishedProjectCount: !publishedProjectCountComplete
        ? null
        : personalActiveProjects!.filter(([projectId]) =>
          projectMetadata!.get(projectId)!.hasDeployment === true).length,
      projectCountCoverage,
    };
  });
}

router.get("/dashboard", async (req, res): Promise<void> => {
  const startedAt = performance.now();
  const parsed = GetDashboardQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const queryError = dashboardQueryError(parsed.data);
  if (queryError) {
    res.status(400).json({ error: queryError });
    return;
  }
  try {
    const selectedRangeType = dashboardRangeType(parsed.data.rangeType);
    const prepared = await prepareScopedAccounting(
      req.authz!,
      parsed.data,
      undefined,
      req.configurationSnapshot,
    );
    let accountingMs = 0;
    let rollupsMs = 0;
    let responseMs = 0;
    const cacheStartedAt = performance.now();
    const accountingStartedAt = performance.now();
    const result = await buildScopedAccounting(
      req.authz!,
      parsed.data,
      undefined,
      prepared,
    );
    await afterAccountingHookForTests?.();
    assertDashboardUsageGeneration(prepared.usageGeneration);
    accountingMs = performance.now() - accountingStartedAt;
    const rollupsStartedAt = performance.now();
    const granularity = parsed.data.granularity ??
      defaultGranularity(result.period.start, result.period.endExclusive);
    const mode = parsed.data.trendMode ?? "period";
    const buckets = buildDashboardBuckets(
      [...result.daily].map(([day, rollup]) => ({
        day,
        spendUsd: bucketRollupSpend(rollup, result.authz, result.usage.groups),
        complete: rollup.isComplete,
      })),
      granularity,
      mode,
      result.period,
    );
    const today = new Date().toISOString().slice(0, 10);
    const lookbackStart = addUtcDays(today, -28);
    const target = projectionTarget(parsed.data, result.period.start);
    const actualStartDay = result.period.start.slice(0, 10);
    const insightsWindow = dashboardInsightsReadWindow(
      result.period.start, new Date(), USAGE_DATA_CUTOFF_ISO);
    const extraStart = [actualStartDay, lookbackStart, insightsWindow.startDate]
      .sort()[0]!;
    let projectionUsage = result.usage;
    let projectionDaily = result.daily;
    if (!isUsageGenerationUpdateActive()) {
      projectionUsage = await usageForRequest(
        result.authz,
        result.dir,
        {
          rangeType: "custom",
          startDate: extraStart,
          endDate: today,
        },
        true,
      );
      projectionDaily = await dailyUsageRollups(result.dir, projectionUsage);
      assertDashboardUsageGeneration(prepared.usageGeneration, true);
    }
    const projectionMetric = result.scope.isPersonal &&
        selectedRangeType === "billing"
      ? (rollup: typeof projectionDaily extends Map<string, infer T> ? T : never) =>
        qualifiedRollupTotals(
          rollup, result.authz, result.usage.groups).agentSpendUsd
      : (rollup: typeof projectionDaily extends Map<string, infer T> ? T : never) =>
        bucketRollupSpend(rollup, result.authz, result.usage.groups);
    const projectionDays = new Map([...projectionDaily].map(([day, rollup]) => [
      day,
      {
        day,
        spendUsd: projectionMetric(rollup),
        complete: rollup.isComplete,
      },
    ]));
    // The selected report is authoritative for its own range (including a
    // recorded current day); the expanded read supplies only pace lookback.
    for (const [day, rollup] of result.daily) {
      projectionDays.set(day, {
        day,
        spendUsd: result.scope.isPersonal && selectedRangeType === "billing"
          ? qualifiedRollupTotals(
            rollup, result.authz, result.usage.groups).agentSpendUsd
          : bucketRollupSpend(rollup, result.authz, result.usage.groups),
        complete: rollup.isComplete,
      });
    }
    for (const missing of [
      ...projectionUsage.snapshot.coverage.missingWorkspaceDays
        .map((item) => item.usageDate),
      ...projectionUsage.snapshot.coverage.missingAccountDays,
    ]) {
      const existing = projectionDays.get(missing);
      if (existing) projectionDays.set(missing, { ...existing, complete: false });
    }
    const projection = buildDashboardProjection({
      now: new Date(),
      actualPeriod: {
        start: result.period.start,
        endExclusive: result.period.endExclusive,
      },
      target,
      days: [...projectionDays.values()],
      budget: matchingProjectionBudget(
        result, selectedRangeType, target),
      stale: result.metadata.stale || projectionUsage.snapshot.status === "stale",
    });
    const insights = buildDashboardInsights({
      selected: result.usage,
      selectedDaily: result.daily,
      expanded: projectionUsage,
      expandedDaily: projectionDaily,
      directory: result.dir,
      period: result.period,
      cutoff: USAGE_DATA_CUTOFF_ISO,
      projectAttributionComplete:
        result.usage.rollup.projectAttribution.isComplete,
    });
    const projectCatalog = personalProjectCatalog(
      result.usage.projectMetadata,
      result.usage.workspaceIds,
      result.authz,
    );
    const personalProjectCatalogSummary = projectCatalog
      ? (({ projects: _projects, ...summary }) => summary)(projectCatalog)
      : undefined;

    const isPersonal = result.scope.isPersonal;
    const isBilling = selectedRangeType === "billing";
    const isAllocationTerm = selectedRangeType === "full-term";
    const matchingBudget = !isPersonal && isAllocationTerm &&
      (result.authz.roles.includes("account") ||
        (result.poolRows.length > 0 && result.poolRows
          .filter((row) => row.kind === "pool")
          .every((row) => row.allocationUsd !== null)));
    const allocation = result.poolRows.reduce(
      (sum, row) => sum + (row.allocationUsd ?? 0), 0);
    const budgetedSpend = result.poolRows
      .filter((row) => row.allocationUsd !== null)
      .reduce((sum, row) => sum + row.spendUsd, 0);
    const withSpend = [...result.usage.rollup.byUser.values()]
      .filter((spendUsd) => spendUsd > 0).length;
    let cardVariant: "budget_health" | "usage_analysis" | "personal_limit" | "personal_usage";
    let cards;
    if (isPersonal && isBilling) {
      const limits = result.personalLimits
        .filter((item) => item.amount !== null)
        .map((item) => item.amount!);
      const oneWorkspace = result.personalLimits.length === 1;
      const limit = oneWorkspace && limits.length > 0 ? limits[0]! : null;
      const observation = result.dir.budgets.observation.status;
      const hasStoredSuccess =
        result.dir.budgets.observation.lastSuccessfulAt !== null;
      const limitQualification = observation === "failed"
        ? hasStoredSuccess
          ? limit === null
            ? "The latest limit refresh failed; the last successful observation had no limit."
            : "The latest limit refresh failed; the last successful value is shown."
          : "The stored limit observation failed."
        : observation === "refreshing"
          ? hasStoredSuccess
            ? limit === null
              ? "Limits are refreshing; the last successful observation had no limit."
              : "Limits are refreshing; the last successful value is shown."
            : "The first stored limit observation is refreshing."
        : observation === "unavailable"
          ? "No completed stored limit observation is available."
          : !oneWorkspace
            ? "Limits are workspace-specific and are not summed."
            : limit === null ? "No Agent limit is configured for this workspace." : null;
      cardVariant = "personal_limit";
      cards = [
        { key: "your_agent_spend", label: "Your Agent spend", value: result.accounting.agentSpendUsd, unit: "usd", qualification: null },
        { key: "monthly_agent_limit", label: "Monthly Agent limit", value: limit, unit: "usd", qualification: limitQualification },
        { key: "agent_limit_remaining", label: "Agent limit remaining", value: limit === null ? null : limit - result.accounting.agentSpendUsd, unit: "usd", qualification: observation !== "complete" ? limitQualification : limit === null ? "No single transferable limit applies." : null },
      ];
    } else if (isPersonal) {
      cardVariant = "personal_usage";
      cards = [
        { key: "spend", label: "Your spend in period", value: result.accounting.grossSpendUsd, unit: "usd", qualification: result.accounting.internalExcludedUsd ? "Your usage is shown here but remains excluded from allocation-eligible spend." : null },
        { key: "agent_spend", label: "Your Agent spend", value: result.accounting.agentSpendUsd, unit: "usd", qualification: null },
        { key: "other_services", label: "Your other services", value: result.accounting.otherServicesUsd, unit: "usd", qualification: null },
      ];
    } else if (matchingBudget) {
      cardVariant = "budget_health";
      const assessable = result.poolRows.filter((row) =>
        row.allocationUsd !== null && result.usage.rollup.isComplete);
      const attention = assessable.filter((row) => (row.percentUsed ?? 0) >= 90).length;
      const over = assessable.filter((row) => (row.percentUsed ?? 0) >= 100).length;
      cards = [
        { key: "eligible_spend", label: "Eligible spend", value: result.accounting.eligibleSpendUsd, unit: "usd", qualification: result.accounting.internalExcludedUsd ? "Internal usage excluded." : null },
        { key: "allocated_budget", label: "Allocated budget", value: allocation, unit: "usd", qualification: "Canonical pools counted once." },
        { key: "allocation_remaining", label: "Allocation remaining", value: allocation - budgetedSpend, unit: "usd", qualification: result.accounting.unbudgetedUsd ? `Excludes ${result.accounting.unbudgetedUsd} USD unbudgeted spend.` : null },
        { key: "pools_attention", label: "Pools needing attention", value: result.usage.rollup.isComplete ? attention : null, unit: "count", qualification: result.usage.rollup.isComplete ? `${over} over allocation.` : "Partial data; pool health is not fully assessable." },
      ];
    } else {
      cardVariant = "usage_analysis";
      cards = [
        { key: "spend", label: "Spend in period", value: result.accounting.eligibleSpendUsd, unit: "usd", qualification: null },
        { key: "agent_spend", label: "Agent spend", value: result.accounting.agentSpendUsd, unit: "usd", qualification: null },
        { key: "other_services", label: "Other services", value: result.accounting.otherServicesUsd, unit: "usd", qualification: null },
        { key: "members_with_spend", label: "Members with spend", value: withSpend, unit: "count", qualification: result.usage.rollup.isComplete ? null : "Known members only; coverage is partial." },
      ];
    }

    const breakdownSource = result.groupRows
      .filter((row) => row.spendUsd !== 0)
      .sort((a, b) => b.spendUsd - a.spendUsd);
    const top = breakdownSource.slice(0, 5).map((row) => ({
      id: row.id, label: row.name, spendUsd: row.spendUsd,
      kind: row.kind === "unattributed" ? "unattributed" as const : "group" as const,
      drillThrough: dashboardDrillThrough(
        result.scope.viewScope,
        result.period.start,
        result.period.endExclusive,
        row.name,
      ),
    }));
    const otherSpend = breakdownSource.slice(5).reduce((sum, row) => sum + row.spendUsd, 0);
    const breakdown = otherSpend === 0 ? top : [...top, {
      id: "other", label: "Other", spendUsd: otherSpend, kind: "other" as const,
      drillThrough: dashboardDrillThrough(
        result.scope.viewScope,
        result.period.start,
        result.period.endExclusive,
      ),
    }];
      rollupsMs = performance.now() - rollupsStartedAt;
      const responseStartedAt = performance.now();
      const responseBody = JSON.stringify(GetDashboardResponse.parse({
      scope: result.scope, period: result.period, cardVariant, cards,
      trend: { granularity, mode, buckets }, breakdown,
        accounting: result.accounting, metadata: result.metadata, projection,
        insights,
        personalLimits: dashboardPersonalLimits(
          result,
          projectionUsage.snapshot,
        ),
        personalSpendByWorkspace: dashboardPersonalSpendByWorkspace(result),
        personalProjectCatalog: personalProjectCatalogSummary,
      }));
      responseMs = performance.now() - responseStartedAt;
    const cacheMs = performance.now() - cacheStartedAt;
    res.setHeader("Server-Timing", [
      `authorization;dur=${prepared.phaseDurations.authorizationMs.toFixed(1)}`,
      `stored-read;dur=${prepared.phaseDurations.storedReadsMs.toFixed(1)}`,
      `cache;dur=${cacheMs.toFixed(1)};desc="shared-accounting"`,
      `accounting;dur=${accountingMs.toFixed(1)}`,
      `rollups;dur=${rollupsMs.toFixed(1)}`,
      `response;dur=${responseMs.toFixed(1)}`,
      `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
    ].join(", "));
    res.type("application/json").send(responseBody);
  } catch (error) {
    if (error instanceof DashboardGenerationChangedError) {
      res.status(503).json({
        error: "Dashboard usage changed during generation; retry the request",
      });
      return;
    }
    if (error instanceof UsageWindowError) {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "dashboard stored accounting failed");
    res.status(503).json({ error: "Dashboard accounting unavailable" });
  }
});

export default router;