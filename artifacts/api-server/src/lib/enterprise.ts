import { logger } from "./logger";
import { db } from "@workspace/db";
import {
  apiDirectoryCacheTable,
  apiBillingPeriodCacheTable,
  apiBillingPeriodObservationTable,
  apiAccountTotalVerificationTable,
  apiSpendCacheTable,
  apiProjectMetadataTable,
  apiProjectMetadataStateTable,
  usageSyncChunksTable,
  usageSyncStateTable,
  usageDailyFactsTable,
  usageFactMonthsTable,
  canonicalMonthlyGroupUserRollupsTable,
  canonicalMonthlyRollupStateTable,
  type UsageSyncChunk,
  type UsageDailyFact,
  type CanonicalMonthlyGroupUserRollup,
} from "@workspace/db/schema";
import { and, eq, gt, gte, inArray, like, lt, lte, or, sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  computeDedupedMemberCounts,
  computeDedupedUsageRollup,
  type DedupedGroupRollup,
  type DedupedUsageRollup,
} from "./usage-rollup";
import { updateJobClaimCursor, withJobClaim } from "./job-claims";

const BASE_URL = "https://api.replit.com/v1";

export const ENTERPRISE_REQUEST_TIMEOUT_MS = 30_000;
export function isConfigured(): boolean {
  return !!process.env["REPLIT_ENTERPRISE_API_KEY"];
}

let lastApiError: string | null = null;
let lastApiOk = false;
const enterpriseIngestContext = new AsyncLocalStorage<boolean>();

export function withEnterpriseIngestAccess<T>(work: () => Promise<T>): Promise<T> {
  return enterpriseIngestContext.run(true, work);
}

export function getApiHealth(): { ok: boolean; error: string | null } {
  return { ok: lastApiOk, error: lastApiError };
}

class EnterpriseApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rawFetch(
  path: string,
  params: Record<string, string | undefined>,
): Promise<{ body: unknown; headers: Headers }> {
  if (process.env.NODE_ENV !== "test" && !enterpriseIngestContext.getStore()) {
    throw new EnterpriseApiError(
      0,
      "Enterprise API access is restricted to the usage ingestion scheduler",
    );
  }
  const key = process.env["REPLIT_ENTERPRISE_API_KEY"];
  if (!key) throw new EnterpriseApiError(0, "REPLIT_ENTERPRISE_API_KEY is not set");

  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const workload = workloadContext.getStore() ?? "scheduled";
  await enterpriseBudget.admit(workload, path === "/usage");
  const res = await enterpriseFetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(ENTERPRISE_REQUEST_TIMEOUT_MS),
  });
  enterpriseBudget.observe(res.headers, res.status);

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
    throw Object.assign(new EnterpriseApiError(429, "rate limited"), {
      retryAfterMs: Math.max(1000, retryAfter * 1000),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EnterpriseApiError(
      res.status,
      `Enterprise API ${path} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const body = (await res.json()) as unknown;
  return { body, headers: res.headers };
}

/**
 * Scheduler-only transport entry point. Keeping URL construction, timeout,
 * authentication, header-driven admission, and 429 handling here ensures every
 * Enterprise request shares one budget.
 */
export async function fetchEnterpriseForIngest(
  path: string,
  params: Record<string, string | undefined>,
): Promise<{ body: unknown; headers: Headers }> {
  return rawFetch(path, params);
}

// ---------- Date ranges ----------

/** All spend data before this date is excluded from every query. */
export const SPEND_DATA_CUTOFF_ISO = "2026-05-20T00:00:00.000Z";
export const SPEND_DATA_CUTOFF_MS = new Date(SPEND_DATA_CUTOFF_ISO).getTime();
export const SPEND_DATA_CUTOFF_LABEL = "May 2026-present";
export const FULL_TERM_RANGE_KEY = "full-term:from-cutoff";
export const PACE_FALLBACK_END_ISO = "2027-05-17T00:00:00.000Z";
const BILLING_PERIOD_REFRESH_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_HEAL_THRESHOLD_USD = 1;
const VERIFICATION_RETRY_BASE_MS = 60 * 1000;
const VERIFICATION_RETRY_MAX_MS = 60 * 60 * 1000;
export const DAILY_FACT_MONTH_GRACE_MS = 24 * 60 * 60 * 1000;
export type RangeType = "billing" | "mtd" | "ytd" | "custom" | "full-term";

export interface UsageRange {
  key: string; // cache key
  label: string;
  params: Record<string, string>; // billingPeriod OR startTime/endTime
}

function resolvedRange(range: UsageRange): UsageRange {
  resolvedUsageRanges.set(range.key, range);
  // Test fixtures and freshly committed facts can be materialized synchronously;
  // persisted facts that are not hot are loaded by synchronizeUsage on demand.
  prepareUsageRangeFromDailyFacts(range);
  return range;
}

export function resolveRange(
  rangeType: string | undefined,
  startDate?: string,
  endDate?: string,
  now = new Date(),
): UsageRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const nextUtcDay = new Date(Date.UTC(y, m, now.getUTCDate() + 1));
  switch (rangeType) {
    case "full-term": {
      const end = nextUtcDay;
      return resolvedRange({
        key: FULL_TERM_RANGE_KEY,
        label: formatPeriodLabel(SPEND_DATA_CUTOFF_ISO, end.toISOString()),
        params: {
          startTime: SPEND_DATA_CUTOFF_ISO,
          endTime: end.toISOString(),
        },
      });
    }
    case "mtd": {
      const rawStart = new Date(Date.UTC(y, m, 1)).getTime();
      const effectiveStart = new Date(Math.max(rawStart, SPEND_DATA_CUTOFF_MS));
      return resolvedRange({
        key: `mtd:${effectiveStart.toISOString().slice(0, 10)}`,
        label: `${now.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })} (MTD)`,
        params: { startTime: effectiveStart.toISOString(), endTime: nextUtcDay.toISOString() },
      });
    }
    case "ytd": {
      const rawStart = new Date(Date.UTC(y, 0, 1)).getTime();
      const effectiveStart = new Date(Math.max(rawStart, SPEND_DATA_CUTOFF_MS));
      return resolvedRange({
        key: `ytd:${effectiveStart.toISOString().slice(0, 10)}`,
        label: `${y} year to date`,
        params: { startTime: effectiveStart.toISOString(), endTime: nextUtcDay.toISOString() },
      });
    }
    case "custom": {
      if (!startDate || !endDate) {
        throw new EnterpriseApiError(400, "startDate and endDate are required for a custom range");
      }
      const rawStart = new Date(`${startDate}T00:00:00.000Z`);
      const end = new Date(`${endDate}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1); // inclusive end date -> exclusive boundary
      if (isNaN(rawStart.getTime()) || isNaN(end.getTime()) || end <= rawStart) {
        throw new EnterpriseApiError(400, "Invalid custom date range");
      }
      const effectiveStart = new Date(Math.max(rawStart.getTime(), SPEND_DATA_CUTOFF_MS));
      if (effectiveStart >= end) {
        throw new EnterpriseApiError(
          400,
          `Date range predates available spend data (cutoff: ${SPEND_DATA_CUTOFF_ISO.slice(0, 10)})`,
        );
      }
      const effectiveStartDate = effectiveStart.toISOString().slice(0, 10);
      return resolvedRange({
        key: `custom:${effectiveStartDate}:${endDate}`,
        label: `${effectiveStartDate} to ${endDate}`,
        params: { startTime: effectiveStart.toISOString(), endTime: end.toISOString() },
      });
    }
    default:
      {
        const activePeriod = getActiveBillingPeriod(now.getTime());
        if (activePeriod) {
        const periodStartMs = new Date(activePeriod.start).getTime();
        const periodEndMs = new Date(activePeriod.end).getTime();
        const effectiveStart = new Date(Math.max(periodStartMs, SPEND_DATA_CUTOFF_MS));
        const effectiveEnd = new Date(Math.min(nextUtcDay.getTime(), periodEndMs));
        if (
          Number.isFinite(effectiveStart.getTime()) &&
          Number.isFinite(effectiveEnd.getTime()) &&
          effectiveEnd > effectiveStart
        ) {
          return resolvedRange({
            // The discovered interval bounds are immutable material identity. The
            // moving reporting end is deliberately excluded so polling reuses cache.
            key: `billing:${activePeriod.start}:${activePeriod.end}:from:${effectiveStart.toISOString()}`,
            label: formatPeriodLabel(effectiveStart.toISOString(), effectiveEnd.toISOString()),
            params: {
              startTime: effectiveStart.toISOString(),
              endTime: effectiveEnd.toISOString(),
            },
          });
        }
      }
      }
      return resolvedRange({
        key: "billing:from-cutoff",
        label: formatPeriodLabel(SPEND_DATA_CUTOFF_ISO, nextUtcDay.toISOString()),
        params: { startTime: SPEND_DATA_CUTOFF_ISO, endTime: nextUtcDay.toISOString() },
      });
  }
}

export function isBadRangeError(err: unknown): boolean {
  return err instanceof EnterpriseApiError && err.status === 400;
}

export type EnterpriseWorkload = "interactive" | "scheduled" | "backfill";
type QueueTask = {
  run: () => Promise<void>;
  priority: number;
  workload: EnterpriseWorkload;
  key: string;
  runId: string;
  enqueuedAt: number;
};

const usageQueues: Record<EnterpriseWorkload, QueueTask[]> = {
  interactive: [],
  scheduled: [],
  backfill: [],
};
const queuedKeys = new Set<string>();

const runningWorkers: Record<EnterpriseWorkload, boolean> = {
  interactive: false,
  scheduled: false,
  backfill: false,
};
let lastQueueProgressAt: number | null = null;
let queueRunSequence = 0;

function nextQueueRunId(): string {
  queueRunSequence += 1;
  return `usage-${Date.now().toString(36)}-${queueRunSequence.toString(36)}`;
}

function markQueueProgress(event: string, fields: Record<string, unknown>): void {
  lastQueueProgressAt = Date.now();
  const queueDepth = typeof fields["queueDepth"] === "number"
    ? fields["queueDepth"]
    : 0;
  const workload = fields["workload"];
  // A cold daily-fact backfill can enqueue thousands of low-priority tasks.
  // Sample those enqueue messages so start/finish/failure telemetry remains
  // visible, while interactive requests and periodic depth checkpoints are
  // always logged.
  if (
    event === "usage_queue_enqueue" &&
    workload !== "interactive" &&
    queueDepth > 20 &&
    queueDepth % 250 !== 0
  ) {
    return;
  }
  logger.info({ event, ...fields }, "Enterprise usage sync progress");
}

function totalQueuedCount(): number {
  return usageQueues.interactive.length +
    usageQueues.scheduled.length +
    usageQueues.backfill.length;
}
function pumpQueue(workload: EnterpriseWorkload): void {
  if (runningWorkers[workload]) return;
  runningWorkers[workload] = true;
  void (async () => {
    const queue = usageQueues[workload];
    while (queue.length > 0) {
      queue.sort((a, b) => a.priority - b.priority);
      const task = queue.shift();
      if (!task) break;
      const startedAt = Date.now();
      activeQueueTasks.set(workload, { ...task, startedAt });
      markQueueProgress("usage_queue_start", {
        runId: task.runId,
        key: task.key,
        priority: task.priority,
        workload,
        queueDepth: totalQueuedCount(),
        waitMs: startedAt - task.enqueuedAt,
      });
      try {
        await workloadContext.run(workload, task.run);
        markQueueProgress("usage_queue_finish", {
          runId: task.runId,
          key: task.key,
          workload,
          queueDepth: totalQueuedCount(),
          durationMs: Date.now() - startedAt,
          outcome: "success",
        });
      } catch (err) {
        // A task wrapper should normally record its own durable failure. This
        // boundary prevents one unexpected rejection from killing the queue
        // pump and leaving every later scope permanently pending.
        logger.error({
          event: "usage_queue_finish",
          err,
          runId: task.runId,
          key: task.key,
          workload,
          queueDepth: totalQueuedCount(),
          durationMs: Date.now() - startedAt,
          outcome: "failed",
        }, "Enterprise usage queue task failed");
      } finally {
        // Keep the key registered while the task is active so polling cannot
        // enqueue the same Enterprise API request again.
        queuedKeys.delete(task.key);
        activeQueueTasks.delete(workload);
        lastQueueProgressAt = Date.now();
      }
    }
    runningWorkers[workload] = false;
  })();
}

function enqueueUsage(
  key: string,
  priority: number,
  run: () => Promise<void>,
  explicitWorkload?: EnterpriseWorkload,
): boolean {
  const workload = explicitWorkload ?? workloadForPriority(priority);
  if (queuedKeys.has(key)) {
    // An interactive detail request may arrive after the dashboard already
    // queued the same cold scope in the background. Promote the queued copy
    // instead of leaving the user behind hundreds of unrelated group fetches.
    const queued = Object.values(usageQueues).flat().find((task) => task.key === key);
    if (queued) {
      const previousPriority = queued.priority;
      const previousWorkload = queued.workload;
      queued.priority = Math.min(queued.priority, priority);
      queued.workload = explicitWorkload ?? workloadForPriority(queued.priority);
      if (queued.workload !== previousWorkload) {
        const oldQueue = usageQueues[previousWorkload];
        const index = oldQueue.indexOf(queued);
        if (index >= 0) oldQueue.splice(index, 1);
        usageQueues[queued.workload].push(queued);
        pumpQueue(queued.workload);
      }
      markQueueProgress("usage_queue_duplicate", {
        runId: queued.runId,
        key,
        workload: queued.workload,
        queueDepth: totalQueuedCount(),
        promoted: queued.priority < previousPriority,
        priority: queued.priority,
        ageMs: Date.now() - queued.enqueuedAt,
      });
    }
    return false;
  }
  const enqueuedAt = Date.now();
  const runId = nextQueueRunId();
  queuedKeys.add(key);
  usageQueues[workload].push({ key, priority, workload, run, runId, enqueuedAt });
  markQueueProgress("usage_queue_enqueue", {
    runId,
    key,
    priority,
    workload,
    queueDepth: totalQueuedCount(),
  });
  pumpQueue(workload);
  return true;
}

export function pendingUsageCount(): number {
  return totalQueuedCount() + activeQueueTasks.size;
}

export interface UsageOperationalDiagnostics {
  queueDepth: number;
  queuedCount: number;
  active: {
    runId: string;
    key: string;
    priority: number;
    enqueuedAt: string;
    startedAt: string;
    ageMs: number;
    waitMs: number;
  } | null;
  oldestQueuedAgeMs: number | null;
  lastProgressAt: string | null;
  pauseUntil: string | null;
  rateLimit: {
    limit: number;
    remaining: number;
    resetAt: string;
    observed: boolean;
    used: Record<EnterpriseWorkload, number>;
  };
  scopes: Array<{
    mode: UsageSyncMode;
    rangeKey: string;
    scopeKey: string;
    status: UsageSyncStatus;
    syncedThrough: string;
    completedAt: string;
    error: string | null;
  }>;
}

export function getUsageOperationalDiagnostics(): UsageOperationalDiagnostics {
  const now = Date.now();
  const budget = enterpriseBudget.snapshot();
  const activeQueueTask = activeQueueTasks.get("interactive") ??
    activeQueueTasks.get("scheduled") ??
    activeQueueTasks.get("backfill") ??
    null;
  const active = activeQueueTask
    ? {
        runId: activeQueueTask.runId,
        key: activeQueueTask.key,
        priority: activeQueueTask.priority,
        enqueuedAt: new Date(activeQueueTask.enqueuedAt).toISOString(),
        startedAt: new Date(activeQueueTask.startedAt).toISOString(),
        ageMs: now - activeQueueTask.startedAt,
        waitMs: activeQueueTask.startedAt - activeQueueTask.enqueuedAt,
      }
    : null;
  const allQueued = Object.values(usageQueues).flat();
  const oldestQueuedAt = allQueued.reduce<number | null>(
    (oldest, task) => oldest === null ? task.enqueuedAt : Math.min(oldest, task.enqueuedAt),
    null,
  );
  const scopes = [...syncMetadata.entries()]
    .filter(([, metadata]) => metadata.status !== "success")
    .sort((a, b) => b[1].completedAt - a[1].completedAt)
    .slice(0, 200)
    .map(([id, metadata]) => {
      const [mode, rangeKey, scopeKey] = id.split("|") as [UsageSyncMode, string, string];
      return {
        mode,
        rangeKey,
        scopeKey,
        status: metadata.status,
        syncedThrough: new Date(metadata.syncedThrough).toISOString(),
        completedAt: new Date(metadata.completedAt).toISOString(),
        error: metadata.error?.slice(0, 500) ?? null,
      };
    });
  return {
    queueDepth: totalQueuedCount() + activeQueueTasks.size,
    queuedCount: totalQueuedCount(),
    active,
    oldestQueuedAgeMs: oldestQueuedAt === null ? null : now - oldestQueuedAt,
    lastProgressAt: lastQueueProgressAt === null
      ? null
      : new Date(lastQueueProgressAt).toISOString(),
    pauseUntil: budget.resetAt > now && budget.remaining <= 0
      ? new Date(budget.resetAt).toISOString()
      : null,
    rateLimit: {
      limit: budget.limit,
      remaining: budget.remaining,
      resetAt: new Date(budget.resetAt).toISOString(),
      observed: budget.observed,
      used: budget.used,
    },
    scopes,
  };
}

const CANONICAL_RESIDUAL_USER_KEY = "\u0001canonical-residual";
interface UsageMetricEntry {
  id: string;
  name: string;
  category: string;
  costUsd: number;
}

export function sumAgentUsageMetrics(
  metrics: UsageMetricEntry[] | undefined,
): number {
  return (metrics ?? [])
    .filter((metric) => {
      const id = metric.id.toLowerCase();
      const name = metric.name.toLowerCase();
      return id.includes("ai_agent") ||
        id.includes("ai-agent") ||
        (metric.category.toLowerCase() === "ai" && name.includes("agent"));
    })
    .reduce((sum, metric) => sum + metric.costUsd, 0);
}

interface UsageGroupEntry {
  key: { userId?: string; workspaceId?: string; projectId?: string; date?: string };
  totalCostUsd: number;
  metrics?: UsageMetricEntry[];
}

interface UsageData {
  interval: { startTime: string; endTime: string };
  totalCostUsd: number;
  attributableTotalCostUsd: number;
  unattributableTotalCostUsd: number;
  groups: UsageGroupEntry[];
  pagination: { cursor: string | null; hasMore: boolean };
}

export interface BillingPeriodMetadata {
  start: string;
  end: string;
  fetchedAt: string | null;
  isFresh: boolean;
  isFallback: boolean;
  differsFromReportingCutoff: boolean;
  label: string;
}

interface StoredBillingPeriod {
  start: string;
  end: string;
  fetchedAt: number;
}

interface StoredBillingObservation {
  start: string;
  end: string;
  count: number;
  observedAt: number;
}
let billingPeriodCache: StoredBillingPeriod | null = null;

let billingPeriodObservation: StoredBillingObservation | null = null;
let accountVerificationRetryTimer: NodeJS.Timeout | null = null;
let accountVerificationFailureCount = 0;

export type AccountTotalVerificationOutcome = "success" | "healed" | "failed";

export interface AccountTotalVerificationState {
  verifiedAt: string;
  outcome: AccountTotalVerificationOutcome;
  error: string | null;
  rangeKey: string;
  rangeStart: string;
  rangeEnd: string;
  upstreamTotalUsd: number | null;
  storedTotalUsd: number | null;
  deltaUsd: number | null;
}

let accountTotalVerificationState: AccountTotalVerificationState | null = null;

export function getAccountTotalVerificationState(): AccountTotalVerificationState | null {
  return accountTotalVerificationState ? { ...accountTotalVerificationState } : null;
}

function getActiveBillingPeriod(now = Date.now()): StoredBillingPeriod | null {
  if (!billingPeriodCache) return null;
  const start = new Date(billingPeriodCache.start).getTime();
  const end = new Date(billingPeriodCache.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= now) {
    return null;
  }
  return billingPeriodCache;
}

function formatPeriodLabel(startIso: string, endIso: string): string {
  const format = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  return `${format(startIso)} – ${format(endIso)}`;
}

function validateBillingInterval(interval: UsageData["interval"]): StoredBillingPeriod {
  const start = new Date(interval.startTime);
  const end = new Date(interval.endTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error("Enterprise API returned an invalid current billing interval");
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    fetchedAt: Date.now(),
  };
}

