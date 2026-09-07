import { pool } from "@workspace/db";
import type { UsageWindow } from "./usage-window";
import { sumAgentUsageMetrics } from "./usage-metrics";
import {
  BoundedTaskScheduler,
  estimateRetainedBytes,
} from "./bounded-stale-cache";

const DAY_MS = 86_400_000;
export const DEFAULT_USAGE_LIVE_STALE_AFTER_MS = 20 * 60_000;
export const DEFAULT_USAGE_CACHE_MAX_AGE_MS = 30_000;
export const DEFAULT_USAGE_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_USAGE_CACHE_MAX_BYTES = 128 * 1024 * 1024;

export type UsageSnapshotStatus = "complete" | "stale" | "partial" | "empty";

export interface MemberUsageTotal {
  totalCostUsd: number;
  aiCostUsd: number;
  agentMetricsComplete?: boolean;
}

export interface ProjectUsageTotal {
  totalCostUsd: number;
  aiCostUsd: number;
}

export interface WorkspaceUsageTotal {
  totalCostUsd: number;
  memberAttributableUsd: number;
  memberUnattributableUsd: number;
}

export interface DailyUsageTotal {
  accountTotalUsd: number;
  workspaceTotalUsd: number;
}

export interface UsageCoverage {
  requestedDays: number;
  requestedWorkspaceDays: number;
  presentWorkspaceDays: number;
  failedWorkspaceDays: Array<{ workspaceId: string; usageDate: string }>;
  missingWorkspaceDays: Array<{ workspaceId: string; usageDate: string }>;
  presentAccountDays: number;
  missingAccountDays: string[];
  ratio: number;
}

export interface UsageRefreshFailure {
  workspaceId: string | null;
  usageDate: string;
  attemptedAt: string;
}

export interface UsageSnapshot {
  window: UsageWindow;
  workspaceIds: string[] | null;
  includesDailyMembers: boolean;
  status: UsageSnapshotStatus;
  /** Readiness of workspace-derived metrics, independent of the account anchor. */
  workspaceStatus: UsageSnapshotStatus;
  /** Oldest relevant successful workspace observation, excluding account data. */
  workspaceDataAsOf: string | null;
  /** False when the caller deliberately omitted the account-wide anchor. */
  includesAccountAnchor: boolean;
  dataAsOf: string | null;
  isLive: boolean;
  hasPersistentlyStaleRows: boolean;
  /** Failed attempts newer than the last successful fact for the same unit. */
  latestFailedAttempts: UsageRefreshFailure[];
  coverage: UsageCoverage;
  members: Map<string, Map<string, MemberUsageTotal>>;
  projects: Map<string, Map<string, ProjectUsageTotal>>;
  workspaces: Map<string, WorkspaceUsageTotal>;
  daily: Map<string, DailyUsageTotal>;
  accountDays: Set<string>;
  accountTotalUsd: number;
  dailyMembers?: Map<string, Map<string, Map<string, MemberUsageTotal>>>;
  dailyProjects?: Map<string, Map<string, Map<string, ProjectUsageTotal>>>;
  dailyWorkspaces?: Map<string, Map<string, WorkspaceUsageTotal>>;
}

export interface UsageSnapshotRequest {
  window: UsageWindow;
  workspaceIds?: Iterable<string>;
  includeDailyMembers?: boolean;
  /**
   * Account totals are privileged reconciliation data. Workspace-only callers
   * can omit them without making otherwise complete workspace facts partial.
   * Defaults to true for compatibility with existing account-wide readers.
   */
  includeAccountAnchor?: boolean;
}

