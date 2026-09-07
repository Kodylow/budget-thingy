import { pool } from "@workspace/db";
import {
  assertCompleteRosterDirectory,
  fetchEnterpriseForIngest,
  getCachedDirectory,
  getDirectoryFreshness,
  refreshBillingPeriodMetadata,
  refreshDirectoryForIngest,
  refreshProjectMetadataSlice,
  getBillingPeriodMetadata,
  type DirectoryCache,
  withEnterpriseIngestAccess,
} from "./enterprise";
import { ENTERPRISE_USAGE_REQUESTS_PER_MINUTE } from "./enterprise-rate-limit";
import { hasDailyRosterSnapshot, recordDailyRosters } from "./history";
import { logger } from "./logger";
import {
  beginUsageGenerationUpdate,
  invalidateUsageSnapshotMemo,
} from "./usage-store";
import { sumAgentUsageMetrics } from "./usage-metrics";
import { CUTOFF, selectIngestSlice, selectLiveSlice, saveIngestCursor, unitKey, type QueueUnit } from "./ingest-selection";
import { reconcileSlice, type ReconciliationDelta } from "./ingest-reconcile";
import {
  assertExplicitIntervalMatches,
  assertIntervalMatches,
  validateUsagePayload,
  type ValidatedUsagePayload,
} from "./ingest-validation";

export {
  reconciliationBounds,
  nextReconciliationMismatchCount,
  reconcileWorkspaceTotal,
} from "./ingest-reconcile";
export type { ReconciliationDelta } from "./ingest-reconcile";

const DAY_MS = 86_400_000;
const DIRECTORY_TTL_MS = 15 * 60_000;
const WORKERS = 3;
const UNIT_ATTEMPTS = 3;
const MAX_USAGE_PAGES = 200;
const MAX_WORKSPACE_UNIT_CALLS = UNIT_ATTEMPTS * 2 * MAX_USAGE_PAGES;
const BATCH_SIZE = 500;

export const BACKGROUND_CYCLE_INTERVAL_MINUTES = 10;

type Metrics = Array<{ id: string; name: string; category: string; costUsd: number }>;
type UsageGroup = {
  key?: { userId?: string; projectId?: string };
  totalCostUsd?: number;
  metrics?: Metrics;
};
type UsagePayload = ValidatedUsagePayload;
type UnitResult = {
  ok: boolean;
  calls: number;
  pages: number;
  durationMs: number;
  error?: string;
};
export type CycleSummary = {
  acquired: boolean;
  unitsAttempted: number;
  unitsSucceeded: number;
  unitsFailed: number;
  totalCalls: number;
  durationMs: number;
  reconciliations: ReconciliationDelta[];
  remainingBackfillCount: number;
  remainingLiveCount: number;
  remainingReconciliationCount: number;
  health: "healthy" | "recovering" | "degraded";
  peakRequestsPerMinute: number;
  lowestRateLimitRemaining: number | null;
};

export interface BackgroundCycleOperations {
  evaluateThresholds: () => Promise<unknown>;
  refreshTeamLimitDrift: () => Promise<unknown>;
  syncAllocationAdjustments: () => Promise<{ ok: boolean; error: string | null }>;
  enforceMemberLimitPolicies: () => Promise<unknown>;
}

const defaultBackgroundCycleOperations: BackgroundCycleOperations = {
  evaluateThresholds: async () => (await import("./checker")).runCheck(),
  refreshTeamLimitDrift: async () => (await import("./team-budgets")).reconcileTeamBudgetsUpstream(),
  syncAllocationAdjustments: async () => {
    const { getAirtableSourceConfigurationStatus, refreshTeamBudgetSnapshot } =
      await import("./team-budgets");
    if (!getAirtableSourceConfigurationStatus().configured) {
      return Promise.resolve({ ok: true, error: null });
    }
    return refreshTeamBudgetSnapshot();
  },
  enforceMemberLimitPolicies: async () =>
    (await import("./member-limit-policies")).applyAllMemberLimitPolicies(),
};

/**
 * Run all post-ingest responsibilities in their authoritative order. Each is
 * attempted even when an earlier operation fails. Core post-ingest failures
 * are reported together so the scheduler retries on its next pass. Allocation
 * synchronization is intentionally non-fatal because it preserves the last
 * successful snapshot and reports its own source diagnostics.
 */
