import { logger } from "./logger";
import { db } from "@workspace/db";
import {
  apiDirectoryCacheTable,
  apiBillingPeriodCacheTable,
  apiAccountTotalVerificationTable,
  apiSpendCacheTable,
  apiProjectMetadataTable,
  apiProjectMetadataStateTable,
  usageSyncChunksTable,
  usageSyncStateTable,
  type UsageSyncChunk,
} from "@workspace/db/schema";
import { and, eq, gt, like, lt, lte, sql } from "drizzle-orm";
import {
  computeDedupedMemberCounts,
  computeDedupedUsageRollup,
  type DedupedGroupRollup,
  type DedupedUsageRollup,
} from "./usage-rollup";

const BASE_URL = "https://api.replit.com/v1";

export function isConfigured(): boolean {
  return !!process.env["REPLIT_ENTERPRISE_API_KEY"];
}

let lastApiError: string | null = null;
let lastApiOk = false;

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
  const key = process.env["REPLIT_ENTERPRISE_API_KEY"];
  if (!key) throw new EnterpriseApiError(0, "REPLIT_ENTERPRISE_API_KEY is not set");

  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  });

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

// ---------- Date ranges ----------

/** All spend data before this date is excluded from every query. */
export const SPEND_DATA_CUTOFF_ISO = "2026-05-20T00:00:00.000Z";
export const SPEND_DATA_CUTOFF_MS = new Date(SPEND_DATA_CUTOFF_ISO).getTime();
export const SPEND_DATA_CUTOFF_LABEL = "May 2026-present";
export const PACE_FALLBACK_END_ISO = "2027-05-17T00:00:00.000Z";
const BILLING_PERIOD_REFRESH_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_HEAL_THRESHOLD_USD = 1;
const VERIFICATION_RETRY_BASE_MS = 60 * 1000;
const VERIFICATION_RETRY_MAX_MS = 60 * 60 * 1000;

export type RangeType = "billing" | "mtd" | "ytd" | "custom";

export interface UsageRange {
  key: string; // cache key
  label: string;
  params: Record<string, string>; // billingPeriod OR startTime/endTime
}

export function resolveRange(
  rangeType: string | undefined,
  startDate?: string,
  endDate?: string,
): UsageRange {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (rangeType) {
    case "mtd": {
      const rawStart = new Date(Date.UTC(y, m, 1)).getTime();
      const effectiveStart = new Date(Math.max(rawStart, SPEND_DATA_CUTOFF_MS));
      return {
        key: `mtd:${effectiveStart.toISOString().slice(0, 10)}`,
        label: `${now.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })} (MTD)`,
        params: { startTime: effectiveStart.toISOString(), endTime: now.toISOString() },
      };
    }
    case "ytd": {
      const rawStart = new Date(Date.UTC(y, 0, 1)).getTime();
      const effectiveStart = new Date(Math.max(rawStart, SPEND_DATA_CUTOFF_MS));
      return {
        key: `ytd:${effectiveStart.toISOString().slice(0, 10)}`,
        label: `${y} year to date`,
        params: { startTime: effectiveStart.toISOString(), endTime: now.toISOString() },
      };
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
      return {
        key: `custom:${effectiveStartDate}:${endDate}`,
        label: `${effectiveStartDate} to ${endDate}`,
        params: { startTime: effectiveStart.toISOString(), endTime: end.toISOString() },
      };
    }
    default:
      {
        const activePeriod = getActiveBillingPeriod(now.getTime());
        if (activePeriod) {
        const periodStartMs = new Date(activePeriod.start).getTime();
        const periodEndMs = new Date(activePeriod.end).getTime();
        const effectiveStart = new Date(Math.max(periodStartMs, SPEND_DATA_CUTOFF_MS));
        const effectiveEnd = new Date(Math.min(now.getTime(), periodEndMs));
        if (
          Number.isFinite(effectiveStart.getTime()) &&
          Number.isFinite(effectiveEnd.getTime()) &&
          effectiveEnd > effectiveStart
        ) {
          return {
            // The discovered interval bounds are immutable material identity. The
            // moving reporting end is deliberately excluded so polling reuses cache.
            key: `billing:${activePeriod.start}:${activePeriod.end}:from:${effectiveStart.toISOString()}`,
            label: formatPeriodLabel(effectiveStart.toISOString(), effectiveEnd.toISOString()),
            params: {
              startTime: effectiveStart.toISOString(),
              endTime: effectiveEnd.toISOString(),
            },
          };
        }
      }
      }
      return {
        key: "billing:from-cutoff",
        label: formatPeriodLabel(SPEND_DATA_CUTOFF_ISO, now.toISOString()),
        params: { startTime: SPEND_DATA_CUTOFF_ISO, endTime: now.toISOString() },
      };
  }
}