async function observeBillingPeriod(
  period: StoredBillingPeriod,
  persistResult: boolean,
  persistenceId = "current",
): Promise<StoredBillingPeriod | null> {
  const sameAsAdopted = billingPeriodCache?.start === period.start &&
    billingPeriodCache.end === period.end;
  const nextCount = billingPeriodObservation?.start === period.start &&
      billingPeriodObservation.end === period.end
    ? billingPeriodObservation.count + 1
    : 1;
  const observation: StoredBillingObservation = {
    start: period.start,
    end: period.end,
    count: nextCount,
    observedAt: period.fetchedAt,
  };

  if (!persistResult) {
    billingPeriodObservation = observation;
    if (sameAsAdopted || nextCount >= 2) return period;
    return null;
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('billing-period-observation'))`);
    const [adoptedRow] = await tx.select().from(apiBillingPeriodCacheTable)
      .where(eq(apiBillingPeriodCacheTable.id, persistenceId));
    const [observedRow] = await tx.select().from(apiBillingPeriodObservationTable)
      .where(eq(apiBillingPeriodObservationTable.id, persistenceId));
    const adoptedMatches = adoptedRow?.periodStart.toISOString() === period.start &&
      adoptedRow.periodEnd.toISOString() === period.end;
    const persistedCount = observedRow?.periodStart.toISOString() === period.start &&
        observedRow.periodEnd.toISOString() === period.end
      ? observedRow.consecutiveCount + 1
      : 1;

    await tx.insert(apiBillingPeriodObservationTable).values({
      id: persistenceId,
      periodStart: new Date(period.start),
      periodEnd: new Date(period.end),
      consecutiveCount: persistedCount,
      observedAt: new Date(period.fetchedAt),
    }).onConflictDoUpdate({
      target: apiBillingPeriodObservationTable.id,
      set: {
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        consecutiveCount: persistedCount,
        observedAt: new Date(period.fetchedAt),
      },
    });
    billingPeriodObservation = {
      start: period.start,
      end: period.end,
      count: persistedCount,
      observedAt: period.fetchedAt,
    };
    if (!adoptedMatches && persistedCount < 2) return null;

    await tx.insert(apiBillingPeriodCacheTable).values({
      id: persistenceId,
      periodStart: new Date(period.start),
      periodEnd: new Date(period.end),
      fetchedAt: new Date(period.fetchedAt),
    }).onConflictDoUpdate({
      target: apiBillingPeriodCacheTable.id,
      set: {
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        fetchedAt: new Date(period.fetchedAt),
      },
    });
    return period;
  });
}
export function getBillingPeriodMetadata(): BillingPeriodMetadata {
  const cached = getActiveBillingPeriod();
  const start = cached?.start ?? SPEND_DATA_CUTOFF_ISO;
  const end = cached?.end ?? PACE_FALLBACK_END_ISO;
  return {
    start,
    end,
    fetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
    isFresh: !!cached && Date.now() - cached.fetchedAt < BILLING_PERIOD_REFRESH_MS,
    isFallback: !cached,
    differsFromReportingCutoff:
      Math.max(new Date(start).getTime(), SPEND_DATA_CUTOFF_MS) !== SPEND_DATA_CUTOFF_MS,
    label: formatPeriodLabel(start, end),
  };
}

export function resolvePaceUsageRange(): UsageRange | null {
  const period = getBillingPeriodMetadata();
  const now = new Date();
  const nextUtcDay = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));
  const start = new Date(Math.max(
    new Date(period.start).getTime(),
    SPEND_DATA_CUTOFF_MS,
  ));
  const end = new Date(Math.min(
    nextUtcDay.getTime(),
    new Date(period.end).getTime(),
  ));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return null;
  }
  return resolvedRange({
    key: `pace:${start.toISOString().slice(0, 10)}:${period.end.slice(0, 10)}`,
    label: period.label,
    params: {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
  });
}

export function refreshBillingPeriodMetadata(
  priority = 1,
  force = false,
  persistResult = true,
): Promise<boolean> {
  if (!isConfigured()) return Promise.resolve(false);
  if (
    !force &&
    getActiveBillingPeriod() &&
    billingPeriodCache &&
    Date.now() - billingPeriodCache.fetchedAt < BILLING_PERIOD_REFRESH_MS
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const queued = enqueueUsage("billing-period:current", priority, async () => {
      try {
        const data = await usageFetch({ billingPeriod: "current" });
        const next = validateBillingInterval(data.interval);
        const adopted = await observeBillingPeriod(next, persistResult);
        if (adopted) {
          billingPeriodCache = adopted;
          logger.info({ start: next.start, end: next.end }, "Current billing interval refreshed");
        } else {
          logger.info(
            { start: next.start, end: next.end },
            "Current billing interval observed; awaiting confirmation",
          );
        }
      } catch (err) {
        logger.warn({ err }, "Failed to refresh current billing interval; retaining prior metadata");
      } finally {
        resolve(true);
      }
    });
    if (!queued) resolve(false);
  });
}

async function usageFetch(
  params: Record<string, string | undefined>,
): Promise<UsageData> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const { body } = await rawFetch("/usage", params);
      lastApiOk = true;
      lastApiError = null;
      return (body as { data: UsageData }).data;
    } catch (err) {
      const e = err as EnterpriseApiError & { retryAfterMs?: number };
      if (e.status === 429 && attempts <= 5) {
        logger.warn({
          event: "usage_rate_limit_pause",
          attempts,
          pauseMs: e.retryAfterMs ?? 5000,
        }, "Usage 429; backing off");
        // Admission is shared across workers. It will reopen at the stricter
        // Retry-After or reset boundary observed by rawFetch.
        continue;
      }
      lastApiOk = false;
      lastApiError = e.message;
      throw e;
    }
  }
}

// ---------- Durable incremental /usage synchronization ----------

type UsageSyncMode =
  | "account_total"
  | "group_total"
  | "group_member"
  | "workspace_member"
  | "group_project";

interface StoredUsagePayload {
  totalCostUsd: number;
  attributableTotalCostUsd: number;
  unattributableTotalCostUsd: number;
  groups: UsageGroupEntry[];
}

const dailyFactCache = new Map<string, UsageDailyFact>();

const materializedFactScopes = new Set<string>();

const resolvedUsageRanges = new Map<string, UsageRange>();
const verifiedDailyFactScopes = new Set<string>();
let dailyFactParityReady = false;
let dailyFactRefreshTimer: NodeJS.Timeout | null = null;

let dailyFactReadsOverrideForTests: boolean | null = null;
function dailyFactId(mode: UsageSyncMode, scopeKey: string, usageDate: string): string {
  return `${mode}|${scopeKey}|${usageDate}`;
}
export function dailyFactReadsEnabled(): boolean {
  return dailyFactReadsOverrideForTests ?? true;
}

function dateRangeDays(start: Date, end: Date): string[] {
  const days: string[] = [];
  for (let cursor = utcDayStart(start.getTime()); cursor < end.getTime(); cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

function factRowsForRange(
  mode: UsageSyncMode,
  scopeKey: string,
  range: UsageRange,
): UsageSyncChunk[] | null {
  const { start, end } = rangeBounds(range);
  if (
    start.getTime() !== utcDayStart(start.getTime()) ||
    end.getTime() !== utcDayStart(end.getTime())
  ) return null;
  const days = dateRangeDays(start, end);
  const facts = days.map((day) => dailyFactCache.get(dailyFactId(mode, scopeKey, day)));
  if (facts.some((fact) => !fact)) return null;
  return facts.map((fact) => {
    const chunkStart = new Date(`${fact!.usageDate}T00:00:00.000Z`);
    return {
      mode: fact!.mode,
      rangeKey: range.key,
      scopeKey: fact!.scopeKey,
      chunkStart,
      chunkEnd: new Date(Math.min(chunkStart.getTime() + 86_400_000, end.getTime())),
      payloadJson: fact!.payloadJson,
      completedAt: fact!.fetchedAt,
    };
  });
}

/**
 * Materialize a requested reporting identity from facts already in the bounded
 * hot-range cache. Cold ranges are loaded from Postgres by synchronizeUsage.
 */
export function prepareUsageRangeFromDailyFacts(range: UsageRange): boolean {
  if (!dailyFactReadsEnabled()) return false;
  const scopes = new Set(
    [...dailyFactCache.values()].map((fact) => `${fact.mode}|${fact.scopeKey}`),
  );
  const rows: UsageSyncChunk[] = [];
  const newlyMaterialized: string[] = [];
  for (const scope of scopes) {
    const separator = scope.indexOf("|");
    const mode = scope.slice(0, separator) as UsageSyncMode;
    const scopeKey = scope.slice(separator + 1);
    const materializedId = syncId(mode, range.key, scopeKey);
    if (materializedFactScopes.has(materializedId)) continue;
    const selected = factRowsForRange(mode, scopeKey, range);
    if (selected) {
      rows.push(...selected);
      newlyMaterialized.push(materializedId);
      syncMetadata.set(materializedId, {
        syncedThrough: new Date(range.params.endTime).getTime(),
        completedAt: Date.now(),
        isClosed: false,
        status: "success",
        error: null,
      });
    }
  }
  if (!factRowsForRange("account_total", ACCOUNT_USAGE_SCOPE, range)) {
    return false;
  }
  hydrateDurableUsage(rows);
  for (const id of newlyMaterialized) materializedFactScopes.add(id);
  return true;
}

async function prepareUsageRangeFromStoredDailyFacts(
  range: UsageRange,
  mode: UsageSyncMode,
  scopeKey: string,
): Promise<boolean> {
  if (!dailyFactReadsEnabled()) return false;
  await prepareCanonicalRangeFromStoredRollups(range);
  prepareUsageRangeFromDailyFacts(range);
  if (factRowsForRange(mode, scopeKey, range)) return true;
  const { start, end } = rangeBounds(range);
  if (
    start.getTime() !== utcDayStart(start.getTime()) ||
    end.getTime() !== utcDayStart(end.getTime())
  ) return false;
  const cacheKey =
    `${range.key}|${mode}|${scopeKey}|${start.toISOString()}|${end.toISOString()}`;
  let entry = dailyFactRangeCache.get(cacheKey);
  let facts: UsageDailyFact[];
  if (entry) {
    dailyFactRangeCache.delete(cacheKey);
    dailyFactRangeCache.set(cacheKey, entry);
    facts = entry.facts;
  } else {
    const requestedScope = and(
      eq(usageDailyFactsTable.mode, mode),
      eq(usageDailyFactsTable.scopeKey, scopeKey),
    );
    const accountScope = and(
      eq(usageDailyFactsTable.mode, "account_total"),
      eq(usageDailyFactsTable.scopeKey, ACCOUNT_USAGE_SCOPE),
    );
    facts = await db.select().from(usageDailyFactsTable).where(and(
      gte(usageDailyFactsTable.usageDate, start.toISOString().slice(0, 10)),
      lt(usageDailyFactsTable.usageDate, end.toISOString().slice(0, 10)),
      mode === "account_total" && scopeKey === ACCOUNT_USAGE_SCOPE
        ? requestedScope
        : or(requestedScope, accountScope),
    ));
    entry = {
      rangeKey: range.key,
      mode,
      scopeKey,
      startMs: start.getTime(),
      endMs: end.getTime(),
      facts,
    };
    dailyFactRangeCache.set(cacheKey, entry);
    let evicted = false;
    while (dailyFactRangeCache.size > DAILY_FACT_RANGE_CACHE_MAX) {
      const oldest = dailyFactRangeCache.keys().next().value;
      if (oldest === undefined) break;
      const removed = dailyFactRangeCache.get(oldest);
      dailyFactRangeCache.delete(oldest);
      if (removed) evictMaterializedFactRange(removed.rangeKey);
      evicted = true;
    }
    if (evicted) {
      dailyFactCache.clear();
      for (const cached of dailyFactRangeCache.values()) {
        for (const fact of cached.facts) {
          dailyFactCache.set(
            dailyFactId(fact.mode as UsageSyncMode, fact.scopeKey, fact.usageDate),
            fact,
          );
        }
      }
    }
  }
  for (const fact of facts) {
    dailyFactCache.set(
      dailyFactId(fact.mode as UsageSyncMode, fact.scopeKey, fact.usageDate),
      fact,
    );
  }
  prepareUsageRangeFromDailyFacts(range);
  return factRowsForRange(mode, scopeKey, range) !== null;
}

function materializeUsageRangeFromDailyFacts(range: UsageRange): boolean {
  return prepareUsageRangeFromDailyFacts(range);
}
interface SyncMetadata {
  syncedThrough: number;
  completedAt: number;
  isClosed: boolean;
  status: UsageSyncStatus;
  error: string | null;
}

export type UsageSyncStatus = "syncing" | "success" | "partial" | "failed";

export interface UsageSyncSummary {
  status: "complete" | "syncing" | "partial" | "failed";
  pendingCount: number;
  failedCount: number;
  partialCount: number;
  error: string | null;
  dataAsOf: string | null;
  isStale: boolean;
}

export const RECONCILIATION_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
export const CUSTOM_RANGE_CLOSURE_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_USAGE_PAGES = 200;
// Cursorless pagination is an upstream API defect. Date sharding can recover
// additional rows, but unbounded bisection of a multi-month range creates
// thousands of serial requests and prevents any terminal state from reaching
// Postgres. Four levels cap one chunk at 31 requests before committing partial.
const MAX_CURSORLESS_SHARD_DEPTH = 4;
/** Closed custom snapshots are retained long enough for normal reporting needs. */
export const CUSTOM_RANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const syncMetadata = new Map<string, SyncMetadata>();
const accountUsageRetryAt = new Map<string, number>();
const accountUsageFailureCount = new Map<string, number>();
const accountUsageRetryTimers = new Map<string, NodeJS.Timeout>();
let lastCleanupAt = 0;

function syncId(mode: UsageSyncMode, rangeKey: string, scopeKey: string): string {
  return `${mode}|${rangeKey}|${scopeKey}`;
}

/**
 * Remove only expired, closed custom snapshots. Each candidate uses the same
 * transaction advisory lock as synchronizeUsage, and eligibility is checked
 * again after locking so cleanup cannot race an active sync.
 */
export async function pruneExpiredCustomUsage(): Promise<number> {
  const cutoff = new Date(Date.now() - CUSTOM_RANGE_RETENTION_MS);
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({
        mode: usageSyncStateTable.mode,
        rangeKey: usageSyncStateTable.rangeKey,
        scopeKey: usageSyncStateTable.scopeKey,
      })
      .from(usageSyncStateTable)
      .where(and(
        eq(usageSyncStateTable.isClosed, true),
        like(usageSyncStateTable.rangeKey, "custom:%"),
        lt(usageSyncStateTable.completedAt, cutoff),
      ));
    let removed = 0;
    for (const candidate of candidates) {
      const id = syncId(
        candidate.mode as UsageSyncMode,
        candidate.rangeKey,
        candidate.scopeKey,
      );
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      const [state] = await tx
        .select({ completedAt: usageSyncStateTable.completedAt })
        .from(usageSyncStateTable)
        .where(and(
          eq(usageSyncStateTable.mode, candidate.mode),
          eq(usageSyncStateTable.rangeKey, candidate.rangeKey),
          eq(usageSyncStateTable.scopeKey, candidate.scopeKey),
          eq(usageSyncStateTable.isClosed, true),
          lt(usageSyncStateTable.completedAt, cutoff),
        ));
      if (!state) continue;
      await tx.delete(usageSyncChunksTable).where(and(
        eq(usageSyncChunksTable.mode, candidate.mode),
        eq(usageSyncChunksTable.rangeKey, candidate.rangeKey),
        eq(usageSyncChunksTable.scopeKey, candidate.scopeKey),
      ));
      await tx.delete(usageSyncStateTable).where(and(
        eq(usageSyncStateTable.mode, candidate.mode),
        eq(usageSyncStateTable.rangeKey, candidate.rangeKey),
        eq(usageSyncStateTable.scopeKey, candidate.scopeKey),
      ));
      syncMetadata.delete(id);
      removed++;
    }
    return removed;
  });
}

async function maybePruneExpiredCustomUsage(): Promise<void> {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = Date.now();
  try {
    const removed = await pruneExpiredCustomUsage();
    if (removed > 0) logger.info({ removed }, "Pruned expired custom usage snapshots");
  } catch (err) {
    logger.warn({ err }, "Failed to prune expired custom usage snapshots");
  }
}

function rangeBounds(
  range: UsageRange,
  now = Date.now(),
): { start: Date; end: Date; isClosed: boolean } {
  const start = new Date(range.params.startTime);
  const end = new Date(range.params.endTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new EnterpriseApiError(400, "Usage range must have valid startTime/endTime boundaries");
  }
  // Late-posted charges may arrive after a requested custom range ends. Keep it
  // mutable through a 24-hour grace window before treating it as immutable.
  const isClosed = range.key.startsWith("custom:") &&
    end.getTime() + CUSTOM_RANGE_CLOSURE_GRACE_MS <= now;
  return { start, end, isClosed };
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function planSyncChunks(
  range: UsageRange,
  previous: SyncMetadata | undefined,
  now = Date.now(),
): { replacementStart: Date; chunks: Array<{ start: Date; end: Date }>; isClosed: boolean } {
  const { start, end, isClosed } = rangeBounds(range, now);
  if (previous?.isClosed && previous.status === "success") {
    return { replacementStart: end, chunks: [], isClosed: previous.isClosed };
  }

  // A cold closed range still needs one complete snapshot. An already durable
  // range only re-fetches its bounded reconciliation tail before it is closed;
  // never replay the full reporting term merely because the grace window ended.
  if (isClosed && !previous) {
    return { replacementStart: start, chunks: [{ start, end }], isClosed: true };
  }

  if (previous?.status === "success" && previous.syncedThrough >= end.getTime() &&
      now - previous.completedAt < USAGE_TTL_MS) {
    return { replacementStart: end, chunks: [], isClosed: false };
  }

  // Pace is a small, workspace-authoritative projection snapshot. Replace its
  // whole interval on refresh instead of splitting it into daily mutable chunks;
  // this keeps the high-priority dashboard calculation fast and still captures
  // every late-posted/restated charge on each refresh.
  if (range.key.startsWith("pace:")) {
    return { replacementStart: start, chunks: [{ start, end }], isClosed: false };
  }

  const overlapAnchor = previous
    ? previous.syncedThrough - RECONCILIATION_OVERLAP_MS
    : end.getTime() - RECONCILIATION_OVERLAP_MS;
  const recentStartMs = Math.max(start.getTime(), utcDayStart(overlapAnchor));
  const chunks: Array<{ start: Date; end: Date }> = [];

  // Bootstrap old history in one request, while recent mutable days are kept
  // separately so later reconciliation can replace them without a full pull.
  if (!previous && start.getTime() < recentStartMs) {
    chunks.push({ start, end: new Date(recentStartMs) });
  }
  let cursor = recentStartMs;
  while (cursor < end.getTime()) {
    const next = Math.min(cursor + 24 * 60 * 60 * 1000, end.getTime());
    chunks.push({ start: new Date(cursor), end: new Date(next) });
    cursor = next;
  }
  return { replacementStart: new Date(recentStartMs), chunks, isClosed };
}

interface FetchedUsageChunk {
  payload: StoredUsagePayload;
  partial: boolean;
  error: string | null;
}

function combineUsagePayloads(parts: StoredUsagePayload[]): StoredUsagePayload {
  return {
    totalCostUsd: parts.reduce((sum, part) => sum + part.totalCostUsd, 0),
    attributableTotalCostUsd: parts.reduce(
      (sum, part) => sum + part.attributableTotalCostUsd,
      0,
    ),
    unattributableTotalCostUsd: parts.reduce(
      (sum, part) => sum + part.unattributableTotalCostUsd,
      0,
    ),
    groups: parts.flatMap((part) => part.groups),
  };
}

async function fetchUsageChunk(
  mode: UsageSyncMode,
  baseParams: Record<string, string | undefined>,
  start: Date,
  end: Date,
  cursorlessShardDepth = 0,
  telemetry: { runId: string; rangeKey: string; scopeKey: string } | null = null,
): Promise<FetchedUsageChunk> {
  const groups: UsageGroupEntry[] = [];
  let first: UsageData | undefined;
  let cursor: string | undefined;
  const groupBy =
    mode === "group_member" || mode === "workspace_member"
      ? "member"
      : mode === "group_project"
        ? "project"
        : undefined;

  for (let page = 0; page < MAX_USAGE_PAGES; page++) {
    markQueueProgress("usage_sync_page_start", {
      ...telemetry,
      mode,
      page: page + 1,
      shardDepth: cursorlessShardDepth,
      start: start.toISOString(),
      end: end.toISOString(),
    });
    const data = await usageFetch({
      ...baseParams,
      groupBy,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      limit: groupBy ? "100" : undefined,
      cursor,
    });
    first ??= data;
    groups.push(...(data.groups ?? []));
    markQueueProgress("usage_sync_page_finish", {
      ...telemetry,
      mode,
      page: page + 1,
      shardDepth: cursorlessShardDepth,
      rowCount: data.groups?.length ?? 0,
      accumulatedRowCount: groups.length,
      hasMore: data.pagination?.hasMore ?? false,
      hasCursor: !!data.pagination?.cursor,
    });
    if (!groupBy || !data.pagination?.hasMore) {
      return {
        payload: {
          totalCostUsd: first.totalCostUsd,
          attributableTotalCostUsd: first.attributableTotalCostUsd ?? 0,
          unattributableTotalCostUsd: first.unattributableTotalCostUsd ?? 0,
          groups,
        },
        partial: false,
        error: null,
      };
    }
    if (!data.pagination.cursor) {
      const duration = end.getTime() - start.getTime();
      if (
        duration > 60 * 60 * 1000 &&
        cursorlessShardDepth < MAX_CURSORLESS_SHARD_DEPTH
      ) {
        const midpoint = new Date(start.getTime() + Math.floor(duration / 2));
        const left = await fetchUsageChunk(
          mode,
          baseParams,
          start,
          midpoint,
          cursorlessShardDepth + 1,
          telemetry,
        );
        const right = await fetchUsageChunk(
          mode,
          baseParams,
          midpoint,
          end,
          cursorlessShardDepth + 1,
          telemetry,
        );
        return {
          payload: combineUsagePayloads([left.payload, right.payload]),
          partial: left.partial || right.partial,
          error: left.error ?? right.error,
        };
      }
      logger.warn({
        event: "usage_sync_malformed_pagination",
        ...telemetry,
        mode,
        page: page + 1,
        shardDepth: cursorlessShardDepth,
        start: start.toISOString(),
        end: end.toISOString(),
        accumulatedRowCount: groups.length,
      }, "Usage pagination reported more pages without a cursor");
      return {
        payload: {
          totalCostUsd: first.totalCostUsd,
          attributableTotalCostUsd: first.attributableTotalCostUsd ?? 0,
          unattributableTotalCostUsd: first.unattributableTotalCostUsd ?? 0,
          groups,
        },
        partial: true,
        error: "Usage pagination reported more pages without a cursor",
      };
    }
    cursor = data.pagination.cursor;
  }
  throw new Error(`Usage pagination exceeded ${MAX_USAGE_PAGES} pages`);
}

interface DailyFactScope {
  mode: UsageSyncMode;
  scopeKey: string;
  params: Record<string, string | undefined>;
}

interface HistoricalDailyFactBatch {
  key: string;
  monthStart: string;
  scope: DailyFactScope;
  usageDates: string[];
  priority: number;
  attempts: number;
  failed: boolean;
  nextAttemptAt: number;
  run?: () => Promise<void>;
}

export const HISTORICAL_DAILY_FACT_QUEUE_LIMIT = 8;
const HISTORICAL_DAILY_FACT_MAX_ATTEMPTS = 3;
const HISTORICAL_DAILY_FACT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const historicalDailyFactBatches = new Map<string, HistoricalDailyFactBatch>();
let historicalDailyFactBatchTotal = 0;
let historicalDailyFactBatchCompleted = 0;
let historicalDailyFactRetryTimer: NodeJS.Timeout | null = null;
let historicalDailyFactRetryAt = 0;

function historicalDailyFactQueueDepth(): number {
  return [...queuedKeys].filter((key) => key.startsWith("daily-facts-batch:")).length;
}

function historicalDailyFactFailedCount(): number {
  return [...historicalDailyFactBatches.values()]
    .filter((batch) => batch.failed)
    .length;
}

function historicalDailyFactRemainingDays(): number {
  return [...historicalDailyFactBatches.values()]
    .reduce((sum, batch) => sum + batch.usageDates.length, 0);
}

function logHistoricalDailyFactProgress(event: string): void {
  logger.info({
    event,
    totalBatches: historicalDailyFactBatchTotal,
    completedBatches: historicalDailyFactBatchCompleted,
    failedBatches: historicalDailyFactFailedCount(),
    remainingBatches: historicalDailyFactBatches.size,
    remainingDays: historicalDailyFactRemainingDays(),
    queuedBatches: historicalDailyFactQueueDepth(),
    queueDepth: totalQueuedCount(),
  }, "Historical daily usage fact progress");
}

function scheduleHistoricalDailyFactRefill(at: number): void {
  if (historicalDailyFactRetryTimer && historicalDailyFactRetryAt <= at) return;
  if (historicalDailyFactRetryTimer) clearTimeout(historicalDailyFactRetryTimer);
  historicalDailyFactRetryAt = at;
  historicalDailyFactRetryTimer = setTimeout(() => {
    historicalDailyFactRetryTimer = null;
    historicalDailyFactRetryAt = 0;
    refillHistoricalDailyFactQueue();
  }, Math.max(0, at - Date.now()));
  historicalDailyFactRetryTimer.unref();
}

function refillHistoricalDailyFactQueue(): void {
  const now = Date.now();
  const batches = [...historicalDailyFactBatches.values()];
  const nextRetryAt = batches.reduce<number | null>((earliest, batch) => {
    if (
      !batch.failed ||
      batch.attempts >= HISTORICAL_DAILY_FACT_MAX_ATTEMPTS ||
      batch.nextAttemptAt <= now
    ) {
      return earliest;
    }
    return earliest === null
      ? batch.nextAttemptAt
      : Math.min(earliest, batch.nextAttemptAt);
  }, null);
  if (nextRetryAt !== null) scheduleHistoricalDailyFactRefill(nextRetryAt);

  let available = HISTORICAL_DAILY_FACT_QUEUE_LIMIT - historicalDailyFactQueueDepth();
  if (available <= 0) return;
  const retryRank = (batch: HistoricalDailyFactBatch): number => {
    if (
      batch.failed &&
      batch.attempts < HISTORICAL_DAILY_FACT_MAX_ATTEMPTS &&
      batch.nextAttemptAt <= now
    ) {
      return 0;
    }
    if (!batch.failed) return 1;
    return 2;
  };
  batches.sort((a, b) => retryRank(a) - retryRank(b));
  for (const batch of batches) {
    if (available <= 0) break;
    if (queuedKeys.has(batch.key)) continue;
    if (batch.failed && batch.attempts >= HISTORICAL_DAILY_FACT_MAX_ATTEMPTS) continue;
    if (batch.nextAttemptAt > now) {
      continue;
    }
    const queued = enqueueUsage(batch.key, batch.priority, async () => {
      let completed = false;
      try {
        batch.failed = false;
        batch.attempts++;
        if (batch.run) {
          await batch.run();
        } else {
          for (const usageDate of batch.usageDates) {
            await syncDailyFactDay(usageDate, batch.scope);
          }
          await finalizeDailyFactMonth(batch.monthStart, batch.scope, new Date());
        }
        completed = true;
      } finally {
        if (completed) {
          historicalDailyFactBatches.delete(batch.key);
          historicalDailyFactBatchCompleted++;
        } else {
          batch.failed = true;
          const delayIndex = Math.min(
            batch.attempts - 1,
            HISTORICAL_DAILY_FACT_RETRY_DELAYS_MS.length - 1,
          );
          batch.nextAttemptAt = Date.now() +
            HISTORICAL_DAILY_FACT_RETRY_DELAYS_MS[delayIndex]!;
        }
        logHistoricalDailyFactProgress(
          completed ? "daily_fact_history_batch_completed" : "daily_fact_history_batch_failed",
        );
        // enqueueUsage keeps the active key registered until this task returns.
        // Refill on the next turn so the completed slot is visible as free.
        const refill = setTimeout(refillHistoricalDailyFactQueue, 0);
        refill.unref();
      }
    }, "backfill");
    if (queued) available--;
  }
}

function monthBounds(monthStart: string): { start: Date; end: Date } {
  const start = new Date(`${monthStart}T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

async function syncDailyFactDay(
  usageDate: string,
  scope: DailyFactScope,
): Promise<void> {
  const dayStart = new Date(`${usageDate}T00:00:00.000Z`);
  const result = await fetchUsageChunk(
    scope.mode,
    scope.params,
    dayStart,
    new Date(dayStart.getTime() + 86_400_000),
    0,
    { runId: nextQueueRunId(), rangeKey: `facts:${usageDate}`, scopeKey: scope.scopeKey },
  );
  if (result.partial) throw new Error(result.error ?? "Daily usage fact was partial");
  const completedAt = new Date();
  const committedFact: UsageDailyFact = {
    mode: scope.mode,
    scopeKey: scope.scopeKey,
    usageDate,
    payloadJson: result.payload,
    source: "enterprise_api",
    fetchedAt: completedAt,
  };
  const lockId = `daily-fact|${scope.mode}|${scope.scopeKey}|${usageDate}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockId}))`);
    await tx.insert(usageDailyFactsTable).values({
      mode: scope.mode,
      scopeKey: scope.scopeKey,
      usageDate,
      payloadJson: result.payload,
      source: "enterprise_api",
      fetchedAt: completedAt,
    }).onConflictDoUpdate({
      target: [
        usageDailyFactsTable.mode,
        usageDailyFactsTable.scopeKey,
        usageDailyFactsTable.usageDate,
      ],
      set: { payloadJson: result.payload, source: "enterprise_api", fetchedAt: completedAt },
    });
  });
  // Never publish data that has not survived the transaction commit.
  invalidateDailyFactRangeEntries(scope.mode, scope.scopeKey, usageDate);
  materializedFactScopes.clear();
  dailyFactRangeCache.clear();
}

async function finalizeDailyFactMonth(
  monthStart: string,
  scope: DailyFactScope,
  now = new Date(),
): Promise<void> {
  const { start: rawStart, end: naturalEnd } = monthBounds(monthStart);
  const start = new Date(Math.max(rawStart.getTime(), SPEND_DATA_CUTOFF_MS));
  const end = new Date(Math.min(naturalEnd.getTime(), utcDayStart(now.getTime()) + 86_400_000));
  const expectedDays = dateRangeDays(start, end);
  const persistedFacts = await db.select().from(usageDailyFactsTable).where(and(
    eq(usageDailyFactsTable.mode, scope.mode),
    eq(usageDailyFactsTable.scopeKey, scope.scopeKey),
    gte(usageDailyFactsTable.usageDate, expectedDays[0]!),
    lt(usageDailyFactsTable.usageDate, new Date(end).toISOString().slice(0, 10)),
  ));
  const persistedByDay = new Map(persistedFacts.map((fact) => [fact.usageDate, fact]));
  if (expectedDays.some((day) => !persistedByDay.has(day))) {
    throw new Error(`Daily fact month ${monthStart} is incomplete for ${scope.mode}/${scope.scopeKey}`);
  }
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().slice(0, 10);
  if (monthStart === currentMonthStart) {
    const direct = await fetchUsageChunk(
      scope.mode,
      scope.params,
      start,
      now,
      0,
      { runId: nextQueueRunId(), rangeKey: `facts-parity:${monthStart}`, scopeKey: scope.scopeKey },
    );
    const storedTotalUsd = expectedDays.reduce(
      (sum, day) =>
        sum + (persistedByDay.get(day)!.payloadJson as StoredUsagePayload).totalCostUsd,
      0,
    );
    const deltaUsd = direct.payload.totalCostUsd - storedTotalUsd;
    if (direct.partial || Math.abs(deltaUsd) >= VERIFICATION_HEAL_THRESHOLD_USD) {
      throw new Error(
        `Daily fact parity failed for ${scope.mode}/${scope.scopeKey}: delta ${deltaUsd}`,
      );
    }
    verifiedDailyFactScopes.add(`${scope.mode}|${scope.scopeKey}`);
  }
  const isClosed = naturalEnd.getTime() + DAILY_FACT_MONTH_GRACE_MS <= now.getTime();
  const monthLockId = `daily-facts-month|${scope.mode}|${scope.scopeKey}|${monthStart}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${monthLockId}))`);
    const committed = await tx.select({
      usageDate: usageDailyFactsTable.usageDate,
    }).from(usageDailyFactsTable).where(and(
      eq(usageDailyFactsTable.mode, scope.mode),
      eq(usageDailyFactsTable.scopeKey, scope.scopeKey),
      gte(usageDailyFactsTable.usageDate, expectedDays[0]!),
      lt(usageDailyFactsTable.usageDate, end.toISOString().slice(0, 10)),
    ));
    const committedDays = new Set(committed.map((fact) => fact.usageDate));
    if (expectedDays.some((day) => !committedDays.has(day))) {
      throw new Error(
        `Daily fact month ${monthStart} lost persisted coverage for ${scope.mode}/${scope.scopeKey}`,
      );
    }
    const completedAt = new Date();
    await tx.insert(usageFactMonthsTable).values({
      mode: scope.mode,
      scopeKey: scope.scopeKey,
      monthStart,
      isClosed,
      status: "success",
      errorMessage: null,
      syncedThrough: end,
      completedAt,
    }).onConflictDoUpdate({
      target: [
        usageFactMonthsTable.mode,
        usageFactMonthsTable.scopeKey,
        usageFactMonthsTable.monthStart,
      ],
      set: { isClosed, status: "success", errorMessage: null, syncedThrough: end, completedAt },
    });
  });
  queueCanonicalMonthRebuild(monthStart);
}

/**
 * Copy legacy chunks that already represent exactly one UTC day. Aggregate
 * chunks are deliberately not divided; the month backfill retrieves those
 * bounded intervals again because splitting an aggregate would invent data.
 */
async function backfillDailyFactsFromLegacyChunks(): Promise<number> {
  const [rows, existing] = await Promise.all([
    db.select().from(usageSyncChunksTable),
    db.select({
      mode: usageDailyFactsTable.mode,
      scopeKey: usageDailyFactsTable.scopeKey,
      usageDate: usageDailyFactsTable.usageDate,
    }).from(usageDailyFactsTable),
  ]);
  const existingIds = new Set(
    existing.map((fact) => dailyFactId(fact.mode as UsageSyncMode, fact.scopeKey, fact.usageDate)),
  );
  const compatible = rows.filter((row) =>
    row.chunkStart.getTime() === utcDayStart(row.chunkStart.getTime()) &&
    row.chunkEnd.getTime() - row.chunkStart.getTime() === 86_400_000 &&
    !existingIds.has(dailyFactId(
      row.mode as UsageSyncMode,
      row.scopeKey,
      row.chunkStart.toISOString().slice(0, 10),
    ))
  );
  let inserted = 0;
  await db.transaction(async (tx) => {
    for (const row of compatible) {
      const usageDate = row.chunkStart.toISOString().slice(0, 10);
      await tx.insert(usageDailyFactsTable).values({
        mode: row.mode,
        scopeKey: row.scopeKey,
        usageDate,
        payloadJson: row.payloadJson,
        source: "legacy_daily_chunk",
        fetchedAt: row.completedAt,
      }).onConflictDoNothing();
      inserted++;
    }
  });
  return inserted;
}