export async function runBackgroundCycleOperations(
  operations: BackgroundCycleOperations = defaultBackgroundCycleOperations,
): Promise<void> {
  const failures: Error[] = [];
  const attempt = async (name: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure);
      logger.error({ err: failure, operation: name }, "Background cycle operation failed");
    }
  };
  await attempt("threshold_evaluation", operations.evaluateThresholds);
  await attempt("team_limit_drift_refresh", operations.refreshTeamLimitDrift);
  try {
    const result = await operations.syncAllocationAdjustments();
    if (!result.ok) {
      logger.warn(
        {
          operation: "allocation_adjustment_sync",
          error: result.error ?? "Allocation adjustment synchronization failed",
        },
        "Optional background cycle operation unavailable",
      );
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.warn(
      { err: failure, operation: "allocation_adjustment_sync" },
      "Optional background cycle operation failed",
    );
  }
  await attempt("member_limit_policy_enforcement", operations.enforceMemberLimitPolicies);
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more background cycle operations failed");
  }
}

let requestCountsByMinute = new Map<number, number>();
let peakRequestsPerMinute = 0;
let lowestRateLimitRemaining: number | null = null;
let usageRequestCount = 0;

export class LocalUsageRateLimiter {
  private readonly requestTimes: number[] = [];
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit = ENTERPRISE_USAGE_REQUESTS_PER_MINUTE,
    private readonly intervalMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (delayMs: number) => Promise<void> =
      (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  ) {}

  acquire(): Promise<void> {
    const acquisition = this.gate.then(async () => {
      for (;;) {
        const current = this.now();
        const cutoff = current - this.intervalMs;
        while (this.requestTimes.length > 0 && this.requestTimes[0]! <= cutoff) {
          this.requestTimes.shift();
        }
        if (this.requestTimes.length < this.limit) {
          this.requestTimes.push(current);
          return;
        }
        await this.sleep(Math.max(1, this.requestTimes[0]! + this.intervalMs - current));
      }
    });
    this.gate = acquisition.catch(() => undefined);
    return acquisition;
  }
}
function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(usageDate: string, count: number): string {
  return day(new Date(Date.parse(`${usageDate}T00:00:00.000Z`) + count * DAY_MS));
}

function mergeMetrics(target: Metrics, incoming: Metrics | undefined): void {
  for (const metric of incoming ?? []) {
    const existing = target.find((candidate) =>
      candidate.id === metric.id &&
      candidate.name === metric.name &&
      candidate.category === metric.category);
    if (existing) existing.costUsd += Number(metric.costUsd ?? 0);
    else target.push({ ...metric, costUsd: Number(metric.costUsd ?? 0) });
  }
}

function noteRequest(headers: Headers): void {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const minuteCalls = (requestCountsByMinute.get(minute) ?? 0) + 1;
  requestCountsByMinute.set(minute, minuteCalls);
  peakRequestsPerMinute = Math.max(peakRequestsPerMinute, minuteCalls);
  const raw = headers.get("X-RateLimit-Remaining") ?? headers.get("RateLimit-Remaining");
  const remaining = raw === null ? NaN : Number(raw);
  if (Number.isFinite(remaining)) {
    lowestRateLimitRemaining = lowestRateLimitRemaining === null
      ? remaining
      : Math.min(lowestRateLimitRemaining, remaining);
  }
}

async function requestUsage(
  params: Record<string, string | undefined>,
  stats: { calls: number },
  groupBy?: "member" | "project",
): Promise<{ data: UsagePayload; headers: Headers }> {
  await usageRequestRateLimiter.acquire();
  stats.calls++;
  usageRequestCount++;
  const response = await fetchEnterpriseForIngest("/usage", params).catch((error) => {
    noteRequest(new Headers());
    throw error;
  });
  noteRequest(response.headers);
  const body = response.body as { data?: UsagePayload };
  if (!body.data) throw new Error("Enterprise /usage response omitted data");
  return { data: validateUsagePayload(body.data, groupBy), headers: response.headers };
}