export function isBadRangeError(err: unknown): boolean {
  return err instanceof EnterpriseApiError && err.status === 400;
}

// ---------- Serial usage queue (~100 req/min budget) ----------

type QueueTask = {
  run: () => Promise<void>;
  priority: number; // 0 = high (interactive), 1 = low (background)
  key: string;
};

const usageQueue: QueueTask[] = [];
const queuedKeys = new Set<string>();
let queueRunning = false;
let pauseUntil = 0;

function pumpQueue(): void {
  if (queueRunning) return;
  queueRunning = true;
  void (async () => {
    while (usageQueue.length > 0) {
      const now = Date.now();
      if (pauseUntil > now) {
        await new Promise((r) => setTimeout(r, pauseUntil - now));
      }
      usageQueue.sort((a, b) => a.priority - b.priority);
      const task = usageQueue.shift();
      if (!task) break;
      try {
        await task.run();
      } finally {
        // Keep the key registered while the task is active so polling cannot
        // enqueue the same Enterprise API request again.
        queuedKeys.delete(task.key);
      }
      // Gentle pacing: keeps well under 100/min with headroom.
      await new Promise((r) => setTimeout(r, 700));
    }
    queueRunning = false;
  })();
}

function enqueueUsage(key: string, priority: number, run: () => Promise<void>): boolean {
  if (queuedKeys.has(key)) return false;
  queuedKeys.add(key);
  usageQueue.push({ key, priority, run });
  pumpQueue();
  return true;
}

export function pendingUsageCount(): number {
  return usageQueue.length + (queueRunning ? 1 : 0);
}