async function queueDailyFactRefreshes(): Promise<void> {
  if (!isConfigured()) return;
  const dir = await getDirectory();
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const scopes: DailyFactScope[] = [
    { mode: "account_total", scopeKey: ACCOUNT_USAGE_SCOPE, params: {} },
    ...dir.groups.flatMap((group): DailyFactScope[] => {
      const params = { workspaceId: group.workspaceId, groupId: group.id };
      return [
        { mode: "group_total", scopeKey: group.id, params },
        { mode: "group_member", scopeKey: group.id, params },
        { mode: "group_project", scopeKey: group.id, params },
      ];
    }),
    ...[...dir.workspaces.keys()].map((workspaceId): DailyFactScope => ({
      mode: "workspace_member",
      scopeKey: workspaceId,
      params: { workspaceId },
    })),
  ];
  const [monthStates, storedFacts] = await Promise.all([
    db.select({
      mode: usageFactMonthsTable.mode,
      scopeKey: usageFactMonthsTable.scopeKey,
      monthStart: usageFactMonthsTable.monthStart,
      isClosed: usageFactMonthsTable.isClosed,
    }).from(usageFactMonthsTable),
    db.select({
      mode: usageDailyFactsTable.mode,
      scopeKey: usageDailyFactsTable.scopeKey,
      usageDate: usageDailyFactsTable.usageDate,
    }).from(usageDailyFactsTable),
  ]);
  const closedMonths = new Set(
    monthStates
      .filter((state) => state.isClosed)
      .map((state) => `${state.monthStart}|${state.mode}|${state.scopeKey}`),
  );
  const existingFacts = new Set(
    storedFacts.map((fact) => dailyFactId(
      fact.mode as UsageSyncMode,
      fact.scopeKey,
      fact.usageDate,
    )),
  );
  dailyFactParityReady = false;
  verifiedDailyFactScopes.clear();
  if (historicalDailyFactBatches.size === 0 && historicalDailyFactQueueDepth() === 0) {
    historicalDailyFactBatchTotal = 0;
    historicalDailyFactBatchCompleted = 0;
  } else {
    for (const batch of historicalDailyFactBatches.values()) {
      if (!batch.failed || queuedKeys.has(batch.key)) continue;
      batch.attempts = 0;
      batch.failed = false;
      batch.nextAttemptAt = 0;
    }
  }
  let scheduledQueued = 0;
  let historicalBatchCount = 0;
  const cutoff = new Date(SPEND_DATA_CUTOFF_MS);
  const months: string[] = [];
  for (
    let cursor = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1));
    cursor <= new Date(`${currentMonth}T00:00:00.000Z`);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  ) {
    months.push(cursor.toISOString().slice(0, 10));
  }
  for (const monthStart of months.reverse()) {
    const { start: rawStart, end: naturalEnd } = monthBounds(monthStart);
    const rangeStart = new Date(Math.max(rawStart.getTime(), SPEND_DATA_CUTOFF_MS));
    const rangeEnd = new Date(Math.min(
      naturalEnd.getTime(),
      utcDayStart(now.getTime()) + 86_400_000,
    ));
    const isCurrent = monthStart === currentMonth;
    const mutableTailStart = utcDayStart(rangeEnd.getTime() - RECONCILIATION_OVERLAP_MS);
    for (const scope of scopes) {
      if (closedMonths.has(`${monthStart}|${scope.mode}|${scope.scopeKey}`)) continue;
      const priority = isCurrent ? (scope.mode === "account_total" ? -5 : 1) : 2;
      const neededDates: string[] = [];
      for (const usageDate of dateRangeDays(rangeStart, rangeEnd)) {
        const factId = dailyFactId(scope.mode, scope.scopeKey, usageDate);
        const dayMs = new Date(`${usageDate}T00:00:00.000Z`).getTime();
        const needsRefresh = !existingFacts.has(factId) ||
          (isCurrent && dayMs >= mutableTailStart);
        if (!needsRefresh) continue;
        if (!isCurrent) {
          neededDates.push(usageDate);
          continue;
        }
        const queued = enqueueUsage(
          `daily-fact:${usageDate}:${scope.mode}:${scope.scopeKey}`,
          priority,
          () => syncDailyFactDay(usageDate, scope),
          "scheduled",
        );
        if (queued) scheduledQueued++;
      }
      if (isCurrent) {
        const finalizerQueued = enqueueUsage(
          `daily-facts-finalize:${monthStart}:${scope.mode}:${scope.scopeKey}`,
          priority,
          () => finalizeDailyFactMonth(monthStart, scope, new Date()),
          "scheduled",
        );
        if (finalizerQueued) scheduledQueued++;
        continue;
      }
      const batchKey = `daily-facts-batch:${monthStart}:${scope.mode}:${scope.scopeKey}`;
      const existingBatch = historicalDailyFactBatches.get(batchKey);
      if (existingBatch && !queuedKeys.has(batchKey)) {
        existingBatch.scope = scope;
        existingBatch.usageDates = neededDates;
        existingBatch.priority = priority;
      } else if (!existingBatch && !queuedKeys.has(batchKey)) {
        historicalDailyFactBatches.set(batchKey, {
          key: batchKey,
          monthStart,
          scope,
          usageDates: neededDates,
          priority,
          attempts: 0,
          failed: false,
          nextAttemptAt: 0,
        });
        historicalBatchCount++;
      }
    }
  }
  historicalDailyFactBatchTotal = Math.max(
    historicalDailyFactBatchTotal,
    historicalDailyFactBatchCompleted + historicalDailyFactBatches.size,
  );
  refillHistoricalDailyFactQueue();
  // Current-month finalizers are inserted before this gate at the same
  // priorities, while historical work remains lower priority.
  enqueueUsage(`daily-facts-parity:${currentMonth}`, 1, async () => {
    dailyFactParityReady = scopes.every((scope) =>
      verifiedDailyFactScopes.has(`${scope.mode}|${scope.scopeKey}`)
    );
    logger[dailyFactParityReady ? "info" : "warn"](
      { verifiedScopes: verifiedDailyFactScopes.size, requiredScopes: scopes.length },
      dailyFactParityReady
        ? "Daily usage facts passed current-month parity"
        : "Daily usage facts failed current-month parity; legacy reads remain active",
    );
  }, "scheduled");
  logger.info({
    event: "daily_fact_refresh_planned",
    scopes: scopes.length,
    months: months.length,
    scheduledQueued,
    historicalBatchCount,
    historicalRemainingBatches: historicalDailyFactBatches.size,
    historicalRemainingDays: historicalDailyFactRemainingDays(),
    historicalFailedBatches: historicalDailyFactFailedCount(),
    historicalQueuedBatches: historicalDailyFactQueueDepth(),
    queueDepth: totalQueuedCount(),
  }, "Daily usage fact refresh planned");
}

export function startDailyFactJob(): void {
  if (dailyFactRefreshTimer) return;
  const run = () => {
    void withJobClaim(
      "enterprise:daily-facts",
      24 * 60 * 60 * 1000,
      10 * 60 * 1000,
      async (claim) => {
        claim.signal?.throwIfAborted();
        await queueDailyFactRefreshes();
        claim.signal?.throwIfAborted();
      },
    ).catch((err) => {
      dailyFactParityReady = false;
      logger.warn({ err }, "Failed to plan daily usage fact refresh");
    });
  };
  const initial = setTimeout(run, 5_000);
  initial.unref();
  // Poll claims more often than the cadence so another replica recovers an
  // abandoned lease promptly; notBefore prevents successful work repeating.
  dailyFactRefreshTimer = setInterval(run, 15 * 60 * 1000);
  dailyFactRefreshTimer.unref();
}

export const USAGE_COORDINATOR_INTERVAL_MS = 5 * 60 * 1000;
async function synchronizeUsage(
  mode: UsageSyncMode,
  range: UsageRange,
  scopeKey: string,
  baseParams: Record<string, string | undefined>,
  force = false,
): Promise<UsageSyncChunk[]> {
  if (await prepareUsageRangeFromStoredDailyFacts(range, mode, scopeKey)) {
    const rows = factRowsForRange(mode, scopeKey, range);
    if (rows) return rows;
  }
  await maybePruneExpiredCustomUsage();
  const id = syncId(mode, range.key, scopeKey);
  const priorMetadata = syncMetadata.get(id);
  const runId = nextQueueRunId();
  const { start: attemptedStart } = rangeBounds(range);
  const startedAt = new Date();
  // Running state is process-local until the advisory-lock transaction commits.
  // A crash therefore leaves either the prior terminal state or no state at all,
  // both of which are safely retryable after startup.
  if (priorMetadata?.status !== "success") {
    syncMetadata.set(id, {
      syncedThrough: priorMetadata?.syncedThrough ?? attemptedStart.getTime(),
      completedAt: startedAt.getTime(),
      isClosed: priorMetadata?.isClosed ?? false,
      status: "syncing",
      error: null,
    });
  }
  try {
  const result = await db.transaction(async (tx) => {
    // The in-process queue serializes API calls for one server. This lock extends
    // the same guarantee across replicas and is held through planning, fetching,
    // and commit so a second writer re-plans from the first writer's watermark.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
    const [storedState] = await tx
      .select()
      .from(usageSyncStateTable)
      .where(and(
        eq(usageSyncStateTable.mode, mode),
        eq(usageSyncStateTable.rangeKey, range.key),
        eq(usageSyncStateTable.scopeKey, scopeKey),
      ));
    const storedPrevious = storedState
      ? {
          syncedThrough: storedState.syncedThrough.getTime(),
          completedAt: storedState.completedAt.getTime(),
          isClosed: storedState.isClosed,
          status: storedState.status as UsageSyncStatus,
          error: storedState.errorMessage,
        }
      : undefined;
    const previous = force && storedPrevious && !storedPrevious.isClosed
      ? { ...storedPrevious, completedAt: 0 }
      : storedPrevious;
    const plan = planSyncChunks(range, previous);
    logger.info({
      event: "usage_sync_plan",
      runId,
      mode,
      rangeKey: range.key,
      scopeKey,
      force,
      chunkCount: plan.chunks.length,
      replacementStart: plan.replacementStart.toISOString(),
      priorWatermark: storedPrevious
        ? new Date(storedPrevious.syncedThrough).toISOString()
        : null,
      targetWatermark: rangeBounds(range).end.toISOString(),
      isClosed: plan.isClosed,
    }, "Planned incremental usage synchronization");
    if (plan.chunks.length === 0) {
      const rows = await tx
        .select()
        .from(usageSyncChunksTable)
        .where(and(
          eq(usageSyncChunksTable.mode, mode),
          eq(usageSyncChunksTable.rangeKey, range.key),
          eq(usageSyncChunksTable.scopeKey, scopeKey),
        ));
      return { rows, metadata: { ...storedPrevious!, status: "success" as const, error: null } };
    }

    // Every chunk/page is fetched before any DELETE/INSERT. A network failure
    // rolls back the transaction and preserves the prior snapshot + watermark.
    const fetched: Array<{
      start: Date;
      end: Date;
      payload: StoredUsagePayload;
      partial: boolean;
      error: string | null;
    }> = [];
    for (const [chunkIndex, chunk] of plan.chunks.entries()) {
      if (fetched.length > 0) {
        await new Promise((r) => setTimeout(r, 700));
      }
      logger.info({
        event: "usage_sync_chunk_start",
        runId,
        mode,
        rangeKey: range.key,
        scopeKey,
        chunkIndex: chunkIndex + 1,
        chunkCount: plan.chunks.length,
        start: chunk.start.toISOString(),
        end: chunk.end.toISOString(),
      }, "Fetching incremental usage chunk");
      const result = await fetchUsageChunk(
        mode,
        baseParams,
        chunk.start,
        chunk.end,
        0,
        { runId, rangeKey: range.key, scopeKey },
      );
      fetched.push({ ...chunk, ...result });
      logger.info({
        event: "usage_sync_chunk_finish",
        runId,
        mode,
        rangeKey: range.key,
        scopeKey,
        chunkIndex: chunkIndex + 1,
        chunkCount: plan.chunks.length,
        partial: result.partial,
        error: result.error,
      }, "Fetched incremental usage chunk");
      // A cursorless workspace-member response cannot be made complete by
      // fetching later chunks. Stop after the bounded recovery for the first
      // affected interval instead of multiplying that bound across the range.
      if (mode === "workspace_member" && result.partial) break;
    }

    const completedAt = new Date();
    const { start: rangeStart, end: syncedThrough } = rangeBounds(range);
    const partialError = fetched.find((chunk) => chunk.partial)?.error ?? null;
    const status: UsageSyncStatus = partialError ? "partial" : "success";
    if (partialError && storedState) {
      const retainedRows = await tx
        .select()
        .from(usageSyncChunksTable)
        .where(and(
          eq(usageSyncChunksTable.mode, mode),
          eq(usageSyncChunksTable.rangeKey, range.key),
          eq(usageSyncChunksTable.scopeKey, scopeKey),
        ));
      if (retainedRows.length > 0) {
        await tx.update(usageSyncStateTable).set({
          isClosed: false,
          status: "partial",
          errorMessage: partialError,
          startedAt,
          completedAt,
        }).where(and(
          eq(usageSyncStateTable.mode, mode),
          eq(usageSyncStateTable.rangeKey, range.key),
          eq(usageSyncStateTable.scopeKey, scopeKey),
        ));
        return {
          rows: retainedRows,
          metadata: {
            syncedThrough: storedState.syncedThrough.getTime(),
            completedAt: completedAt.getTime(),
            isClosed: false,
            status: "partial" as const,
            error: partialError,
          },
        };
      }
    }
    await tx
      .delete(usageSyncChunksTable)
      .where(and(
        eq(usageSyncChunksTable.mode, mode),
        eq(usageSyncChunksTable.rangeKey, range.key),
        eq(usageSyncChunksTable.scopeKey, scopeKey),
        gt(usageSyncChunksTable.chunkEnd, plan.replacementStart),
      ));
    if (fetched.length > 0) {
      await tx.insert(usageSyncChunksTable).values(fetched.map((chunk) => ({
        mode,
        rangeKey: range.key,
        scopeKey,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        payloadJson: chunk.payload,
        completedAt,
      })));
    }
    await tx.insert(usageSyncStateTable).values({
      mode,
      rangeKey: range.key,
      scopeKey,
      rangeStart,
      syncedThrough,
      isClosed: plan.isClosed,
      status,
      errorMessage: partialError,
      startedAt,
      completedAt,
    }).onConflictDoUpdate({
      target: [usageSyncStateTable.mode, usageSyncStateTable.rangeKey, usageSyncStateTable.scopeKey],
      set: {
        rangeStart,
        syncedThrough,
        isClosed: plan.isClosed && status === "success",
        status,
        errorMessage: partialError,
        startedAt,
        completedAt,
      },
    });
    const rows = await tx
      .select()
      .from(usageSyncChunksTable)
      .where(and(
        eq(usageSyncChunksTable.mode, mode),
        eq(usageSyncChunksTable.rangeKey, range.key),
        eq(usageSyncChunksTable.scopeKey, scopeKey),
      ));
    return {
      rows,
      metadata: {
        syncedThrough: syncedThrough.getTime(),
        completedAt: completedAt.getTime(),
        isClosed: plan.isClosed && status === "success",
        status,
        error: partialError,
      },
    };
  });
  syncMetadata.set(id, result.metadata);
  logger.info({
    event: "usage_sync_commit",
    runId,
    mode,
    rangeKey: range.key,
    scopeKey,
    status: result.metadata.status,
    priorWatermark: priorMetadata
      ? new Date(priorMetadata.syncedThrough).toISOString()
      : null,
    newWatermark: new Date(result.metadata.syncedThrough).toISOString(),
    rowCount: result.rows.length,
    retainedSnapshot: result.metadata.status === "partial" && !!priorMetadata,
    durationMs: Date.now() - startedAt.getTime(),
  }, "Committed incremental usage synchronization");
  return result.rows;
  } catch (err) {
    const completedAt = new Date();
    const message = err instanceof Error ? err.message : String(err);
    const failureMetadata = await db.transaction(async (tx): Promise<SyncMetadata> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      const [current] = await tx.select().from(usageSyncStateTable).where(and(
        eq(usageSyncStateTable.mode, mode),
        eq(usageSyncStateTable.rangeKey, range.key),
        eq(usageSyncStateTable.scopeKey, scopeKey),
      ));
      // A competing replica may have completed a newer attempt after this one
      // started. Never let this older failure overwrite that newer success.
      if (current && current.completedAt > startedAt) {
        return {
          syncedThrough: current.syncedThrough.getTime(),
          completedAt: current.completedAt.getTime(),
          isClosed: current.isClosed,
          status: current.status as UsageSyncStatus,
          error: current.errorMessage,
        };
      }
      if (current) {
        await tx.update(usageSyncStateTable).set({
          status: "failed",
          errorMessage: message.slice(0, 1000),
          startedAt,
          completedAt,
        }).where(and(
          eq(usageSyncStateTable.mode, mode),
          eq(usageSyncStateTable.rangeKey, range.key),
          eq(usageSyncStateTable.scopeKey, scopeKey),
          lte(usageSyncStateTable.completedAt, startedAt),
        ));
      } else {
        await tx.insert(usageSyncStateTable).values({
          mode,
          rangeKey: range.key,
          scopeKey,
          rangeStart: attemptedStart,
          syncedThrough: attemptedStart,
          isClosed: false,
          status: "failed",
          errorMessage: message.slice(0, 1000),
          startedAt,
          completedAt,
        });
      }
      return {
        syncedThrough: priorMetadata?.syncedThrough ?? attemptedStart.getTime(),
        completedAt: completedAt.getTime(),
        isClosed: priorMetadata?.isClosed ?? false,
        status: "failed",
        error: message,
      };
    });
    syncMetadata.set(id, failureMetadata);
    logger.error({
      event: "usage_sync_rollback",
      err,
      runId,
      mode,
      rangeKey: range.key,
      scopeKey,
      status: failureMetadata.status,
      retainedSnapshot: priorMetadata?.status === "success" ||
        priorMetadata?.status === "partial",
      priorWatermark: priorMetadata
        ? new Date(priorMetadata.syncedThrough).toISOString()
        : null,
      durationMs: Date.now() - startedAt.getTime(),
    }, "Incremental usage synchronization failed; prior snapshot retained");
    throw err;
  }
}

function storedPayload(row: UsageSyncChunk): StoredUsagePayload {
  return row.payloadJson as StoredUsagePayload;
}

function aggregateGroupSpend(rows: UsageSyncChunk[]): GroupSpend {
  return {
    spendUsd: rows.reduce((sum, row) => sum + storedPayload(row).totalCostUsd, 0),
    fetchedAt: Math.max(...rows.map((row) => row.completedAt.getTime())),
    periodStart: new Date(Math.min(...rows.map((row) => row.chunkStart.getTime()))).toISOString(),
    periodEnd: new Date(Math.max(...rows.map((row) => row.chunkEnd.getTime()))).toISOString(),
  };
}

export interface AccountUsage {
  fetchedAt: number;
  totalCostUsd: number;
  attributableTotalCostUsd: number;
  unattributableTotalCostUsd: number;
}

function aggregateAccountUsage(rows: UsageSyncChunk[]): AccountUsage {
  let totalCostUsd = 0;
  let attributableTotalCostUsd = 0;
  let unattributableTotalCostUsd = 0;
  for (const row of rows) {
    const payload = storedPayload(row);
    totalCostUsd += payload.totalCostUsd;
    attributableTotalCostUsd += payload.attributableTotalCostUsd;
    unattributableTotalCostUsd += payload.unattributableTotalCostUsd;
  }
  return {
    fetchedAt: Math.max(...rows.map((row) => row.completedAt.getTime())),
    totalCostUsd,
    attributableTotalCostUsd,
    unattributableTotalCostUsd,
  };
}

function aggregateMemberUsage(rows: UsageSyncChunk[]): MemberUsage {
  const byUser = new Map<string, number>();
  const agentByUser = new Map<string, number>();
  let attributableTotalCostUsd = 0;
  let unattributableTotalCostUsd = 0;
  let totalCostUsd = 0;
  for (const row of rows) {
    const payload = storedPayload(row);
    attributableTotalCostUsd += payload.attributableTotalCostUsd;
    unattributableTotalCostUsd += payload.unattributableTotalCostUsd;
    totalCostUsd += payload.totalCostUsd;
    for (const entry of payload.groups) {
      if (entry.key.userId) {
        byUser.set(entry.key.userId, (byUser.get(entry.key.userId) ?? 0) + entry.totalCostUsd);
        if (Array.isArray(entry.metrics)) {
          const agentSpend = sumAgentUsageMetrics(entry.metrics);
          agentByUser.set(
            entry.key.userId,
            (agentByUser.get(entry.key.userId) ?? 0) + agentSpend,
          );
        }
      }
    }
  }
  return {
    fetchedAt: Math.max(...rows.map((row) => row.completedAt.getTime())),
    byUser,
    agentByUser,
    attributableTotalCostUsd,
    unattributableTotalCostUsd,
    totalCostUsd,
  };
}

function aggregateWorkspaceMemberUsage(rows: UsageSyncChunk[]): MemberUsage {
  return aggregateMemberUsage(rows);
}

function aggregateProjectUsage(rows: UsageSyncChunk[]): ProjectUsage {
  const byProject = new Map<string, ProjectUsageEntry>();
  let totalCostUsd = 0;
  for (const row of rows) {
    const payload = storedPayload(row);
    totalCostUsd += payload.totalCostUsd;
    for (const entry of payload.groups) {
      if (!entry.key.projectId) continue;
      let project = byProject.get(entry.key.projectId);
      if (!project) {
        project = { projectId: entry.key.projectId, workspaceId: entry.key.workspaceId ?? null, totalCostUsd: 0, metrics: [] };
        byProject.set(entry.key.projectId, project);
      }
      project.totalCostUsd += entry.totalCostUsd;
      for (const metric of entry.metrics ?? []) {
        const existing = project.metrics.find((candidate) => candidate.id === metric.id);
        if (existing) existing.costUsd += metric.costUsd;
        else project.metrics.push({ ...metric });
      }
    }
  }
  return {
    fetchedAt: Math.max(...rows.map((row) => row.completedAt.getTime())),
    byProject,
    totalCostUsd,
  };
}

function isDurablyFresh(
  mode: UsageSyncMode,
  rangeKey: string,
  scopeKey: string,
  fetchedAt: number | undefined,
  force: boolean,
): boolean {
  const metadata = syncMetadata.get(syncId(mode, rangeKey, scopeKey));
  if (!force && (metadata?.status === "failed" || metadata?.status === "partial")) {
    if (mode !== "account_total") return true;
    return Date.now() < (accountUsageRetryAt.get(rangeKey) ?? metadata.completedAt);
  }
  if (metadata?.isClosed && metadata.status === "success") return true;
  return !force && fetchedAt !== undefined && Date.now() - fetchedAt < USAGE_TTL_MS;
}

function markUsageSyncQueued(
  mode: UsageSyncMode,
  rangeKey: string,
  scopeKey: string,
): void {
  const id = syncId(mode, rangeKey, scopeKey);
  const previous = syncMetadata.get(id);
  // Keep serving an already-hydrated Postgres snapshot as complete while its
  // incremental replacement is queued. Only a genuinely cold scope blocks UI.
  if (previous?.status === "success") return;
  const now = Date.now();
  syncMetadata.set(id, {
    syncedThrough: previous?.syncedThrough ?? 0,
    completedAt: now,
    isClosed: previous?.isClosed ?? false,
    status: "syncing",
    error: null,
  });
}

export function getUsageSyncSummary(
  rangeKey: string,
  groups: readonly EnterpriseGroup[],
  workspaceIds: Iterable<string>,
  includeAccount = false,
  includeProjects = true,
): UsageSyncSummary {
  const requirements = [
    ...groups.flatMap((group) => [
      ...(!wsSpendCache.has(`${rangeKey}|${group.workspaceId}`) ? [{
        id: syncId("group_member", rangeKey, group.id),
        loaded: memberUsageCache.has(`${rangeKey}|${group.id}`),
        fetchedAt: memberUsageCache.get(`${rangeKey}|${group.id}`)?.fetchedAt,
      }] : []),
      ...(includeProjects ? [{
        id: syncId("group_project", rangeKey, group.id),
        loaded: projectUsageCache.has(`${rangeKey}|${group.id}`),
        fetchedAt: projectUsageCache.get(`${rangeKey}|${group.id}`)?.fetchedAt,
      }] : []),
    ]),
    ...[...workspaceIds].map((workspaceId) => ({
      id: syncId("workspace_member", rangeKey, workspaceId),
      loaded: wsSpendCache.has(`${rangeKey}|${workspaceId}`),
      fetchedAt: wsSpendCache.get(`${rangeKey}|${workspaceId}`)?.fetchedAt,
    })),
    ...(includeAccount ? [{
      id: syncId("account_total", rangeKey, ACCOUNT_USAGE_SCOPE),
      loaded: accountUsageCache.has(rangeKey),
      fetchedAt: accountUsageCache.get(rangeKey)?.fetchedAt,
    }] : []),
  ];
  let pendingCount = 0;
  let failedCount = 0;
  let partialCount = 0;
  let error: string | null = null;
  for (const { id, loaded } of requirements) {
    const metadata = syncMetadata.get(id);
    // The loaded fallback supports in-process test seams and upgrades from
    // pre-ledger caches. Normal runtime hydration always supplies metadata.
    if ((!metadata && !loaded) || (metadata?.status === "syncing" && !loaded)) pendingCount++;
    else if (metadata?.status === "failed") {
      failedCount++;
      error ??= formatUsageScopeError(id, metadata.error);
    } else if (metadata?.status === "partial") {
      partialCount++;
      error ??= formatUsageScopeError(id, metadata.error);
    }
  }
  const fetchedTimes = requirements
    .filter((requirement) => requirement.loaded && requirement.fetchedAt !== undefined)
    .map((requirement) => requirement.fetchedAt!);
  const oldestFetchedAt = fetchedTimes.length > 0 ? Math.min(...fetchedTimes) : null;
  return {
    status: failedCount > 0
      ? "failed"
      : partialCount > 0
        ? "partial"
        : pendingCount > 0
          ? "syncing"
          : "complete",
    pendingCount,
    failedCount,
    partialCount,
    error,
    dataAsOf: oldestFetchedAt === null ? null : new Date(oldestFetchedAt).toISOString(),
    isStale: oldestFetchedAt !== null && Date.now() - oldestFetchedAt >= USAGE_TTL_MS,
  };
}

export function getProjectUsageSyncSummary(
  rangeKey: string,
  groups: readonly EnterpriseGroup[],
): UsageSyncSummary {
  let pendingCount = 0;
  let failedCount = 0;
  let partialCount = 0;
  let error: string | null = null;
  const fetchedTimes: number[] = [];
  for (const group of groups) {
    const id = syncId("group_project", rangeKey, group.id);
    const metadata = syncMetadata.get(id);
    const loaded = projectUsageCache.has(`${rangeKey}|${group.id}`);
    const fetchedAt = projectUsageCache.get(`${rangeKey}|${group.id}`)?.fetchedAt;
    if (fetchedAt !== undefined) fetchedTimes.push(fetchedAt);
    if ((!metadata && !loaded) || (metadata?.status === "syncing" && !loaded)) {
      pendingCount++;
    } else if (metadata?.status === "failed") {
      failedCount++;
      error ??= formatUsageScopeError(id, metadata.error);
    } else if (metadata?.status === "partial") {
      partialCount++;
      error ??= formatUsageScopeError(id, metadata.error);
    }
  }
  const oldestFetchedAt = fetchedTimes.length > 0 ? Math.min(...fetchedTimes) : null;
  return {
    status: failedCount > 0
      ? "failed"
      : partialCount > 0
        ? "partial"
        : pendingCount > 0
          ? "syncing"
          : "complete",
    pendingCount,
    failedCount,
    partialCount,
    error,
    dataAsOf: oldestFetchedAt === null ? null : new Date(oldestFetchedAt).toISOString(),
    isStale: oldestFetchedAt !== null && Date.now() - oldestFetchedAt >= USAGE_TTL_MS,
  };
}

function formatUsageScopeError(id: string, error: string | null): string | null {
  if (!error) return null;
  const [mode, , scopeKey] = id.split("|");
  const label = mode === "workspace_member"
    ? "Workspace member usage"
    : mode === "group_member"
      ? "Group member usage"
      : mode === "group_project"
        ? "Project detail"
        : mode === "account_total"
          ? "Account usage"
          : "Usage";
  return `${label} (${scopeKey ?? "unknown scope"}): ${error}`;
}

export function isUsageSyncRetryable(
  mode: UsageSyncMode,
  rangeKey: string,
  scopeKey: string,
): boolean {
  const status = syncMetadata.get(syncId(mode, rangeKey, scopeKey))?.status;
  return status === "failed" || status === "partial";
}

// ---------- Directory (workspaces, groups, members, platform budgets) ----------

interface Pagination {
  cursor: string | null;
  hasMore: boolean;
}

async function paginate<T>(
  path: string,
  params: Record<string, string | undefined>,
  maxPages = 200,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let body: unknown;
    for (let attempts = 1;; attempts++) {
      try {
        ({ body } = await rawFetch(path, { ...params, limit: "100", cursor }));
        break;
      } catch (err) {
        const apiError = err as EnterpriseApiError;
        if (apiError.status !== 429 || attempts > 5) throw err;
        // rawFetch has already applied Retry-After to the shared budget.
        // Retry this exact cursor after admission reopens.
      }
    }
    lastApiOk = true;
    lastApiError = null;
    const resp = body as { data: T[]; pagination: Pagination };
    out.push(...resp.data);
    if (!resp.pagination.hasMore || !resp.pagination.cursor) return out;
    cursor = resp.pagination.cursor;
  }
  logger.warn({ path }, "Pagination truncated at maxPages — results may be incomplete");
  return out;
}
export interface EnterpriseWorkspace {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
}

export interface EnterpriseGroup {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
}

const BUILT_IN_GROUP_TYPES = new Set(["admin", "member", "guest"]);

export function isCustomGroup(group: EnterpriseGroup): boolean {
  return !BUILT_IN_GROUP_TYPES.has(group.type.toLowerCase());
}

export interface EnterpriseMember {
  userId: string;
  username: string;
  email: string;
  name: string | null;
  // Whether this member is an account-wide administrator of the Enterprise org.
  isAccountAdmin: boolean;
  // per-workspace role/disabled state
  workspaces: Map<string, { role: string; isDisabled: boolean }>;
}

