import { logger } from "./logger";
import { db } from "@workspace/db";
import {
  apiDirectoryCacheTable,
  apiSpendCacheTable,
  usageSyncChunksTable,
  usageSyncStateTable,
  type UsageSyncChunk,
} from "@workspace/db/schema";
import { and, eq, gte, like, lt, sql } from "drizzle-orm";
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
      return {
        key: "billing:from-cutoff",
        label: SPEND_DATA_CUTOFF_LABEL,
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
}

const RECONCILIATION_OVERLAP_MS = 48 * 60 * 60 * 1000;
const MAX_USAGE_PAGES = 200;
/** Closed custom snapshots are retained long enough for normal reporting needs. */
export const CUSTOM_RANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const syncMetadata = new Map<string, SyncMetadata>();
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

function rangeBounds(range: UsageRange): { start: Date; end: Date; isClosed: boolean } {
  const start = new Date(range.params.startTime);
  const end = new Date(range.params.endTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new EnterpriseApiError(400, "Usage range must have valid startTime/endTime boundaries");
  }
  // MTD/YTD/default ranges expand while their key remains stable. Custom ranges
  // whose exclusive end has passed are immutable after one complete sync.
  const isClosed = range.key.startsWith("custom:") && end.getTime() <= Date.now();
  return { start, end, isClosed };
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function planSyncChunks(
  range: UsageRange,
  previous: SyncMetadata | undefined,
): { replacementStart: Date; chunks: Array<{ start: Date; end: Date }>; isClosed: boolean } {
  const { start, end, isClosed } = rangeBounds(range);
  if (previous?.isClosed || (previous && previous.syncedThrough >= end.getTime() &&
      Date.now() - previous.completedAt < USAGE_TTL_MS)) {
    return { replacementStart: end, chunks: [], isClosed: previous.isClosed };
  }

  if (isClosed) {
    return { replacementStart: start, chunks: [{ start, end }], isClosed: true };
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

async function fetchUsageChunk(
  mode: UsageSyncMode,
  baseParams: Record<string, string | undefined>,
  start: Date,
  end: Date,
): Promise<StoredUsagePayload> {
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
        totalCostUsd: first.totalCostUsd,
        attributableTotalCostUsd: first.attributableTotalCostUsd ?? 0,
        unattributableTotalCostUsd: first.unattributableTotalCostUsd ?? 0,
        groups,
      };
    }
    if (!data.pagination.cursor) {
      throw new Error("Usage pagination reported more pages without a cursor");
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
      return { rows, metadata: storedPrevious! };
    }

    // Every chunk/page is fetched before any DELETE/INSERT. A network failure
    // rolls back the transaction and preserves the prior snapshot + watermark.
    const fetched: Array<{ start: Date; end: Date; payload: StoredUsagePayload }> = [];
    for (const chunk of plan.chunks) {
      if (fetched.length > 0) {
        await new Promise((r) => setTimeout(r, 700));
      }
      fetched.push({
        ...chunk,
        payload: await fetchUsageChunk(mode, baseParams, chunk.start, chunk.end),
      });
    }

    const completedAt = new Date();
    const { start: rangeStart, end: syncedThrough } = rangeBounds(range);
    await tx
      .delete(usageSyncChunksTable)
      .where(and(
        eq(usageSyncChunksTable.mode, mode),
        eq(usageSyncChunksTable.rangeKey, range.key),
        eq(usageSyncChunksTable.scopeKey, scopeKey),
        gte(usageSyncChunksTable.chunkStart, plan.replacementStart),
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
      completedAt,
    }).onConflictDoUpdate({
      target: [usageSyncStateTable.mode, usageSyncStateTable.rangeKey, usageSyncStateTable.scopeKey],
      set: { rangeStart, syncedThrough, isClosed: plan.isClosed, completedAt },
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
        isClosed: plan.isClosed,
      },
    };
  });
  syncMetadata.set(id, result.metadata);
  return result.rows;
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
  if (metadata?.isClosed) return true;
  return !force && fetchedAt !== undefined && Date.now() - fetchedAt < USAGE_TTL_MS;
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
    const [dirRow, spendRows, durable] = await Promise.all([
      db.query.apiDirectoryCacheTable.findFirst({ where: eq(apiDirectoryCacheTable.id, "singleton") }),
      db.select().from(apiSpendCacheTable),
      db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level repeatable read read only`);
        const states = await tx.select().from(usageSyncStateTable);
        const chunks = await tx.select().from(usageSyncChunksTable);
        return { states, chunks };
      }),
    ]);
    const { states, chunks } = durable;

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
      });
    }
    hydrateDurableUsage(chunks);
    if (chunks.length > 0) {
      logger.info({ chunks: chunks.length, scopes: states.length }, "Incremental usage cache hydrated from DB");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to hydrate caches from DB — will fetch fresh on first request");
  }
}

interface DirectoryCache {
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
    return;
  }

  const rangeKey = first;
  const usageByGroup = second;
  const unattributableByGroup = (third as ReadonlyMap<string, number> | undefined) ?? new Map();
  for (const key of memberUsageCache.keys()) {
    if (key.startsWith(`${rangeKey}|`)) memberUsageCache.delete(key);
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

export function getBillingPeriod(): { start: string | null; label: string } {
  for (const [k, s] of spendCache) {
    if (!k.startsWith("billing:from-cutoff|")) continue;
    return {
      start: s.periodStart,
      label: SPEND_DATA_CUTOFF_LABEL,
    };
  }
  return {
    start: null,
    label: SPEND_DATA_CUTOFF_LABEL,
  };
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
  return enqueueUsage(`account-usage:${range.key}`, priority, async () => {
    try {
      const rows = await synchronizeUsage(
        "account_total",
        range,
        ACCOUNT_USAGE_SCOPE,
        {},
        force,
      );
      accountUsageCache.set(range.key, aggregateAccountUsage(rows));
    } catch (err) {
      logger.error({ err, range: range.key }, "Failed to fetch account usage");
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
  return enqueueUsage(`member-usage:${cacheKey}`, priority, async () => {
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
  return enqueueUsage(`ws-spend:${cacheKey}`, priority, async () => {
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

const PRIMARY_COMCAST_WORKSPACE_ID = "1awqan";

export interface ProjectAttribution {
  projectToGroup: Map<string, string>;
  spendByGroup: Map<string, number>;
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
 * Projects reported in both the primary Comcast workspace and a sub-workspace
 * belong to the sub-workspace. Otherwise the group reporting the highest spend
 * wins, with a stable group-ID tie break. Spend that the API includes in a
 * group's total without a project ID cannot be matched and is surfaced as
 * enterprise-level unattributed project spend.
 */
export function getProjectAttribution(
  rangeKey: string,
  groups: readonly EnterpriseGroup[],
  _workspaces: ReadonlyMap<string, EnterpriseWorkspace>,
): ProjectAttribution {
  const candidates = new Map<string, Array<{ group: EnterpriseGroup; spendUsd: number }>>();
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
      projectCandidates.push({ group, spendUsd: project.totalCostUsd });
      candidates.set(project.projectId, projectCandidates);
    }
    unattributedSpendUsd += Math.max(0, usage.totalCostUsd - identifiedSpendUsd);
  }

  const projectToGroup = new Map<string, string>();
  const spendByGroup = new Map<string, number>();
  let attributedSpendUsd = 0;

  for (const [projectId, projectCandidates] of candidates) {
    const subWorkspaceCandidates = projectCandidates.filter(
      ({ group }) => group.workspaceId !== PRIMARY_COMCAST_WORKSPACE_ID,
    );
    const eligible =
      subWorkspaceCandidates.length > 0 ? subWorkspaceCandidates : projectCandidates;
    const winner = eligible.slice().sort(
      (a, b) => b.spendUsd - a.spendUsd || a.group.id.localeCompare(b.group.id),
    )[0]!;

    projectToGroup.set(projectId, winner.group.id);
    spendByGroup.set(
      winner.group.id,
      (spendByGroup.get(winner.group.id) ?? 0) + winner.spendUsd,
    );
    attributedSpendUsd += winner.spendUsd;
  }

  return {
    projectToGroup,
    spendByGroup,
    unattributedSpendUsd,
    totalSpendUsd: attributedSpendUsd + unattributedSpendUsd,
    isComplete: loadedCount === groups.length,
    pendingCount: groups.length - loadedCount,
  };
}

/** Test-only seam for project attribution fixtures. */
export function __setProjectUsageForTests(
  groupId: string,
  rangeKey: string,
  usage: ProjectUsage | null,
): void {
  const key = `${rangeKey}|${groupId}`;
  if (usage) projectUsageCache.set(key, usage);
  else projectUsageCache.delete(key);
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
  return enqueueUsage(`project-usage:${cacheKey}`, priority, async () => {
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

/** Returns true if project info (titles + creatorIds) has been fetched for this workspace. */
export function hasProjectInfo(workspaceId: string): boolean {
  return projectInfoCache.has(workspaceId);
}

export function queueProjectTitlesFetch(workspaceId: string, priority = 0): boolean {
  if (projectInfoCache.has(workspaceId) || projectTitlesFetching.has(workspaceId)) return false;
  projectTitlesFetching.add(workspaceId);
  return enqueueUsage(`project-titles:${workspaceId}`, priority, async () => {
    try {
      const projects = await paginate<RawProject>("/projects", { workspaceId });
      const infoMap = new Map<string, ProjectInfo>();
      for (const p of projects) {
        infoMap.set(p.id, {
          title: p.title ?? null,
          creatorId: p.creatorId ?? null,
        });
      }
      projectInfoCache.set(workspaceId, infoMap);
    } catch (err) {
      logger.warn({ err, workspaceId }, "Failed to fetch project titles");
    } finally {
      projectTitlesFetching.delete(workspaceId);
    }
  });
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
 */
export function getDedupedUsageRollup(
  groups: EnterpriseGroup[],
  rangeKey: string,
  workspaceIds?: ReadonlySet<string>,
  groupMembers?: ReadonlyMap<string, readonly string[]>,
  directoryMembers?: ReadonlyMap<string, EnterpriseMember>,
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
  const ungroupedByWorkspace = new Map<string, DedupedGroupRollup>();
  const scopedWorkspaceIds =
    workspaceIds ?? new Set(ordered.map((group) => group.workspaceId));

  let totalMemberCount = 0;
  let totalSpendUsd = 0;

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

      const owner = workspaceGroups.find(
        (group) =>
          (groupMembers?.get(group.id) ?? []).includes(userId) ||
          usageByGroup.get(group.id)?.byUser.has(userId),
      );
      const target = owner ? byGroup.get(owner.id)! : ungrouped;
      const targetByUser = target.byUser as Map<string, number>;
      targetByUser.set(userId, spendUsd);
      (target as { spendUsd: number }).spendUsd += spendUsd;
      (target as { memberCount: number }).memberCount += 1;
      totalMemberCount += 1;
      totalSpendUsd += spendUsd;
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

  return {
    byGroup,
    ungroupedByWorkspace,
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
  );
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
    isComplete: rollup.isComplete && missingMemberUsageCount === 0,
    pendingCount: rollup.pendingCount + missingMemberUsageCount,
    rangeKey,
    mergePlan,
    displayGroups,
    spendByPrimaryGroup,
    byTeam,
    accountUsage,
    accountReconciliationSpendUsd: accountUsage
      ? accountUsage.totalCostUsd - rollup.totalSpendUsd
      : null,
    projectAttribution: getProjectAttribution(rangeKey, groups, workspaces),
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
  syncMetadata.clear();
}