interface QueryResult {
  rows: Record<string, unknown>[];
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

interface ReleasableQueryable extends Queryable {
  release(): void;
}

interface ConnectableQueryable extends Queryable {
  connect?(): Promise<ReleasableQueryable>;
}

interface UsageStoreOptions {
  queryable?: ConnectableQueryable;
  now?: () => number;
  staleAfterMs?: number;
  cacheMaxAgeMs?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
}

interface MemoEntry {
  promise: Promise<UsageSnapshot>;
  snapshot?: UsageSnapshot;
  expiresAt: number;
  weight: number;
}

function normalizedWindow(window: UsageWindow): {
  window: UsageWindow;
  startDay: string;
  endDay: string;
  dayCount: number;
} {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    start % DAY_MS !== 0 ||
    end % DAY_MS !== 0
  ) {
    throw new Error("Usage windows must be non-empty, exclusive-end UTC day boundaries");
  }
  return {
    window: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    },
    startDay: new Date(start).toISOString().slice(0, 10),
    endDay: new Date(end).toISOString().slice(0, 10),
    dayCount: (end - start) / DAY_MS,
  };
}

function normalizeScope(workspaceIds: Iterable<string> | undefined): string[] | null {
  if (workspaceIds === undefined) return null;
  return [...new Set([...workspaceIds].map(String).filter(Boolean))].sort();
}

