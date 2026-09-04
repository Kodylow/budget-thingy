import { pool } from "@workspace/db";
import {
  assertCompleteRosterDirectory,
  fetchEnterpriseForIngest,
  getCachedDirectory,
  getDirectory,
  getDirectoryFreshness,
  pendingUsageCount,
  queueProjectTitlesFetch,
  refreshDirectoryForIngest,
  sumAgentUsageMetrics,
  type DirectoryCache,
  withEnterpriseIngestAccess,
} from "./enterprise";
import { hasDailyRosterSnapshot, recordDailyRosters } from "./history";
import { logger } from "./logger";

const CUTOFF = "2026-05-20";
const DAY_MS = 86_400_000;
const DIRECTORY_TTL_MS = 15 * 60_000;
const METADATA_WAIT_TIMEOUT_MS = 60_000;
const METADATA_WAIT_POLL_MS = 25;
const WORKERS = 4;
const UNIT_ATTEMPTS = 3;
const BATCH_SIZE = 500;

type Metrics = Array<{ id: string; name: string; category: string; costUsd: number }>;
type UsageGroup = {
  key?: { userId?: string; projectId?: string };
  totalCostUsd?: number;
  metrics?: Metrics;
};
type UsagePayload = {
  totalCostUsd?: number;
  attributableTotalCostUsd?: number;
  unattributableTotalCostUsd?: number;
  metrics?: Metrics;
  groups?: UsageGroup[];
  pagination?: { nextCursor?: string | null; hasMore?: boolean };
};
type UnitResult = {
  ok: boolean;
  calls: number;
  pages: number;
  durationMs: number;
  error?: string;
};
type QueueUnit =
  | { type: "workspace"; workspaceId: string; usageDate: string }
  | { type: "account"; usageDate: string };
export type ReconciliationDelta = {
  monthStart: string;
  scope: string;
  scopeId: string;
  upstreamUsd: number;
  storedUsd: number;
  deltaUsd: number;
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
  peakRequestsPerMinute: number;
  lowestRateLimitRemaining: number | null;
};

let requestCountsByMinute = new Map<number, number>();
let peakRequestsPerMinute = 0;
let lowestRateLimitRemaining: number | null = null;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(usageDate: string, count: number): string {
  return day(new Date(Date.parse(`${usageDate}T00:00:00.000Z`) + count * DAY_MS));
}

function daysBetween(start: string, endInclusive: string): string[] {
  const out: string[] = [];
  for (let current = start; current <= endInclusive; current = addDays(current, 1)) {
    out.push(current);
  }
  return out;
}

function monthStarts(endDay: string): string[] {
  const out: string[] = [];
  let current = CUTOFF.slice(0, 7) + "-01";
  const endMonth = endDay.slice(0, 7) + "-01";
  while (current <= endMonth) {
    out.push(current);
    const d = new Date(`${current}T00:00:00.000Z`);
    current = day(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
  }
  return out;
}

export function reconciliationBounds(
  monthStart: string,
  today: string,
): { effectiveStart: string; effectiveEnd: string } | null {
  const effectiveStart = monthStart < CUTOFF ? CUTOFF : monthStart;
  const nextMonth = monthStarts(addDays(monthStart, 35))
    .find((candidate) => candidate > monthStart);
  const monthEnd = nextMonth ?? addDays(today, 1);
  const currentMonth = today.slice(0, 7) + "-01";
  const effectiveEnd = monthStart === currentMonth
    ? addDays(today, -2)
    : monthEnd;
  return effectiveEnd > effectiveStart ? { effectiveStart, effectiveEnd } : null;
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
): Promise<{ data: UsagePayload; headers: Headers }> {
  const response = await fetchEnterpriseForIngest("/usage", params);
  stats.calls++;
  noteRequest(response.headers);
  const body = response.body as { data?: UsagePayload };
  if (!body.data) throw new Error("Enterprise /usage response omitted data");
  return { data: body.data, headers: response.headers };
}

async function pagedUsage(
  params: Record<string, string | undefined>,
  stats: { calls: number; pages: number },
): Promise<{ top: UsagePayload; groups: UsageGroup[] }> {
  const groups: UsageGroup[] = [];
  let cursor: string | undefined;
  let top: UsagePayload | null = null;
  for (let page = 0; page < 200; page++) {
    const response = await requestUsage({ ...params, limit: "100", cursor }, stats);
    stats.pages++;
    top ??= response.data;
    groups.push(...(response.data.groups ?? []));
    if (!response.data.pagination?.hasMore) return { top, groups };
    if (!response.data.pagination.nextCursor) {
      throw new Error("Enterprise /usage pagination reported hasMore without a cursor");
    }
    cursor = response.data.pagination.nextCursor;
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
    const result = { ok: true, ...stats, durationMs: Date.now() - started };
    logger.info({ event: "usage_ingest_unit", workspaceId, usageDate, ...result, outcome: "complete" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `insert into usage_workspace_day
         (workspace_id, usage_date, total_cost_usd, member_attributable_usd,
          member_unattributable_usd, metrics_json, fetched_at, status, error)
       values ($1,$2::date,0,0,0,'[]'::jsonb,now(),'failed',$3)
       on conflict (workspace_id, usage_date) do update set
          status='failed', error=excluded.error`,
      [workspaceId, usageDate, message.slice(0, 2000)],
    );
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
      await pool.query(
        `insert into usage_account_day (usage_date,total_cost_usd,fetched_at)
         values ($1::date,$2,now())
         on conflict (usage_date) do update set
           total_cost_usd=excluded.total_cost_usd,fetched_at=excluded.fetched_at`,
        [usageDate, Number(response.data.totalCostUsd ?? 0)],
      );
    });
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

async function runQueue(units: QueueUnit[]): Promise<{
  attempted: number; succeeded: number; failed: number; calls: number;
}> {
  let next = 0;
  const totals = { attempted: units.length, succeeded: 0, failed: 0, calls: 0 };
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (;;) {
      const index = next++;
      if (index >= units.length) return;
      const unit = units[index]!;
      const result = unit.type === "workspace"
        ? await ingestWorkspaceDay(unit.workspaceId, unit.usageDate)
        : await ingestAccountDay(unit.usageDate);
      totals.calls += result.calls;
      if (result.ok) totals.succeeded++;
      else totals.failed++;
    }
  }));
  return totals;
}

