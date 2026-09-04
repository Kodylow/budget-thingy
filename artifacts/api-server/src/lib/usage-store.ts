import { pool } from "@workspace/db";
import type { UsageWindow } from "./usage-window";
import { sumAgentUsageMetrics } from "./usage-metrics";

const DAY_MS = 86_400_000;
export const DEFAULT_USAGE_LIVE_STALE_AFTER_MS = 20 * 60_000;

export type UsageSnapshotStatus = "complete" | "stale" | "partial" | "empty";

export interface MemberUsageTotal {
  totalCostUsd: number;
  aiCostUsd: number;
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

export interface UsageSnapshot {
  window: UsageWindow;
  workspaceIds: string[] | null;
  includesDailyMembers: boolean;
  status: UsageSnapshotStatus;
  dataAsOf: string | null;
  isLive: boolean;
  hasPersistentlyStaleRows: boolean;
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
}

interface QueryResult {
  rows: Record<string, unknown>[];
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

interface UsageStoreOptions {
  queryable?: Queryable;
  now?: () => number;
  staleAfterMs?: number;
}

interface MemoEntry {
  promise: Promise<UsageSnapshot>;
  snapshot?: UsageSnapshot;
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
  const memo = new Map<string, MemoEntry>();

  function emptySnapshot(
    resolved: ReturnType<typeof normalizedWindow>,
    scope: string[],
    includeDailyMembers: boolean,
  ): UsageSnapshot {
    const dayCount = resolved.dayCount;
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    return {
      window: resolved.window,
      workspaceIds: scope,
      includesDailyMembers: includeDailyMembers,
      status: "empty",
      dataAsOf: null,
      isLive: Date.parse(resolved.window.end) > todayStart,
      hasPersistentlyStaleRows: false,
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
    if (snapshot.status === "partial" || snapshot.status === "empty") return snapshot;
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    const liveStart = todayStart - 2 * DAY_MS;
    const isLive =
      Date.parse(snapshot.window.end) > liveStart &&
      Date.parse(snapshot.window.start) < todayStart + DAY_MS;
    const dataAsOfMs = snapshot.dataAsOf === null
      ? null
      : Date.parse(snapshot.dataAsOf);
    const status: UsageSnapshotStatus = snapshot.hasPersistentlyStaleRows ||
        (isLive && (dataAsOfMs === null || now() - dataAsOfMs > staleAfterMs))
      ? "stale"
      : "complete";
    return status === snapshot.status && isLive === snapshot.isLive
      ? snapshot
      : { ...snapshot, status, isLive };
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

    const [memberResult, projectResult, workspaceResult, accountResult] =
      await Promise.all([
        queryable.query(
          request.includeDailyMembers
            ? `select workspace_id,user_id,usage_date::text,total_cost_usd,ai_cost_usd
           from usage_member_day
           where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}`
            : `select workspace_id,user_id,sum(total_cost_usd)::float8 as total_cost_usd,
                      sum(ai_cost_usd)::float8 as ai_cost_usd
               from usage_member_day
               where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}
               group by workspace_id,user_id`,
          values,
        ),
        queryable.query(
          `select workspace_id,project_id,usage_date::text,total_cost_usd,metrics_json
           from usage_project_day
           where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}`,
          values,
        ),
        queryable.query(
          `select workspace_id,usage_date::text,total_cost_usd,member_attributable_usd,
                  member_unattributable_usd,fetched_at,status
           from usage_workspace_day
           where usage_date >= $1::date and usage_date < $2::date${workspaceFilter}`,
          values,
        ),
        queryable.query(
          `select usage_date::text,total_cost_usd,fetched_at
           from usage_account_day
           where usage_date >= $1::date and usage_date < $2::date`,
          values.slice(0, 2),
        ),
      ]);

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
    let hasStaleWorkspaceRows = false;

    for (const row of memberResult.rows) {
      const workspaceId = String(row["workspace_id"]);
      const userId = String(row["user_id"]);
      const totals = nested(members, workspaceId);
      const current = totals.get(userId) ?? { totalCostUsd: 0, aiCostUsd: 0 };
      current.totalCostUsd += number(row["total_cost_usd"]);
      current.aiCostUsd += number(row["ai_cost_usd"]);
      totals.set(userId, current);
      if (dailyMembers) {
        const usageDate = dateString(row["usage_date"]);
        const byWorkspace = nested(dailyMembers, usageDate);
        const byUser = nested(byWorkspace, workspaceId);
        byUser.set(userId, {
          totalCostUsd: number(row["total_cost_usd"]),
          aiCostUsd: number(row["ai_cost_usd"]),
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
      }
    }

    let accountTotalUsd = 0;
    const presentAccountDays = new Set<string>();
    for (const row of accountResult.rows) {
      const usageDate = dateString(row["usage_date"]);
      presentAccountDays.add(usageDate);
      accountTotalUsd += number(row["total_cost_usd"]);
      addDaily(daily, usageDate).accountTotalUsd += number(row["total_cost_usd"]);
      const fetched = fetchedTime(row["fetched_at"]);
      if (fetched !== null) {
        successfulFetchTimes.push({ usageDate, fetchedAt: fetched });
      }
    }

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
    const missingAccountDays = requestedDates.filter((usageDate) =>
      !presentAccountDays.has(usageDate));
    const requestedWorkspaceDays = effectiveWorkspaceIds.length * resolved.dayCount;
    const totalExpected = requestedWorkspaceDays + resolved.dayCount;
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
    const isLive = containsLiveDays;
    const hasData = presentWorkspaceKeys.size > 0 ||
      presentAccountDays.size > 0 ||
      memberResult.rows.length > 0 ||
      projectResult.rows.length > 0;
    const hasCoverageGap = failedWorkspaceDays.length > 0 ||
      missingWorkspaceDays.length > 0 ||
      missingAccountDays.length > 0;
    const status: UsageSnapshotStatus = failedWorkspaceDays.length > 0
      ? "partial"
      : !hasData
      ? "empty"
      : hasCoverageGap
      ? "partial"
       : hasStaleWorkspaceRows ||
           (isLive && (dataAsOfMs === null || now() - dataAsOfMs > staleAfterMs))
      ? "stale"
      : "complete";

    return {
      window: resolved.window,
      workspaceIds: scope,
      includesDailyMembers: !!request.includeDailyMembers,
      status,
      dataAsOf,
      isLive,
      hasPersistentlyStaleRows: hasStaleWorkspaceRows,
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
    if (scope?.length === 0) {
      const key = JSON.stringify([
        resolved.window.start,
        resolved.window.end,
        scope,
        !!request.includeDailyMembers,
      ]);
      const current = memo.get(key);
      if (current) return current.promise;
      const snapshot = emptySnapshot(
        resolved,
        scope,
        !!request.includeDailyMembers,
      );
      const promise = Promise.resolve(snapshot);
      memo.set(key, { promise, snapshot });
      return promise;
    }
    const key = JSON.stringify([
      resolved.window.start,
      resolved.window.end,
      scope,
      !!request.includeDailyMembers,
    ]);
    const current = memo.get(key);
    if (current) {
      if (current.snapshot) {
        const refreshed = refreshTimeClassification(current.snapshot);
        if (refreshed !== current.snapshot) {
          current.snapshot = refreshed;
          current.promise = Promise.resolve(refreshed);
        }
      }
      return current.promise;
    }

    const promise = load(request, resolved, scope);
    const entry: MemoEntry = { promise };
    memo.set(key, entry);
    void promise.then(
      (snapshot) => {
        if (memo.get(key) === entry) entry.snapshot = snapshot;
      },
      () => {
        if (memo.get(key) === entry) memo.delete(key);
      },
    );
    return promise;
  }

  return {
    read,
    invalidate: () => memo.clear(),
    memoSize: () => memo.size,
  };
}

const usageStore = createUsageStore();
let usageSnapshotGeneration = 0;

export function readUsageSnapshot(
  request: UsageSnapshotRequest,
): Promise<UsageSnapshot> {
  return usageStore.read(request);
}

export function invalidateUsageSnapshotMemo(): void {
  usageStore.invalidate();
  usageSnapshotGeneration += 1;
}

export function getUsageSnapshotGeneration(): number {
  return usageSnapshotGeneration;
}

export function __getUsageSnapshotMemoSizeForTests(): number {
  return usageStore.memoSize();
}