interface RawMember {
  user: {
    id: string;
    username: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
  // Account-wide admin flag. The Enterprise directory may expose this as a
  // top-level boolean or nested under the user; parse defensively.
  isAccountAdmin?: boolean;
  user_is_account_admin?: boolean;
  // Additional field shapes observed or documented by the Replit Enterprise API.
  role?: string;
  organizationRole?: string;
  accountRole?: string;
  workspaces: { id: string; role: string; isDisabled: boolean }[];
}

/**
 * The set of role strings that are considered account-wide admins.
 * Intentionally mirrors the ADMIN_ROLES set in authz.ts; kept local here to
 * avoid a circular import (authz.ts imports enterprise.ts).
 */
const RAW_ADMIN_ROLES = new Set(["admin", "owner", "account_admin"]);

function rawIsAdminRole(role: unknown): boolean {
  if (typeof role !== "string") return false;
  return RAW_ADMIN_ROLES.has(role.trim().toLowerCase());
}

/** Extract the account-admin flag from a raw directory member, tolerating
 * a few plausible field placements without weakening the closed-by-default
 * posture (anything unrecognized resolves to false).
 *
 * Checked field shapes (in order):
 *   rm.isAccountAdmin (boolean)
 *   rm.user_is_account_admin (boolean)
 *   rm.user.isAccountAdmin / rm.user.is_account_admin (boolean)
 *   rm.role (string, matched against ADMIN_ROLES)
 *   rm.organizationRole (string, matched against ADMIN_ROLES)
 *   rm.accountRole (string, matched against ADMIN_ROLES)
 *
 * A warning is logged when none of the recognized boolean fields are present
 * and a string-role field resolves to non-admin, so future API shape changes
 * surface in server logs rather than silent denials.
 */
export function parseIsAccountAdmin(rm: RawMember): boolean {
  const user = rm.user as unknown as Record<string, unknown> | undefined;

  // Boolean fields — checked first; unambiguous.
  if (rm.isAccountAdmin === true) return true;
  if (rm.user_is_account_admin === true) return true;
  if (user?.["isAccountAdmin"] === true) return true;
  if (user?.["is_account_admin"] === true) return true;

  // String role fields — checked against the ADMIN_ROLES set.
  if (rawIsAdminRole(rm.role)) return true;
  if (rawIsAdminRole(rm.organizationRole)) return true;
  if (rawIsAdminRole(rm.accountRole)) return true;

  // None of the recognized boolean shapes were present. If an unexpected
  // role-like string field exists, log so future API changes are visible.
  const rmRec = rm as unknown as Record<string, unknown>;
  const hasNoRecognizedBooleans =
    rm.isAccountAdmin === undefined &&
    rm.user_is_account_admin === undefined &&
    user?.["isAccountAdmin"] === undefined &&
    user?.["is_account_admin"] === undefined;
  if (hasNoRecognizedBooleans) {
    const unknownRoleFields = Object.keys(rmRec).filter(
      (k) => !["user", "workspaces", "role", "organizationRole", "accountRole"].includes(k) &&
             typeof rmRec[k] === "string" && (k.toLowerCase().includes("role") || k.toLowerCase().includes("admin")),
    );
    if (unknownRoleFields.length > 0) {
      logger.warn(
        { userId: rm.user?.id, unknownRoleFields },
        "parseIsAccountAdmin: unrecognized role-like fields on raw member — API shape may have changed",
      );
    }
  }

  return false;
}
export interface PlatformBudgets {
  // workspaceId -> group limits (groupId -> amountUsd)
  groupLimits: Map<string, Map<string, number>>;
  // workspaceId -> user limits (userId -> amountUsd)
  userLimits: Map<string, Map<string, number>>;
  // workspaceId -> default per-user limit
  workspaceDefaults: Map<string, number>;
}

interface RawBudget {
  type: string;
  workspaceId?: string;
  groupId?: string;
  userId?: string;
  amountUsd?: number;
}

const DIRECTORY_TTL_MS = 15 * 60 * 1000;
const USAGE_TTL_MS = 10 * 60 * 1000;
const PROJECT_INFO_TTL_MS = 15 * 60 * 1000;

// ---------- DB serialisation helpers ----------

interface SerializedDirectory {
  fetchedAt: number;
  workspaces: Record<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[];
  allGroups?: EnterpriseGroup[];
  groupMembers: Record<string, string[]>;
  members: Record<
    string,
    {
      userId: string;
      username: string;
      email: string;
      name: string | null;
      isAccountAdmin?: boolean;
      workspaces: Record<string, { role: string; isDisabled: boolean }>;
    }
  >;
  budgets: {
    groupLimits: Record<string, Record<string, number>>;
    userLimits: Record<string, Record<string, number>>;
    workspaceDefaults: Record<string, number>;
  };
}

function serializeDirectory(d: DirectoryCache): SerializedDirectory {
  const workspaces: Record<string, EnterpriseWorkspace> = {};
  for (const [k, v] of d.workspaces) workspaces[k] = v;

  const groupMembers: Record<string, string[]> = {};
  for (const [k, v] of d.groupMembers) groupMembers[k] = v;

  const members: SerializedDirectory["members"] = {};
  for (const [k, v] of d.members) {
    const ws: Record<string, { role: string; isDisabled: boolean }> = {};
    for (const [wk, wv] of v.workspaces) ws[wk] = wv;
    members[k] = { userId: v.userId, username: v.username, email: v.email, name: v.name, isAccountAdmin: v.isAccountAdmin, workspaces: ws };
  }

  const groupLimits: Record<string, Record<string, number>> = {};
  for (const [wsId, m] of d.budgets.groupLimits) {
    groupLimits[wsId] = {};
    for (const [gId, amt] of m) groupLimits[wsId]![gId] = amt;
  }
  const userLimits: Record<string, Record<string, number>> = {};
  for (const [wsId, m] of d.budgets.userLimits) {
    userLimits[wsId] = {};
    for (const [uId, amt] of m) userLimits[wsId]![uId] = amt;
  }
  const workspaceDefaults: Record<string, number> = {};
  for (const [wsId, amt] of d.budgets.workspaceDefaults) workspaceDefaults[wsId] = amt;

  return {
    fetchedAt: d.fetchedAt,
    workspaces,
    groups: d.groups,
    allGroups: d.allGroups,
    groupMembers,
    members,
    budgets: { groupLimits, userLimits, workspaceDefaults },
  };
}

function deserializeDirectory(s: SerializedDirectory): DirectoryCache {
  const workspaces = new Map<string, EnterpriseWorkspace>(Object.entries(s.workspaces));
  const groupMembers = new Map<string, string[]>(Object.entries(s.groupMembers));

  const members = new Map<string, EnterpriseMember>();
  for (const [k, v] of Object.entries(s.members)) {
    members.set(k, {
      userId: v.userId,
      username: v.username,
      email: v.email,
      name: v.name,
      isAccountAdmin: v.isAccountAdmin ?? false,
      workspaces: new Map(Object.entries(v.workspaces)),
    });
  }

  const groupLimits = new Map<string, Map<string, number>>();
  for (const [wsId, m] of Object.entries(s.budgets.groupLimits)) {
    groupLimits.set(wsId, new Map(Object.entries(m)));
  }
  const userLimits = new Map<string, Map<string, number>>();
  for (const [wsId, m] of Object.entries(s.budgets.userLimits)) {
    userLimits.set(wsId, new Map(Object.entries(m)));
  }
  const workspaceDefaults = new Map<string, number>(Object.entries(s.budgets.workspaceDefaults));

  const allGroups = s.allGroups ?? s.groups;

  return {
    fetchedAt: s.fetchedAt,
    workspaces,
    groups: allGroups.filter(isCustomGroup),
    allGroups,
    groupMembers,
    members,
    budgets: { groupLimits, userLimits, workspaceDefaults },
  };
}

// ---------- DB write-through helpers ----------

function persistDirectoryToDb(d: DirectoryCache): void {
  const serialized = serializeDirectory(d);
  db.insert(apiDirectoryCacheTable)
    .values({ id: "singleton", directoryJson: serialized, fetchedAt: new Date(d.fetchedAt) })
    .onConflictDoUpdate({
      target: apiDirectoryCacheTable.id,
      set: { directoryJson: serialized, fetchedAt: new Date(d.fetchedAt) },
    })
    .catch((err: unknown) => logger.warn({ err }, "Failed to persist directory cache to DB"));
}

async function persistSpendToDb(
  rangeKey: string,
  groupId: string,
  spend: GroupSpend,
): Promise<void> {
  await db.insert(apiSpendCacheTable)
    .values({
      rangeKey,
      groupId,
      spendUsd: spend.spendUsd,
      periodStart: spend.periodStart,
      periodEnd: spend.periodEnd,
      fetchedAt: new Date(spend.fetchedAt),
    })
    .onConflictDoUpdate({
      target: [apiSpendCacheTable.rangeKey, apiSpendCacheTable.groupId],
      set: {
        spendUsd: spend.spendUsd,
        periodStart: spend.periodStart,
        periodEnd: spend.periodEnd,
        fetchedAt: new Date(spend.fetchedAt),
      },
    })
    .catch((err: unknown) => logger.warn({ err, rangeKey, groupId }, "Failed to persist spend cache to DB"));
}

// ---------- Cold-start cache hydration ----------

export async function initCache(
  _options: { revalidateOnStartup?: boolean } = {},
): Promise<void> {
  try {
    const [
      dirRow,
      billingPeriodRow,
      billingObservationRow,
      verificationRow,
    ] = await Promise.all([
      db.query.apiDirectoryCacheTable.findFirst({ where: eq(apiDirectoryCacheTable.id, "singleton") }),
      db.query.apiBillingPeriodCacheTable.findFirst({
        where: eq(apiBillingPeriodCacheTable.id, "current"),
      }),
      db.query.apiBillingPeriodObservationTable.findFirst({
        where: eq(apiBillingPeriodObservationTable.id, "current"),
      }),
      db.query.apiAccountTotalVerificationTable.findFirst({
        where: eq(apiAccountTotalVerificationTable.id, "singleton"),
      }),
    ]);

    if (billingPeriodRow) {
      billingPeriodCache = {
        start: billingPeriodRow.periodStart.toISOString(),
        end: billingPeriodRow.periodEnd.toISOString(),
        fetchedAt: billingPeriodRow.fetchedAt.getTime(),
      };
    }
    if (billingObservationRow) {
      billingPeriodObservation = {
        start: billingObservationRow.periodStart.toISOString(),
        end: billingObservationRow.periodEnd.toISOString(),
        count: billingObservationRow.consecutiveCount,
        observedAt: billingObservationRow.observedAt.getTime(),
      };
    }
    if (verificationRow) {
      accountTotalVerificationState = {
        verifiedAt: verificationRow.verifiedAt.toISOString(),
        outcome: verificationRow.outcome as AccountTotalVerificationOutcome,
        error: verificationRow.errorMessage,
        rangeKey: verificationRow.rangeKey,
        rangeStart: verificationRow.rangeStart.toISOString(),
        rangeEnd: verificationRow.rangeEnd.toISOString(),
        upstreamTotalUsd: verificationRow.upstreamTotalUsd,
        storedTotalUsd: verificationRow.storedTotalUsd,
        deltaUsd: verificationRow.deltaUsd,
      };
    }

    if (dirRow) {
      try {
        const deserialized = deserializeDirectory(dirRow.directoryJson as SerializedDirectory);
        // Only hydrate if not already populated by a concurrent fetch
        if (!directoryCache) {
          directoryCache = deserialized;
          logger.info({ fetchedAt: new Date(deserialized.fetchedAt).toISOString() }, "Directory cache hydrated from DB");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to deserialize directory cache from DB");
      }
    }

  } catch (err) {
    logger.warn({ err }, "Failed to hydrate caches from DB — will fetch fresh on first request");
  }
}

const LEGACY_FULL_TERM_KEY = /^custom:2026-05-20:\d{4}-\d{2}-\d{2}$/;

/**
 * Adopt the newest usable cutoff-based custom snapshot into the stable rolling
 * full-term identity. This is intentionally copy-only and idempotent: existing
 * stable scopes always win, and legacy custom reports remain available.
 */
async function adoptLegacyFullTermUsage(): Promise<number> {
  return db.transaction(async (tx) => {
    const states = await tx.select().from(usageSyncStateTable);
    const stableIds = new Set(
      states
        .filter((state) => state.rangeKey === FULL_TERM_RANGE_KEY)
        .map((state) => syncId(state.mode as UsageSyncMode, state.rangeKey, state.scopeKey)),
    );
    const candidates = states.filter((state) =>
      LEGACY_FULL_TERM_KEY.test(state.rangeKey) &&
      state.rangeStart.getTime() === SPEND_DATA_CUTOFF_MS &&
      (state.status === "success" || state.status === "partial")
    );
    const winners = new Map<string, typeof candidates[number]>();
    for (const candidate of candidates) {
      const id = syncId(candidate.mode as UsageSyncMode, FULL_TERM_RANGE_KEY, candidate.scopeKey);
      if (stableIds.has(id)) continue;
      const current = winners.get(id);
      const candidateRank = candidate.status === "success" ? 1 : 0;
      const currentRank = current?.status === "success" ? 1 : 0;
      if (
        !current ||
        candidateRank > currentRank ||
        (candidateRank === currentRank &&
          (candidate.syncedThrough > current.syncedThrough ||
            (candidate.syncedThrough.getTime() === current.syncedThrough.getTime() &&
              candidate.completedAt > current.completedAt)))
      ) {
        winners.set(id, candidate);
      }
    }

    let adopted = 0;
    for (const [id, source] of winners) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      const [existing] = await tx.select({ rangeKey: usageSyncStateTable.rangeKey })
        .from(usageSyncStateTable)
        .where(and(
          eq(usageSyncStateTable.mode, source.mode),
          eq(usageSyncStateTable.rangeKey, FULL_TERM_RANGE_KEY),
          eq(usageSyncStateTable.scopeKey, source.scopeKey),
        ));
      if (existing) continue;
      const sourceRows = await tx.select().from(usageSyncChunksTable).where(and(
        eq(usageSyncChunksTable.mode, source.mode),
        eq(usageSyncChunksTable.rangeKey, source.rangeKey),
        eq(usageSyncChunksTable.scopeKey, source.scopeKey),
      ));
      if (sourceRows.length === 0) continue;
      await tx.insert(usageSyncChunksTable).values(sourceRows.map((row) => ({
        mode: row.mode,
        rangeKey: FULL_TERM_RANGE_KEY,
        scopeKey: row.scopeKey,
        chunkStart: row.chunkStart,
        chunkEnd: row.chunkEnd,
        payloadJson: row.payloadJson,
        completedAt: row.completedAt,
      }))).onConflictDoNothing();
      await tx.insert(usageSyncStateTable).values({
        mode: source.mode,
        rangeKey: FULL_TERM_RANGE_KEY,
        scopeKey: source.scopeKey,
        rangeStart: source.rangeStart,
        syncedThrough: source.syncedThrough,
        isClosed: false,
        status: source.status,
        errorMessage: source.errorMessage,
        startedAt: source.startedAt,
        completedAt: source.completedAt,
      }).onConflictDoNothing();
      adopted++;
    }
    if (adopted > 0) {
      logger.info({ adopted }, "Adopted legacy full-term usage snapshots");
    }
    return adopted;
  });
}

export interface DirectoryCache {
  fetchedAt: number;
  workspaces: Map<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[]; // custom/SCIM groups exposed by the dashboard
  allGroups: EnterpriseGroup[]; // raw Enterprise API list, including built-in role groups
  groupMembers: Map<string, string[]>; // groupId -> userIds
  members: Map<string, EnterpriseMember>; // userId -> member
  budgets: PlatformBudgets;
}

export interface DirectoryFreshness {
  dataAsOf: string | null;
  isStale: boolean;
  isRefreshing: boolean;
}
export interface StoredBudgetEvaluationSnapshot {
  directory: DirectoryCache;
  rangeKey: string;
  dataAsOf: Date;
}
let directoryCache: DirectoryCache | null = null;
let directoryPromise: Promise<DirectoryCache> | null = null;

function setSuccessfulSyncMetadataForTests(
  mode: UsageSyncMode,
  rangeKey: string,
  scopeKey: string,
  fetchedAt = Date.now(),
): void {
  syncMetadata.set(syncId(mode, rangeKey, scopeKey), {
    syncedThrough: fetchedAt,
    completedAt: fetchedAt,
    isClosed: false,
    status: "success",
    error: null,
  });
}

export function __setMemberUsageForTests(
  first: string,
  second: string | ReadonlyMap<string, ReadonlyMap<string, number>> | null,
  third?: Map<string, number> | null | ReadonlyMap<string, number>,
): void {
  if (typeof second === "string") {
    const key = `${second}|${first}`;
    const byUser = third as Map<string, number> | null;
    if (byUser === null) {
      memberUsageCache.delete(key);
      syncMetadata.delete(syncId("group_member", second, first));
      return;
    }
    const totalCostUsd = [...byUser.values()].reduce((sum, spend) => sum + spend, 0);
    memberUsageCache.set(key, {
      fetchedAt: Date.now(),
      byUser: new Map(byUser),
      attributableTotalCostUsd: totalCostUsd,
      unattributableTotalCostUsd: 0,
      totalCostUsd,
    });
    setSuccessfulSyncMetadataForTests("group_member", second, first);
    return;
  }

  const rangeKey = first;
  const usageByGroup = second;
  const unattributableByGroup = (third as ReadonlyMap<string, number> | undefined) ?? new Map();
  for (const key of memberUsageCache.keys()) {
    if (key.startsWith(`${rangeKey}|`)) memberUsageCache.delete(key);
  }
  for (const id of syncMetadata.keys()) {
    if (id.startsWith(`group_member|${rangeKey}|`)) syncMetadata.delete(id);
  }
  if (!usageByGroup) return;
  for (const [groupId, byUser] of usageByGroup) {
    const totalCostUsd = [...byUser.values()].reduce((sum, spend) => sum + spend, 0);
    memberUsageCache.set(`${rangeKey}|${groupId}`, {
      fetchedAt: Date.now(),
      byUser: new Map(byUser),
      attributableTotalCostUsd: totalCostUsd,
      unattributableTotalCostUsd: unattributableByGroup.get(groupId) ?? 0,
      totalCostUsd: totalCostUsd + (unattributableByGroup.get(groupId) ?? 0),
    });
    setSuccessfulSyncMetadataForTests("group_member", rangeKey, groupId);
  }
}
/**
 * Test-only seam: seed the in-memory directory cache with a representative
 * fixture so authorization/scoping can be exercised without calling the real
 * Enterprise API. Production never calls this — the cache is populated by the
 * real paginated fetch in {@link getDirectory}. Passing `null` clears it.
 */
/** Test-only: seed the per-workspace spend cache (used for extra-workspace rollup).
 *  Passing `null` for byUser clears the entry. */
export function __setWsSpendForTests(
  wsId: string,
  rangeKey: string,
  byUser: Map<string, number> | null,
  totals?: {
    attributableTotalCostUsd?: number;
    unattributableTotalCostUsd?: number;
    totalCostUsd?: number;
    agentByUser?: Map<string, number>;
  },
): void {
  const key = `${rangeKey}|${wsId}`;
  if (byUser === null) {
    wsSpendCache.delete(key);
    wsSpendCachedAt.delete(key);
    syncMetadata.delete(syncId("workspace_member", rangeKey, wsId));
  } else {
    const attributableTotalCostUsd =
      totals?.attributableTotalCostUsd ??
      [...byUser.values()].reduce((sum, spend) => sum + spend, 0);
    const unattributableTotalCostUsd = totals?.unattributableTotalCostUsd ?? 0;
    const fetchedAt = Date.now();
    wsSpendCache.set(key, {
      fetchedAt,
      byUser: new Map(byUser),
      agentByUser: totals?.agentByUser
        ? new Map(totals.agentByUser)
        : undefined,
      attributableTotalCostUsd,
      unattributableTotalCostUsd,
      totalCostUsd:
        totals?.totalCostUsd ?? attributableTotalCostUsd + unattributableTotalCostUsd,
    });
    wsSpendCachedAt.set(key, fetchedAt);
    setSuccessfulSyncMetadataForTests("workspace_member", rangeKey, wsId, fetchedAt);
  }
}

export function __setDirectoryCacheForTests(
  fixture: {
    workspaces?: Map<string, EnterpriseWorkspace>;
    groups: EnterpriseGroup[];
    groupMembers?: Map<string, string[]>;
    members: Map<string, EnterpriseMember>;
    fetchedAt?: number;
  } | null,
): void {
  if (!fixture) {
    directoryCache = null;
    return;
  }
  directoryCache = {
    fetchedAt: fixture.fetchedAt ?? Date.now(),
    workspaces: fixture.workspaces ?? new Map(),
    groups: fixture.groups,
    allGroups: fixture.groups,
    groupMembers: fixture.groupMembers ?? new Map(),
    members: fixture.members,
    budgets: { groupLimits: new Map(), userLimits: new Map(), workspaceDefaults: new Map() },
  };
}

/** Read the startup-hydrated directory without turning request traffic into ingestion. */
export function getCachedDirectory(): Promise<DirectoryCache> {
  if (!directoryCache) {
    return Promise.reject(new Error("Enterprise directory has not been hydrated yet"));
  }
  return Promise.resolve(directoryCache);
}

export function getDirectoryFreshness(now = Date.now()): DirectoryFreshness {
  return {
    dataAsOf: directoryCache ? new Date(directoryCache.fetchedAt).toISOString() : null,
    isStale: !!directoryCache && now - directoryCache.fetchedAt >= DIRECTORY_TTL_MS,
    isRefreshing: directoryPromise !== null,
  };
}
export async function getDirectory(force = false): Promise<DirectoryCache> {
  const now = Date.now();
  if (force) return refreshDirectory();
  if (directoryCache) {
    if (now - directoryCache.fetchedAt >= DIRECTORY_TTL_MS) {
      void refreshDirectory().catch((err) => {
        lastApiOk = false;
        lastApiError = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, "Background directory refresh failed; serving stored snapshot");
      });
    }
    return directoryCache;
  }
  void refreshDirectory().catch((err) => {
    lastApiOk = false;
    lastApiError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "Initial directory sync failed");
  });
  throw new EnterpriseApiError(503, "Directory is syncing; no stored snapshot is available");
}

/** Refresh directory metadata without scheduling any legacy usage materialization. */
export function refreshDirectoryForIngest(): Promise<DirectoryCache> {
  return refreshDirectory(false);
}

/**
 * A roster snapshot is immutable, so it must never be based on the durable
 * directory cache or on a refresh where one group's membership fetch failed.
 * Force a live refresh and reject the whole observation unless every custom
 * group has an explicit membership result (including successful empty lists).
 */
export function assertCompleteRosterDirectory(
  directory: DirectoryCache,
): DirectoryCache {
  const missingGroupIds = directory.groups
    .filter((group) => !directory.groupMembers.has(group.id))
    .map((group) => group.id);
  if (missingGroupIds.length > 0) {
    throw new Error(
      `Roster directory refresh incomplete for ${missingGroupIds.length} group(s)`,
    );
  }
  return directory;
}

export async function getCompleteDirectoryForRosterSnapshot(): Promise<DirectoryCache> {
  return assertCompleteRosterDirectory(await getDirectory(true));
}

// ---------- Group spend cache (keyed by groupId + range) ----------

export interface GroupSpend {
  spendUsd: number;
  fetchedAt: number;
  periodStart: string;
  periodEnd: string;
}

const spendCache = new Map<string, GroupSpend>(); // `${rangeKey}|${groupId}`

export function getSpend(groupId: string, rangeKey = "billing:from-cutoff"): GroupSpend | undefined {
  return spendCache.get(`${rangeKey}|${groupId}`);
}

export function getBillingPeriod(): { start: string; end: string; label: string } {
  const period = getBillingPeriodMetadata();
  return { start: period.start, end: period.end, label: period.label };
}

/**
 * Result of queueGroupSpendFetch:
 * - "fresh_cache": cache is fresh, nothing queued, onDone NOT registered —
 *   read the cached value via getSpend() if needed.
 * - "queued": a new fetch was enqueued; onDone fires when it completes.
 * - "duplicate_queued": an identical fetch is already in flight/queued;
 *   onDone was still registered and fires when that fetch completes.
 */
export type QueueSpendResult = "fresh_cache" | "queued" | "duplicate_queued";

// Completion callbacks per `${rangeKey}|${groupId}`, fanned out when the
// in-flight fetch lands, so duplicate callers never act on stale data.
const spendCallbacks = new Map<string, Array<(spend: GroupSpend) => void>>();

function registerSpendCallback(cacheKey: string, cb: (spend: GroupSpend) => void): void {
  const list = spendCallbacks.get(cacheKey);
  if (list) list.push(cb);
  else spendCallbacks.set(cacheKey, [cb]);
}

function fireSpendCallbacks(cacheKey: string, spend: GroupSpend): void {
  const list = spendCallbacks.get(cacheKey);
  if (!list) return;
  spendCallbacks.delete(cacheKey);
  for (const cb of list) {
    try {
      cb(spend);
    } catch (err) {
      logger.error({ err, cacheKey }, "Spend callback failed");
    }
  }
}

export function queueGroupSpendFetch(
  group: EnterpriseGroup,
  priority: number,
  force = false,
  onDone?: (spend: GroupSpend) => void,
  range: UsageRange = resolveRange("billing"),
): QueueSpendResult {
  const cacheKey = `${range.key}|${group.id}`;
  const cached = spendCache.get(cacheKey);
  if (isDurablyFresh("group_total", range.key, group.id, cached?.fetchedAt, force)) {
    return "fresh_cache";
  }
  if (onDone) registerSpendCallback(cacheKey, onDone);
  const queued = enqueueUsage(`usage:${cacheKey}`, priority, async () => {
    try {
      const rows = await synchronizeUsage("group_total", range, group.id, {
        workspaceId: group.workspaceId,
        groupId: group.id,
      }, force);
      const spend = aggregateGroupSpend(rows);
      spendCache.set(cacheKey, spend);
      await persistSpendToDb(range.key, group.id, spend);
      // The network request has landed and cache is current. Release the queue
      // key before callbacks run so a callback-triggered forced refresh is a
      // new request rather than being reported as a duplicate of the finished one.
      queuedKeys.delete(`usage:${cacheKey}`);
      fireSpendCallbacks(cacheKey, spend);
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch group usage");
      // Drop pending callbacks so they don't fire with a later, unrelated fetch.
      spendCallbacks.delete(cacheKey);
      throw err;
    }
  });
  return queued ? "queued" : "duplicate_queued";
}

export async function refreshAllGroupSpends(
  priority = 1,
  onGroupDone?: (group: EnterpriseGroup, spend: GroupSpend) => void,
  range: UsageRange = resolveRange("billing"),
): Promise<EnterpriseGroup[]> {
      const dir = await getDirectory();
  for (const g of dir.groups) {
    queueGroupSpendFetch(g, priority, false, (spend) => onGroupDone?.(g, spend), range);
  }
  return dir.groups;
}

// ---------- Per-member group usage (groupBy=member, one call per group+range) ----------

export interface MemberUsage {
  fetchedAt: number;
  byUser: Map<string, number>;
  /** Agent-only spend from the metric breakdown, when the source supplied it. */
  agentByUser?: Map<string, number>;
  attributableTotalCostUsd: number;
  unattributableTotalCostUsd: number;
  totalCostUsd: number;
}

const memberUsageCache = new Map<string, MemberUsage>(); // `${rangeKey}|${groupId}`

// ---------- Account-wide usage anchor (unfiltered /usage, one call per range) ----------

const ACCOUNT_USAGE_SCOPE = "enterprise";
const accountUsageCache = new Map<string, AccountUsage>(); // rangeKey

export function getAccountUsage(rangeKey: string): AccountUsage | undefined {
  return accountUsageCache.get(rangeKey);
}

function scheduleAccountUsageRetry(range: UsageRange, priority: number): void {
  const failures = (accountUsageFailureCount.get(range.key) ?? 0) + 1;
  accountUsageFailureCount.set(range.key, failures);
  const delay = Math.min(
    VERIFICATION_RETRY_MAX_MS,
    VERIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
  );
  accountUsageRetryAt.set(range.key, Date.now() + delay);
  if (accountUsageRetryTimers.has(range.key)) return;
  const timer = setTimeout(() => {
    accountUsageRetryTimers.delete(range.key);
    queueAccountUsageFetch(range, priority, true);
  }, delay);
  timer.unref();
  accountUsageRetryTimers.set(range.key, timer);
}

export function queueAccountUsageFetch(
  range: UsageRange,
  priority = 0,
  force = false,
): boolean {
  const cached = accountUsageCache.get(range.key);
  if (isDurablyFresh(
    "account_total",
    range.key,
    ACCOUNT_USAGE_SCOPE,
    cached?.fetchedAt,
    force,
  )) {
    return false;
  }
  const queued = enqueueUsage(`account-usage:${range.key}`, priority, async () => {
    try {
      const rows = await synchronizeUsage(
        "account_total",
        range,
        ACCOUNT_USAGE_SCOPE,
        {},
        force,
      );
      accountUsageCache.set(range.key, aggregateAccountUsage(rows));
      const metadata = syncMetadata.get(
        syncId("account_total", range.key, ACCOUNT_USAGE_SCOPE),
      );
      if (metadata?.status === "partial") {
        scheduleAccountUsageRetry(range, priority);
      } else {
        accountUsageFailureCount.delete(range.key);
        accountUsageRetryAt.delete(range.key);
        const retryTimer = accountUsageRetryTimers.get(range.key);
        if (retryTimer) clearTimeout(retryTimer);
        accountUsageRetryTimers.delete(range.key);
      }
    } catch (err) {
      logger.error({ err, range: range.key }, "Failed to fetch account usage");
      scheduleAccountUsageRetry(range, priority);
      throw err;
    }
  });
  if (queued) markUsageSyncQueued("account_total", range.key, ACCOUNT_USAGE_SCOPE);
  return queued;
}

function scheduleAccountVerificationRetry(): void {
  if (accountVerificationRetryTimer) return;
  const exponent = Math.max(0, accountVerificationFailureCount - 1);
  const delay = Math.min(
    VERIFICATION_RETRY_MAX_MS,
    VERIFICATION_RETRY_BASE_MS * 2 ** exponent,
  );
  accountVerificationRetryTimer = setTimeout(() => {
    accountVerificationRetryTimer = null;
    queueAccountTotalVerification(1);
  }, delay);
  accountVerificationRetryTimer.unref();
}