interface UsageMetricEntry {
  id: string;
  name: string;
  category: string;
  costUsd: number;
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

let billingPeriodCache: StoredBillingPeriod | null = null;
let billingPeriodRefreshTimer: NodeJS.Timeout | null = null;
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

async function persistBillingPeriod(period: StoredBillingPeriod): Promise<void> {
  await db.insert(apiBillingPeriodCacheTable)
    .values({
      id: "current",
      periodStart: new Date(period.start),
      periodEnd: new Date(period.end),
      fetchedAt: new Date(period.fetchedAt),
    })
    .onConflictDoUpdate({
      target: apiBillingPeriodCacheTable.id,
      set: {
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        fetchedAt: new Date(period.fetchedAt),
      },
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
  const start = new Date(Math.max(
    new Date(period.start).getTime(),
    SPEND_DATA_CUTOFF_MS,
  ));
  const end = new Date(Math.min(
    Date.now(),
    new Date(period.end).getTime(),
  ));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return null;
  }
  return {
    key: `pace:${start.toISOString().slice(0, 10)}:${period.end.slice(0, 10)}`,
    label: period.label,
    params: {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
  };
}

export function refreshBillingPeriodMetadata(priority = 1, force = false): Promise<boolean> {
  if (!isConfigured()) return Promise.resolve(false);
  if (
    !force &&
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
        await persistBillingPeriod(next);
        billingPeriodCache = next;
        logger.info({ start: next.start, end: next.end }, "Current billing interval refreshed");
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
      const { body, headers } = await rawFetch("/usage", params);
      lastApiOk = true;
      lastApiError = null;
      const remaining = Number(headers.get("X-RateLimit-Remaining") ?? "10");
      if (remaining <= 3) {
        const reset = Number(headers.get("X-RateLimit-Reset") ?? "10");
        // The API may return either seconds-until-reset or a Unix timestamp.
        const resetDelayMs = reset > 1_000_000_000
          ? reset * 1000 - Date.now()
          : reset * 1000;
        pauseUntil = Date.now() + Math.max(2000, resetDelayMs);
        logger.warn({ remaining }, "Usage rate budget low; pausing queue");
      }
      return (body as { data: UsageData }).data;
    } catch (err) {
      const e = err as EnterpriseApiError & { retryAfterMs?: number };
      if (e.status === 429 && attempts <= 5) {
        pauseUntil = Date.now() + (e.retryAfterMs ?? 5000);
        logger.warn({ attempts }, "Usage 429; backing off");
        await new Promise((r) => setTimeout(r, e.retryAfterMs ?? 5000));
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

  // Once grace expires, immediately perform the final complete sync and mark
  // the range closed even if its last mutable sync is still inside the TTL.
  if (isClosed) {
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
  return { replacementStart: new Date(recentStartMs), chunks, isClosed: false };
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
        );
        await new Promise((resolve) => setTimeout(resolve, 700));
        const right = await fetchUsageChunk(
          mode,
          baseParams,
          midpoint,
          end,
          cursorlessShardDepth + 1,
        );
        return {
          payload: combineUsagePayloads([left.payload, right.payload]),
          partial: left.partial || right.partial,
          error: left.error ?? right.error,
        };
      }
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
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`Usage pagination exceeded ${MAX_USAGE_PAGES} pages`);
}

async function synchronizeUsage(
  mode: UsageSyncMode,
  range: UsageRange,
  scopeKey: string,
  baseParams: Record<string, string | undefined>,
  force = false,
): Promise<UsageSyncChunk[]> {
  await maybePruneExpiredCustomUsage();
  const id = syncId(mode, range.key, scopeKey);
  const priorMetadata = syncMetadata.get(id);
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
    for (const chunk of plan.chunks) {
      if (fetched.length > 0) {
        await new Promise((r) => setTimeout(r, 700));
      }
      const result = await fetchUsageChunk(mode, baseParams, chunk.start, chunk.end);
      fetched.push({ ...chunk, ...result });
    }

    const completedAt = new Date();
    const { start: rangeStart, end: syncedThrough } = rangeBounds(range);
    const partialError = fetched.find((chunk) => chunk.partial)?.error ?? null;
    const status: UsageSyncStatus = partialError ? "partial" : "success";
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
      }
    }
  }
  return {
    fetchedAt: Math.max(...rows.map((row) => row.completedAt.getTime())),
    byUser,
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
      }] : []),
      ...(includeProjects ? [{
        id: syncId("group_project", rangeKey, group.id),
        loaded: projectUsageCache.has(`${rangeKey}|${group.id}`),
      }] : []),
    ]),
    ...[...workspaceIds].map((workspaceId) => ({
      id: syncId("workspace_member", rangeKey, workspaceId),
      loaded: wsSpendCache.has(`${rangeKey}|${workspaceId}`),
    })),
    ...(includeAccount ? [{
      id: syncId("account_total", rangeKey, ACCOUNT_USAGE_SCOPE),
      loaded: accountUsageCache.has(rangeKey),
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
    if ((!metadata && !loaded) || metadata?.status === "syncing") pendingCount++;
    else if (metadata?.status === "failed") {
      failedCount++;
      error ??= metadata.error;
    } else if (metadata?.status === "partial") {
      partialCount++;
      error ??= metadata.error;
    }
  }
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
  };
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
    const { body } = await rawFetch(path, { ...params, limit: "100", cursor });
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

// ---------- DB write-through helpers (fire-and-forget) ----------

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

function persistSpendToDb(rangeKey: string, groupId: string, spend: GroupSpend): void {
  db.insert(apiSpendCacheTable)
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

export async function initCache(): Promise<void> {
  try {
    await maybePruneExpiredCustomUsage();
    const [
      dirRow,
      billingPeriodRow,
      verificationRow,
      spendRows,
      projectRows,
      projectStates,
      durable,
    ] = await Promise.all([
      db.query.apiDirectoryCacheTable.findFirst({ where: eq(apiDirectoryCacheTable.id, "singleton") }),
      db.query.apiBillingPeriodCacheTable.findFirst({
        where: eq(apiBillingPeriodCacheTable.id, "current"),
      }),
      db.query.apiAccountTotalVerificationTable.findFirst({
        where: eq(apiAccountTotalVerificationTable.id, "singleton"),
      }),
      db.select().from(apiSpendCacheTable),
      db.select().from(apiProjectMetadataTable),
      db.select().from(apiProjectMetadataStateTable),
      db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level repeatable read read only`);
        const states = await tx.select().from(usageSyncStateTable);
        const chunks = await tx.select().from(usageSyncChunksTable);
        return { states, chunks };
      }),
    ]);
    const { states, chunks } = durable;

    if (billingPeriodRow) {
      billingPeriodCache = {
        start: billingPeriodRow.periodStart.toISOString(),
        end: billingPeriodRow.periodEnd.toISOString(),
        fetchedAt: billingPeriodRow.fetchedAt.getTime(),
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

    for (const row of spendRows) {
      const cacheKey = `${row.rangeKey}|${row.groupId}`;
      if (!spendCache.has(cacheKey)) {
        spendCache.set(cacheKey, {
          spendUsd: row.spendUsd,
          fetchedAt: row.fetchedAt.getTime(),
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
        });
      }
    }
    if (spendRows.length > 0) {
      logger.info({ count: spendRows.length }, "Spend cache hydrated from DB");
    }

    for (const state of states) {
      syncMetadata.set(syncId(
        state.mode as UsageSyncMode,
        state.rangeKey,
        state.scopeKey,
      ), {
        syncedThrough: state.syncedThrough.getTime(),
        completedAt: state.completedAt.getTime(),
        isClosed: state.isClosed,
          status: state.status as UsageSyncStatus,
          error: state.errorMessage,
      });
    }
    hydrateDurableUsage(chunks);
    if (chunks.length > 0) {
      logger.info({ chunks: chunks.length, scopes: states.length }, "Incremental usage cache hydrated from DB");
    }
    const projectsByWorkspace = new Map<string, Map<string, ProjectInfo>>();
    for (const state of projectStates) {
      if (state.status !== "success") continue;
      projectsByWorkspace.set(state.workspaceId, new Map());
    }
    for (const row of projectRows) {
      const workspace = projectsByWorkspace.get(row.workspaceId);
      if (!workspace) continue;
      workspace.set(row.projectId, { title: row.title, creatorId: row.creatorId });
    }
    for (const [workspaceId, projects] of projectsByWorkspace) {
      if (!projectInfoCache.has(workspaceId)) {
        projectInfoCache.set(workspaceId, projects);
        const completedAt = projectStates.find(
          (state) => state.workspaceId === workspaceId && state.status === "success",
        )?.completedAt;
        if (completedAt) projectInfoFetchedAt.set(workspaceId, completedAt.getTime());
      }
    }
    if (projectStates.length > 0) {
      logger.info({ workspaces: projectStates.length, projects: projectRows.length }, "Project metadata hydrated from DB");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to hydrate caches from DB — will fetch fresh on first request");
  }
  // Revalidate on process startup before resolving the account anchor. Hydrated
  // metadata remains the immediate fallback if this live request fails.
  await refreshBillingPeriodMetadata(0, true);
  // Publish the one-call account anchor before hundreds of newly keyed group
  // warm-up scopes can occupy the serial queue.
  queueAccountTotalVerification(-10);
  if (!billingPeriodRefreshTimer) {
    billingPeriodRefreshTimer = setInterval(() => {
      void refreshBillingPeriodMetadata(1).then(() => queueAccountTotalVerification(1));
    }, BILLING_PERIOD_REFRESH_MS);
    billingPeriodRefreshTimer.unref();
  }
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
  } | null,
): void {
  if (!fixture) {
    directoryCache = null;
    return;
  }
  directoryCache = {
    fetchedAt: Date.now(),
    workspaces: fixture.workspaces ?? new Map(),
    groups: fixture.groups,
    allGroups: fixture.groups,
    groupMembers: fixture.groupMembers ?? new Map(),
    members: fixture.members,
    budgets: { groupLimits: new Map(), userLimits: new Map(), workspaceDefaults: new Map() },
  };
}
export async function getDirectory(force = false): Promise<DirectoryCache> {
  const now = Date.now();
  if (!force && directoryCache && now - directoryCache.fetchedAt < DIRECTORY_TTL_MS) {
    return directoryCache;
  }
  if (directoryPromise) return directoryPromise;
  directoryPromise = (async () => {
    try {
      const workspaces = await paginate<EnterpriseWorkspace>("/workspaces", {});
      const wsMap = new Map(workspaces.map((w) => [w.id, w]));

      const allGroups: EnterpriseGroup[] = [];
      for (const ws of workspaces) {
        const wsGroups = await paginate<EnterpriseGroup>("/groups", { workspaceId: ws.id });
        for (const g of wsGroups) {
          allGroups.push({ ...g, workspaceId: g.workspaceId || ws.id });
        }
      }
      const groups = allGroups.filter(isCustomGroup);

      const groupMembers = new Map<string, string[]>();
      for (const g of groups) {
        try {
          const users = await paginate<{ userId: string }>(
            `/groups/${encodeURIComponent(g.id)}/users`,
            {},
          );
          groupMembers.set(g.id, users.map((u) => u.userId));
        } catch (err) {
          logger.warn({ err, groupId: g.id }, "Failed to fetch group members");
        }
      }

      const rawMembers = await paginate<RawMember>("/members", {});
      const members = new Map<string, EnterpriseMember>();
      for (const rm of rawMembers) {
        const name =
          [rm.user.firstName, rm.user.lastName].filter(Boolean).join(" ") || null;
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
      try {
        const rawBudgets = await paginate<RawBudget>("/budgets", {});
        for (const b of rawBudgets) {
          if (!b.workspaceId || b.amountUsd == null) continue;
          if (b.type === "workspace_group_limit" && b.groupId) {
            if (!budgets.groupLimits.has(b.workspaceId))
              budgets.groupLimits.set(b.workspaceId, new Map());
            budgets.groupLimits.get(b.workspaceId)!.set(b.groupId, b.amountUsd);
          } else if (b.type === "workspace_user_limit" && b.userId) {
            if (!budgets.userLimits.has(b.workspaceId))
              budgets.userLimits.set(b.workspaceId, new Map());
            budgets.userLimits.get(b.workspaceId)!.set(b.userId, b.amountUsd);
          } else if (b.type === "workspace_default_user_limit") {
            budgets.workspaceDefaults.set(b.workspaceId, b.amountUsd);
          }
        }
      } catch (err) {
        logger.warn({ err }, "Failed to fetch platform budgets");
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
      return directoryCache;
    } finally {
      directoryPromise = null;
    }
  })();
  return directoryPromise;
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
      persistSpendToDb(range.key, group.id, spend);
      // The network request has landed and cache is current. Release the queue
      // key before callbacks run so a callback-triggered forced refresh is a
      // new request rather than being reported as a duplicate of the finished one.
      queuedKeys.delete(`usage:${cacheKey}`);
      fireSpendCallbacks(cacheKey, spend);
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch group usage");
      // Drop pending callbacks so they don't fire with a later, unrelated fetch.
      spendCallbacks.delete(cacheKey);
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
  const queued = enqueueUsage(`account-usage:${range.key}`, cached ? priority : 0, async () => {
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

async function verifyAccountTotal(range: UsageRange, scheduleRetry = true): Promise<void> {
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

async function rebuildUsageRangeAtomically(
  range: UsageRange,
  scopes: FullRebuildScope[],
): Promise<FullRebuildResult[]> {
  await maybePruneExpiredCustomUsage();
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

    const staged: Array<{
      scope: FullRebuildScope;
      chunks: Array<{
        start: Date;
        end: Date;
        payload: StoredUsagePayload;
        partial: boolean;
        error: string | null;
      }>;
      isClosed: boolean;
    }> = [];
    for (const scope of scopes) {
      const plan = planSyncChunks(range, undefined);
      const chunks: Array<{
        start: Date;
        end: Date;
        payload: StoredUsagePayload;
        partial: boolean;
        error: string | null;
      }> = [];
      for (const chunk of plan.chunks) {
        if (chunks.length > 0 || staged.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        const fetched = await fetchUsageChunk(
          scope.mode,
          scope.params,
          chunk.start,
          chunk.end,
        );
        chunks.push({ ...chunk, ...fetched });
      }
      staged.push({ scope, chunks, isClosed: plan.isClosed });
    }

    // Nothing is removed until every upstream fetch succeeds. Any thrown error
    // rolls back the whole selected range, not just the currently fetched scope.
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

    return staged.map(({ scope, chunks, isClosed }) => ({
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
  return enqueueUsage(`full-range-rebuild:${range.key}`, 0, async () => {
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
          persistSpendToDb(range.key, scopeKey, spend);
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
    }
  });
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
  const queued = enqueueUsage(`member-usage:${cacheKey}`, cached ? priority : 0, async () => {
    try {
      const rows = await synchronizeUsage("group_member", range, group.id, {
        workspaceId: group.workspaceId,
        groupId: group.id,
      }, force);
      memberUsageCache.set(cacheKey, aggregateMemberUsage(rows));
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch member usage");
    }
  });
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
  const queued = enqueueUsage(`ws-spend:${cacheKey}`, cached ? priority : 0, async () => {
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
    const winner = projectCandidates.slice().sort(
      (a, b) => b.spendUsd - a.spendUsd || a.group.id.localeCompare(b.group.id),
    )[0]!;

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
      : [...groups]
        .filter((group) => group.workspaceId === winner.group.workspaceId)
        .sort(
          (a, b) =>
            a.workspaceId.localeCompare(b.workspaceId) ||
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
            a.id.localeCompare(b.id),
        )
        .find((group) => (groupMembers?.get(group.id) ?? []).includes(creatorId));
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
  const queued = enqueueUsage(`project-usage:${cacheKey}`, cached ? priority : 0, async () => {
    try {
      const rows = await synchronizeUsage("group_project", range, group.id, {
        workspaceId: group.workspaceId,
        groupId: group.id,
      }, force);
      projectUsageCache.set(cacheKey, aggregateProjectUsage(rows));
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch project usage");
    }
  });
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
  return enqueueUsage(`project-titles:${workspaceId}`, hasStoredSnapshot ? priority : 0, async () => {
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
    const workspaceGroups = ordered.filter((group) => group.workspaceId === workspaceId);
    const workspaceUsage = wsSpendCache.get(`${rangeKey}|${workspaceId}`);
    if (!workspaceUsage) pendingCount += 1;

    const candidates = new Set<string>();
    for (const member of directoryMembers?.values() ?? []) {
      if (member.workspaces.has(workspaceId)) candidates.add(member.userId);
    }
    for (const userId of workspaceUsage?.byUser.keys() ?? []) candidates.add(userId);
    for (const group of workspaceGroups) {
      for (const userId of groupMembers?.get(group.id) ?? []) candidates.add(userId);
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
            (groupMembers?.get(group.id) ?? []).includes(userId) ||
            usageByGroup.get(group.id)?.byUser.has(userId),
          )
          : undefined;

      // Otherwise find the first group in this workspace (stable order) whose
      // directory or usage membership contains the user.
      let owner = parentComcastOwner ?? workspaceGroups.find(
        (group) =>
          (groupMembers?.get(group.id) ?? []).includes(userId) ||
          usageByGroup.get(group.id)?.byUser.has(userId),
      );

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
            (groupMembers?.get(group.id) ?? []).includes(userId) ||
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
  ]
): CanonicalUsageResult {
  const [
    teamByGroupName,
    workspaces,
    includeAccountMetadata = false,
    requireGroupMemberUsage = false,
  ] = options;
  const rollup = getDedupedUsageRollup(
    groups,
    rangeKey,
    workspaceIds,
    groupMembers,
    directoryMembers,
    workspaces,
  );
  const projectAttribution = getProjectAttribution(
    rangeKey,
    groups,
    workspaces,
    groupMembers,
  );

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
  for (const group of orderedGroups) {
    attributedByGroup.set(group.id, new Map());
    aiSpendByGroup.set(group.id, new Map());
    nonAiSpendByGroup.set(group.id, new Map());
  }
  const remainingGroupCapacity = (groupId: string): number => {
    const groupTotal = rollup.byGroup.get(groupId)?.spendUsd ?? 0;
    const attributed = [...(attributedByGroup.get(groupId)?.values() ?? [])]
      .reduce((sum, value) => sum + value, 0);
    return Math.max(0, groupTotal - attributed);
  };
  for (const workspaceId of new Set(orderedGroups.map((group) => group.workspaceId))) {
    const workspaceGroups = orderedGroups.filter((group) => group.workspaceId === workspaceId);
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
      const owner =
        workspaceGroups.find((group) => rollup.byGroup.get(group.id)?.byUser.has(userId)) ??
        workspaceGroups.find((group) =>
          (groupMembers?.get(group.id) ?? []).includes(userId),
        );
      if (!owner) continue;
      // Observed AI spend comes from per-group member-usage APIs.
      // Exception: users attributed via the workspace-admin fallback are absent
      // from all group member-usage APIs (they are not formal group members),
      // so their spend would be silently zeroed out and classified as residual.
      // For these users only — those absent from every group's groupMembers —
      // fall back to the rollup's per-user total (workspace spend from
      // wsSpendCache). Regular members with $0 AI spend intentionally stay
      // as residual; the inGroupMembers guard preserves that invariant.
      const inGroupMembers = workspaceGroups.some((group) =>
        (groupMembers?.get(group.id) ?? []).includes(userId),
      );
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
      aiSpendByGroup.get(owner.id)!.set(userId, aiSpendUsd);
    }
  }
  for (const [winnerGroupId, nonAiByUser] of projectAttribution.creatorNonAiSpendByGroup) {
    const winnerGroup = orderedGroups.find((group) => group.id === winnerGroupId);
    if (!winnerGroup) continue;
    const workspaceGroups = orderedGroups.filter(
      (group) => group.workspaceId === winnerGroup.workspaceId,
    );
    for (const [userId, nonAiSpendUsd] of nonAiByUser) {
      // Project deduplication selects the highest-total winning observation,
      // but per-user ownership follows the same stable member owner as AI.
      // Otherwise an overlapping creator can be counted in both their stable
      // owner group and the winning project's group.
      // Mirror the AI-loop ownership rule: prefer the rollup's byUser (which
      // already encodes Comcast re-homing and workspace-admin attribution) over
      // groupMembers, so re-homed users' non-AI spend lands in the destination
      // group rather than the (now zero-capacity) source group.
      const owner =
        workspaceGroups.find((group) => rollup.byGroup.get(group.id)?.byUser.has(userId)) ??
        workspaceGroups.find((group) =>
          (groupMembers?.get(group.id) ?? []).includes(userId),
        );
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
  const creatorAttributionRequired =
    loadedProjectNonAiSpendUsd > 1e-9 ||
    rollup.totalSpendUsd - knownUngroupedResidualUsd - aiSpendUsd > 1e-9;
  const effectiveProjectPendingCount = creatorAttributionRequired
    ? projectAttribution.pendingCount
    : 0;
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
  const missingMemberUsageCount = requireGroupMemberUsage
    ? groups.filter((group) => !getMemberUsage(group.id, rangeKey)).length
    : 0;
  return {
    ...rollup,
    isComplete:
      rollup.isComplete &&
      missingMemberUsageCount === 0 &&
      (!creatorAttributionRequired || projectAttribution.isComplete),
    pendingCount:
      rollup.pendingCount +
      missingMemberUsageCount +
      effectiveProjectPendingCount,
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
    residualSpendByGroup,
    residualSpendUsd,
    creatorAttributionRequired,
  };
}

export function getDedupedMemberCounts(
  groups: EnterpriseGroup[],
  membersByGroup: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  return computeDedupedMemberCounts(groups, membersByGroup);
}

/** Test-only seam for simulating a process restart before calling initCache(). */
export function __resetDurableUsageCachesForTests(): void {
  accountUsageCache.clear();
  spendCache.clear();
  memberUsageCache.clear();
  wsSpendCache.clear();
  wsSpendCachedAt.clear();
  projectUsageCache.clear();
  projectInfoCache.clear();
  syncMetadata.clear();
  billingPeriodCache = null;
  accountTotalVerificationState = null;
  if (accountVerificationRetryTimer) clearTimeout(accountVerificationRetryTimer);
  accountVerificationRetryTimer = null;
  accountVerificationFailureCount = 0;
  accountUsageRetryAt.clear();
  accountUsageFailureCount.clear();
  for (const timer of accountUsageRetryTimers.values()) clearTimeout(timer);
  accountUsageRetryTimers.clear();
}

export function __setBillingPeriodForTests(period: StoredBillingPeriod | null): void {
  billingPeriodCache = period;
}

export function __planSyncChunksForTests(
  range: UsageRange,
  previous: SyncMetadata | undefined,
  now: number,
): { replacementStart: string; chunks: Array<{ start: string; end: string }>; isClosed: boolean } {
  const plan = planSyncChunks(range, previous, now);
  return {
    replacementStart: plan.replacementStart.toISOString(),
    chunks: plan.chunks.map((chunk) => ({
      start: chunk.start.toISOString(),
      end: chunk.end.toISOString(),
    })),
    isClosed: plan.isClosed,
  };
}

export function __rebuildAccountUsageForTests(range: UsageRange): Promise<UsageSyncChunk[]> {
  return rebuildUsageRangeAtomically(range, [{
    mode: "account_total",
    scopeKey: ACCOUNT_USAGE_SCOPE,
    params: {},
  }]).then(([result]) => result?.rows ?? []);
}

export async function __verifyAccountTotalForTests(range: UsageRange): Promise<void> {
  await verifyAccountTotal(range, false);
}

export function __rebuildAccountAndWorkspaceUsageForTests(
  range: UsageRange,
  workspaceId: string,
): Promise<FullRebuildResult[]> {
  return rebuildUsageRangeAtomically(range, [
    { mode: "account_total", scopeKey: ACCOUNT_USAGE_SCOPE, params: {} },
    { mode: "workspace_member", scopeKey: workspaceId, params: { workspaceId } },
  ]);
}

export async function __getDurableRangeRowsForTests(
  rangeKey: string,
): Promise<UsageSyncChunk[]> {
  return db.select()
    .from(usageSyncChunksTable)
    .where(eq(usageSyncChunksTable.rangeKey, rangeKey))
    .orderBy(
      usageSyncChunksTable.mode,
      usageSyncChunksTable.scopeKey,
      usageSyncChunksTable.chunkStart,
    );
}