async function pagedUsage(
  params: Record<string, string | undefined>,
  stats: { calls: number; pages: number },
): Promise<{ top: UsagePayload; groups: UsageGroup[] }> {
  const groups: UsageGroup[] = [];
  let cursor: string | undefined;
  let top: UsagePayload | null = null;
  const seenCursors = new Set<string>();
  const groupBy = params.groupBy === "member" ? "member" : "project";
  for (let page = 0; page < MAX_USAGE_PAGES; page++) {
    const response = await requestUsage({ ...params, limit: "100", cursor }, stats, groupBy);
    stats.pages++;
    assertExplicitIntervalMatches(
      response.data,
      String(params.startTime),
      String(params.endTime),
    );
    if (top && response.data.totalCostUsd !== top.totalCostUsd) {
      throw new Error("Enterprise /usage pagination changed the aggregate total between pages");
    }
    top ??= response.data;
    groups.push(...(response.data.groups ?? []));
    if (!response.data.pagination?.hasMore) return { top, groups };
    const nextCursor = response.data.pagination.nextCursor ??
      response.data.pagination.cursor;
    if (!nextCursor) {
      throw new Error("Enterprise /usage pagination reported hasMore without a cursor");
    }
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      throw new Error("Enterprise /usage pagination repeated a cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("Enterprise /usage exceeded 200 pages");
}

async function retry<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UNIT_ATTEMPTS; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt < UNIT_ATTEMPTS) {
        const retryAfterMs = Number((error as { retryAfterMs?: number }).retryAfterMs);
        const delay = Number.isFinite(retryAfterMs)
          ? Math.max(retryAfterMs, 250 * 2 ** (attempt - 1))
          : 250 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function batchedInsert(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  table: "usage_member_day" | "usage_project_day",
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders = batch.map((row) => {
      const base = values.length;
      values.push(...row);
      return `(${row.map((_, index) => `$${base + index + 1}`).join(",")})`;
    });
    await client.query(
      `insert into ${table} (${columns.join(",")}) values ${placeholders.join(",")}`,
      values,
    );
  }
}

export async function ingestWorkspaceDay(
  workspaceId: string,
  usageDate: string,
): Promise<UnitResult> {
  const started = Date.now();
  const stats = { calls: 0, pages: 0 };
  try {
    await retry(async () => {
      const range = {
        workspaceId,
        startTime: `${usageDate}T00:00:00.000Z`,
        endTime: `${addDays(usageDate, 1)}T00:00:00.000Z`,
      };
      const members = await pagedUsage({ ...range, groupBy: "member" }, stats);
      const projects = await pagedUsage({ ...range, groupBy: "project" }, stats);
      const fetchedAt = new Date();
      const memberRows = new Map<string, { total: number; metrics: Metrics }>();
      for (const entry of members.groups) {
        const userId = entry.key?.userId;
        if (!userId) continue;
        const row = memberRows.get(userId) ?? { total: 0, metrics: [] };
        row.total += Number(entry.totalCostUsd ?? 0);
        mergeMetrics(row.metrics, entry.metrics);
        memberRows.set(userId, row);
      }
      const projectRows = new Map<string, { total: number; metrics: Metrics }>();
      for (const entry of projects.groups) {
        const projectId = entry.key?.projectId;
        if (!projectId) continue;
        const row = projectRows.get(projectId) ?? { total: 0, metrics: [] };
        row.total += Number(entry.totalCostUsd ?? 0);
        mergeMetrics(row.metrics, entry.metrics);
        projectRows.set(projectId, row);
      }
      const memberInsertRows = [...memberRows].map(([userId, row]) => [
        workspaceId,
        usageDate,
        userId,
        row.total,
        sumAgentUsageMetrics(row.metrics),
        JSON.stringify(row.metrics),
        fetchedAt,
      ]);
      const projectInsertRows = [...projectRows].map(([projectId, row]) => [
        workspaceId,
        usageDate,
        projectId,
        row.total,
        JSON.stringify(row.metrics),
        fetchedAt,
      ]);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "delete from usage_member_day where workspace_id=$1 and usage_date=$2::date",
          [workspaceId, usageDate],
        );
        await client.query(
          "delete from usage_project_day where workspace_id=$1 and usage_date=$2::date",
          [workspaceId, usageDate],
        );
        await batchedInsert(
          client,
          "usage_member_day",
          ["workspace_id", "usage_date", "user_id", "total_cost_usd", "ai_cost_usd", "metrics_json", "fetched_at"],
          memberInsertRows,
        );
        await batchedInsert(
          client,
          "usage_project_day",
          ["workspace_id", "usage_date", "project_id", "total_cost_usd", "metrics_json", "fetched_at"],
          projectInsertRows,
        );
        await client.query(
          `insert into usage_workspace_day
             (workspace_id, usage_date, total_cost_usd, member_attributable_usd,
              member_unattributable_usd, metrics_json, fetched_at, status, error)
           values ($1,$2::date,$3,$4,$5,$6::jsonb,$7,'complete',null)
           on conflict (workspace_id, usage_date) do update set
             total_cost_usd=excluded.total_cost_usd,
             member_attributable_usd=excluded.member_attributable_usd,
             member_unattributable_usd=excluded.member_unattributable_usd,
             metrics_json=excluded.metrics_json, fetched_at=excluded.fetched_at,
             status='complete', error=null`,
          [
            workspaceId, usageDate, Number(members.top.totalCostUsd ?? 0),
            Number(members.top.attributableTotalCostUsd ?? 0),
            Number(members.top.unattributableTotalCostUsd ?? 0),
            JSON.stringify(members.top.metrics ?? []), fetchedAt,
          ],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    });
    invalidateUsageSnapshotMemo();
    const result = { ok: true, ...stats, durationMs: Date.now() - started };
    logger.info({ event: "usage_ingest_unit", workspaceId, usageDate, ...result, outcome: "complete" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { ok: false, ...stats, durationMs: Date.now() - started, error: message };
    logger.error({ event: "usage_ingest_unit", workspaceId, usageDate, ...result, outcome: "failed" });
    return result;
  }
}

export async function ingestAccountDay(usageDate: string): Promise<UnitResult> {
  const started = Date.now();
  const stats = { calls: 0, pages: 0 };
  try {
    await retry(async () => {
      const response = await requestUsage({
        startTime: `${usageDate}T00:00:00.000Z`,
        endTime: `${addDays(usageDate, 1)}T00:00:00.000Z`,
      }, stats);
      assertIntervalMatches(
        response.data,
        `${usageDate}T00:00:00.000Z`,
        `${addDays(usageDate, 1)}T00:00:00.000Z`,
      );
      await pool.query(
        `insert into usage_account_day (usage_date,total_cost_usd,fetched_at)
         values ($1::date,$2,now())
         on conflict (usage_date) do update set
           total_cost_usd=excluded.total_cost_usd,fetched_at=excluded.fetched_at`,
        [usageDate, Number(response.data.totalCostUsd ?? 0)],
      );
    });
    invalidateUsageSnapshotMemo();
    const result = { ok: true, ...stats, durationMs: Date.now() - started };
    logger.info({ event: "usage_ingest_unit", usageDate, ...result, outcome: "complete" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { ok: false, ...stats, durationMs: Date.now() - started, error: message };
    logger.error({ event: "usage_ingest_unit", usageDate, ...result, outcome: "failed" });
    return result;
  }
}

export async function runQueue(
  units: QueueUnit[],
  budget = { units: 12, calls: 48, durationMs: 60_000 },
  stage?: string,
): Promise<{
  attempted: number; succeeded: number; failed: number; calls: number; deferred: number;
  failureKeys: string[];
}> {
  let next = 0;
  const started = Date.now();
  const startingCalls = usageRequestCount;
  let reservedCalls = 0;
  const hardCallCeiling = budget.calls + WORKERS * MAX_WORKSPACE_UNIT_CALLS;
  const totals = {
    attempted: 0, succeeded: 0, failed: 0, calls: 0, deferred: 0,
    failureKeys: [] as string[],
  };
  const publish = beginUsageGenerationUpdate();
  try {
    // Budgets stop admission, never an atomic replacement. All admitted workers
    // settle before publication or releasing the sole owner's advisory lock.
    await Promise.allSettled(Array.from({ length: WORKERS }, async () => {
      for (;;) {
        if (next >= units.length || next >= budget.units ||
            usageRequestCount - startingCalls >= budget.calls ||
            Date.now() - started >= budget.durationMs) return;
        const unit = units[next]!;
        const allowance = unit.type === "workspace" ? MAX_WORKSPACE_UNIT_CALLS : UNIT_ATTEMPTS;
        if (usageRequestCount - startingCalls + reservedCalls + allowance > hardCallCeiling) return;
        // The soft target cannot interrupt grouped pagination without losing
        // the atomic workspace-day contract. Reserve its finite worst case.
        reservedCalls += allowance;
        next++;
        totals.attempted++;
        try {
          const result = unit.type === "workspace"
            ? await ingestWorkspaceDay(unit.workspaceId, unit.usageDate)
            : await ingestAccountDay(unit.usageDate);
          if (result.ok) totals.succeeded++;
          else {
            totals.failed++;
            totals.failureKeys.push(unitKey(unit));
          }
        } catch {
          totals.failed++;
          totals.failureKeys.push(unitKey(unit));
          logger.error({ event: "usage_ingest_persistence_failure", stage },
            "Usage unit could not persist its result");
        } finally {
          reservedCalls -= allowance;
        }
      }
    }));
    if (stage && next > 0) await saveIngestCursor(stage, unitKey(units[next - 1]!));
  } finally {
    publish();
  }
  totals.calls = usageRequestCount - startingCalls;
  totals.deferred = units.length - totals.attempted;
  logger.info({ event: "usage_ingest_stage", stage, ...totals,
    softCallTarget: budget.calls, hardCallCeiling, admissionDurationMs: budget.durationMs,
    durationMs: Date.now() - started });
  return totals;
}

export async function refreshMetadata(
  now = Date.now(), force = false, dataOnly = false,
): Promise<DirectoryCache> {
  const freshness = getDirectoryFreshness();
  const rosterMissing = !(await hasDailyRosterSnapshot(now));
  let directory: DirectoryCache;
  if (force || rosterMissing ||
      !freshness.dataAsOf ||
      Date.now() - Date.parse(freshness.dataAsOf) >= DIRECTORY_TTL_MS) {
    directory = await refreshDirectoryForIngest(dataOnly);
  } else {
    directory = await getCachedDirectory();
  }
  assertCompleteRosterDirectory(directory);
  await recordDailyRosters(directory.groups, directory.groupMembers, now);
  return directory;
}

export async function beginRun(kind: "live" | "backfill" | "reconcile"): Promise<string> {
  const result = await pool.query(
    `insert into ingest_run (kind,started_at,units,calls,failures)
     values ($1,now(),0,0,0) returning id::text`,
    [kind],
  );
  return String(result.rows[0]?.id);
}

export async function finishRun(
  id: string,
  totals: {
    attempted: number; calls: number; failed: number; remaining?: number;
    failureKeys?: string[];
  },
  error?: string,
): Promise<void> {
  const durableError = totals.failureKeys?.length
    ? `failed-units:${totals.failureKeys.join("\n")}`
    : error;
  await pool.query(
    `update ingest_run set finished_at=now(),units=$2,calls=$3,failures=$4,error=$5,remaining=$6 where id=$1`,
    [id, totals.attempted, totals.calls, totals.failed, durableError ?? null, totals.remaining ?? null],
  );
}

export async function fetchTotal(
  startTime: string,
  endTime: string,
  workspaceId: string | undefined,
  stats: { calls: number },
): Promise<{ totalCostUsd: number; intervalStart: string; intervalEnd: string }> {
  const response = await retry(() => requestUsage({ startTime, endTime, workspaceId }, stats));
  assertIntervalMatches(response.data, startTime, endTime);
  return {
    totalCostUsd: Number(response.data.totalCostUsd ?? 0),
    intervalStart: response.data.interval?.startTime ?? startTime,
    intervalEnd: response.data.interval?.endTime ?? endTime,
  };
}

async function runAuthorizedCycle(
  now: Date,
  operations: BackgroundCycleOperations,
): Promise<CycleSummary> {
  const started = Date.now();
  const lockClient = await pool.connect();
  const empty: CycleSummary = {
    acquired: false, unitsAttempted: 0, unitsSucceeded: 0, unitsFailed: 0,
    totalCalls: 0, durationMs: 0, reconciliations: [], remainingBackfillCount: 0,
    remainingLiveCount: 0, health: "healthy",
    remainingReconciliationCount: 0,
    peakRequestsPerMinute: 0, lowestRateLimitRemaining: null,
  };
  try {
    const lock = await lockClient.query(
      "select pg_try_advisory_lock(hashtext('usage-ingest')) as acquired",
    );
    if (!lock.rows[0]?.acquired) {
      logger.info({ event: "usage_ingest_run", outcome: "lock_not_acquired" });
      return { ...empty, durationMs: Date.now() - started };
    }
    empty.acquired = true;
    requestCountsByMinute = new Map();
    peakRequestsPerMinute = 0;
    lowestRateLimitRemaining = null;
    usageRequestCount = 0;
    const directoryStarted = Date.now();
    const directory = await refreshMetadata(now.getTime());
    logger.info({ event: "usage_ingest_stage", stage: "directory",
      durationMs: Date.now() - directoryStarted, workspaces: directory.workspaces.size });
    const workspaceIds = [...directory.workspaces.keys()].sort();
    const today = day(now);
    const liveRun = await beginRun("live");
    const selectedLive = await selectLiveSlice(workspaceIds, today, 96);
    // One finite live slice, not a loop that drains an arbitrarily large
    // directory. Its cursor advances even past failed units.
    const live = await runQueue(selectedLive.units,
      { units: 96, calls: 150, durationMs: 90_000 }, "live");
    await finishRun(liveRun, { ...live,
      remaining: selectedLive.remaining - live.attempted });

    // Billing qualification remains fail-closed in its consumers. Its outage
    // must not discard otherwise healthy daily facts.
    const billingStarted = Date.now();
    try {
      const refreshed = await refreshBillingPeriodMetadata();
      logger.info({ event: "usage_ingest_stage", stage: "billing", refreshed,
        durationMs: Date.now() - billingStarted });
    } catch {
      logger.warn({ event: "usage_ingest_stage", stage: "billing", outcome: "failed",
        durationMs: Date.now() - billingStarted },
        "Billing metadata unavailable; dependent work retains its safety gates");
    }

    const backfillRun = await beginRun("backfill");
    const period = getBillingPeriodMetadata();
    const currentStart = period.isFallback ? today.slice(0, 7) + "-01"
      : period.start.slice(0, 10);
    const priorityStart = currentStart < CUTOFF ? CUTOFF : currentStart;
    const historical = {
      attempted: 0, succeeded: 0, failed: 0, calls: 0,
      failureKeys: [] as string[],
    };
    // Reserve independent slices for current-cycle gaps and older history.
    // Neither a growing current cycle nor a permanently failed early unit can
    // monopolize the other lane.
    for (const failedOnly of [false, true]) {
      for (const [lane, start, end] of [
        ["current", priorityStart, addDays(today, -3)],
        ["older", CUTOFF, [addDays(priorityStart, -1), addDays(today, -3)].sort()[0]!],
      ]) {
        const stage = `${failedOnly ? "retry" : "backfill"}-${lane}`;
        const selected = await selectIngestSlice(workspaceIds, start!, end!, stage,
          failedOnly ? 3 : 6, failedOnly);
        const result = await runQueue(selected.units,
          { units: failedOnly ? 3 : 6, calls: failedOnly ? 18 : 24, durationMs: 30_000 },
          stage);
        historical.attempted += result.attempted;
        historical.succeeded += result.succeeded;
        historical.failed += result.failed;
        historical.calls += result.calls;
        historical.failureKeys.push(...result.failureKeys);
      }
    }
    const pending = await Promise.all([false, true].map((failedOnly) =>
      selectIngestSlice(workspaceIds, CUTOFF, addDays(today, -3), "", 1, failedOnly)));
    const remainingBackfillCount = pending.reduce((sum, result) => sum + result.remaining, 0);
    await finishRun(backfillRun, { ...historical, remaining: remainingBackfillCount });

    let reconciliationResult = {
      calls: 0, failed: 0, remaining: 0,
      reconciliations: [] as ReconciliationDelta[],
    };
    if (now.getUTCHours() >= 2) {
      const reconcileRun = await beginRun("reconcile");
      const reconcileStarted = Date.now();
      const publish = beginUsageGenerationUpdate();
      try {
        const result = await reconcileSlice(workspaceIds, today, fetchTotal);
        reconciliationResult = result;
        await finishRun(reconcileRun, result);
        logger.info({ event: "usage_ingest_stage", stage: "reconcile", ...result,
          reconciliations: undefined, durationMs: Date.now() - reconcileStarted });
      } catch {
        reconciliationResult.failed = 1;
        await finishRun(reconcileRun, {
          attempted: 0, calls: 0,
          failed: 1,
        }, "Reconciliation slice failed; pending units remain retryable");
      } finally {
        publish();
      }
    }
    const operationsStarted = Date.now();
    try {
      await runBackgroundCycleOperations(operations);
    } finally {
      logger.info({ event: "usage_ingest_stage", stage: "post_operations",
        durationMs: Date.now() - operationsStarted });
      // Enrichment is optional and last: even slow title/creator requests cannot
      // delay financial publication or this cycle's required dependent work.
      const enrichmentStarted = Date.now();
      try {
        const enrichment = await refreshProjectMetadataSlice(workspaceIds);
        logger.info({ event: "usage_ingest_stage", stage: "enrichment", ...enrichment,
          durationMs: Date.now() - enrichmentStarted });
      } catch {
        logger.warn({ event: "usage_ingest_stage", stage: "enrichment", outcome: "failed",
          durationMs: Date.now() - enrichmentStarted },
          "Project enrichment unavailable");
      }
    }
    const unitsFailed = live.failed + historical.failed + reconciliationResult.failed;
    const remainingLiveCount = Math.max(0, selectedLive.remaining - live.attempted);
    const summary: CycleSummary = {
      acquired: true,
      unitsAttempted:
        live.attempted + historical.attempted,
      unitsSucceeded:
        live.succeeded + historical.succeeded,
      unitsFailed,
      totalCalls:
        live.calls + historical.calls + reconciliationResult.calls,
      durationMs: Date.now() - started,
      reconciliations: reconciliationResult.reconciliations,
      remainingBackfillCount,
      remainingLiveCount,
      remainingReconciliationCount: reconciliationResult.remaining,
      health: unitsFailed > 0
        ? "degraded"
        : remainingBackfillCount > 0 || remainingLiveCount > 0 ||
            reconciliationResult.remaining > 0
        ? "recovering"
        : "healthy",
      peakRequestsPerMinute,
      lowestRateLimitRemaining,
    };
    logger.info({ event: "usage_ingest_run", ...summary, outcome: summary.health });
    return summary;
  } catch (error) {
    logger.error({ event: "usage_ingest_run", err: error, outcome: "failed" });
    throw error;
  } finally {
    try {
      if (empty.acquired) {
        await lockClient.query("select pg_advisory_unlock(hashtext('usage-ingest'))");
      }
    } finally {
      lockClient.release();
    }
  }
}

let interval: NodeJS.Timeout | null = null;

export function runCycle(
  now = new Date(),
  operations: BackgroundCycleOperations = defaultBackgroundCycleOperations,
): Promise<CycleSummary> {
  return withEnterpriseIngestAccess(() => runAuthorizedCycle(now, operations));
}

export function startUsageIngestScheduler(): void {
  if (interval) return;
  void runCycle().catch((error) => logger.error({ err: error }, "Initial usage ingest cycle failed"));
  interval = setInterval(() => {
    void runCycle().catch((error) => logger.error({ err: error }, "Scheduled usage ingest cycle failed"));
  }, BACKGROUND_CYCLE_INTERVAL_MINUTES * 60_000);
  interval.unref();
}

/**
 * Startup hydration improves the first cycle but cannot be allowed to suppress
 * the sole scheduler for the lifetime of the process after a transient failure.
 */
export async function initializeUsageIngestScheduler(
  initialization: Promise<unknown>,
  startScheduler: () => void = startUsageIngestScheduler,
): Promise<void> {
  try {
    await initialization;
  } catch (error) {
    logger.error({ err: error }, "Post-listen startup initialization failed");
  }
  startScheduler();
}

export function __stopUsageIngestSchedulerForTests(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

const usageRequestRateLimiter = new LocalUsageRateLimiter();