async function verifyAccountTotal(
  range: UsageRange,
  scheduleRetry = true,
  persistVerificationRecord = true,
): Promise<void> {
  const { start, end } = rangeBounds(range);
  const id = syncId("account_total", range.key, ACCOUNT_USAGE_SCOPE);
  try {
    const committed = await db.transaction(async (tx) => {
      // Hold the same cross-replica lock used by incremental synchronization
      // before fetching. A moving-end verification can therefore never replace
      // a newer snapshot committed while its upstream response was in flight.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      // Account totals are not paginated. This remains exactly one unfiltered
      // request for the fully resolved reporting interval.
      const upstream = await usageFetch({
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
      const payload: StoredUsagePayload = {
        totalCostUsd: upstream.totalCostUsd,
        attributableTotalCostUsd: upstream.attributableTotalCostUsd ?? 0,
        unattributableTotalCostUsd: upstream.unattributableTotalCostUsd ?? 0,
        groups: upstream.groups ?? [],
      };
      const verifiedAt = new Date();
      const rows = await tx.select().from(usageSyncChunksTable).where(and(
        eq(usageSyncChunksTable.mode, "account_total"),
        eq(usageSyncChunksTable.rangeKey, range.key),
        eq(usageSyncChunksTable.scopeKey, ACCOUNT_USAGE_SCOPE),
      ));
      const storedTotalUsd = rows.reduce(
        (sum, row) => sum + storedPayload(row).totalCostUsd,
        0,
      );
      const deltaUsd = upstream.totalCostUsd - storedTotalUsd;
      const healed = Math.abs(deltaUsd) > VERIFICATION_HEAL_THRESHOLD_USD;
      if (healed) {
        await tx.delete(usageSyncChunksTable).where(and(
          eq(usageSyncChunksTable.mode, "account_total"),
          eq(usageSyncChunksTable.rangeKey, range.key),
          eq(usageSyncChunksTable.scopeKey, ACCOUNT_USAGE_SCOPE),
        ));
        await tx.delete(usageSyncStateTable).where(and(
          eq(usageSyncStateTable.mode, "account_total"),
          eq(usageSyncStateTable.rangeKey, range.key),
          eq(usageSyncStateTable.scopeKey, ACCOUNT_USAGE_SCOPE),
        ));
        await tx.insert(usageSyncChunksTable).values({
          mode: "account_total",
          rangeKey: range.key,
          scopeKey: ACCOUNT_USAGE_SCOPE,
          chunkStart: start,
          chunkEnd: end,
          payloadJson: payload,
          completedAt: verifiedAt,
        });
        await tx.insert(usageSyncStateTable).values({
          mode: "account_total",
          rangeKey: range.key,
          scopeKey: ACCOUNT_USAGE_SCOPE,
          rangeStart: start,
          syncedThrough: end,
          isClosed: false,
          status: "success",
          errorMessage: null,
          startedAt: verifiedAt,
          completedAt: verifiedAt,
        });
      }
      const outcome: AccountTotalVerificationOutcome = healed ? "healed" : "success";
      if (persistVerificationRecord) {
        await tx.insert(apiAccountTotalVerificationTable).values({
          id: "singleton",
          verifiedAt,
          outcome,
          errorMessage: null,
          rangeKey: range.key,
          rangeStart: start,
          rangeEnd: end,
          upstreamTotalUsd: upstream.totalCostUsd,
          storedTotalUsd,
          deltaUsd,
        }).onConflictDoUpdate({
          target: apiAccountTotalVerificationTable.id,
          set: {
            verifiedAt,
            outcome,
            errorMessage: null,
            rangeKey: range.key,
            rangeStart: start,
            rangeEnd: end,
            upstreamTotalUsd: upstream.totalCostUsd,
            storedTotalUsd,
            deltaUsd,
          },
        });
      }
      return { outcome, storedTotalUsd, deltaUsd, healed, upstream, payload, verifiedAt };
    });
    accountTotalVerificationState = {
      verifiedAt: committed.verifiedAt.toISOString(),
      outcome: committed.outcome,
      error: null,
      rangeKey: range.key,
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
      upstreamTotalUsd: committed.upstream.totalCostUsd,
      storedTotalUsd: committed.storedTotalUsd,
      deltaUsd: committed.deltaUsd,
    };
    if (committed.healed) {
      accountUsageCache.set(range.key, {
        fetchedAt: committed.verifiedAt.getTime(),
        totalCostUsd: committed.payload.totalCostUsd,
        attributableTotalCostUsd: committed.payload.attributableTotalCostUsd,
        unattributableTotalCostUsd: committed.payload.unattributableTotalCostUsd,
      });
      syncMetadata.set(id, {
        syncedThrough: end.getTime(),
        completedAt: committed.verifiedAt.getTime(),
        isClosed: false,
        status: "success",
        error: null,
      });
    }
    accountVerificationFailureCount = 0;
  } catch (err) {
    const verifiedAt = new Date();
    const error = err instanceof Error ? err.message : String(err);
    const prior = accountUsageCache.get(range.key);
    const failedState: AccountTotalVerificationState = {
      verifiedAt: verifiedAt.toISOString(),
      outcome: "failed",
      error,
      rangeKey: range.key,
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
      upstreamTotalUsd: null,
      storedTotalUsd: prior?.totalCostUsd ?? null,
      deltaUsd: null,
    };
    accountTotalVerificationState = failedState;
    try {
      if (persistVerificationRecord) {
        await db.insert(apiAccountTotalVerificationTable).values({
          id: "singleton",
          verifiedAt,
          outcome: "failed",
          errorMessage: error.slice(0, 1000),
          rangeKey: range.key,
          rangeStart: start,
          rangeEnd: end,
          upstreamTotalUsd: null,
          storedTotalUsd: failedState.storedTotalUsd,
          deltaUsd: null,
        }).onConflictDoUpdate({
          target: apiAccountTotalVerificationTable.id,
          set: {
            verifiedAt,
            outcome: "failed",
            errorMessage: error.slice(0, 1000),
            rangeKey: range.key,
            rangeStart: start,
            rangeEnd: end,
            upstreamTotalUsd: null,
            storedTotalUsd: failedState.storedTotalUsd,
            deltaUsd: null,
          },
        });
      }
    } catch (persistErr) {
      logger.warn({ err: persistErr }, "Failed to persist account-total verification failure");
    }
    accountVerificationFailureCount += 1;
    if (scheduleRetry) scheduleAccountVerificationRetry();
    logger.warn({ err, range: range.key }, "Account-total verification failed; retained prior cache");
  }
}

export function queueAccountTotalVerification(priority = 1): boolean {
  if (!isConfigured()) return false;
  const range = resolveRange("billing");
  return enqueueUsage(
    `account-total-verification:${range.key}`,
    priority,
    () => verifyAccountTotal(range),
  );
}

interface FullRebuildScope {
  mode: UsageSyncMode;
  scopeKey: string;
  params: Record<string, string | undefined>;
}

interface FullRebuildResult {
  scope: FullRebuildScope;
  rows: UsageSyncChunk[];
  metadata: SyncMetadata;
}

interface StagedFullRebuildScope {
  scope: FullRebuildScope;
  chunks: Array<{
    start: Date;
    end: Date;
    payload: StoredUsagePayload;
    partial: boolean;
    error: string | null;
  }>;
  isClosed: boolean;
}

interface UsageRangeVersion {
  mode: string;
  scopeKey: string;
  completedAt: Date;
}

function usageRangeVersionKey(states: UsageRangeVersion[]): string {
  return states
    .map((state) => `${state.mode}|${state.scopeKey}|${state.completedAt.toISOString()}`)
    .sort()
    .join("\n");
}

async function rebuildUsageRangeAtomically(
  range: UsageRange,
  scopes: FullRebuildScope[],
): Promise<FullRebuildResult[]> {
  await maybePruneExpiredCustomUsage();
  const runId = nextQueueRunId();
  const baselineStates = await db
    .select({
      mode: usageSyncStateTable.mode,
      scopeKey: usageSyncStateTable.scopeKey,
      completedAt: usageSyncStateTable.completedAt,
    })
    .from(usageSyncStateTable)
    .where(eq(usageSyncStateTable.rangeKey, range.key));
  const baselineVersion = usageRangeVersionKey(baselineStates);
  logger.info({
    event: "usage_rebuild_start",
    runId,
    rangeKey: range.key,
    scopeCount: scopes.length,
  }, "Starting atomic usage range rebuild");

  const staged: StagedFullRebuildScope[] = [];
  for (const scope of scopes) {
    const plan = planSyncChunks(range, undefined);
    logger.info({
      event: "usage_rebuild_scope_plan",
      runId,
      rangeKey: range.key,
      mode: scope.mode,
      scopeKey: scope.scopeKey,
      chunkCount: plan.chunks.length,
    }, "Planned atomic rebuild scope");
    const chunks: StagedFullRebuildScope["chunks"] = [];
    for (const chunk of plan.chunks) {
      if (chunks.length > 0 || staged.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      const fetched = await fetchUsageChunk(
        scope.mode,
        scope.params,
        chunk.start,
        chunk.end,
        0,
        { runId, rangeKey: range.key, scopeKey: scope.scopeKey },
      );
      if (fetched.partial) {
        throw new Error(
          fetched.error ?? `Incomplete usage response for ${scope.mode}:${scope.scopeKey}`,
        );
      }
      chunks.push({ ...chunk, ...fetched });
    }
    staged.push({ scope, chunks, isClosed: plan.isClosed });
  }

  return db.transaction(async (tx) => {
    const existingStates = await tx
      .select({
        mode: usageSyncStateTable.mode,
        rangeKey: usageSyncStateTable.rangeKey,
        scopeKey: usageSyncStateTable.scopeKey,
      })
      .from(usageSyncStateTable)
      .where(eq(usageSyncStateTable.rangeKey, range.key));
    const lockIds = new Set([
      ...existingStates.map((state) =>
        syncId(state.mode as UsageSyncMode, state.rangeKey, state.scopeKey)
      ),
      ...scopes.map((scope) => syncId(scope.mode, range.key, scope.scopeKey)),
    ]);
    // Stable lock ordering prevents two concurrent rebuilds from deadlocking.
    for (const id of [...lockIds].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
    }

    const currentStates = await tx
      .select({
        mode: usageSyncStateTable.mode,
        scopeKey: usageSyncStateTable.scopeKey,
        completedAt: usageSyncStateTable.completedAt,
      })
      .from(usageSyncStateTable)
      .where(eq(usageSyncStateTable.rangeKey, range.key));
    if (usageRangeVersionKey(currentStates) !== baselineVersion) {
      throw new Error("Usage range changed while the rebuild was staged");
    }

    // Staging completed before this transaction opened. From here on, the lock
    // protects only the short atomic replacement of the validated snapshot.
    await tx.delete(usageSyncChunksTable)
      .where(eq(usageSyncChunksTable.rangeKey, range.key));
    await tx.delete(usageSyncStateTable)
      .where(eq(usageSyncStateTable.rangeKey, range.key));

    const completedAt = new Date();
    const { start: rangeStart, end: syncedThrough } = rangeBounds(range);
    const chunkValues = staged.flatMap(({ scope, chunks }) =>
      chunks.map((chunk) => ({
        mode: scope.mode,
        rangeKey: range.key,
        scopeKey: scope.scopeKey,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        payloadJson: chunk.payload,
        completedAt,
      }))
    );
    // Keep each insert below PostgreSQL's bind-parameter limit for large accounts.
    for (let offset = 0; offset < chunkValues.length; offset += 500) {
      await tx.insert(usageSyncChunksTable).values(chunkValues.slice(offset, offset + 500));
    }
    if (staged.length > 0) {
      await tx.insert(usageSyncStateTable).values(staged.map(({ scope, isClosed, chunks }) => ({
        mode: scope.mode,
        rangeKey: range.key,
        scopeKey: scope.scopeKey,
        rangeStart,
        syncedThrough,
        isClosed: isClosed && !chunks.some((chunk) => chunk.partial),
        status: chunks.some((chunk) => chunk.partial) ? "partial" : "success",
        errorMessage: chunks.find((chunk) => chunk.partial)?.error ?? null,
        startedAt: completedAt,
        completedAt,
      })));
    }

    const rebuilt = staged.map(({ scope, chunks, isClosed }) => ({
      scope,
      rows: chunks.map((chunk) => ({
        mode: scope.mode,
        rangeKey: range.key,
        scopeKey: scope.scopeKey,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        payloadJson: chunk.payload,
        completedAt,
      })),
      metadata: {
        syncedThrough: syncedThrough.getTime(),
        completedAt: completedAt.getTime(),
        isClosed: isClosed && !chunks.some((chunk) => chunk.partial),
        status: (chunks.some((chunk) => chunk.partial) ? "partial" : "success") as UsageSyncStatus,
        error: chunks.find((chunk) => chunk.partial)?.error ?? null,
      },
    }));
    logger.info({
      event: "usage_rebuild_commit",
      runId,
      rangeKey: range.key,
      scopeCount: rebuilt.length,
      chunkCount: chunkValues.length,
    }, "Committed atomic usage range rebuild");
    return rebuilt;
  });
}

/**
 * Queue a complete rebuild of every durable usage scope for one selected range.
 * Every upstream response is staged before one transaction replaces the range,
 * so any failure preserves the complete prior snapshot.
 */
export function queueFullRangeRebuild(
  range: UsageRange,
  groups: readonly EnterpriseGroup[],
  workspaceIds: readonly string[],
): boolean {
  return enqueueUsage(`full-range-rebuild:${range.key}`, 2, async () => {
    try {
      const scopes: FullRebuildScope[] = [
        { mode: "account_total", scopeKey: ACCOUNT_USAGE_SCOPE, params: {} },
        ...groups.flatMap((group): FullRebuildScope[] => {
          const params = { workspaceId: group.workspaceId, groupId: group.id };
          return [
            { mode: "group_total", scopeKey: group.id, params },
            { mode: "group_member", scopeKey: group.id, params },
            { mode: "group_project", scopeKey: group.id, params },
          ];
        }),
        ...workspaceIds.map((workspaceId): FullRebuildScope => ({
          mode: "workspace_member",
          scopeKey: workspaceId,
          params: { workspaceId },
        })),
      ];
      const rebuilt = await rebuildUsageRangeAtomically(range, scopes);

      accountUsageCache.delete(range.key);
      for (const key of spendCache.keys()) {
        if (key.startsWith(`${range.key}|`)) spendCache.delete(key);
      }
      for (const key of memberUsageCache.keys()) {
        if (key.startsWith(`${range.key}|`)) memberUsageCache.delete(key);
      }
      for (const key of projectUsageCache.keys()) {
        if (key.startsWith(`${range.key}|`)) projectUsageCache.delete(key);
      }
      for (const key of wsSpendCache.keys()) {
        if (key.startsWith(`${range.key}|`)) wsSpendCache.delete(key);
      }
      for (const key of wsSpendCachedAt.keys()) {
        if (key.startsWith(`${range.key}|`)) wsSpendCachedAt.delete(key);
      }
      for (const key of syncMetadata.keys()) {
        if (key.includes(`|${range.key}|`)) syncMetadata.delete(key);
      }

      for (const result of rebuilt) {
        const { mode, scopeKey } = result.scope;
        syncMetadata.set(syncId(mode, range.key, scopeKey), result.metadata);
        if (mode === "account_total") {
          accountUsageCache.set(range.key, aggregateAccountUsage(result.rows));
        } else if (mode === "group_total") {
          const spend = aggregateGroupSpend(result.rows);
          spendCache.set(`${range.key}|${scopeKey}`, spend);
          await persistSpendToDb(range.key, scopeKey, spend);
        } else if (mode === "group_member") {
          memberUsageCache.set(
            `${range.key}|${scopeKey}`,
            aggregateMemberUsage(result.rows),
          );
        } else if (mode === "group_project") {
          projectUsageCache.set(
            `${range.key}|${scopeKey}`,
            aggregateProjectUsage(result.rows),
          );
        } else if (mode === "workspace_member") {
          const cacheKey = `${range.key}|${scopeKey}`;
          const usage = aggregateWorkspaceMemberUsage(result.rows);
          wsSpendCache.set(cacheKey, usage);
          wsSpendCachedAt.set(cacheKey, usage.fetchedAt);
        }
      }
      logger.info({ range: range.key }, "Full usage range rebuild completed");
    } catch (err) {
      logger.error({ err, range: range.key }, "Full usage range rebuild failed");
      throw err;
    }
  }, "backfill");
}

/** Test-only seam for account summary and authorization fixtures. */
export function __setAccountUsageForTests(
  rangeKey: string,
  usage: AccountUsage | null,
): void {
  if (usage) accountUsageCache.set(rangeKey, usage);
  else accountUsageCache.delete(rangeKey);
  if (usage) {
    setSuccessfulSyncMetadataForTests(
      "account_total",
      rangeKey,
      ACCOUNT_USAGE_SCOPE,
      usage.fetchedAt,
    );
  } else {
    syncMetadata.delete(syncId("account_total", rangeKey, ACCOUNT_USAGE_SCOPE));
  }
}

export function getMemberUsage(groupId: string, rangeKey: string): MemberUsage | undefined {
  return memberUsageCache.get(`${rangeKey}|${groupId}`);
}
export function queueMemberUsageFetch(
  group: EnterpriseGroup,
  range: UsageRange,
  priority = 0,
  force = false,
): boolean {
  const cacheKey = `${range.key}|${group.id}`;
  const cached = memberUsageCache.get(cacheKey);
  if (isDurablyFresh("group_member", range.key, group.id, cached?.fetchedAt, force)) {
    return false;
  }
  const queued = enqueueUsage(
    `member-usage:${cacheKey}`,
    priority,
    async () => {
      try {
        const rows = await synchronizeUsage("group_member", range, group.id, {
          workspaceId: group.workspaceId,
          groupId: group.id,
        }, force);
        memberUsageCache.set(cacheKey, aggregateMemberUsage(rows));
      } catch (err) {
        logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch member usage");
        throw err;
      }
    },
  );
  if (queued) markUsageSyncQueued("group_member", range.key, group.id);
  return queued;
}

// ---------- Per-workspace member spend (workspaces without custom groups) ----------
// Users often belong to both the main Comcast workspace (where all AZ-Replit groups
// live) AND a dedicated team workspace (e.g. Strategic Development). Their spend in
// the dedicated workspace is not captured by the per-group Comcast fetches, so we
// fetch each extra workspace's member-level totals and merge them in.

const wsSpendCache = new Map<string, MemberUsage>(); // `${rangeKey}|${wsId}` → complete workspace usage
const wsSpendCachedAt = new Map<string, number>(); // `${rangeKey}|${wsId}` → fetchedAt timestamp
const wsSpendFetching = new Set<string>(); // in-flight cache keys

export function getWsSpendByUser(wsId: string, rangeKey: string): Map<string, number> | undefined {
  return wsSpendCache.get(`${rangeKey}|${wsId}`)?.byUser;
}

export function getWorkspaceMemberUsage(
  wsId: string,
  rangeKey: string,
): MemberUsage | undefined {
  return wsSpendCache.get(`${rangeKey}|${wsId}`);
}

export function isWorkspaceMemberUsageComplete(
  wsId: string,
  rangeKey: string,
): boolean {
  const metadata = syncMetadata.get(syncId("workspace_member", rangeKey, wsId));
  return metadata?.status === "success";
}

export function __setWorkspaceMemberUsageStatusForTests(
  wsId: string,
  rangeKey: string,
  status: UsageSyncStatus | null,
): void {
  if (status === null) {
    syncMetadata.delete(syncId("workspace_member", rangeKey, wsId));
    return;
  }
  const previous = syncMetadata.get(syncId("workspace_member", rangeKey, wsId));
  syncMetadata.set(syncId("workspace_member", rangeKey, wsId), {
    syncedThrough: previous?.syncedThrough ?? Date.now(),
    completedAt: Date.now(),
    isClosed: previous?.isClosed ?? false,
    status,
    error: status === "success" ? null : `test ${status}`,
  });
}

export function queueWsSpendFetch(
  wsId: string,
  range: UsageRange,
  priority = 1,
  force = false,
): boolean {
  const cacheKey = `${range.key}|${wsId}`;
  const cached = wsSpendCache.get(cacheKey);
  const cachedAt = wsSpendCachedAt.get(cacheKey);
  // Apply the same TTL as per-group member usage so cross-workspace totals refresh
  // at the same cadence (rather than freezing for the lifetime of the server process).
  if (cached && isDurablyFresh("workspace_member", range.key, wsId, cachedAt, force)) return false;
  if (wsSpendFetching.has(cacheKey)) return false;
  wsSpendFetching.add(cacheKey);
  const queued = enqueueUsage(`ws-spend:${cacheKey}`, priority, async () => {
    try {
      const rows = await synchronizeUsage("workspace_member", range, wsId, {
        workspaceId: wsId,
      }, force);
      wsSpendCache.set(cacheKey, aggregateWorkspaceMemberUsage(rows));
      wsSpendCachedAt.set(
        cacheKey,
        Math.max(...rows.map((row) => row.completedAt.getTime())),
      );
    } catch (err) {
      logger.error({ err, wsId, range: range.key }, "Failed to fetch workspace member spend");
      throw err;
    } finally {
      wsSpendFetching.delete(cacheKey);
    }
  });
  if (queued) markUsageSyncQueued("workspace_member", range.key, wsId);
  else wsSpendFetching.delete(cacheKey);
  return queued;
}

/** Queue per-member spend fetches for every workspace that owns no custom groups.
 *  These are the "extra" workspaces where users accumulate spend beyond their
 *  Comcast workspace group membership. */
export function queueExtraWorkspacesFetch(
  dir: DirectoryCache,
  range: UsageRange,
  priority = 1,
  force = false,
): void {
  const groupWorkspaceIds = new Set(dir.groups.map((g) => g.workspaceId));
  for (const [wsId] of dir.workspaces) {
    if (!groupWorkspaceIds.has(wsId)) {
      queueWsSpendFetch(wsId, range, priority, force);
    }
  }
}

/** Queue per-member spend fetches for ALL workspaces, including those with custom groups.
 *  The group_member API only returns users with AI-agent spend; workspace_member fetches
 *  capture the full per-user total (compute + storage + all metric types) so the dashboard
 *  can use MAX(group_member, workspace_member) and avoid under-counting non-agent spend. */
export function queueAllWorkspacesFetch(
  dir: DirectoryCache,
  range: UsageRange,
  priority = 1,
  force = false,
): void {
  for (const [wsId] of dir.workspaces) {
    queueWsSpendFetch(wsId, range, priority, force);
  }
}

/** Returns the summed extra-workspace spend per user and whether all fetches have landed. */
export function getExtraWorkspaceSpend(
  dir: DirectoryCache,
  rangeKey: string,
): { byUser: Map<string, number>; isComplete: boolean; loadedCount: number; totalCount: number } {
  const groupWorkspaceIds = new Set(dir.groups.map((g) => g.workspaceId));
  const byUser = new Map<string, number>();
  let loadedCount = 0;
  let totalCount = 0;
  for (const [wsId] of dir.workspaces) {
    if (groupWorkspaceIds.has(wsId)) continue;
    totalCount += 1;
    const wsData = wsSpendCache.get(`${rangeKey}|${wsId}`);
    if (!wsData) continue;
    loadedCount += 1;
    for (const [userId, spend] of wsData.byUser) {
      byUser.set(userId, (byUser.get(userId) ?? 0) + spend);
    }
  }
  return { byUser, isComplete: loadedCount === totalCount, loadedCount, totalCount };
}

// ---------- Per-project group usage (groupBy=project, one call per group+range) ----------

export interface ProjectUsageMetric {
  id: string;
  name: string;
  category: string;
  costUsd: number;
}

export interface ProjectUsageEntry {
  projectId: string;
  workspaceId: string | null;
  totalCostUsd: number;
  metrics: ProjectUsageMetric[];
}

export interface ProjectUsage {
  fetchedAt: number;
  byProject: Map<string, ProjectUsageEntry>;
  totalCostUsd: number;
}

const projectUsageCache = new Map<string, ProjectUsage>(); // `${rangeKey}|${groupId}`
export interface ProjectAttribution {
  projectToGroup: Map<string, string>;
  spendByGroup: Map<string, number>;
  aiSpendByProject: Map<string, number>;
  nonAiSpendByProject: Map<string, number>;
  creatorByProject: Map<string, string | null>;
  creatorNonAiSpendByUser: Map<string, number>;
  creatorNonAiSpendByGroup: Map<string, Map<string, number>>;
  unattributedSpendUsd: number;
  totalSpendUsd: number;
  isComplete: boolean;
  pendingCount: number;
}

export function getProjectUsage(groupId: string, rangeKey: string): ProjectUsage | undefined {
  return projectUsageCache.get(`${rangeKey}|${groupId}`);
}

/**
 * Attribute every project to one custom group.
 *
 * When several group filters report the same project, the highest-total
 * observation wins, with a stable group-ID tie break. Spend that the API
 * includes in a group's total without a project ID cannot be matched and is
 * surfaced as enterprise-level unattributed project spend.
 */
export function getProjectAttribution(
  rangeKey: string,
  groups: readonly EnterpriseGroup[],
  _workspaces: ReadonlyMap<string, EnterpriseWorkspace>,
  groupMembers?: ReadonlyMap<string, readonly string[]>,
): ProjectAttribution {
  const creatorOwnerByWorkspaceUser = new Map<string, EnterpriseGroup>();
  if (groupMembers) {
    const orderedGroups = [...groups].sort(
      (a, b) =>
        a.workspaceId.localeCompare(b.workspaceId) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
    for (const group of orderedGroups) {
      for (const userId of groupMembers.get(group.id) ?? []) {
        const key = `${group.workspaceId}\u0000${userId}`;
        if (!creatorOwnerByWorkspaceUser.has(key)) {
          creatorOwnerByWorkspaceUser.set(key, group);
        }
      }
    }
  }
  const candidates = new Map<string, Array<{
    group: EnterpriseGroup;
    project: ProjectUsageEntry;
    spendUsd: number;
  }>>();
  let unattributedSpendUsd = 0;
  let loadedCount = 0;

  for (const group of groups) {
    const usage = getProjectUsage(group.id, rangeKey);
    if (!usage) continue;
    loadedCount += 1;

    let identifiedSpendUsd = 0;
    for (const project of usage.byProject.values()) {
      identifiedSpendUsd += project.totalCostUsd;
      const projectCandidates = candidates.get(project.projectId) ?? [];
      projectCandidates.push({ group, project, spendUsd: project.totalCostUsd });
      candidates.set(project.projectId, projectCandidates);
    }
    unattributedSpendUsd += Math.max(0, usage.totalCostUsd - identifiedSpendUsd);
  }

  const projectToGroup = new Map<string, string>();
  const spendByGroup = new Map<string, number>();
  const aiSpendByProject = new Map<string, number>();
  const nonAiSpendByProject = new Map<string, number>();
  const creatorByProject = new Map<string, string | null>();
  const creatorNonAiSpendByUser = new Map<string, number>();
  const creatorNonAiSpendByGroup = new Map<string, Map<string, number>>();
  let attributedSpendUsd = 0;
  const missingProjectInfoWorkspaces = new Set<string>();
  const unidentifiedProjectSpendUsd = unattributedSpendUsd;

  for (const [projectId, projectCandidates] of candidates) {
    // The same project can be reported by several group filters. The single
    // highest-total observation is authoritative; a stable ID resolves ties.
    let winner = projectCandidates[0]!;
    for (let i = 1; i < projectCandidates.length; i++) {
      const candidate = projectCandidates[i]!;
      if (
        candidate.spendUsd > winner.spendUsd ||
        (candidate.spendUsd === winner.spendUsd && candidate.group.id < winner.group.id)
      ) {
        winner = candidate;
      }
    }

    projectToGroup.set(projectId, winner.group.id);
    spendByGroup.set(
      winner.group.id,
      (spendByGroup.get(winner.group.id) ?? 0) + winner.spendUsd,
    );
    attributedSpendUsd += winner.spendUsd;

    const aiSpendUsd = Math.min(
      winner.spendUsd,
      Math.max(0, winner.project.metrics
        .filter((metric) => metric.category.toLowerCase() === "ai")
        .reduce((sum, metric) => sum + metric.costUsd, 0)),
    );
    const nonAiSpendUsd = Math.max(0, winner.spendUsd - aiSpendUsd);
    aiSpendByProject.set(projectId, aiSpendUsd);
    nonAiSpendByProject.set(projectId, nonAiSpendUsd);

    const info = getProjectInfo(winner.group.workspaceId, projectId);
    if (
      groupMembers &&
      nonAiSpendUsd > 1e-9 &&
      !hasProjectInfo(winner.group.workspaceId)
    ) {
      missingProjectInfoWorkspaces.add(winner.group.workspaceId);
    }
    const creatorId = info?.creatorId ?? null;
    creatorByProject.set(projectId, creatorId);
    const creatorOwner = creatorId === null
      ? undefined
      : creatorOwnerByWorkspaceUser.get(`${winner.group.workspaceId}\u0000${creatorId}`);
    if (!groupMembers) {
      continue;
    } else if (creatorOwner && creatorId !== null) {
      creatorNonAiSpendByUser.set(
        creatorId,
        (creatorNonAiSpendByUser.get(creatorId) ?? 0) + nonAiSpendUsd,
      );
      const groupByUser = creatorNonAiSpendByGroup.get(creatorOwner.id) ?? new Map();
      groupByUser.set(creatorId, (groupByUser.get(creatorId) ?? 0) + nonAiSpendUsd);
      creatorNonAiSpendByGroup.set(creatorOwner.id, groupByUser);
    } else {
      unattributedSpendUsd += nonAiSpendUsd;
    }
  }

  return {
    projectToGroup,
    spendByGroup,
    aiSpendByProject,
    nonAiSpendByProject,
    creatorByProject,
    creatorNonAiSpendByUser,
    creatorNonAiSpendByGroup,
    unattributedSpendUsd,
    totalSpendUsd: attributedSpendUsd + unidentifiedProjectSpendUsd,
    isComplete: loadedCount === groups.length && missingProjectInfoWorkspaces.size === 0,
    pendingCount: groups.length - loadedCount + missingProjectInfoWorkspaces.size,
  };
}

/** Test-only seam for project attribution fixtures. */
export function __setProjectUsageForTests(
  groupId: string,
  rangeKey: string,
  usage: ProjectUsage | null,
): void {
  const key = `${rangeKey}|${groupId}`;
  if (usage) {
    projectUsageCache.set(key, usage);
    setSuccessfulSyncMetadataForTests("group_project", rangeKey, groupId, usage.fetchedAt);
  } else {
    projectUsageCache.delete(key);
    syncMetadata.delete(syncId("group_project", rangeKey, groupId));
  }
}

export function queueProjectUsageFetch(
  group: EnterpriseGroup,
  range: UsageRange,
  priority = 0,
  force = false,
): boolean {
  const cacheKey = `${range.key}|${group.id}`;
  const cached = projectUsageCache.get(cacheKey);
  if (isDurablyFresh("group_project", range.key, group.id, cached?.fetchedAt, force)) {
    return false;
  }
  const queued = enqueueUsage(
    `project-usage:${cacheKey}`,
    priority,
    async () => {
      try {
        const rows = await synchronizeUsage("group_project", range, group.id, {
          workspaceId: group.workspaceId,
          groupId: group.id,
        }, force);
        projectUsageCache.set(cacheKey, aggregateProjectUsage(rows));
      } catch (err) {
        logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch project usage");
        throw err;
      }
    },
  );
  if (queued) markUsageSyncQueued("group_project", range.key, group.id);
  return queued;
}

function hydrateDurableUsage(rows: UsageSyncChunk[]): void {
  const grouped = new Map<string, UsageSyncChunk[]>();
  for (const row of rows) {
    const id = syncId(row.mode as UsageSyncMode, row.rangeKey, row.scopeKey);
    const list = grouped.get(id) ?? [];
    list.push(row);
    grouped.set(id, list);
  }
  for (const [id, scopeRows] of grouped) {
    const [mode, rangeKey, scopeKey] = id.split("|") as [UsageSyncMode, string, string];
    const cacheKey = `${rangeKey}|${scopeKey}`;
    if (mode === "account_total") {
      accountUsageCache.set(rangeKey, aggregateAccountUsage(scopeRows));
    } else if (mode === "group_total") {
      spendCache.set(cacheKey, aggregateGroupSpend(scopeRows));
    } else if (mode === "group_member") {
      memberUsageCache.set(cacheKey, aggregateMemberUsage(scopeRows));
    } else if (mode === "workspace_member") {
      wsSpendCache.set(cacheKey, aggregateWorkspaceMemberUsage(scopeRows));
      wsSpendCachedAt.set(
        cacheKey,
        Math.max(...scopeRows.map((row) => row.completedAt.getTime())),
      );
    } else if (mode === "group_project") {
      projectUsageCache.set(cacheKey, aggregateProjectUsage(scopeRows));
    }
  }
}

// ---------- Project titles (per workspace) ----------

interface RawProject {
  id: string;
  title?: string | null;
  creatorId?: string | null;
}

export interface ProjectInfo {
  title: string | null;
  creatorId: string | null;
}

// workspaceId -> projectId -> { title, creatorId }
const projectInfoCache = new Map<string, Map<string, ProjectInfo>>();
const projectInfoFetchedAt = new Map<string, number>();
const projectTitlesFetching = new Set<string>();

export function getProjectTitles(workspaceId: string): Map<string, string> {
  const infoMap = projectInfoCache.get(workspaceId);
  if (!infoMap) return new Map();
  const out = new Map<string, string>();
  for (const [id, info] of infoMap) {
    if (info.title) out.set(id, info.title);
  }
  return out;
}

/** Returns undefined if cache not yet loaded for this workspace, otherwise the project's info. */
export function getProjectInfo(workspaceId: string, projectId: string): ProjectInfo | undefined {
  const infoMap = projectInfoCache.get(workspaceId);
  if (!infoMap) return undefined;
  return infoMap.get(projectId) ?? { title: null, creatorId: null };
}

/** Test-only seam for creator-attribution fixtures. */
export function __setProjectInfoForTests(
  workspaceId: string,
  projects: ReadonlyMap<string, ProjectInfo> | null,
): void {
  if (projects) {
    projectInfoCache.set(workspaceId, new Map(projects));
    projectInfoFetchedAt.set(workspaceId, Date.now());
  } else {
    projectInfoCache.delete(workspaceId);
    projectInfoFetchedAt.delete(workspaceId);
  }
}
/** Returns true if project info (titles + creatorIds) has been fetched for this workspace. */
export function hasProjectInfo(workspaceId: string): boolean {
  return projectInfoCache.has(workspaceId);
}

export function queueProjectTitlesFetch(
  workspaceId: string,
  priority = 0,
  force = false,
  scheduleCanonical = true,
): boolean {
  const fetchedAt = projectInfoFetchedAt.get(workspaceId);
  const hasStoredSnapshot = projectInfoCache.has(workspaceId);
  if (
    projectTitlesFetching.has(workspaceId) ||
    (!force &&
      hasStoredSnapshot &&
      fetchedAt !== undefined &&
      Date.now() - fetchedAt < PROJECT_INFO_TTL_MS)
  ) {
    return false;
  }
  projectTitlesFetching.add(workspaceId);
  return enqueueUsage(`project-titles:${workspaceId}`, priority, async () => {
    const startedAt = new Date();
    try {
      if (!hasStoredSnapshot) {
        await db.insert(apiProjectMetadataStateTable).values({
          workspaceId,
          status: "syncing",
          errorMessage: null,
          startedAt,
          completedAt: startedAt,
        }).onConflictDoUpdate({
          target: apiProjectMetadataStateTable.workspaceId,
          set: { status: "syncing", errorMessage: null, startedAt },
        });
      }
      const projects = await paginate<RawProject>("/projects", { workspaceId });
      const infoMap = new Map<string, ProjectInfo>();
      for (const p of projects) {
        infoMap.set(p.id, {
          title: p.title ?? null,
          creatorId: p.creatorId ?? null,
        });
      }
      const completedAt = new Date();
      await db.transaction(async (tx) => {
        await tx.delete(apiProjectMetadataTable)
          .where(eq(apiProjectMetadataTable.workspaceId, workspaceId));
        if (projects.length > 0) {
          await tx.insert(apiProjectMetadataTable).values(projects.map((project) => ({
            workspaceId,
            projectId: project.id,
            title: project.title ?? null,
            creatorId: project.creatorId ?? null,
            fetchedAt: completedAt,
          })));
        }
        await tx.insert(apiProjectMetadataStateTable).values({
          workspaceId,
          status: "success",
          errorMessage: null,
          startedAt,
          completedAt,
        }).onConflictDoUpdate({
          target: apiProjectMetadataStateTable.workspaceId,
          set: { status: "success", errorMessage: null, startedAt, completedAt },
        });
      });
      projectInfoCache.set(workspaceId, infoMap);
      projectInfoFetchedAt.set(workspaceId, completedAt.getTime());
      if (scheduleCanonical) {
        for (const monthStart of canonicalCandidateMonths) {
          queueCanonicalMonthRebuild(monthStart);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!hasStoredSnapshot) {
        await db.insert(apiProjectMetadataStateTable).values({
          workspaceId,
          status: "failed",
          errorMessage: message.slice(0, 1000),
          startedAt,
          completedAt: new Date(),
        }).onConflictDoUpdate({
          target: apiProjectMetadataStateTable.workspaceId,
          set: { status: "failed", errorMessage: message.slice(0, 1000), completedAt: new Date() },
        }).catch((dbErr: unknown) => logger.warn({ err: dbErr, workspaceId }, "Failed to persist project metadata failure"));
      }
      logger.warn({ err, workspaceId }, "Failed to fetch project titles");
      throw err;
    } finally {
      projectTitlesFetching.delete(workspaceId);
    }
  });
}

/**
 * Returns the workspace ID whose name matches "Comcast" (case-insensitive),
 * or null if no such workspace is found.
 */
export function getComcastWorkspaceId(
  workspaces: ReadonlyMap<string, { name: string }>,
): string | null {
  for (const [wsId, ws] of workspaces) {
    if (ws.name.trim().toLowerCase() === "comcast") return wsId;
  }
  return null;
}

export interface WorkspaceSpendAttribution {
  spendByWorkspace: Map<string, number>;
  reAttributedSpendByWorkspace: Map<string, number>;
}

/**
 * Apply the dashboard's Comcast re-attribution rule to one user's workspace
 * spend. The highest-spend non-Comcast workspace is the primary destination;
 * workspace ID breaks ties deterministically. Comcast-only users are unchanged.
 *
 * The returned maps contain every input workspace, including zero-spend rows,
 * so callers can preserve membership rows independently from spend visibility.
 */
export function applyComcastReAttribution(
  workspaces: ReadonlyMap<string, { name: string }>,
  perUserWsSpend: ReadonlyMap<string, number>,
  comcastWsId: string | null = getComcastWorkspaceId(workspaces),
): WorkspaceSpendAttribution {
  const spendByWorkspace = new Map(perUserWsSpend);
  const reAttributedSpendByWorkspace = new Map<string, number>();

  if (!comcastWsId) return { spendByWorkspace, reAttributedSpendByWorkspace };

  const comcastSpend = perUserWsSpend.get(comcastWsId) ?? 0;
  if (comcastSpend <= 0) return { spendByWorkspace, reAttributedSpendByWorkspace };

  let primaryWsId: string | null = null;
  let primarySpend = -Infinity;
  for (const [workspaceId, spend] of perUserWsSpend) {
    if (workspaceId === comcastWsId || spend <= 0) continue;
    if (
      spend > primarySpend ||
      (spend === primarySpend && primaryWsId !== null && workspaceId < primaryWsId)
    ) {
      primaryWsId = workspaceId;
      primarySpend = spend;
    }
  }

  if (!primaryWsId) return { spendByWorkspace, reAttributedSpendByWorkspace };

  spendByWorkspace.set(comcastWsId, 0);
  spendByWorkspace.set(primaryWsId, (spendByWorkspace.get(primaryWsId) ?? 0) + comcastSpend);
  reAttributedSpendByWorkspace.set(primaryWsId, comcastSpend);

  return { spendByWorkspace, reAttributedSpendByWorkspace };
}

/**
 * Workspace-aware dashboard rollup.
 *
 * A workspace_member payload is the authoritative observation for each
 * (workspace, user) pair. While it is loading, the largest group_member
 * observation in that workspace is exposed provisionally; different serialized
 * observations are never added together. Distinct workspaces always remain
 * distinct observations, even when their dollar values happen to be equal.
 *
 * Each pair is attributed to the first custom group in stable order whose
 * directory or usage membership contains the user. Unmatched workspace members,
 * usage users, and no-user workspace charges are retained in a synthetic
 * per-workspace "No group" bucket.
 *
 * When a `workspaces` map is provided, Comcast workspace spend re-attribution
 * is applied:
 *  - Each user's Comcast-workspace spend is re-homed to their primary
 *    non-Comcast workspace's group (the workspace with the highest actual spend
 *    per wsSpendCache; stable workspace-ID order breaks ties).
 *  - Non-Comcast workspace spend is always attributed to that workspace's own
 *    groups (or ungrouped if the workspace has no custom groups).
 *  - Comcast-only users (no non-Comcast workspace spend) are unchanged.
 */
export function getDedupedUsageRollup(
  groups: EnterpriseGroup[],
  rangeKey: string,
  workspaceIds?: ReadonlySet<string>,
  groupMembers?: ReadonlyMap<string, readonly string[]>,
  directoryMembers?: ReadonlyMap<string, EnterpriseMember>,
  workspaces?: ReadonlyMap<string, { name: string }>,
): DedupedUsageRollup {
  const ordered: EnterpriseGroup[] = [...groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const groupsByWorkspace = new Map<string, EnterpriseGroup[]>();
  const memberIdsByGroup = new Map<string, ReadonlySet<string>>();
  for (const group of ordered) {
    const workspaceGroups = groupsByWorkspace.get(group.workspaceId) ?? [];
    workspaceGroups.push(group);
    groupsByWorkspace.set(group.workspaceId, workspaceGroups);
    memberIdsByGroup.set(group.id, new Set(groupMembers?.get(group.id) ?? []));
  }

  let pendingCount = 0;
  const usageByGroup = new Map<string, MemberUsage>();
  for (const group of ordered) {
    const usage = getMemberUsage(group.id, rangeKey);
    if (!usage) {
      // Workspace payloads are authoritative when a workspace scope is supplied.
      // Missing group payloads only make the legacy group-only fallback incomplete.
      if (!workspaceIds) pendingCount++;
      continue;
    }
    usageByGroup.set(group.id, usage);
  }

  const byGroup = new Map<string, DedupedGroupRollup>();
  for (const group of ordered) byGroup.set(group.id, { spendUsd: 0, memberCount: 0, byUser: new Map() });
  const byUser = new Map<string, number>();
  const ungroupedByWorkspace = new Map<string, DedupedGroupRollup>();
  const crossWorkspaceAttributedUsersByGroup = new Map<string, Set<string>>();
  const scopedWorkspaceIds =
    workspaceIds ?? new Set(ordered.map((group) => group.workspaceId));
  const ownerByWorkspaceUser = new Map<string, Map<string, EnterpriseGroup>>();
  for (const [workspaceId, workspaceGroups] of groupsByWorkspace) {
    const owners = new Map<string, EnterpriseGroup>();
    for (const group of workspaceGroups) {
      for (const userId of memberIdsByGroup.get(group.id) ?? []) {
        if (!owners.has(userId)) owners.set(userId, group);
      }
      for (const userId of usageByGroup.get(group.id)?.byUser.keys() ?? []) {
        if (!owners.has(userId)) owners.set(userId, group);
      }
    }
    ownerByWorkspaceUser.set(workspaceId, owners);
  }

  let totalMemberCount = 0;
  let totalSpendUsd = 0;

  // Step 1: Identify the Comcast workspace by name.
  const comcastWorkspaceId = workspaces ? getComcastWorkspaceId(workspaces) : null;
  if (workspaces && !comcastWorkspaceId) {
    logger.warn("No workspace named 'Comcast' found; extra-workspace re-attribution skipped");
  }

  // Step 2: Build a mapping from each non-Comcast workspace ID to matching
  // Comcast-workspace groups. Prefer an exact normalized team-name match. When
  // none exists, allow the full workspace name as a bounded parent prefix so a
  // parent workspace such as "Strategic Development" can map to child teams
  // such as "Strategic Development LIFT Labs" and "Strategic Development
  // Mosaic". Using the full normalized name (rather than the first token)
  // prevents "Talent" from accidentally matching "Talent Learning" whenever
  // an exact "Talent" team exists.
  const normalizeTeamName = (s: string): string =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const comcastGroupsByWorkspace = new Map<string, EnterpriseGroup[]>();
  const parentWorkspaceIds = new Set<string>();
  if (comcastWorkspaceId && workspaces) {
    const comcastGroups = ordered.filter((g) => g.workspaceId === comcastWorkspaceId);
    const normalizedTeamNameByGroupId = new Map<string, string>();
    for (const group of comcastGroups) {
      const body = group.name
        .replace(/^az[-–\s]+replit[-–\s]+/i, "")
        .replace(/[-–\s]+(admin|member|creator|viewer|owner|manager)$/i, "")
        .trim();
      normalizedTeamNameByGroupId.set(group.id, normalizeTeamName(body));
    }
    for (const [wsId, ws] of workspaces) {
      if (wsId === comcastWorkspaceId) continue;
      const normalizedWsName = normalizeTeamName(ws.name);
      if (normalizedWsName.length < 2) continue;
      const exact = comcastGroups.filter(
        (group) => normalizedTeamNameByGroupId.get(group.id) === normalizedWsName,
      );
      const matching = exact.length > 0
        ? exact
        : comcastGroups.filter((group) =>
          normalizedTeamNameByGroupId.get(group.id)?.startsWith(`${normalizedWsName} `),
        );
      if (matching.length > 0) {
        comcastGroupsByWorkspace.set(wsId, matching);
        if (exact.length === 0) parentWorkspaceIds.add(wsId);
      }
    }
  }

  // Tracking state for Comcast spend re-homing.
  // userId → the Comcast-workspace group they were attributed to.
  const userComcastGroupId = new Map<string, string>();
  // userId → their spend amount in the Comcast workspace.
  const userComcastSpend = new Map<string, number>();

  for (const workspaceId of [...scopedWorkspaceIds].sort()) {
    const workspaceGroups = groupsByWorkspace.get(workspaceId) ?? [];
    const workspaceUsage = wsSpendCache.get(`${rangeKey}|${workspaceId}`);
    if (!workspaceUsage) pendingCount += 1;

    const candidates = new Set<string>();
    for (const member of directoryMembers?.values() ?? []) {
      if (member.workspaces.has(workspaceId)) candidates.add(member.userId);
    }
    for (const userId of workspaceUsage?.byUser.keys() ?? []) candidates.add(userId);
    for (const group of workspaceGroups) {
      for (const userId of memberIdsByGroup.get(group.id) ?? []) candidates.add(userId);
      for (const userId of usageByGroup.get(group.id)?.byUser.keys() ?? []) candidates.add(userId);
    }

    const ungrouped: DedupedGroupRollup = {
      spendUsd: workspaceUsage?.unattributableTotalCostUsd ?? 0,
      memberCount: 0,
      byUser: new Map(),
    };
    const ungroupedByUser = ungrouped.byUser as Map<string, number>;
    totalSpendUsd += ungrouped.spendUsd;

    for (const userId of [...candidates].sort()) {
      let spendUsd = workspaceUsage?.byUser.get(userId);
      if (spendUsd === undefined) {
        spendUsd = 0;
        for (const group of workspaceGroups) {
          spendUsd = Math.max(spendUsd, usageByGroup.get(group.id)?.byUser.get(userId) ?? 0);
        }
      }

      // Parent extra workspaces can own several Comcast team families. If this
      // user already belongs to one of those Comcast groups, that membership is
      // the deterministic owner for spend in the parent workspace. This is what
      // distinguishes LIFT Labs members from Mosaic members inside the shared
      // Strategic Development workspace. This explicit parent-team ownership
      // takes precedence over incidental local groups such as PREPROD.
      const parentComcastOwner =
        comcastWorkspaceId &&
        workspaceId !== comcastWorkspaceId &&
        parentWorkspaceIds.has(workspaceId)
          ? (comcastGroupsByWorkspace.get(workspaceId) ?? []).find(
          (group) =>
            memberIdsByGroup.get(group.id)?.has(userId) ||
            usageByGroup.get(group.id)?.byUser.has(userId),
          )
          : undefined;

      // Otherwise find the first group in this workspace (stable order) whose
      // directory or usage membership contains the user.
      let owner = parentComcastOwner ?? ownerByWorkspaceUser.get(workspaceId)?.get(userId);

      // Workspace-admin fallback: workspace admins often lack explicit Comcast
      // group membership but their spend belongs to the team they administer.
      // • Extra workspace: if the user is an admin of THIS workspace, attribute
      //   them to the matching Comcast group (e.g. LIFT Labs admin → LIFT Labs group).
      // • Comcast workspace: if still unmatched, check whether the user is an
      //   admin of any extra workspace with a matching Comcast group and use that
      //   group (prefer the workspace with the highest wsSpendCache spend).
      if (!owner && comcastWorkspaceId && comcastGroupsByWorkspace.size > 0) {
        const member = directoryMembers?.get(userId);
        if (member) {
          if (workspaceId !== comcastWorkspaceId) {
            // Extra workspace: attribute only if user is an admin of this workspace.
            // Applies regardless of whether the workspace has custom groups — a
            // workspace admin with no group membership belongs to the mapped
            // Comcast group even if the workspace contains other custom groups.
            if (member.workspaces.get(workspaceId)?.role === "admin") {
              const matchingGroups = comcastGroupsByWorkspace.get(workspaceId) ?? [];
              const teamNames = new Set(
                matchingGroups.map((group) =>
                  normalizeTeamName(
                    group.name
                      .replace(/^az[-–\s]+replit[-–\s]+/i, "")
                      .replace(/[-–\s]+(admin|member|creator|viewer|owner|manager)$/i, "")
                      .trim(),
                  ),
                ),
              );
              // A no-membership admin fallback is safe only when the workspace
              // maps to one team family. Parent workspaces with multiple child
              // teams require explicit group membership to disambiguate.
              if (teamNames.size === 1) owner = matchingGroups[0];
            }
          } else if (workspaceId === comcastWorkspaceId) {
            // Comcast workspace: pick the extra workspace they admin with most spend.
            let bestWsId: string | null = null;
            let bestSpend = -1;
            for (const [wsId] of comcastGroupsByWorkspace) {
              if (member.workspaces.get(wsId)?.role !== "admin") continue;
              const wsSpend = wsSpendCache.get(`${rangeKey}|${wsId}`)?.byUser.get(userId) ?? 0;
              if (wsSpend > bestSpend || (wsSpend === bestSpend && bestWsId && wsId < bestWsId)) {
                bestSpend = wsSpend;
                bestWsId = wsId;
              }
            }
            if (bestWsId) owner = comcastGroupsByWorkspace.get(bestWsId)?.[0];
          }
        }
      }

      const target = owner ? byGroup.get(owner.id)! : ungrouped;
      if (owner && owner.workspaceId !== workspaceId) {
        const users = crossWorkspaceAttributedUsersByGroup.get(owner.id) ?? new Set<string>();
        users.add(userId);
        crossWorkspaceAttributedUsersByGroup.set(owner.id, users);
      }
      const targetByUser = target.byUser as Map<string, number>;
      // Accumulate: a workspace admin may appear in the same Comcast group from
      // both the extra workspace and the Comcast workspace iterations.
      // Use has() for the first-entry guard — prevSpend may be $0 on first
      // contribution (e.g. Comcast $0 then extra-workspace $N) and testing
      // prevSpend === 0 would double-count the memberCount in that case.
      if (!targetByUser.has(userId)) {
        (target as { memberCount: number }).memberCount += 1;
      }
      const prevSpend = targetByUser.get(userId) ?? 0;
      targetByUser.set(userId, prevSpend + spendUsd);
      byUser.set(userId, (byUser.get(userId) ?? 0) + spendUsd);
      (target as { spendUsd: number }).spendUsd += spendUsd;
      totalMemberCount += 1; // counts user-workspace pairs (unchanged semantics)
      totalSpendUsd += spendUsd;

      // Track Comcast-workspace attribution for re-homing step below.
      if (comcastWorkspaceId && workspaceId === comcastWorkspaceId && owner) {
        userComcastGroupId.set(userId, owner.id);
        userComcastSpend.set(userId, (userComcastSpend.get(userId) ?? 0) + spendUsd);
      }
    }

    if (ungrouped.memberCount > 0 || ungrouped.spendUsd !== 0) {
      ungroupedByWorkspace.set(workspaceId, ungrouped);
    }

    // Preserve provisional group-filter no-user charges until the authoritative
    // workspace payload lands. Once loaded, its no-user total replaces them.
    if (!workspaceUsage) {
      for (const group of workspaceGroups) {
        const unattributableSpend =
          usageByGroup.get(group.id)?.unattributableTotalCostUsd ?? 0;
        const target = byGroup.get(group.id)!;
        (target as { spendUsd: number }).spendUsd += unattributableSpend;
        totalSpendUsd += unattributableSpend;
      }
    }
  }

  // Steps 5–6: Re-home each user's Comcast-workspace spend to their primary
  // non-Comcast workspace's group. Primary = highest attributed non-Comcast spend;
  // stable workspace-ID order breaks ties. Comcast-only users are unchanged.
  // totalSpendUsd and the global byUser map are unchanged — dollars only move
  // between group buckets, never created or destroyed.
  if (comcastWorkspaceId) {
    // Build per-user non-Comcast workspace spend directly from the loaded
    // workspace caches. Using raw workspace totals (not attributed group spend)
    // ensures the primary-workspace calculation reflects actual spend location.
    const userNonComcastSpendByWorkspace = new Map<string, Map<string, number>>();
    for (const wsId of scopedWorkspaceIds) {
      if (wsId === comcastWorkspaceId) continue;
      const wsUsage = wsSpendCache.get(`${rangeKey}|${wsId}`);
      if (!wsUsage) continue;
      for (const [userId, spend] of wsUsage.byUser) {
        if (spend <= 0) continue;
        const wsMap = userNonComcastSpendByWorkspace.get(userId) ?? new Map<string, number>();
        wsMap.set(wsId, (wsMap.get(wsId) ?? 0) + spend);
        userNonComcastSpendByWorkspace.set(userId, wsMap);
      }
    }

    for (const [userId, comcastGroupId] of userComcastGroupId) {
      const nonComcastByWs = userNonComcastSpendByWorkspace.get(userId);
      if (!nonComcastByWs || nonComcastByWs.size === 0) continue;

      // Step 5: Find primary workspace (highest spend; stable wsId tiebreak).
      let primaryWsId: string | null = null;
      let primaryWsSpend = -Infinity;
      for (const [wsId, spend] of nonComcastByWs) {
        if (
          spend > primaryWsSpend ||
          (spend === primaryWsSpend && primaryWsId !== null && wsId < primaryWsId)
        ) {
          primaryWsSpend = spend;
          primaryWsId = wsId;
        }
      }
      if (!primaryWsId) continue;

      // Find the Comcast group matching the primary workspace. Use the first group
      // in stable sort order (Admin before Member) — no membership check needed;
      // the destination is determined structurally by workspace name, not by
      // whether the user is already a member of that group.
      const primaryMatchingGroups = comcastGroupsByWorkspace.get(primaryWsId) ?? [];
      const primaryComcastOwner =
        primaryMatchingGroups.find(
          (group) =>
            memberIdsByGroup.get(group.id)?.has(userId) ||
            usageByGroup.get(group.id)?.byUser.has(userId),
        ) ??
        primaryMatchingGroups[0];
      // Nothing to move if: no matching group exists, or the spend is already
      // in the right group.
      if (!primaryComcastOwner || primaryComcastOwner.id === comcastGroupId) continue;

      // Step 6: Move user's Comcast spend from their current group to the primary's.
      const comcastSpend = userComcastSpend.get(userId) ?? 0;
      if (comcastSpend <= 0) continue;

      const sourceGroup = byGroup.get(comcastGroupId);
      const destGroup = byGroup.get(primaryComcastOwner.id);
      if (!sourceGroup || !destGroup) continue;

      const sourceByUser = sourceGroup.byUser as Map<string, number>;
      const destByUser = destGroup.byUser as Map<string, number>;

      // Debit source group.
      const sourceUserSpend = sourceByUser.get(userId) ?? 0;
      const newSourceSpend = Math.max(0, sourceUserSpend - comcastSpend);
      (sourceGroup as { spendUsd: number }).spendUsd = Math.max(
        0,
        sourceGroup.spendUsd - comcastSpend,
      );
      if (newSourceSpend <= 0) {
        sourceByUser.delete(userId);
        (sourceGroup as { memberCount: number }).memberCount = Math.max(
          0,
          sourceGroup.memberCount - 1,
        );
      } else {
        sourceByUser.set(userId, newSourceSpend);
      }

      // Credit destination group.
      const destUserSpend = destByUser.get(userId) ?? 0;
      if (destUserSpend === 0) {
        (destGroup as { memberCount: number }).memberCount += 1;
      }
      destByUser.set(userId, destUserSpend + comcastSpend);
      (destGroup as { spendUsd: number }).spendUsd += comcastSpend;
    }
  }

  return {
    byGroup,
    byUser,
    ungroupedByWorkspace,
    crossWorkspaceAttributedUsersByGroup,
    totalSpendUsd,
    totalMemberCount,
    pendingCount,
    isComplete: pendingCount === 0,
  };
}

/**
 * The canonical range-scoped accounting result used by every headline, budget,
 * trend, and alert surface. Project usage and the account total are
 * reconciliation metadata only: they never replace or alter the member-deduped
 * rollup that drives group/team spend.
 */
export interface CanonicalUsageResult extends DedupedUsageRollup {
  rangeKey: string;
  mergePlan: CanonicalGroupMergePlan;
  displayGroups: readonly EnterpriseGroup[];
  spendByPrimaryGroup: ReadonlyMap<string, number>;
  byTeam: ReadonlyMap<string, number>;
  accountUsage: AccountUsage | null;
  accountReconciliationSpendUsd: number | null;
  projectAttribution: ProjectAttribution | null;
  aiSpendByUser: ReadonlyMap<string, number>;
  nonAiSpendByUser: ReadonlyMap<string, number>;
  aiSpendByGroup: ReadonlyMap<string, ReadonlyMap<string, number>>;
  nonAiSpendByGroup: ReadonlyMap<string, ReadonlyMap<string, number>>;
  authoritativeSpendByGroup: ReadonlyMap<string, ReadonlyMap<string, number>>;
  authoritativeSpendComplete: boolean;
  authoritativePendingCount: number;
  residualSpendByGroup: ReadonlyMap<string, number>;
  residualSpendUsd: number;
  creatorAttributionRequired: boolean;
}

export interface CanonicalGroupMergePlan {
  mergeMap: Map<string, string[]>;
  hiddenGroupIds: Set<string>;
  primaryByGroupId: Map<string, string>;
}

export interface CanonicalMergedGroupBudget {
  amountUsd: number;
  sourceGroupId: string;
}

/**
 * Resolve one displayed primary's budget across its migration aliases.
 * A budget stored directly on the displayed primary always wins. Otherwise the
 * first alias by stable ID supplies the budget, so restarts and directory order
 * cannot change the effective pool.
 */
export function resolveCanonicalMergedGroupBudget(
  primaryGroupId: string,
  mergePlan: CanonicalGroupMergePlan,
  budgetByGroupId: ReadonlyMap<string, number>,
): CanonicalMergedGroupBudget | null {
  const primaryAmount = budgetByGroupId.get(primaryGroupId);
  if (primaryAmount != null) {
    return { amountUsd: primaryAmount, sourceGroupId: primaryGroupId };
  }
  const aliasId = (mergePlan.mergeMap.get(primaryGroupId) ?? [])
    .filter((id) => id !== primaryGroupId && budgetByGroupId.has(id))
    .sort()[0];
  if (!aliasId) return null;
  return { amountUsd: budgetByGroupId.get(aliasId)!, sourceGroupId: aliasId };
}

/** Shared migration policy for same-name groups duplicated across workspaces. */
export function buildCanonicalGroupMergePlan(
  groups: readonly EnterpriseGroup[],
  workspaces: ReadonlyMap<string, Pick<EnterpriseWorkspace, "name">>,
): CanonicalGroupMergePlan {
  const byName = new Map<string, EnterpriseGroup[]>();
  for (const group of groups) {
    const key = group.name.trim().toLowerCase();
    const matches = byName.get(key) ?? [];
    matches.push(group);
    byName.set(key, matches);
  }
  const mergeMap = new Map<string, string[]>();
  const hiddenGroupIds = new Set<string>();
  const primaryByGroupId = new Map<string, string>();
  for (const matches of byName.values()) {
    const body = matches[0]!.name
      .replace(/^az-replit\s*[-–]\s*/i, "")
      .toLowerCase()
      .trim();
    const matched = matches.find((group) => {
      const workspaceName = (workspaces.get(group.workspaceId)?.name ?? "").trim().toLowerCase();
      const firstToken = workspaceName.split(/[-\s]+/)[0] ?? "";
      return firstToken.length >= 2 && body.startsWith(firstToken);
    });
    const primary = matched ?? matches.slice().sort((a, b) => {
      const aName = workspaces.get(a.workspaceId)?.name ?? "";
      const bName = workspaces.get(b.workspaceId)?.name ?? "";
      return aName.localeCompare(bName) || a.id.localeCompare(b.id);
    })[0]!;
    const sourceIds = matches.map((group) => group.id);
    mergeMap.set(primary.id, sourceIds);
    for (const group of matches) {
      primaryByGroupId.set(group.id, primary.id);
      if (group.id !== primary.id) hiddenGroupIds.add(group.id);
    }
  }
  return { mergeMap, hiddenGroupIds, primaryByGroupId };
}

export function getCanonicalUsage(
  groups: EnterpriseGroup[],
  rangeKey: string,
  workspaceIds?: ReadonlySet<string>,
  groupMembers?: ReadonlyMap<string, readonly string[]>,
  directoryMembers?: ReadonlyMap<string, EnterpriseMember>,
  ...options: [
    teamByGroupName: ReadonlyMap<string, string> | undefined,
    workspaces: ReadonlyMap<string, EnterpriseWorkspace>,
    includeAccountMetadata?: boolean,
    requireGroupMemberUsage?: boolean,
    requiredDetailGroupIds?: ReadonlySet<string>,
  ]
): CanonicalUsageResult {
  const [
    teamByGroupName,
    workspaces,
    includeAccountMetadata = false,
    requireGroupMemberUsage = false,
    requiredDetailGroupIds,
  ] = options;
  const materializedMonths = bypassCanonicalMonthlyRead
    ? null
    : (directoryCache ? canonicalMonthsForRange(rangeKey, directoryCache) : null);
  const materializedRollup =
    materializedMonths &&
    directoryCache &&
    !requiredDetailGroupIds &&
    isFullDirectoryCanonicalScope(groups, workspaceIds, directoryCache)
      ? aggregateMaterializedCanonicalRollups(materializedMonths, groups)
      : null;
  const rollup = materializedRollup ?? getDedupedUsageRollup(
      groups,
      rangeKey,
      workspaceIds,
      groupMembers,
      directoryMembers,
      workspaces,
    );
  // Preserve the authoritative workspace-derived per-user allocation before
  // canonical AI/non-AI attribution replaces rollup.byGroup.byUser below.
  // Total-spend-only surfaces can render this even when the optional breakdown
  // inputs are still syncing or have reached a terminal partial state.
  const authoritativeSpendByGroup = new Map(
    [...rollup.byGroup].map(([groupId, usage]) => [
      groupId,
      new Map(usage.byUser),
    ]),
  );
  const projectAttribution = getProjectAttribution(
    rangeKey,
    groups,
    workspaces,
    groupMembers,
  );
  if (materializedMonths && materializedRollup) {
    const rows = materializedMonths.flatMap((monthStart) =>
      canonicalMonthlyRows.get(monthStart) ?? []
    );
    const aiSpendByUser = new Map<string, number>();
    const nonAiSpendByUser = new Map<string, number>();
    const aiSpendByGroup = new Map<string, Map<string, number>>();
    const nonAiSpendByGroup = new Map<string, Map<string, number>>();
    const authoritativeSpendByGroup = new Map<string, Map<string, number>>();
    const residualSpendByGroup = new Map<string, number>();
    for (const group of groups) {
      aiSpendByGroup.set(group.id, new Map());
      nonAiSpendByGroup.set(group.id, new Map());
      authoritativeSpendByGroup.set(group.id, new Map());
      residualSpendByGroup.set(group.id, 0);
    }
    for (const row of rows) {
      if (row.userKey === CANONICAL_RESIDUAL_USER_KEY) {
        if (residualSpendByGroup.has(row.groupId)) {
          residualSpendByGroup.set(
            row.groupId,
            (residualSpendByGroup.get(row.groupId) ?? 0) + row.residualSpendUsd,
          );
        }
        continue;
      }
      if (!aiSpendByGroup.has(row.groupId)) continue;
      const groupAi = aiSpendByGroup.get(row.groupId)!;
      const groupNonAi = nonAiSpendByGroup.get(row.groupId)!;
      const groupAuthoritative = authoritativeSpendByGroup.get(row.groupId)!;
      groupAi.set(
        row.userKey,
        (groupAi.get(row.userKey) ?? 0) + row.aiSpendUsd,
      );
      groupNonAi.set(
        row.userKey,
        (groupNonAi.get(row.userKey) ?? 0) + row.nonAiSpendUsd,
      );
      groupAuthoritative.set(
        row.userKey,
        (groupAuthoritative.get(row.userKey) ?? 0) + row.authoritativeSpendUsd,
      );
      aiSpendByUser.set(
        row.userKey,
        (aiSpendByUser.get(row.userKey) ?? 0) + row.aiSpendUsd,
      );
      nonAiSpendByUser.set(
        row.userKey,
        (nonAiSpendByUser.get(row.userKey) ?? 0) + row.nonAiSpendUsd,
      );
    }
    const mergePlan = buildCanonicalGroupMergePlan(groups, workspaces);
    const displayGroups = groups.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
    const spendByPrimaryGroup = new Map<string, number>();
    for (const group of displayGroups) {
      spendByPrimaryGroup.set(
        group.id,
        (mergePlan.mergeMap.get(group.id) ?? [group.id]).reduce(
          (sum, id) => sum + (materializedRollup.byGroup.get(id)?.spendUsd ?? 0),
          0,
        ),
      );
    }
    const byTeam = new Map<string, number>();
    for (const group of displayGroups) {
      const teamName = teamByGroupName?.get(group.name);
      if (teamName) {
        byTeam.set(
          teamName,
          (byTeam.get(teamName) ?? 0) + (spendByPrimaryGroup.get(group.id) ?? 0),
        );
      }
    }
    const accountUsage = includeAccountMetadata ? (getAccountUsage(rangeKey) ?? null) : null;
    const residualSpendUsd = [...residualSpendByGroup.values()]
      .reduce((sum, value) => sum + value, 0) +
      [...materializedRollup.ungroupedByWorkspace.values()]
        .reduce((sum, value) => sum + value.spendUsd, 0);
    return {
      ...materializedRollup,
      rangeKey,
      mergePlan,
      displayGroups,
      spendByPrimaryGroup,
      byTeam,
      accountUsage,
      accountReconciliationSpendUsd: accountUsage
        ? accountUsage.totalCostUsd - materializedRollup.totalSpendUsd
        : null,
      projectAttribution,
      aiSpendByUser,
      nonAiSpendByUser,
      aiSpendByGroup,
      nonAiSpendByGroup,
      authoritativeSpendByGroup,
      authoritativeSpendComplete: true,
      authoritativePendingCount: 0,
      residualSpendByGroup,
      residualSpendUsd,
      creatorAttributionRequired: residualSpendUsd > 1e-9,
    };
  }

  // Member-grouped usage is the canonical AI observation. Deduplicate a
  // user/workspace across overlapping groups, then add only creator-attributed
  // project non-AI. Group/account totals remain the authoritative workspace
  // rollup above; any genuine gap is retained as residual instead of changing it.
  const orderedGroups = [...groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const aiSpendByUser = new Map<string, number>();
  const nonAiSpendByUser = new Map<string, number>();
  const aiSpendByGroup = new Map<string, Map<string, number>>();
  const nonAiSpendByGroup = new Map<string, Map<string, number>>();
  const attributedByGroup = new Map<string, Map<string, number>>();
  const attributedTotalByGroup = new Map<string, number>();
  const canonicalGroupsByWorkspace = new Map<string, EnterpriseGroup[]>();
  const canonicalMemberIdsByGroup = new Map<string, ReadonlySet<string>>();
  for (const group of orderedGroups) {
    attributedByGroup.set(group.id, new Map());
    aiSpendByGroup.set(group.id, new Map());
    nonAiSpendByGroup.set(group.id, new Map());
    attributedTotalByGroup.set(group.id, 0);
    const workspaceGroups = canonicalGroupsByWorkspace.get(group.workspaceId) ?? [];
    workspaceGroups.push(group);
    canonicalGroupsByWorkspace.set(group.workspaceId, workspaceGroups);
    canonicalMemberIdsByGroup.set(group.id, new Set(groupMembers?.get(group.id) ?? []));
  }
  const canonicalOwnerByWorkspaceUser =
    new Map<string, Map<string, EnterpriseGroup>>();
  const canonicalMembersByWorkspace = new Map<string, Set<string>>();
  for (const [workspaceId, workspaceGroups] of canonicalGroupsByWorkspace) {
    const owners = new Map<string, EnterpriseGroup>();
    const members = new Set<string>();
    for (const group of workspaceGroups) {
      for (const userId of rollup.byGroup.get(group.id)?.byUser.keys() ?? []) {
        if (!owners.has(userId)) owners.set(userId, group);
      }
    }
    for (const group of workspaceGroups) {
      for (const userId of canonicalMemberIdsByGroup.get(group.id) ?? []) {
        members.add(userId);
        if (!owners.has(userId)) owners.set(userId, group);
      }
    }
    canonicalOwnerByWorkspaceUser.set(workspaceId, owners);
    canonicalMembersByWorkspace.set(workspaceId, members);
  }
  const remainingGroupCapacity = (groupId: string): number => {
    const groupTotal = rollup.byGroup.get(groupId)?.spendUsd ?? 0;
    const attributed = attributedTotalByGroup.get(groupId) ?? 0;
    return Math.max(0, groupTotal - attributed);
  };
  for (const [workspaceId, workspaceGroups] of canonicalGroupsByWorkspace) {
    const users = new Set<string>();
    for (const group of workspaceGroups) {
      for (const userId of getMemberUsage(group.id, rangeKey)?.byUser.keys() ?? []) users.add(userId);
      // Also include users attributed via rollup re-homing or workspace-admin
      // fallback: they may not appear in any group's member-usage API.
      for (const userId of rollup.byGroup.get(group.id)?.byUser.keys() ?? []) users.add(userId);
    }
    for (const userId of users) {
      // Prefer the rollup's ownership over groupMembers: the rollup already
      // incorporates Comcast spend re-homing and workspace-admin attribution,
      // so its byUser map is the authoritative record of which group owns
      // each user for this range. Fall back to groupMembers only when the
      // rollup has no entry (e.g. member with $0 spend not yet cached).
      const owner = canonicalOwnerByWorkspaceUser.get(workspaceId)?.get(userId);
      if (!owner) continue;
      // Observed AI spend comes from per-group member-usage APIs.
      // Exception: users attributed via the workspace-admin fallback are absent
      // from all group member-usage APIs (they are not formal group members),
      // so their spend would be silently zeroed out and classified as residual.
      // For these users only — those absent from every group's groupMembers —
      // fall back to the rollup's per-user total (workspace spend from
      // wsSpendCache). Regular members with $0 AI spend intentionally stay
      // as residual; the inGroupMembers guard preserves that invariant.
      const inGroupMembers = canonicalMembersByWorkspace.get(workspaceId)?.has(userId) ?? false;
      const observedAiSpendUsd = (() => {
        const fromApi = workspaceGroups.reduce(
          (max, group) => Math.max(max, getMemberUsage(group.id, rangeKey)?.byUser.get(userId) ?? 0),
          0,
        );
        if (rollup.crossWorkspaceAttributedUsersByGroup?.get(owner.id)?.has(userId)) {
          return Math.max(
            fromApi,
            rollup.byGroup.get(owner.id)?.byUser.get(userId) ?? 0,
          );
        }
        if (fromApi > 0) return fromApi;
        // Only fall back to rollup spend for non-members (workspace-admin path).
        if (inGroupMembers) return 0;
        return rollup.byGroup.get(owner.id)?.byUser.get(userId) ?? 0;
      })();
      // A member table must never exceed its authoritative group rollup. This
      // is an allocation guard (not residual clamping): any observation which
      // cannot fit remains an explicit residual.
      const aiSpendUsd = Math.min(observedAiSpendUsd, remainingGroupCapacity(owner.id));
      aiSpendByUser.set(userId, (aiSpendByUser.get(userId) ?? 0) + aiSpendUsd);
      attributedByGroup.get(owner.id)!.set(userId, aiSpendUsd);
      attributedTotalByGroup.set(
        owner.id,
        (attributedTotalByGroup.get(owner.id) ?? 0) + aiSpendUsd,
      );
      aiSpendByGroup.get(owner.id)!.set(userId, aiSpendUsd);
    }
  }
  for (const [winnerGroupId, nonAiByUser] of projectAttribution.creatorNonAiSpendByGroup) {
    const winnerGroup = orderedGroups.find((group) => group.id === winnerGroupId);
    if (!winnerGroup) continue;
    const workspaceGroups = canonicalGroupsByWorkspace.get(winnerGroup.workspaceId) ?? [];
    for (const [userId, nonAiSpendUsd] of nonAiByUser) {
      // Project deduplication selects the highest-total winning observation,
      // but per-user ownership follows the same stable member owner as AI.
      // Otherwise an overlapping creator can be counted in both their stable
      // owner group and the winning project's group.
      // Mirror the AI-loop ownership rule: prefer the rollup's byUser (which
      // already encodes Comcast re-homing and workspace-admin attribution) over
      // groupMembers, so re-homed users' non-AI spend lands in the destination
      // group rather than the (now zero-capacity) source group.
      const owner = canonicalOwnerByWorkspaceUser
        .get(winnerGroup.workspaceId)?.get(userId);
      if (!owner) continue;
      const groupByUser = attributedByGroup.get(owner.id)!;
      const attributedNonAiSpendUsd = Math.min(
        nonAiSpendUsd,
        remainingGroupCapacity(owner.id),
      );
      nonAiSpendByUser.set(
        userId,
        (nonAiSpendByUser.get(userId) ?? 0) + attributedNonAiSpendUsd,
      );
      groupByUser.set(
        userId,
        (groupByUser.get(userId) ?? 0) + attributedNonAiSpendUsd,
      );
      attributedTotalByGroup.set(
        owner.id,
        (attributedTotalByGroup.get(owner.id) ?? 0) + attributedNonAiSpendUsd,
      );
      const nonAiGroupByUser = nonAiSpendByGroup.get(owner.id)!;
      nonAiGroupByUser.set(
        userId,
        (nonAiGroupByUser.get(userId) ?? 0) + attributedNonAiSpendUsd,
      );
    }
  }
  const canonicalByUser = new Map<string, number>();
  const residualSpendByGroup = new Map<string, number>();
  for (const group of orderedGroups) {
    const groupByUser = attributedByGroup.get(group.id)!;
    const groupTotal = rollup.byGroup.get(group.id)?.spendUsd ?? 0;
    let userTotal = 0;
    for (const [userId, spendUsd] of groupByUser) {
      userTotal += spendUsd;
      canonicalByUser.set(userId, (canonicalByUser.get(userId) ?? 0) + spendUsd);
    }
    const residualSpendUsd = groupTotal - userTotal;
    if (residualSpendUsd < -1e-9) {
      throw new Error(`Canonical attribution exceeded authoritative total for group ${group.id}`);
    }
    residualSpendByGroup.set(group.id, Math.max(0, residualSpendUsd));
    const rollupGroup = rollup.byGroup.get(group.id);
    if (rollupGroup) {
      (rollupGroup as { byUser: ReadonlyMap<string, number> }).byUser = groupByUser;
    }
  }
  rollup.byUser = canonicalByUser;
  const residualSpendUsd = [...residualSpendByGroup.values()].reduce((sum, value) => sum + value, 0) +
    [...rollup.ungroupedByWorkspace.values()].reduce((sum, value) => sum + value.spendUsd, 0);
  const aiSpendUsd = [...aiSpendByUser.values()].reduce((sum, value) => sum + value, 0);
  const knownUngroupedResidualUsd = [...rollup.ungroupedByWorkspace.values()]
    .reduce((sum, value) => sum + value.spendUsd, 0);
  const loadedProjectNonAiSpendUsd = [...projectAttribution.nonAiSpendByProject.values()]
    .reduce((sum, value) => sum + value, 0);
  // Project inputs are required only when the authoritative totals contain a
  // non-AI gap (or loaded project rows explicitly contain non-AI). This lets a
  // fully-known AI-only range complete while project synchronization is cold,
  // without declaring a range complete when hosting still needs a creator.
  const detailRollupSpendUsd = requiredDetailGroupIds
    ? groups
        .filter((group) => requiredDetailGroupIds.has(group.id))
        .reduce((sum, group) => sum + (rollup.byGroup.get(group.id)?.spendUsd ?? 0), 0)
    : rollup.totalSpendUsd - knownUngroupedResidualUsd;
  const detailAiSpendUsd = requiredDetailGroupIds
    ? groups
        .filter((group) => requiredDetailGroupIds.has(group.id))
        .reduce(
          (sum, group) =>
            sum + [...(aiSpendByGroup.get(group.id)?.values() ?? [])]
              .reduce((groupSum, value) => groupSum + value, 0),
          0,
        )
    : aiSpendUsd;
  const detailLoadedProjectNonAiSpendUsd = requiredDetailGroupIds
    ? groups
        .filter((group) => requiredDetailGroupIds.has(group.id))
        .reduce(
          (sum, group) =>
            sum + [...(nonAiSpendByGroup.get(group.id)?.values() ?? [])]
              .reduce((groupSum, value) => groupSum + value, 0),
          0,
        )
    : loadedProjectNonAiSpendUsd;
  const creatorAttributionRequired =
    detailLoadedProjectNonAiSpendUsd > 1e-9 ||
    detailRollupSpendUsd - detailAiSpendUsd > 1e-9;
  const mergePlan = buildCanonicalGroupMergePlan(groups, workspaces);
  const displayGroups = groups.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
  const spendByPrimaryGroup = new Map<string, number>();
  for (const group of displayGroups) {
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
    spendByPrimaryGroup.set(
      group.id,
      sourceIds.reduce((sum, id) => sum + (rollup.byGroup.get(id)?.spendUsd ?? 0), 0),
    );
  }
  const byTeam = new Map<string, number>();
  if (teamByGroupName) {
    for (const group of displayGroups) {
      const teamName = teamByGroupName.get(group.name);
      if (!teamName) continue;
      byTeam.set(
        teamName,
        (byTeam.get(teamName) ?? 0) + (spendByPrimaryGroup.get(group.id) ?? 0),
      );
    }
  }
  const accountUsage = includeAccountMetadata ? (getAccountUsage(rangeKey) ?? null) : null;
  const requiredDetailGroups = requiredDetailGroupIds
    ? groups.filter((group) => requiredDetailGroupIds.has(group.id))
    : groups;
  const missingMemberUsageCount = requireGroupMemberUsage
    ? requiredDetailGroups.filter((group) => !getMemberUsage(group.id, rangeKey)).length
    : 0;
  const missingProjectUsageCount = requiredDetailGroupIds
    ? requiredDetailGroups.filter((group) => !getProjectUsage(group.id, rangeKey)).length
    : projectAttribution.pendingCount;
  const projectInputsComplete = requiredDetailGroupIds
    ? missingProjectUsageCount === 0
    : projectAttribution.isComplete;
  return {
    ...rollup,
    isComplete:
      rollup.isComplete &&
      missingMemberUsageCount === 0 &&
      (!creatorAttributionRequired || projectInputsComplete),
    pendingCount:
      rollup.pendingCount +
      missingMemberUsageCount +
      (creatorAttributionRequired ? missingProjectUsageCount : 0),
    rangeKey,
    mergePlan,
    displayGroups,
    spendByPrimaryGroup,
    byTeam,
    accountUsage,
    accountReconciliationSpendUsd: accountUsage
      ? accountUsage.totalCostUsd - rollup.totalSpendUsd
      : null,
    projectAttribution,
    aiSpendByUser,
    nonAiSpendByUser,
    aiSpendByGroup,
    nonAiSpendByGroup,
    authoritativeSpendByGroup,
    authoritativeSpendComplete: rollup.isComplete,
    authoritativePendingCount: rollup.pendingCount,
    residualSpendByGroup,
    residualSpendUsd,
    creatorAttributionRequired,
  };
}

export async function rebuildCanonicalMonthlyRollup(
  monthStart: string,
): Promise<boolean> {
  const existing = canonicalMonthRebuilds.get(monthStart);
  if (existing) return existing;
  const rebuild = (async () => {
    const dir = directoryCache ?? await getDirectory();
    const inputFingerprint = canonicalInputFingerprint(monthStart, dir);
    if (
      canonicalMonthlyRows.has(monthStart) &&
      canonicalMonthlyFingerprints.get(monthStart) === inputFingerprint
    ) return true;
    const { start: rawStart, end } = monthBounds(monthStart);
    const start = new Date(Math.max(rawStart.getTime(), SPEND_DATA_CUTOFF_MS));
    const rangeEnd = new Date(Math.min(
      end.getTime(),
      utcDayStart(Date.now()) + 86_400_000,
    ));
    if (rangeEnd <= start) return false;
    const range: UsageRange = {
      key: `canonical-month:${monthStart}`,
      label: monthStart,
      params: { startTime: start.toISOString(), endTime: rangeEnd.toISOString() },
    };
    resolvedUsageRanges.set(range.key, range);
    if (!materializeUsageRangeFromDailyFacts(range)) return false;
    bypassCanonicalMonthlyRead = true;
    let canonical: CanonicalUsageResult;
    try {
      canonical = getCanonicalUsage(
        dir.groups,
        range.key,
        new Set(dir.workspaces.keys()),
        dir.groupMembers,
        dir.members,
        undefined,
        dir.workspaces,
        false,
        true,
      );
    } finally {
      bypassCanonicalMonthlyRead = false;
    }
    if (!canonical.isComplete || !canonical.authoritativeSpendComplete) return false;

    const updatedAt = new Date();
    const rows: Array<typeof canonicalMonthlyGroupUserRollupsTable.$inferInsert> = [];
    for (const group of dir.groups) {
      const ai = canonical.aiSpendByGroup.get(group.id) ?? new Map();
      const nonAi = canonical.nonAiSpendByGroup.get(group.id) ?? new Map();
      const authoritative = canonical.authoritativeSpendByGroup.get(group.id) ?? new Map();
      // Keep users whose workspace-authoritative spend remains entirely
      // residual. Compatible detail/export reads still need their per-user
      // authoritative observation even when no AI/project amount was allocated.
      const userIds = new Set([
        ...authoritative.keys(),
        ...ai.keys(),
        ...nonAi.keys(),
      ]);
      for (const userKey of userIds) {
        rows.push({
          monthStart,
          groupId: group.id,
          workspaceId: group.workspaceId,
          userKey,
          aiSpendUsd: ai.get(userKey) ?? 0,
          nonAiSpendUsd: nonAi.get(userKey) ?? 0,
          residualSpendUsd: 0,
          authoritativeSpendUsd: authoritative.get(userKey) ?? 0,
          updatedAt,
        });
      }
      const residualSpendUsd = canonical.residualSpendByGroup.get(group.id) ?? 0;
      if (residualSpendUsd !== 0 || userIds.size === 0) {
        rows.push({
          monthStart,
          groupId: group.id,
          workspaceId: group.workspaceId,
          userKey: CANONICAL_RESIDUAL_USER_KEY,
          residualSpendUsd,
          authoritativeSpendUsd: 0,
          updatedAt,
        });
      }
    }
    for (const [workspaceId, ungrouped] of canonical.ungroupedByWorkspace) {
      rows.push({
        monthStart,
        groupId: `synthetic:no-group:${workspaceId}`,
        workspaceId,
        userKey: CANONICAL_RESIDUAL_USER_KEY,
        residualSpendUsd: ungrouped.spendUsd,
        authoritativeSpendUsd: ungrouped.spendUsd,
        updatedAt,
      });
    }
    const lockId = `canonical-monthly-rollup|${monthStart}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockId}))`);
      await tx.delete(canonicalMonthlyGroupUserRollupsTable)
        .where(eq(canonicalMonthlyGroupUserRollupsTable.monthStart, monthStart));
      if (rows.length > 0) await tx.insert(canonicalMonthlyGroupUserRollupsTable).values(rows);
      await tx.insert(canonicalMonthlyRollupStateTable).values({
        monthStart,
        rangeStart: start,
        rangeEnd,
        inputFingerprint,
        status: "success",
        completedAt: updatedAt,
      }).onConflictDoUpdate({
        target: canonicalMonthlyRollupStateTable.monthStart,
        set: {
          rangeStart: start,
          rangeEnd,
          inputFingerprint,
          status: "success",
          completedAt: updatedAt,
        },
      });
    });
    canonicalMonthlyRows.set(
      monthStart,
      rows.map((row) => ({
        monthStart: row.monthStart,
        groupId: row.groupId,
        workspaceId: row.workspaceId,
        userKey: row.userKey,
        aiSpendUsd: row.aiSpendUsd ?? 0,
        nonAiSpendUsd: row.nonAiSpendUsd ?? 0,
        residualSpendUsd: row.residualSpendUsd ?? 0,
        authoritativeSpendUsd: row.authoritativeSpendUsd ?? 0,
        updatedAt,
      })),
    );
    canonicalMonthlyFingerprints.set(monthStart, inputFingerprint);
    canonicalMonthlyBounds.set(monthStart, {
      start: start.getTime(),
      end: rangeEnd.getTime(),
    });
    return true;
  })().finally(() => {
    canonicalMonthRebuilds.delete(monthStart);
  });
  canonicalMonthRebuilds.set(monthStart, rebuild);
  return rebuild;
}
export function getDedupedMemberCounts(
  groups: EnterpriseGroup[],
  membersByGroup: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  return computeDedupedMemberCounts(groups, membersByGroup);
}

const INTERACTIVE_RESERVATION_RATIO = 0.2;

/**
 * Build a canonical-checker range solely from durable daily facts. The common
 * contiguous prefix prevents a partially refreshed scope from being evaluated
 * against newer data than its peers.
 */
export async function getStoredBudgetEvaluationSnapshot(): Promise<
  { snapshot: StoredBudgetEvaluationSnapshot; skipReason: null } |
  { snapshot: null; skipReason: string }
> {
  const dirRow = await db.query.apiDirectoryCacheTable.findFirst({
    where: eq(apiDirectoryCacheTable.id, "singleton"),
  });
  if (!dirRow) return { snapshot: null, skipReason: "Stored directory is unavailable" };

  let directory: DirectoryCache;
  try {
    directory = deserializeDirectory(dirRow.directoryJson as SerializedDirectory);
  } catch {
    return { snapshot: null, skipReason: "Stored directory is invalid" };
  }
  const billing = getBillingPeriod();
  if (!billing.start) return { snapshot: null, skipReason: "Billing period is unavailable" };
  const start = new Date(Math.max(new Date(billing.start).getTime(), SPEND_DATA_CUTOFF_MS));
  if (!Number.isFinite(start.getTime())) {
    return { snapshot: null, skipReason: "Billing period start is invalid" };
  }
  const requestedEnd = new Date(utcDayStart(Date.now()) + 86_400_000);
  const facts = await db.select().from(usageDailyFactsTable).where(and(
    inArray(usageDailyFactsTable.mode, ["group_member", "workspace_member", "group_project"]),
    gte(usageDailyFactsTable.usageDate, start.toISOString().slice(0, 10)),
    lt(usageDailyFactsTable.usageDate, requestedEnd.toISOString().slice(0, 10)),
  ));

  const requiredScopes = [
    ...directory.groups.map((group) => `group_member|${group.id}`),
    ...directory.groups.map((group) => `group_project|${group.id}`),
    ...[...directory.workspaces.keys()].map((workspaceId) => `workspace_member|${workspaceId}`),
  ];
  const requiredScopeSet = new Set(requiredScopes);
  if (requiredScopes.length === 0) {
    return { snapshot: null, skipReason: "No stored usage scopes are configured" };
  }
  const datesByScope = new Map<string, Set<string>>();
  for (const fact of facts) {
    const scope = `${fact.mode}|${fact.scopeKey}`;
    if (!requiredScopeSet.has(scope)) continue;
    const dates = datesByScope.get(scope) ?? new Set<string>();
    dates.add(fact.usageDate);
    datesByScope.set(scope, dates);
  }

  let commonEnd = requestedEnd.getTime();
  for (const scope of requiredScopes) {
    const dates = datesByScope.get(scope);
    if (!dates) return { snapshot: null, skipReason: `Stored usage is missing for ${scope}` };
    let cursor = utcDayStart(start.getTime());
    while (dates.has(new Date(cursor).toISOString().slice(0, 10))) cursor += 86_400_000;
    commonEnd = Math.min(commonEnd, cursor);
  }
  if (commonEnd <= start.getTime()) {
    return { snapshot: null, skipReason: "Stored usage has no complete billing-period day" };
  }

  const dataAsOf = new Date(commonEnd);
  const rangeKey = `budget-check:${start.toISOString()}:${dataAsOf.toISOString()}`;
  const rows: UsageSyncChunk[] = facts
    .filter((fact) => {
      const day = new Date(`${fact.usageDate}T00:00:00.000Z`).getTime();
      return requiredScopeSet.has(`${fact.mode}|${fact.scopeKey}`) &&
        day >= start.getTime() && day < commonEnd;
    })
    .map((fact) => {
      const chunkStart = new Date(`${fact.usageDate}T00:00:00.000Z`);
      return {
        mode: fact.mode,
        rangeKey,
        scopeKey: fact.scopeKey,
        chunkStart,
        chunkEnd: new Date(chunkStart.getTime() + 86_400_000),
        payloadJson: fact.payloadJson,
        completedAt: fact.fetchedAt,
      };
    });
  hydrateDurableUsage(rows);
  return { snapshot: { directory, rangeKey, dataAsOf }, skipReason: null };
}

type EnterpriseFetch = typeof fetch;

const activeQueueTasks = new Map<EnterpriseWorkload, QueueTask & { startedAt: number }>();

const DEFAULT_WINDOW_MS = 60_000;

function nextFixedMinute(now = Date.now()): number {
  return (Math.floor(now / DEFAULT_WINDOW_MS) + 1) * DEFAULT_WINDOW_MS;
}

function rateHeader(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw !== null && raw.trim() !== "") {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return null;
}

function workloadForPriority(priority: number): EnterpriseWorkload {
  if (priority <= 0) return "interactive";
  if (priority === 1) return "scheduled";
  return "backfill";
}

function resetTimestamp(value: number, now: number): number {
  if (value > 10_000_000_000) return value;
  if (value > 1_000_000_000) return value * 1000;
  return now + value * 1000;
}

const workloadContext = new AsyncLocalStorage<EnterpriseWorkload>();

const SCHEDULED_CAP_RATIO = 0.55;
const DEFAULT_RATE_LIMIT = 100;
const BACKFILL_CAP_RATIO = 0.25;
const LOCAL_USAGE_REQUESTS_PER_MINUTE = 170;

type RateBudgetSnapshot = {
  limit: number;
  remaining: number;
  resetAt: number;
  observed: boolean;
};

class EnterpriseRateBudget {
  private state: RateBudgetSnapshot = {
    limit: DEFAULT_RATE_LIMIT,
    remaining: DEFAULT_RATE_LIMIT,
    resetAt: Date.now() + DEFAULT_WINDOW_MS,
    observed: false,
  };

  private used: Record<EnterpriseWorkload, number> = {
    interactive: 0,
    scheduled: 0,
    backfill: 0,
  };
  private localWindowResetAt = nextFixedMinute();
  private localTotalUsed = 0;
  private localUsageUsed = 0;
  private embargoUntil = 0;

  private waiters = new Set<() => void>();

  private rollWindow(now: number): void {
    if (now >= this.localWindowResetAt) {
      this.localWindowResetAt = nextFixedMinute(now);
      this.localTotalUsed = 0;
      this.localUsageUsed = 0;
      this.used = { interactive: 0, scheduled: 0, backfill: 0 };
    }
    if (now >= this.state.resetAt && this.state.remaining <= 0) {
      this.state.remaining = this.state.limit;
      this.state.resetAt = now + DEFAULT_WINDOW_MS;
    }
  }

  private canAdmit(isUsage: boolean): boolean {
    if (Date.now() < this.embargoUntil) return false;
    if (this.state.remaining <= 0) return false;
    if (this.localTotalUsed >= 600) return false;
    // Keep deliberate headroom below the documented 200/min /usage ceiling.
    return !isUsage || this.localUsageUsed < LOCAL_USAGE_REQUESTS_PER_MINUTE;
  }

  async admit(workload: EnterpriseWorkload, isUsage = false): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.rollWindow(now);
      if (this.canAdmit(isUsage)) {
        // Reserve before issuing the request. A later response may lower this
        // estimate further, but concurrent workers can never spend one token twice.
        this.state.remaining -= 1;
        this.used[workload] += 1;
        this.localTotalUsed += 1;
        if (isUsage) this.localUsageUsed += 1;
        return;
      }
      const embargoed = now < this.embargoUntil;
      const upstreamBlocked = this.state.remaining <= 0;
      const delay = Math.max(
        1,
        (
          embargoed
            ? this.embargoUntil
            : upstreamBlocked
              ? this.state.resetAt
              : this.localWindowResetAt
        ) - now,
      );
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, delay);
        this.waiters.add(wake);
      });
    }
  }

  observe(headers: Headers, status: number): void {
    const now = Date.now();
    this.rollWindow(now);
    const limit = rateHeader(headers, [
      "X-RateLimit-Limit",
      "RateLimit-Limit",
    ]);
    const remaining = rateHeader(headers, [
      "X-RateLimit-Remaining",
      "RateLimit-Remaining",
    ]);
    const reset = rateHeader(headers, [
      "X-RateLimit-Reset",
      "RateLimit-Reset",
    ]);
    const retryAfter = rateHeader(headers, ["Retry-After"]);
    if (limit !== null) this.state.limit = Math.max(1, Math.floor(limit));
    if (remaining !== null) {
      this.state.remaining = Math.floor(remaining);
    }
    if (reset !== null) {
      const reportedResetAt = Math.max(now + 1, resetTimestamp(reset, now));
      this.state.resetAt = Math.max(reportedResetAt, this.embargoUntil);
    }
    if (status === 429) {
      this.state.remaining = 0;
      this.embargoUntil = Math.max(
        this.embargoUntil,
        now + Math.max(1000, (retryAfter ?? 5) * 1000),
      );
      this.state.resetAt = Math.max(this.state.resetAt, this.embargoUntil);
    }
    this.state.observed ||=
      limit !== null || remaining !== null || reset !== null || retryAfter !== null || status === 429;
    for (const wake of [...this.waiters]) wake();
  }

  snapshot(): RateBudgetSnapshot & { used: Record<EnterpriseWorkload, number> } {
    this.rollWindow(Date.now());
    return { ...this.state, used: { ...this.used } };
  }

  resetForTests(snapshot?: Partial<RateBudgetSnapshot>): void {
    this.state = {
      limit: snapshot?.limit ?? DEFAULT_RATE_LIMIT,
      remaining: snapshot?.remaining ?? snapshot?.limit ?? DEFAULT_RATE_LIMIT,
      resetAt: snapshot?.resetAt ?? Date.now() + DEFAULT_WINDOW_MS,
      observed: snapshot?.observed ?? false,
    };
    this.used = { interactive: 0, scheduled: 0, backfill: 0 };
    this.localWindowResetAt = nextFixedMinute();
    this.localTotalUsed = 0;
    this.localUsageUsed = 0;
    this.embargoUntil = 0;
    for (const wake of [...this.waiters]) wake();
  }
}