export async function waitForLegacyMetadata(
  options: {
    timeoutMs?: number;
    pollMs?: number;
    pending?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<{ timedOut: boolean; pendingCount: number; waitedMs: number }> {
  const timeoutMs = options.timeoutMs ?? METADATA_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? METADATA_WAIT_POLL_MS;
  const pending = options.pending ?? pendingUsageCount;
  const sleep = options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const started = now();
  let pendingCount = pending();
  while (pendingCount > 0 && now() - started < timeoutMs) {
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (now() - started))));
    pendingCount = pending();
  }
  return {
    timedOut: pendingCount > 0,
    pendingCount,
    waitedMs: now() - started,
  };
}

async function refreshMetadata(now = Date.now()): Promise<DirectoryCache> {
  const freshness = getDirectoryFreshness();
  const rosterMissing = !(await hasDailyRosterSnapshot(now));
  let directory: DirectoryCache;
  if (rosterMissing ||
      !freshness.dataAsOf ||
      Date.now() - Date.parse(freshness.dataAsOf) >= DIRECTORY_TTL_MS) {
    directory = await refreshDirectoryForIngest();
  } else {
    directory = await getCachedDirectory();
  }
  assertCompleteRosterDirectory(directory);
  await recordDailyRosters(directory.groups, directory.groupMembers, now);
  for (const workspaceId of directory.workspaces.keys()) {
    queueProjectTitlesFetch(workspaceId, 1, false, false);
  }
  const metadataWait = await waitForLegacyMetadata();
  if (metadataWait.timedOut) {
    logger.warn({
      event: "usage_ingest_metadata_wait_timeout",
      timeoutMs: METADATA_WAIT_TIMEOUT_MS,
      pendingCount: metadataWait.pendingCount,
      waitedMs: metadataWait.waitedMs,
      workspaceCount: directory.workspaces.size,
    }, "Legacy project metadata queue did not drain; continuing usage ingestion");
  }
  return directory;
}

async function beginRun(kind: "live" | "backfill" | "reconcile"): Promise<string> {
  const result = await pool.query(
    `insert into ingest_run (kind,started_at,units,calls,failures)
     values ($1,now(),0,0,0) returning id::text`,
    [kind],
  );
  return String(result.rows[0]?.id);
}

async function finishRun(
  id: string,
  totals: { attempted: number; calls: number; failed: number },
  error?: string,
): Promise<void> {
  await pool.query(
    `update ingest_run set finished_at=now(),units=$2,calls=$3,failures=$4,error=$5 where id=$1`,
    [id, totals.attempted, totals.calls, totals.failed, error ?? null],
  );
}