function dates(startDay: string, count: number): string[] {
  const start = Date.parse(`${startDay}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10));
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function fetchedTime(value: unknown): number | null {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function nested<K1, K2, V>(map: Map<K1, Map<K2, V>>, first: K1): Map<K2, V> {
  const existing = map.get(first);
  if (existing) return existing;
  const created = new Map<K2, V>();
  map.set(first, created);
  return created;
}

function addDaily(daily: Map<string, DailyUsageTotal>, usageDate: string): DailyUsageTotal {
  const existing = daily.get(usageDate);
  if (existing) return existing;
  const created = {
    accountTotalUsd: 0,
    workspaceTotalUsd: 0,
  };
  daily.set(usageDate, created);
  return created;
}

export function createUsageStore(options: UsageStoreOptions = {}): {
  read(request: UsageSnapshotRequest): Promise<UsageSnapshot>;
  invalidate(): void;
  memoSize(): number;
} {
  const queryable = options.queryable ?? pool;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_USAGE_LIVE_STALE_AFTER_MS;
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_USAGE_CACHE_MAX_AGE_MS;
  const cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_USAGE_CACHE_MAX_ENTRIES;
  const cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_USAGE_CACHE_MAX_BYTES;
  if (!Number.isFinite(cacheMaxAgeMs) || cacheMaxAgeMs < 0) {
    throw new Error("Usage cache max age must be a non-negative finite number");
  }
  if (!Number.isInteger(cacheMaxEntries) || cacheMaxEntries < 1) {
    throw new Error("Usage cache max entries must be a positive integer");
  }
  if (!Number.isFinite(cacheMaxBytes) || cacheMaxBytes < 1) {
    throw new Error("Usage cache max bytes must be a positive finite number");
  }
  const memo = new Map<string, MemoEntry>();
  const readScheduler = new BoundedTaskScheduler(4, 16);
  let memoWeight = 0;

  function remove(key: string): void {
    const existing = memo.get(key);
    if (!existing) return;
    memoWeight -= existing.weight;
    memo.delete(key);
  }

  function trim(): void {
    const at = now();
    for (const [key, entry] of memo) {
      if (entry.snapshot && at >= entry.expiresAt) remove(key);
    }
    while (memo.size > cacheMaxEntries || memoWeight > cacheMaxBytes) {
      const oldest = [...memo].find(([, entry]) =>
        entry.snapshot !== undefined &&
        (memoWeight <= cacheMaxBytes || entry.weight > 0))?.[0];
      if (oldest === undefined) break;
      remove(oldest);
    }
  }

  function put(key: string, entry: MemoEntry): void {
    remove(key);
    memo.set(key, entry);
    memoWeight += entry.weight;
    trim();
  }

  function currentEntry(key: string): MemoEntry | undefined {
    const entry = memo.get(key);
    if (!entry) return undefined;
    if (entry.snapshot && now() >= entry.expiresAt) {
      remove(key);
      return undefined;
    }
    // Successful warm entries are LRU-touched. In-flight reads retain their
    // insertion position so a flood of distinct scopes remains bounded.
    if (entry.snapshot) put(key, entry);
    return entry;
  }

  function emptySnapshot(
    resolved: ReturnType<typeof normalizedWindow>,
    scope: string[],
    includeDailyMembers: boolean,
    includeAccountAnchor: boolean,
  ): UsageSnapshot {
    const dayCount = resolved.dayCount;
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    return {
      window: resolved.window,
      workspaceIds: scope,
      includesDailyMembers: includeDailyMembers,
      status: "empty",
      workspaceStatus: "empty",
      workspaceDataAsOf: null,
      includesAccountAnchor: includeAccountAnchor,
      dataAsOf: null,
      isLive: Date.parse(resolved.window.end) > todayStart,
      hasPersistentlyStaleRows: false,
      latestFailedAttempts: [],
      coverage: {
        requestedDays: dayCount,
        requestedWorkspaceDays: 0,
        presentWorkspaceDays: 0,
        failedWorkspaceDays: [],
        missingWorkspaceDays: [],
        presentAccountDays: 0,
        missingAccountDays: [],
        ratio: 1,
      },
      members: new Map(),
      projects: new Map(),
      workspaces: new Map(),
      daily: new Map(),
      accountDays: new Set(),
      accountTotalUsd: 0,
      ...(includeDailyMembers
        ? {
            dailyMembers: new Map(),
            dailyProjects: new Map(),
            dailyWorkspaces: new Map(),
          }
        : {}),
    };
  }

  function refreshTimeClassification(snapshot: UsageSnapshot): UsageSnapshot {
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    const liveStart = todayStart - 2 * DAY_MS;
    const isLive =
      Date.parse(snapshot.window.end) > liveStart &&
      Date.parse(snapshot.window.start) < todayStart + DAY_MS;
    const dataAsOfMs = snapshot.dataAsOf === null
      ? null
      : Date.parse(snapshot.dataAsOf);
    const workspaceDataAsOfMs = snapshot.workspaceDataAsOf === null
      ? null
      : Date.parse(snapshot.workspaceDataAsOf);
    const workspaceStatus: UsageSnapshotStatus =
      snapshot.workspaceStatus === "partial" ||
        snapshot.workspaceStatus === "empty"
        ? snapshot.workspaceStatus
        : snapshot.hasPersistentlyStaleRows ||
            snapshot.latestFailedAttempts.some(
              (failure) => failure.workspaceId !== null) ||
            (isLive &&
              (workspaceDataAsOfMs === null ||
                now() - workspaceDataAsOfMs > staleAfterMs))
        ? "stale"
        : "complete";
    const status: UsageSnapshotStatus =
      snapshot.status === "partial" || snapshot.status === "empty"
        ? snapshot.status
        : !snapshot.includesAccountAnchor
        ? workspaceStatus
        : snapshot.hasPersistentlyStaleRows ||
          snapshot.latestFailedAttempts.length > 0 ||
        (isLive && (dataAsOfMs === null || now() - dataAsOfMs > staleAfterMs))
      ? "stale"
      : "complete";
    return status === snapshot.status &&
        workspaceStatus === snapshot.workspaceStatus &&
        isLive === snapshot.isLive
      ? snapshot
      : { ...snapshot, status, workspaceStatus, isLive };
  }

  async function load(
    request: UsageSnapshotRequest,
    resolved: ReturnType<typeof normalizedWindow>,
    scope: string[] | null,
  ): Promise<UsageSnapshot> {
    const values: unknown[] = [resolved.startDay, resolved.endDay];
    const workspaceFilter = scope === null
      ? ""
      : " and workspace_id = any($3::text[])";
    if (scope !== null) values.push(scope);

    const readTables = async (reader: Queryable) => {
      // node-postgres does not support concurrent queries on one client. Keep
      // these sequential so every result is both snapshot-consistent and free
      // of the client's deprecated implicit queueing behavior.
      const memberResult = await reader.query(
          request.includeDailyMembers
            ? `select workspace_id,user_id,usage_date::text,total_cost_usd,ai_cost_usd,
                      (total_cost_usd=0 or
                       (jsonb_typeof(metrics_json)='array' and jsonb_array_length(metrics_json)>0))
                        as agent_metrics_complete
           from usage_member_day
           where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}`
            : `select workspace_id,user_id,sum(total_cost_usd)::float8 as total_cost_usd,
                      sum(ai_cost_usd)::float8 as ai_cost_usd,
                      bool_and(total_cost_usd=0 or
                        (jsonb_typeof(metrics_json)='array' and jsonb_array_length(metrics_json)>0))
                          as agent_metrics_complete
               from usage_member_day
               where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}
               group by workspace_id,user_id`,
          values,
        );
      const projectResult = await reader.query(
          `select workspace_id,project_id,usage_date::text,total_cost_usd,metrics_json
           from usage_project_day
           where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}`,
          values,
        );
      const workspaceResult = await reader.query(
          `select workspace_id,usage_date::text,total_cost_usd,member_attributable_usd,
                  member_unattributable_usd,fetched_at,status
           from usage_workspace_day
           where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}`,
          values,
        );
      const accountResult = request.includeAccountAnchor === false
        ? { rows: [] }
        : await reader.query(
          `select usage_date::text,total_cost_usd,fetched_at
           from usage_account_day
           where usage_date >= $1::date and usage_date < $2::date`,
          values.slice(0, 2),
          );
      const failedAttemptResult = await reader.query(
        `with failed_units as (
           select r.finished_at,
                  split_part(unit_key,'|',1) as usage_date,
                  nullif(split_part(unit_key,'|',2),'') as workspace_id
           from ingest_run r
           cross join lateral unnest(string_to_array(
             substring(r.error from char_length('failed-units:') + 1),
             E'\\n'
           )) unit_key
           where r.finished_at is not null
             and r.failures > 0
             and r.error like 'failed-units:%'
         )
         select usage_date,workspace_id,max(finished_at) as attempted_at
         from failed_units
         where usage_date >= $1 and usage_date < $2
           and usage_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
           and (
             (workspace_id is not null and
               ($3::text[] is null or workspace_id = any($3::text[])))
             or (workspace_id is null and $4::boolean)
           )
         group by usage_date,workspace_id
         order by usage_date,workspace_id`,
        [
          resolved.startDay,
          resolved.endDay,
          scope,
          request.includeAccountAnchor !== false,
        ],
      );
      return [
        memberResult,
        projectResult,
        workspaceResult,
        accountResult,
        failedAttemptResult,
      ] as const;
    };
    let results: Awaited<ReturnType<typeof readTables>>;
    if (queryable.connect) {
      const client = await queryable.connect();
      try {
        await client.query("begin transaction isolation level repeatable read read only");
        results = await readTables(client);
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve the read failure; a broken connection is discarded by pg.
        }
        throw error;
      } finally {
        client.release();
      }
    } else {
      // Injectable query-only adapters are retained for small unit tests.
      // Production uses the pool's connect() path above.
      results = await readTables(queryable);
    }
    const [
      memberResult,
      projectResult,
      workspaceResult,
      accountResult,
      failedAttemptResult,
    ] = results;

    const members = new Map<string, Map<string, MemberUsageTotal>>();
    const projects = new Map<string, Map<string, ProjectUsageTotal>>();
    const workspaces = new Map<string, WorkspaceUsageTotal>();
    const daily = new Map<string, DailyUsageTotal>();
    const dailyMembers = request.includeDailyMembers
      ? new Map<string, Map<string, Map<string, MemberUsageTotal>>>()
      : undefined;
    const dailyProjects = request.includeDailyMembers
      ? new Map<string, Map<string, Map<string, ProjectUsageTotal>>>()
      : undefined;
    const dailyWorkspaces = request.includeDailyMembers
      ? new Map<string, Map<string, WorkspaceUsageTotal>>()
      : undefined;
    const successfulFetchTimes: Array<{ usageDate: string; fetchedAt: number }> = [];
    const successfulWorkspaceFetchTimes: Array<{
      usageDate: string;
      fetchedAt: number;
    }> = [];
    const successfulWorkspaceFetchByUnit = new Map<string, number>();
    let hasStaleWorkspaceRows = false;

    for (const row of memberResult.rows) {
      const workspaceId = String(row["workspace_id"]);
      const userId = String(row["user_id"]);
      const totals = nested(members, workspaceId);
      const current = totals.get(userId) ?? {
        totalCostUsd: 0,
        aiCostUsd: 0,
        agentMetricsComplete: true,
      };
      current.totalCostUsd += number(row["total_cost_usd"]);
      current.aiCostUsd += number(row["ai_cost_usd"]);
      current.agentMetricsComplete =
        current.agentMetricsComplete && row["agent_metrics_complete"] === true;
      totals.set(userId, current);
      if (dailyMembers) {
        const usageDate = dateString(row["usage_date"]);
        const byWorkspace = nested(dailyMembers, usageDate);
        const byUser = nested(byWorkspace, workspaceId);
        byUser.set(userId, {
          totalCostUsd: number(row["total_cost_usd"]),
          aiCostUsd: number(row["ai_cost_usd"]),
          agentMetricsComplete: row["agent_metrics_complete"] === true,
        });
      }
    }

    for (const row of projectResult.rows) {
      const workspaceId = String(row["workspace_id"]);
      const projectId = String(row["project_id"]);
      const totals = nested(projects, workspaceId);
      const aiCostUsd = sumAgentUsageMetrics(row["metrics_json"]);
      const current = totals.get(projectId) ?? { totalCostUsd: 0, aiCostUsd: 0 };
      current.totalCostUsd += number(row["total_cost_usd"]);
      current.aiCostUsd += aiCostUsd;
      totals.set(projectId, current);
      if (dailyProjects) {
        const usageDate = dateString(row["usage_date"]);
        const byWorkspace = nested(dailyProjects, usageDate);
        const byProject = nested(byWorkspace, workspaceId);
        const dailyProject = byProject.get(projectId) ?? { totalCostUsd: 0, aiCostUsd: 0 };
        dailyProject.totalCostUsd += number(row["total_cost_usd"]);
        dailyProject.aiCostUsd += aiCostUsd;
        byProject.set(projectId, dailyProject);
      }
    }

    const failedWorkspaceDays: UsageCoverage["failedWorkspaceDays"] = [];
    const presentWorkspaceKeys = new Set<string>();
    const discoveredWorkspaceIds = new Set<string>();
    for (const row of workspaceResult.rows) {
      const workspaceId = String(row["workspace_id"]);
      const usageDate = dateString(row["usage_date"]);
      discoveredWorkspaceIds.add(workspaceId);
      if (row["status"] === "failed") {
        failedWorkspaceDays.push({ workspaceId, usageDate });
      } else {
        presentWorkspaceKeys.add(`${workspaceId}|${usageDate}`);
      }
      if (row["status"] === "stale") hasStaleWorkspaceRows = true;
      const current = workspaces.get(workspaceId) ?? {
        totalCostUsd: 0,
        memberAttributableUsd: 0,
        memberUnattributableUsd: 0,
      };
      current.totalCostUsd += number(row["total_cost_usd"]);
      current.memberAttributableUsd += number(row["member_attributable_usd"]);
      current.memberUnattributableUsd += number(row["member_unattributable_usd"]);
      workspaces.set(workspaceId, current);
      if (dailyWorkspaces) {
        nested(dailyWorkspaces, usageDate).set(workspaceId, {
          totalCostUsd: number(row["total_cost_usd"]),
          memberAttributableUsd: number(row["member_attributable_usd"]),
          memberUnattributableUsd: number(row["member_unattributable_usd"]),
        });
      }
      addDaily(daily, usageDate).workspaceTotalUsd += number(row["total_cost_usd"]);
      const fetched = fetchedTime(row["fetched_at"]);
      if (
        fetched !== null &&
        (row["status"] !== "failed" || number(row["total_cost_usd"]) !== 0)
      ) {
        successfulFetchTimes.push({ usageDate, fetchedAt: fetched });
        successfulWorkspaceFetchTimes.push({ usageDate, fetchedAt: fetched });
        successfulWorkspaceFetchByUnit.set(
          `${usageDate}|${workspaceId}`,
          fetched,
        );
      }
    }

    let accountTotalUsd = 0;
    const presentAccountDays = new Set<string>();
    const successfulAccountFetchByDay = new Map<string, number>();
    for (const row of accountResult.rows) {
      const usageDate = dateString(row["usage_date"]);
      presentAccountDays.add(usageDate);
      accountTotalUsd += number(row["total_cost_usd"]);
      addDaily(daily, usageDate).accountTotalUsd += number(row["total_cost_usd"]);
      const fetched = fetchedTime(row["fetched_at"]);
      if (fetched !== null) {
        successfulFetchTimes.push({ usageDate, fetchedAt: fetched });
        successfulAccountFetchByDay.set(usageDate, fetched);
      }
    }

    const latestFailureByUnit = new Map<string, UsageRefreshFailure>();
    for (const row of failedAttemptResult.rows) {
      const usageDate = dateString(row["usage_date"]);
      const workspaceId = row["workspace_id"] == null
        ? null
        : String(row["workspace_id"]);
      const attemptedAtMs = fetchedTime(row["attempted_at"]);
      if (attemptedAtMs === null) continue;
      const key = `${usageDate}|${workspaceId ?? ""}`;
      const successfulAt = workspaceId === null
        ? successfulAccountFetchByDay.get(usageDate)
        : successfulWorkspaceFetchByUnit.get(key);
      if (successfulAt !== undefined && successfulAt >= attemptedAtMs) continue;
      latestFailureByUnit.set(key, {
        workspaceId,
        usageDate,
        attemptedAt: new Date(attemptedAtMs).toISOString(),
      });
    }
    const latestFailedAttempts = [...latestFailureByUnit.values()].sort(
      (a, b) =>
        b.attemptedAt.localeCompare(a.attemptedAt) ||
        a.usageDate.localeCompare(b.usageDate) ||
        (a.workspaceId ?? "").localeCompare(b.workspaceId ?? ""),
    );
    const hasWorkspaceRefreshFailure = latestFailedAttempts.some(
      (failure) => failure.workspaceId !== null,
    );
    const hasAnyRefreshFailure = latestFailedAttempts.length > 0;

    const requestedDates = dates(resolved.startDay, resolved.dayCount);
    const effectiveWorkspaceIds = scope ?? [...discoveredWorkspaceIds].sort();
    const missingWorkspaceDays: UsageCoverage["missingWorkspaceDays"] = [];
    for (const workspaceId of effectiveWorkspaceIds) {
      for (const usageDate of requestedDates) {
        const key = `${workspaceId}|${usageDate}`;
        if (
          !presentWorkspaceKeys.has(key) &&
          !failedWorkspaceDays.some((failed) =>
            failed.workspaceId === workspaceId && failed.usageDate === usageDate)
        ) {
          missingWorkspaceDays.push({ workspaceId, usageDate });
        }
      }
    }
    const includesAccountAnchor = request.includeAccountAnchor !== false;
    const missingAccountDays = includesAccountAnchor
      ? requestedDates.filter((usageDate) => !presentAccountDays.has(usageDate))
      : [];
    const requestedWorkspaceDays = effectiveWorkspaceIds.length * resolved.dayCount;
    const totalExpected = requestedWorkspaceDays +
      (includesAccountAnchor ? resolved.dayCount : 0);
    const totalPresent = presentWorkspaceKeys.size + presentAccountDays.size;
    const coverage: UsageCoverage = {
      requestedDays: resolved.dayCount,
      requestedWorkspaceDays,
      presentWorkspaceDays: presentWorkspaceKeys.size,
      failedWorkspaceDays,
      missingWorkspaceDays,
      presentAccountDays: presentAccountDays.size,
      missingAccountDays,
      ratio: totalExpected === 0 ? 1 : totalPresent / totalExpected,
    };
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    const liveStart = todayStart - 2 * DAY_MS;
    const windowStart = Date.parse(resolved.window.start);
    const windowEnd = Date.parse(resolved.window.end);
    const containsLiveDays =
      windowEnd > liveStart && windowStart < todayStart + DAY_MS;
    const liveStartDay = new Date(liveStart).toISOString().slice(0, 10);
    const freshnessCandidates = containsLiveDays
      ? successfulFetchTimes.filter(({ usageDate }) => usageDate >= liveStartDay)
      : successfulFetchTimes;
    const dataAsOfMs = freshnessCandidates.length > 0
      ? Math.min(...freshnessCandidates.map(({ fetchedAt }) => fetchedAt))
      : null;
    const dataAsOf = dataAsOfMs === null ? null : new Date(dataAsOfMs).toISOString();
    const workspaceFreshnessCandidates = containsLiveDays
      ? successfulWorkspaceFetchTimes.filter(({ usageDate }) =>
        usageDate >= liveStartDay)
      : successfulWorkspaceFetchTimes;
    const workspaceDataAsOfMs = workspaceFreshnessCandidates.length > 0
      ? Math.min(...workspaceFreshnessCandidates.map(({ fetchedAt }) => fetchedAt))
      : null;
    const workspaceDataAsOf = workspaceDataAsOfMs === null
      ? null
      : new Date(workspaceDataAsOfMs).toISOString();
    const isLive = containsLiveDays;
    const hasData = presentWorkspaceKeys.size > 0 ||
      presentAccountDays.size > 0 ||
      memberResult.rows.length > 0 ||
      projectResult.rows.length > 0;
    const workspaceHasData = presentWorkspaceKeys.size > 0 ||
      memberResult.rows.length > 0 ||
      projectResult.rows.length > 0;
    const workspaceHasCoverageGap = failedWorkspaceDays.length > 0 ||
      missingWorkspaceDays.length > 0;
    const workspaceStatus: UsageSnapshotStatus = failedWorkspaceDays.length > 0
      ? "partial"
      : !workspaceHasData
      ? "empty"
      : workspaceHasCoverageGap
      ? "partial"
      : hasStaleWorkspaceRows || hasWorkspaceRefreshFailure ||
          (isLive &&
            (workspaceDataAsOfMs === null ||
              now() - workspaceDataAsOfMs > staleAfterMs))
      ? "stale"
      : "complete";
    const hasCoverageGap = workspaceHasCoverageGap || missingAccountDays.length > 0;
    const status: UsageSnapshotStatus = !includesAccountAnchor
      ? workspaceStatus
      : failedWorkspaceDays.length > 0
      ? "partial"
      : !hasData
      ? "empty"
      : hasCoverageGap
      ? "partial"
      : hasStaleWorkspaceRows || hasAnyRefreshFailure ||
           (isLive && (dataAsOfMs === null || now() - dataAsOfMs > staleAfterMs))
      ? "stale"
      : "complete";

    return {
      window: resolved.window,
      workspaceIds: scope,
      includesDailyMembers: !!request.includeDailyMembers,
      status,
      workspaceStatus,
      workspaceDataAsOf,
      includesAccountAnchor,
      dataAsOf,
      isLive,
      hasPersistentlyStaleRows: hasStaleWorkspaceRows,
      latestFailedAttempts,
      coverage,
      members,
      projects,
      workspaces,
      daily,
      accountDays: presentAccountDays,
      accountTotalUsd,
      ...(dailyMembers ? { dailyMembers, dailyProjects, dailyWorkspaces } : {}),
    };
  }

  function read(request: UsageSnapshotRequest): Promise<UsageSnapshot> {
    const resolved = normalizedWindow(request.window);
    const scope = normalizeScope(request.workspaceIds);
    const includeAccountAnchor = request.includeAccountAnchor !== false;
    if (scope?.length === 0) {
      const key = JSON.stringify([
        resolved.window.start,
        resolved.window.end,
        scope,
        !!request.includeDailyMembers,
        includeAccountAnchor,
      ]);
      const current = currentEntry(key);
      if (current) return current.promise;
      const snapshot = emptySnapshot(
        resolved,
        scope,
        !!request.includeDailyMembers,
        includeAccountAnchor,
      );
      const promise = Promise.resolve(snapshot);
      put(key, {
        promise,
        snapshot,
        expiresAt: now() + cacheMaxAgeMs,
        weight: estimateRetainedBytes(snapshot),
      });
      return promise;
    }
    const key = JSON.stringify([
      resolved.window.start,
      resolved.window.end,
      scope,
      !!request.includeDailyMembers,
      includeAccountAnchor,
    ]);
    const current = currentEntry(key);
    if (current) {
      if (current.snapshot) {
        const refreshed = refreshTimeClassification(current.snapshot);
        if (refreshed !== current.snapshot) {
          memoWeight -= current.weight;
          current.snapshot = refreshed;
          current.promise = Promise.resolve(refreshed);
          current.weight = estimateRetainedBytes(refreshed);
          memoWeight += current.weight;
          trim();
        }
      }
      return current.promise;
    }

    const promise = readScheduler.schedule(() => load(request, resolved, scope));
    const entry: MemoEntry = {
      promise,
      expiresAt: now() + cacheMaxAgeMs,
      weight: 0,
    };
    put(key, entry);
    void promise.then(
      (snapshot) => {
        if (memo.get(key) === entry) {
          entry.snapshot = snapshot;
          entry.weight = estimateRetainedBytes(snapshot);
          memoWeight += entry.weight;
          trim();
        }
      },
      () => {
        if (memo.get(key) === entry) remove(key);
      },
    );
    return promise;
  }

  return {
    read,
    invalidate: () => {
      memo.clear();
      memoWeight = 0;
    },
    memoSize: () => {
      trim();
      return memo.size;
    },
  };
}

const usageStore = createUsageStore();
let usageSnapshotGeneration = 0;
let generationUpdateDepth = 0;
let generationInvalidationPending = false;
let usageGenerationExpiresAt = Date.now() + DEFAULT_USAGE_CACHE_MAX_AGE_MS;

function publishUsageGeneration(): void {
  usageStore.invalidate();
  usageSnapshotGeneration += 1;
  usageGenerationExpiresAt = Date.now() + DEFAULT_USAGE_CACHE_MAX_AGE_MS;
}

function expireUsageGenerationIfNeeded(): void {
  if (Date.now() < usageGenerationExpiresAt) return;
  if (generationUpdateDepth > 0) {
    generationInvalidationPending = true;
    return;
  }
  publishUsageGeneration();
}

export function readUsageSnapshot(
  request: UsageSnapshotRequest,
): Promise<UsageSnapshot> {
  return usageStore.read(request);
}

export function invalidateUsageSnapshotMemo(): void {
  if (generationUpdateDepth > 0) {
    generationInvalidationPending = true;
    return;
  }
  publishUsageGeneration();
}

/**
 * Coalesces unit-level invalidations so route caches continue identifying the
 * last published generation until an admitted atomic slice has settled.
 */
export function beginUsageGenerationUpdate(): () => void {
  generationUpdateDepth += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    generationUpdateDepth = Math.max(0, generationUpdateDepth - 1);
    if (generationUpdateDepth === 0 && generationInvalidationPending) {
      generationInvalidationPending = false;
      publishUsageGeneration();
    }
  };
}

export function getUsageSnapshotGeneration(): number {
  // A bounded generation lifetime makes commits from another process visible
  // even though process-local invalidation cannot observe them directly.
  expireUsageGenerationIfNeeded();
  return usageSnapshotGeneration;
}

export function isUsageGenerationUpdateActive(): boolean {
  return generationUpdateDepth > 0;
}

export function __getUsageSnapshotMemoSizeForTests(): number {
  return usageStore.memoSize();
}