const enterpriseBudget = new EnterpriseRateBudget();

function isFullDirectoryCanonicalScope(
  groups: readonly EnterpriseGroup[],
  workspaceIds: ReadonlySet<string> | undefined,
  dir: DirectoryCache,
): boolean {
  if (groups.length !== dir.groups.length) return false;
  const groupIds = new Set(groups.map((group) => group.id));
  if (dir.groups.some((group) => !groupIds.has(group.id))) return false;
  if (!workspaceIds || workspaceIds.size !== dir.workspaces.size) return false;
  return [...dir.workspaces.keys()].every((id) => workspaceIds.has(id));
}

function refreshDirectory(scheduleCanonical = true): Promise<DirectoryCache> {
  if (directoryPromise) return directoryPromise;
  const workload = workloadContext.getStore() ?? "interactive";
  directoryPromise = workloadContext.run(workload, async () => {
    try {
      const workspaces = await paginate<EnterpriseWorkspace>("/workspaces", {});
      const wsMap = new Map(workspaces.map((w) => [w.id, w]));

      const allGroups: EnterpriseGroup[] = [];
      for (const ws of workspaces) {
        const wsGroups = await paginate<EnterpriseGroup>("/groups", { workspaceId: ws.id });
        for (const g of wsGroups) allGroups.push({ ...g, workspaceId: g.workspaceId || ws.id });
      }
      const groups = allGroups.filter(isCustomGroup);

      const groupMembers = new Map<string, string[]>();
      for (const g of groups) {
        const users = await paginate<{ userId: string }>(
          `/groups/${encodeURIComponent(g.id)}/users`,
          {},
        );
        groupMembers.set(g.id, users.map((u) => u.userId));
      }

      const rawMembers = await paginate<RawMember>("/members", {});
      const members = new Map<string, EnterpriseMember>();
      for (const rm of rawMembers) {
        const name = [rm.user.firstName, rm.user.lastName].filter(Boolean).join(" ") || null;
        members.set(rm.user.id, {
          userId: rm.user.id,
          username: rm.user.username,
          email: rm.user.email,
          name,
          isAccountAdmin: parseIsAccountAdmin(rm),
          workspaces: new Map(
            rm.workspaces.map((w) => [w.id, { role: w.role, isDisabled: w.isDisabled }]),
          ),
        });
      }

      const budgets: PlatformBudgets = {
        groupLimits: new Map(),
        userLimits: new Map(),
        workspaceDefaults: new Map(),
      };
      const rawBudgets = await paginate<RawBudget>("/budgets", {});
      for (const b of rawBudgets) {
        if (!b.workspaceId || b.amountUsd == null) continue;
        if (b.type === "workspace_group_limit" && b.groupId) {
          if (!budgets.groupLimits.has(b.workspaceId)) budgets.groupLimits.set(b.workspaceId, new Map());
          budgets.groupLimits.get(b.workspaceId)!.set(b.groupId, b.amountUsd);
        } else if (b.type === "workspace_user_limit" && b.userId) {
          if (!budgets.userLimits.has(b.workspaceId)) budgets.userLimits.set(b.workspaceId, new Map());
          budgets.userLimits.get(b.workspaceId)!.set(b.userId, b.amountUsd);
        } else if (b.type === "workspace_default_user_limit") {
          budgets.workspaceDefaults.set(b.workspaceId, b.amountUsd);
        }
      }

      directoryCache = {
        fetchedAt: Date.now(),
        workspaces: wsMap,
        groups,
        allGroups,
        groupMembers,
        members,
        budgets,
      };
      persistDirectoryToDb(directoryCache);
      if (scheduleCanonical) {
        for (const monthStart of canonicalCandidateMonths) {
          queueCanonicalMonthRebuild(monthStart);
        }
      }
      return directoryCache;
    } finally {
      directoryPromise = null;
    }
  });
  return directoryPromise;
}