async function backfillUnits(workspaceIds: string[], today: string): Promise<QueueUnit[]> {
  const finalThrough = addDays(today, -3);
  if (finalThrough < CUTOFF) return [];
  const [workspaceRows, accountRows] = await Promise.all([
    pool.query(
      `select workspace_id,usage_date::text,status from usage_workspace_day
       where usage_date between $1::date and $2::date`,
      [CUTOFF, finalThrough],
    ),
    pool.query(
      `select usage_date::text from usage_account_day
       where usage_date between $1::date and $2::date`,
      [CUTOFF, finalThrough],
    ),
  ]);
  const complete = new Set(
    workspaceRows.rows
      .filter((row) => row.status === "complete")
      .map((row) => `${row.workspace_id}|${row.usage_date}`),
  );
  const account = new Set(accountRows.rows.map((row) => String(row.usage_date)));
  const units: QueueUnit[] = [];
  for (const usageDate of daysBetween(CUTOFF, finalThrough)) {
    for (const workspaceId of workspaceIds) {
      if (!complete.has(`${workspaceId}|${usageDate}`)) {
        units.push({ type: "workspace", workspaceId, usageDate });
      }
    }
    if (!account.has(usageDate)) units.push({ type: "account", usageDate });
  }
  return units;
}

async function failedWorkspaceUnits(): Promise<QueueUnit[]> {
  const result = await pool.query(
    `select workspace_id,usage_date::text
     from usage_workspace_day where status='failed'
     order by usage_date,workspace_id`,
  );
  return result.rows.map((row): QueueUnit => ({
    type: "workspace",
    workspaceId: String(row.workspace_id),
    usageDate: String(row.usage_date),
  }));
}

async function fetchTotal(
  startTime: string,
  endTime: string,
  workspaceId: string | undefined,
  stats: { calls: number },
): Promise<number> {
  const response = await retry(() => requestUsage({ startTime, endTime, workspaceId }, stats));
  return Number(response.data.totalCostUsd ?? 0);
}

async function shouldReconcile(today: string, now: Date): Promise<boolean> {
  if (now.getUTCHours() < 2) return false;
  const result = await pool.query(
    `select 1 from ingest_run
     where kind='reconcile' and started_at >= $1::date and finished_at is not null limit 1`,
    [today],
  );
  return result.rowCount === 0;
}

async function reconcile(
  workspaceIds: string[],
  today: string,
): Promise<{ calls: number; reconciliations: ReconciliationDelta[] }> {
  const stats = { calls: 0 };
  const reconciliations: ReconciliationDelta[] = [];
  for (const monthStart of monthStarts(today)) {
    const bounds = reconciliationBounds(monthStart, today);
    if (!bounds) continue;
    const { effectiveStart, effectiveEnd } = bounds;
    const startTime = `${effectiveStart}T00:00:00.000Z`;
    const endTime = `${effectiveEnd}T00:00:00.000Z`;
    const accountUpstream = await fetchTotal(startTime, endTime, undefined, stats);
    const accountStoredResult = await pool.query(
      `select coalesce(sum(total_cost_usd),0)::float8 as total
       from usage_account_day where usage_date >= $1::date and usage_date < $2::date`,
      [effectiveStart, effectiveEnd],
    );
    const accountStored = Number(accountStoredResult.rows[0]?.total ?? 0);
    reconciliations.push({
      monthStart, scope: "account", scopeId: "enterprise",
      upstreamUsd: accountUpstream, storedUsd: accountStored,
      deltaUsd: accountUpstream - accountStored,
    });
    for (const workspaceId of workspaceIds) {
      const upstream = await fetchTotal(startTime, endTime, workspaceId, stats);
      const storedResult = await pool.query(
        `select coalesce(sum(total_cost_usd),0)::float8 as total
         from usage_workspace_day
         where workspace_id=$1 and usage_date >= $2::date and usage_date < $3::date
           and status='complete'`,
        [workspaceId, effectiveStart, effectiveEnd],
      );
      const stored = Number(storedResult.rows[0]?.total ?? 0);
      const delta = upstream - stored;
      reconciliations.push({
        monthStart, scope: "workspace", scopeId: workspaceId,
        upstreamUsd: upstream, storedUsd: stored, deltaUsd: delta,
      });
      if (Math.abs(delta) > 0.01) {
        await pool.query(
          `update usage_workspace_day set status='failed',
             error='monthly reconciliation delta exceeded $0.01'
           where workspace_id=$1 and usage_date >= $2::date and usage_date < $3::date`,
          [workspaceId, effectiveStart, effectiveEnd],
        );
      }
    }
  }
  if (reconciliations.length > 0) {
    const values: unknown[] = [];
    const placeholders = reconciliations.map((row) => {
      const base = values.length;
      values.push(row.monthStart, row.scope, row.scopeId, row.upstreamUsd, row.storedUsd, row.deltaUsd);
      return `($${base + 1}::date,$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},now())`;
    });
    await pool.query(
      `insert into ingest_reconciliation
       (month_start,scope,scope_id,upstream_usd,stored_usd,delta_usd,checked_at)
       values ${placeholders.join(",")}
       on conflict (month_start,scope,scope_id) do update set
         upstream_usd=excluded.upstream_usd,stored_usd=excluded.stored_usd,
         delta_usd=excluded.delta_usd,checked_at=excluded.checked_at`,
      values,
    );
  }
  return { calls: stats.calls, reconciliations };
}

