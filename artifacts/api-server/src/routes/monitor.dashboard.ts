import { Router, type IRouter } from "express";
import {
  GetDashboardQueryParams,
  GetDashboardResponse,
} from "@workspace/api-zod";
import {
  bucketRollupSpend,
  buildScopedAccounting,
  prepareScopedAccounting,
} from "../services/scoped-accounting";
import { buildDashboardBuckets } from "../services/dashboard-buckets";
import { UsageWindowError } from "../lib/usage-window";
import { BoundedStaleCache } from "../lib/bounded-stale-cache";
import { isUsageGenerationUpdateActive } from "../lib/usage-store";

const router: IRouter = Router();
const DAY_MS = 86_400_000;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dashboardCache = new BoundedStaleCache<string>({
  maxEntries: 256,
  freshMs: 30_000,
  staleMs: 2 * 60_000,
});

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

export function __getDashboardCacheSizeForTests(): number {
  return dashboardCache.size;
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
}): string | null {
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
    const prepared = await prepareScopedAccounting(req.authz!, parsed.data);
    const key = JSON.stringify([
      prepared.cacheIdentity,
      canonicalValue(parsed.data),
    ]);
    const cacheStatus = dashboardCache.status(key);
    let accountingMs = 0;
    let rollupsMs = 0;
    let responseMs = 0;
    const cacheStartedAt = performance.now();
    const responseBody = await dashboardCache.getOrLoad(key, async () => {
      const accountingStartedAt = performance.now();
      const result = await buildScopedAccounting(
        req.authz!,
        parsed.data,
        undefined,
        prepared,
      );
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
    );

    const isPersonal = result.scope.isPersonal;
    const isBilling = (parsed.data.rangeType ?? "billing") === "billing";
    const isAllocationTerm = parsed.data.rangeType === "full-term";
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
        { key: "spend", label: "Your spend in period", value: result.accounting.eligibleSpendUsd, unit: "usd", qualification: null },
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
      const body = JSON.stringify(GetDashboardResponse.parse({
      scope: result.scope, period: result.period, cardVariant, cards,
      trend: { granularity, mode, buckets }, breakdown,
      accounting: result.accounting, metadata: result.metadata,
      }));
      responseMs = performance.now() - responseStartedAt;
      return body;
    }, { refreshStale: !isUsageGenerationUpdateActive() });
    const cacheMs = performance.now() - cacheStartedAt;
    res.setHeader("Server-Timing", [
      `authorization;dur=${prepared.phaseDurations.authorizationMs.toFixed(1)}`,
      `stored-read;dur=${prepared.phaseDurations.storedReadsMs.toFixed(1)}`,
      `cache;dur=${cacheMs.toFixed(1)};desc="${cacheStatus}"`,
      `accounting;dur=${accountingMs.toFixed(1)}`,
      `rollups;dur=${rollupsMs.toFixed(1)}`,
      `response;dur=${responseMs.toFixed(1)}`,
      `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
    ].join(", "));
    res.type("application/json").send(responseBody);
  } catch (error) {
    if (error instanceof UsageWindowError) {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "dashboard stored accounting failed");
    res.status(503).json({ error: "Dashboard accounting unavailable" });
  }
});

export default router;