/** Test-only transport seam. Production always uses the platform fetch. */
export function setEnterpriseFetchForTests(override: EnterpriseFetch | null): void {
  enterpriseFetch = override ?? platformEnterpriseFetch;
}

const platformEnterpriseFetch: EnterpriseFetch = (input, init) => fetch(input, init);
let enterpriseFetch: EnterpriseFetch = platformEnterpriseFetch;

export interface RotatingUsageItem {
  key: string;
  kind: "group_member" | "group_project" | "project_metadata";
  group?: EnterpriseGroup;
  workspaceId?: string;
}

export function startUsageCoordinator(): void {
  if (usageCoordinatorTimer) return;
  const run = () => void runUsageCoordinator().catch((err) => {
    logger.error({ err }, "Usage coordinator failed");
  });
  run();
  usageCoordinatorTimer = setInterval(run, USAGE_COORDINATOR_INTERVAL_MS);
  usageCoordinatorTimer.unref();
}

/**
 * One fixed-cadence planner owns all ordinary current-range ingestion. Workspace
 * member observations are always queued first; lower-priority group/project
 * scopes share a durable fair cursor and a bounded amount of scheduled work.
 */
export async function runUsageCoordinator(): Promise<boolean> {
  const result = await withJobClaim(
    "enterprise:usage-coordinator",
    USAGE_COORDINATOR_INTERVAL_MS,
    USAGE_COORDINATOR_LEASE_MS,
    async (claim) => {
      if (!isConfigured()) return;
      claim.signal?.throwIfAborted();
      // Stabilize the reporting anchor before planning any range-bound work.
      await refreshBillingPeriodMetadata(1);
      claim.signal?.throwIfAborted();
      const dir = await getDirectory(true);
      claim.signal?.throwIfAborted();
      const range = resolveRange("billing");
      queueAccountTotalVerification(-10);

      // Workspace-member observations establish the canonical current-month
      // view and deliberately enter the scheduled queue before every other
      // scope.
      for (const workspaceId of [...dir.workspaces.keys()].sort()) {
        claim.signal?.throwIfAborted();
        queueWsSpendFetch(workspaceId, range, 1, true);
      }
      queueAccountUsageFetch(range, 1, true);

      const items: RotatingUsageItem[] = [
        ...dir.groups.flatMap((group) => [
          { key: `member:${group.id}`, kind: "group_member" as const, group },
          { key: `project:${group.id}`, kind: "group_project" as const, group },
        ]),
        ...[...dir.workspaces.keys()].map((workspaceId) => ({
          key: `metadata:${workspaceId}`,
          kind: "project_metadata" as const,
          workspaceId,
        })),
      ];
      const rotation = selectRoundRobinUsageItems(
        items,
        claim.cursor,
        USAGE_COORDINATOR_ROTATING_BUDGET,
      );
      for (const item of rotation.selected) {
        claim.signal?.throwIfAborted();
        if (item.kind === "group_member") {
          queueMemberUsageFetch(item.group!, range, 1, true);
        } else if (item.kind === "group_project") {
          queueProjectUsageFetch(item.group!, range, 1, true);
        } else {
          queueProjectTitlesFetch(item.workspaceId!, 1, true);
        }
      }
      await updateJobClaimCursor(claim, rotation.cursor);
      claim.signal?.throwIfAborted();
    },
  );
  return result.acquired;
}