async function runAuthorizedCycle(now = new Date()): Promise<CycleSummary> {
  const started = Date.now();
  requestCountsByMinute = new Map();
  peakRequestsPerMinute = 0;
  lowestRateLimitRemaining = null;
  const lockClient = await pool.connect();
  const empty: CycleSummary = {
    acquired: false, unitsAttempted: 0, unitsSucceeded: 0, unitsFailed: 0,
    totalCalls: 0, durationMs: 0, reconciliations: [], remainingBackfillCount: 0,
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
    const directory = await refreshMetadata(now.getTime());
    const workspaceIds = [...directory.workspaces.keys()].sort();
    const today = day(now);
    const liveDays = [today, addDays(today, -1), addDays(today, -2)];
    const liveUnits: QueueUnit[] = liveDays.flatMap((usageDate) => [
      ...workspaceIds.map((workspaceId): QueueUnit => ({ type: "workspace", workspaceId, usageDate })),
      { type: "account", usageDate },
    ]);
    const liveRun = await beginRun("live");
    const live = await runQueue(liveUnits);
    await finishRun(liveRun, live);

    const backfillRun = await beginRun("backfill");
    const backfill = await backfillUnits(workspaceIds, today);
    const historical = await runQueue(backfill);
    await finishRun(backfillRun, historical);

    let reconciliationResult = { calls: 0, reconciliations: [] as ReconciliationDelta[] };
    if (await shouldReconcile(today, now)) {
      const reconcileRun = await beginRun("reconcile");
      try {
        reconciliationResult = await reconcile(workspaceIds, today);
        await finishRun(reconcileRun, {
          attempted: reconciliationResult.reconciliations.length,
          calls: reconciliationResult.calls,
          failed: 0,
        });
      } catch (error) {
        await finishRun(reconcileRun, {
          attempted: reconciliationResult.reconciliations.length,
          calls: reconciliationResult.calls,
          failed: 1,
        }, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    const reconciliationRetries = await runQueue(await failedWorkspaceUnits());
    const remaining = await backfillUnits(workspaceIds, today);
    const summary: CycleSummary = {
      acquired: true,
      unitsAttempted:
        live.attempted + historical.attempted + reconciliationRetries.attempted,
      unitsSucceeded:
        live.succeeded + historical.succeeded + reconciliationRetries.succeeded,
      unitsFailed: live.failed + historical.failed + reconciliationRetries.failed,
      totalCalls:
        live.calls + historical.calls + reconciliationResult.calls +
        reconciliationRetries.calls,
      durationMs: Date.now() - started,
      reconciliations: reconciliationResult.reconciliations,
      remainingBackfillCount: remaining.length,
      peakRequestsPerMinute,
      lowestRateLimitRemaining,
    };
    logger.info({ event: "usage_ingest_run", ...summary, outcome: "complete" });
    return summary;
  } catch (error) {
    logger.error({ event: "usage_ingest_run", err: error, outcome: "failed" });
    throw error;
  } finally {
    if (empty.acquired) {
      await lockClient.query("select pg_advisory_unlock(hashtext('usage-ingest'))");
    }
    lockClient.release();
  }
}

let interval: NodeJS.Timeout | null = null;

export function runCycle(now = new Date()): Promise<CycleSummary> {
  return withEnterpriseIngestAccess(() => runAuthorizedCycle(now));
}

export function startUsageIngestScheduler(): void {
  if (interval) return;
  void runCycle().catch((error) => logger.error({ err: error }, "Initial usage ingest cycle failed"));
  interval = setInterval(() => {
    void runCycle().catch((error) => logger.error({ err: error }, "Scheduled usage ingest cycle failed"));
  }, 10 * 60_000);
  interval.unref();
}

export function __stopUsageIngestSchedulerForTests(): void {
  if (interval) clearInterval(interval);
  interval = null;
}