const USAGE_COORDINATOR_ROTATING_BUDGET = 8;

let usageCoordinatorTimer: NodeJS.Timeout | null = null;

/** Stable persisted round-robin selection; exported to keep fairness testable. */
export function selectRoundRobinUsageItems(
  items: readonly RotatingUsageItem[],
  previousCursor: string | null,
  limit: number,
): { selected: RotatingUsageItem[]; cursor: string | null } {
  if (items.length === 0 || limit <= 0) return { selected: [], cursor: previousCursor };
  const ordered = [...items].sort((a, b) => a.key.localeCompare(b.key));
  const previous = previousCursor
    ? ordered.findIndex((item) => item.key === previousCursor)
    : -1;
  const selected: RotatingUsageItem[] = [];
  const count = Math.min(Math.floor(limit), ordered.length);
  for (let offset = 1; offset <= count; offset++) {
    selected.push(ordered[(previous + offset) % ordered.length]!);
  }
  return { selected, cursor: selected.at(-1)?.key ?? previousCursor };
}

const USAGE_COORDINATOR_LEASE_MS = 4 * 60 * 1000;

function canonicalInputFingerprint(monthStart: string, dir: DirectoryCache): string {
  const parts: string[] = [];
  for (const workspace of [...dir.workspaces.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`w:${workspace.id}:${workspace.name}:${workspace.slug ?? ""}`);
  }
  for (const group of [...dir.groups].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`g:${group.id}:${group.workspaceId}:${group.name}:${group.type ?? ""}`);
    parts.push(`gm:${group.id}:${[...(dir.groupMembers.get(group.id) ?? [])].sort().join(",")}`);
  }
  for (const member of [...dir.members.values()].sort((a, b) => a.userId.localeCompare(b.userId))) {
    parts.push(`m:${member.userId}:${[...member.workspaces.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, value]) => `${id}:${value.role}:${value.isDisabled}`).join(",")}`);
  }
  const groupIds = new Set(dir.groups.map((group) => group.id));
  const workspaceIds = new Set(dir.workspaces.keys());
  for (const fact of [...dailyFactCache.values()].sort((a, b) =>
    `${a.mode}|${a.scopeKey}|${a.usageDate}`.localeCompare(`${b.mode}|${b.scopeKey}|${b.usageDate}`)
  )) {
    if (!fact.usageDate.startsWith(monthStart.slice(0, 7))) continue;
    if (
      (fact.mode.startsWith("group_") && !groupIds.has(fact.scopeKey)) ||
      (fact.mode === "workspace_member" && !workspaceIds.has(fact.scopeKey))
    ) continue;
    parts.push(`f:${fact.mode}:${fact.scopeKey}:${fact.usageDate}:${JSON.stringify(fact.payloadJson)}`);
  }
  for (const workspaceId of [...workspaceIds].sort()) {
    const projects = projectInfoCache.get(workspaceId);
    if (!projects) {
      parts.push(`p:${workspaceId}:missing`);
      continue;
    }
    for (const [projectId, info] of [...projects].sort(([a], [b]) => a.localeCompare(b))) {
      // Titles are presentation metadata; only creator identity affects attribution.
      parts.push(`p:${workspaceId}:${projectId}:${info.creatorId ?? ""}`);
    }
  }
  return stableFingerprint(parts);
}

function stableFingerprint(parts: Iterable<string>): string {
  // FNV-1a is used only to keep the durable identity compact; this is an input
  // change detector, not a security primitive.
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // Preserve part boundaries so ["ab", "c"] cannot hash as ["a", "bc"].
    hash ^= 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const canonicalMonthlyBounds = new Map<string, { start: number; end: number }>();

const canonicalMonthRebuilds = new Map<string, Promise<boolean>>();

const canonicalMonthlyFingerprints = new Map<string, string>();

function materializedCanonicalRollup(
  monthStart: string,
  groups: EnterpriseGroup[],
): DedupedUsageRollup | null {
  const rows = canonicalMonthlyRows.get(monthStart);
  if (!rows) return null;
  const groupIds = new Set(groups.map((group) => group.id));
  const byGroup = new Map<string, DedupedGroupRollup>(
    groups.map((group) => [
      group.id,
      { spendUsd: 0, memberCount: 0, byUser: new Map<string, number>() },
    ]),
  );
  const byUser = new Map<string, number>();
  const ungroupedByWorkspace = new Map<string, DedupedGroupRollup>();
  let totalSpendUsd = 0;
  let totalMemberCount = 0;
  for (const row of rows) {
    const isUngrouped = row.groupId.startsWith("synthetic:no-group:");
    if (!isUngrouped && !groupIds.has(row.groupId)) continue;
    const target = isUngrouped
      ? (ungroupedByWorkspace.get(row.workspaceId) ?? {
          spendUsd: 0,
          memberCount: 0,
          byUser: new Map<string, number>(),
        })
      : byGroup.get(row.groupId)!;
    if (isUngrouped) ungroupedByWorkspace.set(row.workspaceId, target);
    const spend = row.aiSpendUsd + row.nonAiSpendUsd;
    (target as { spendUsd: number }).spendUsd += spend + row.residualSpendUsd;
    totalSpendUsd += spend + row.residualSpendUsd;
    if (row.userKey !== CANONICAL_RESIDUAL_USER_KEY) {
      (target.byUser as Map<string, number>).set(row.userKey, spend);
      byUser.set(row.userKey, (byUser.get(row.userKey) ?? 0) + spend);
      (target as { memberCount: number }).memberCount += 1;
      totalMemberCount += 1;
    }
  }
  return {
    byGroup,
    byUser,
    ungroupedByWorkspace,
    totalSpendUsd,
    totalMemberCount,
    pendingCount: 0,
    isComplete: true,
  };
}

function aggregateMaterializedCanonicalRollups(
  months: readonly string[],
  groups: EnterpriseGroup[],
): DedupedUsageRollup | null {
  const aggregate = materializedCanonicalRollup(months[0]!, groups);
  if (!aggregate) return null;
  for (const monthStart of months.slice(1)) {
    const next = materializedCanonicalRollup(monthStart, groups);
    if (!next) return null;
    for (const [groupId, nextGroup] of next.byGroup) {
      const target = aggregate.byGroup.get(groupId);
      if (!target) continue;
      (target as { spendUsd: number }).spendUsd += nextGroup.spendUsd;
      const targetUsers = target.byUser as Map<string, number>;
      for (const [userId, spend] of nextGroup.byUser) {
        targetUsers.set(userId, (targetUsers.get(userId) ?? 0) + spend);
      }
      (target as { memberCount: number }).memberCount = targetUsers.size;
    }
    for (const [workspaceId, nextGroup] of next.ungroupedByWorkspace) {
      const target = aggregate.ungroupedByWorkspace.get(workspaceId) ?? {
        spendUsd: 0,
        memberCount: 0,
        byUser: new Map<string, number>(),
      };
      (target as { spendUsd: number }).spendUsd += nextGroup.spendUsd;
      const targetUsers = target.byUser as Map<string, number>;
      for (const [userId, spend] of nextGroup.byUser) {
        targetUsers.set(userId, (targetUsers.get(userId) ?? 0) + spend);
      }
      (target as { memberCount: number }).memberCount = targetUsers.size;
      aggregate.ungroupedByWorkspace.set(workspaceId, target);
    }
    aggregate.totalSpendUsd += next.totalSpendUsd;
  }
  aggregate.byUser = new Map();
  aggregate.totalMemberCount = 0;
  for (const group of aggregate.byGroup.values()) {
    aggregate.totalMemberCount += group.memberCount;
    for (const [userId, spend] of group.byUser) {
      aggregate.byUser.set(userId, (aggregate.byUser.get(userId) ?? 0) + spend);
    }
  }
  for (const group of aggregate.ungroupedByWorkspace.values()) {
    aggregate.totalMemberCount += group.memberCount;
  }
  return aggregate;
}

function queueCanonicalMonthRebuild(monthStart: string): void {
  canonicalCandidateMonths.add(monthStart);
  canonicalMonthsNeedingRebuild.add(monthStart);
  enqueueUsage(`canonical-monthly-rollup:${monthStart}`, 2, async () => {
    canonicalMonthsNeedingRebuild.delete(monthStart);
    const rebuilt = await rebuildCanonicalMonthlyRollup(monthStart);
    if (!rebuilt) {
      logger.info({ monthStart }, "Canonical monthly rollup deferred until inputs are complete");
    }
    // A source may commit while this task is active. The queue deduplicates the
    // active key, so schedule one follow-up after the pump releases that key.
    if (canonicalMonthsNeedingRebuild.has(monthStart)) {
      setTimeout(() => queueCanonicalMonthRebuild(monthStart), 0);
    }
  });
}

const canonicalMonthsNeedingRebuild = new Set<string>();

const canonicalCandidateMonths = new Set<string>();

const canonicalMonthlyRows = new Map<string, CanonicalMonthlyGroupUserRollup[]>();

let bypassCanonicalMonthlyRead = false;

const CANONICAL_RANGE_CACHE_MAX = 24;
const preparedCanonicalRanges = new Map<string, Set<string>>();
const canonicalRangeLoads = new Map<string, Promise<void>>();

function touchPreparedCanonicalRange(rangeKey: string, months: Set<string>): void {
  preparedCanonicalRanges.delete(rangeKey);
  preparedCanonicalRanges.set(rangeKey, months);
  while (preparedCanonicalRanges.size > CANONICAL_RANGE_CACHE_MAX) {
    const oldest = preparedCanonicalRanges.keys().next().value;
    if (oldest === undefined) break;
    const evictedMonths = preparedCanonicalRanges.get(oldest) ?? new Set<string>();
    preparedCanonicalRanges.delete(oldest);
    const retainedMonths = new Set(
      [...preparedCanonicalRanges.values()].flatMap((entry) => [...entry]),
    );
    for (const monthStart of evictedMonths) {
      if (retainedMonths.has(monthStart)) continue;
      canonicalMonthlyRows.delete(monthStart);
      canonicalMonthlyFingerprints.delete(monthStart);
      canonicalMonthlyBounds.delete(monthStart);
      canonicalCandidateMonths.delete(monthStart);
    }
  }
}

async function prepareCanonicalRangeFromStoredRollups(range: UsageRange): Promise<void> {
  const existing = preparedCanonicalRanges.get(range.key);
  if (existing) {
    touchPreparedCanonicalRange(range.key, existing);
    return;
  }
  const pending = canonicalRangeLoads.get(range.key);
  if (pending) return pending;
  const load = (async () => {
    try {
      const { start, end } = rangeBounds(range);
      const startDay = start.toISOString().slice(0, 10);
      const endDay = end.toISOString().slice(0, 10);
      const [rows, states] = await Promise.all([
        db.select().from(canonicalMonthlyGroupUserRollupsTable).where(and(
          gte(canonicalMonthlyGroupUserRollupsTable.monthStart, startDay),
          lt(canonicalMonthlyGroupUserRollupsTable.monthStart, endDay),
        )),
        db.select().from(canonicalMonthlyRollupStateTable).where(and(
          gte(canonicalMonthlyRollupStateTable.monthStart, startDay),
          lt(canonicalMonthlyRollupStateTable.monthStart, endDay),
        )),
      ]);
      const stateMonths = new Set(states.map((state) => state.monthStart));
      const validMonths = new Set(
        states.filter((state) => state.status === "success").map((state) => state.monthStart),
      );
      for (const state of states) {
        canonicalCandidateMonths.add(state.monthStart);
        if (state.status !== "success") continue;
        canonicalMonthlyFingerprints.set(state.monthStart, state.inputFingerprint);
        canonicalMonthlyBounds.set(state.monthStart, {
          start: state.rangeStart.getTime(),
          end: state.rangeEnd.getTime(),
        });
        if (
          directoryCache &&
          state.inputFingerprint !== canonicalInputFingerprint(state.monthStart, directoryCache)
        ) {
          queueCanonicalMonthRebuild(state.monthStart);
        }
      }
      const rowsByMonth = new Map<string, CanonicalMonthlyGroupUserRollup[]>();
      for (const row of rows) {
        if (!validMonths.has(row.monthStart)) continue;
        const monthRows = rowsByMonth.get(row.monthStart) ?? [];
        monthRows.push(row);
        rowsByMonth.set(row.monthStart, monthRows);
      }
      for (const monthStart of validMonths) {
        canonicalMonthlyRows.set(monthStart, rowsByMonth.get(monthStart) ?? []);
      }
      touchPreparedCanonicalRange(range.key, stateMonths);
    } catch (err) {
      touchPreparedCanonicalRange(range.key, new Set());
      logger.warn({ err, rangeKey: range.key }, "Failed to load canonical rollups on demand");
    }
  })();
  canonicalRangeLoads.set(range.key, load);
  try {
    await load;
  } finally {
    canonicalRangeLoads.delete(range.key);
  }
}

function canonicalMonthsForRange(
  rangeKey: string,
  dir: DirectoryCache,
): string[] | null {
  const range = resolvedUsageRanges.get(rangeKey);
  if (!range) return null;
  const { start, end } = rangeBounds(range);
  const candidates = [...canonicalMonthlyBounds.entries()]
    .sort(([, a], [, b]) => a.start - b.start);
  const months: string[] = [];
  let cursor = start.getTime();
  while (cursor < end.getTime()) {
    const match = candidates.find(([, bounds]) => bounds.start === cursor);
    if (!match || match[1].end > end.getTime()) return null;
    const [monthStart, bounds] = match;
    if (
      !canonicalMonthlyRows.has(monthStart) ||
      canonicalMonthlyFingerprints.get(monthStart) !==
        canonicalInputFingerprint(monthStart, dir)
    ) return null;
    months.push(monthStart);
    cursor = bounds.end;
  }
  return cursor === end.getTime() && months.length > 0 ? months : null;
}

const dailyFactRangeCache = new Map<string, {
  rangeKey: string;
  mode: UsageSyncMode;
  scopeKey: string;
  startMs: number;
  endMs: number;
  facts: UsageDailyFact[];
}>();

function invalidateDailyFactRangeEntries(
  mode: UsageSyncMode,
  scopeKey: string,
  usageDate: string,
): void {
  const changedAt = new Date(`${usageDate}T00:00:00.000Z`).getTime();
  const evictedRanges = new Set<string>();
  for (const [key, entry] of dailyFactRangeCache) {
    const includesChangedScope =
      (entry.mode === mode && entry.scopeKey === scopeKey) ||
      (mode === "account_total" && scopeKey === ACCOUNT_USAGE_SCOPE);
    if (!includesChangedScope) continue;
    if (changedAt < entry.startMs || changedAt >= entry.endMs) continue;
    dailyFactRangeCache.delete(key);
    evictedRanges.add(entry.rangeKey);
  }
  for (const rangeKey of evictedRanges) evictMaterializedFactRange(rangeKey);
  if (evictedRanges.size === 0) return;
  dailyFactCache.clear();
  for (const entry of dailyFactRangeCache.values()) {
    for (const fact of entry.facts) {
      dailyFactCache.set(
        dailyFactId(fact.mode as UsageSyncMode, fact.scopeKey, fact.usageDate),
        fact,
      );
    }
  }
}

export const DAILY_FACT_RANGE_CACHE_MAX = 24;

function evictMaterializedFactRange(rangeKey: string): void {
  for (const id of materializedFactScopes) {
    if (id.includes(`|${rangeKey}|`)) materializedFactScopes.delete(id);
  }
  accountUsageCache.delete(rangeKey);
  for (const cache of [
    spendCache,
    memberUsageCache,
    wsSpendCache,
    wsSpendCachedAt,
    projectUsageCache,
  ]) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${rangeKey}|`)) cache.delete(key);
    }
  }
  for (const id of syncMetadata.keys()) {
    if (id.includes(`|${rangeKey}|`)) syncMetadata.delete(id);
  }
}
