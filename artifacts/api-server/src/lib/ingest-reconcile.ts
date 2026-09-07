import { pool } from "@workspace/db";
import { invalidateUsageSnapshotMemo } from "./usage-store";

const CUTOFF = "2026-05-20";
const DAY_MS = 86_400_000;
const RECONCILIATION_TOLERANCE_USD = 1;
const MAX_UNITS = 8;
const MAX_REQUEST_ATTEMPTS = 24;
const MAX_SLICE_MS = 45_000;
const REQUEST_ATTEMPTS_PER_UNIT = 3;
const CURSOR_STAGE = "reconciliation";

export type ReconciliationDelta = {
  monthStart: string;
  scope: string;
  scopeId: string;
  upstreamUsd: number;
  storedUsd: number;
  deltaUsd: number;
  mismatchCount: number;
};

export type ReconciliationFetchTotal = (
  startTime: string,
  endTime: string,
  workspaceId: string | undefined,
  stats: { calls: number },
) => Promise<{ totalCostUsd: number; intervalStart: string; intervalEnd: string }>;

type ReconciliationUnit = {
  monthStart: string;
  scope: "account" | "workspace";
  scopeId: string;
  unitKey: string;
};

function databaseDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error("Reconciliation query returned an invalid month");
  return match[0];
}

export type ReconciliationSliceResult = {
  attempted: number;
  failed: number;
  calls: number;
  remaining: number;
  reconciliations: ReconciliationDelta[];
};

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, count: number): string {
  return day(new Date(Date.parse(`${value}T00:00:00.000Z`) + count * DAY_MS));
}

function nextMonth(monthStart: string): string {
  const value = new Date(`${monthStart}T00:00:00.000Z`);
  return day(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)));
}

export function reconciliationBounds(
  monthStart: string,
  today: string,
): { effectiveStart: string; effectiveEnd: string } | null {
  const effectiveStart = monthStart < CUTOFF ? CUTOFF : monthStart;
  const currentMonth = `${today.slice(0, 7)}-01`;
  const effectiveEnd = monthStart === currentMonth
    ? addDays(today, -2)
    : nextMonth(monthStart);
  return effectiveEnd > effectiveStart ? { effectiveStart, effectiveEnd } : null;
}

export function nextReconciliationMismatchCount(
  previousCount: number,
  deltaUsd: number,
  toleranceUsd = RECONCILIATION_TOLERANCE_USD,
): number {
  return Math.abs(deltaUsd) > toleranceUsd ? previousCount + 1 : 0;
}

function reconciliationRow(
  input: {
    monthStart: string;
    scope: "account" | "workspace";
    scopeId: string;
    upstreamUsd: number;
  },
  storedUsd: number,
  previousCount: number,
): ReconciliationDelta {
  const deltaUsd = input.upstreamUsd - storedUsd;
  return {
    monthStart: input.monthStart,
    scope: input.scope,
    scopeId: input.scopeId,
    upstreamUsd: input.upstreamUsd,
    storedUsd,
    deltaUsd,
    mismatchCount: nextReconciliationMismatchCount(previousCount, deltaUsd),
  };
}

async function saveReconciliation(
  client: { query: (text: string, values?: unknown[]) => Promise<any> },
  row: ReconciliationDelta,
): Promise<void> {
  await client.query(
    `insert into ingest_reconciliation
       (month_start,scope,scope_id,upstream_usd,stored_usd,delta_usd,
        mismatch_count,checked_at)
     values ($1::date,$2,$3,$4,$5,$6,$7,now())
     on conflict (month_start,scope,scope_id) do update set
       upstream_usd=excluded.upstream_usd,
       stored_usd=excluded.stored_usd,
       delta_usd=excluded.delta_usd,
       mismatch_count=excluded.mismatch_count,
       checked_at=excluded.checked_at`,
    [
      row.monthStart,
      row.scope,
      row.scopeId,
      row.upstreamUsd,
      row.storedUsd,
      row.deltaUsd,
      row.mismatchCount,
    ],
  );
}

export async function reconcileWorkspaceTotal(input: {
  monthStart: string;
  effectiveStart: string;
  effectiveEnd: string;
  workspaceId: string;
  upstreamUsd: number;
}): Promise<ReconciliationDelta> {
  const client = await pool.connect();
  let madeStale = false;
  try {
    await client.query("begin");
    const previousResult = await client.query(
      `select mismatch_count from ingest_reconciliation
       where month_start=$1::date and scope='workspace' and scope_id=$2
       for update`,
      [input.monthStart, input.workspaceId],
    );
    const storedResult = await client.query(
      `select coalesce(sum(total_cost_usd),0)::float8 as total
       from usage_workspace_day
       where workspace_id=$1 and usage_date >= $2::date and usage_date < $3::date`,
      [input.workspaceId, input.effectiveStart, input.effectiveEnd],
    );
    const result = reconciliationRow({
      monthStart: input.monthStart,
      scope: "workspace",
      scopeId: input.workspaceId,
      upstreamUsd: input.upstreamUsd,
    }, Number(storedResult.rows[0]?.total ?? 0),
    Number(previousResult.rows[0]?.mismatch_count ?? 0));
    await saveReconciliation(client, result);
    if (result.mismatchCount >= 2) {
      const stale = await client.query(
        `update usage_workspace_day set status='stale',
           error='monthly reconciliation delta exceeded $1 twice'
         where workspace_id=$1 and usage_date >= $2::date and usage_date < $3::date
           and status='complete'`,
        [input.workspaceId, input.effectiveStart, input.effectiveEnd],
      );
      madeStale = (stale.rowCount ?? 0) > 0;
    }
    await client.query("commit");
    if (madeStale) invalidateUsageSnapshotMemo();
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function sanitizedFailure(error: unknown): string {
  const source = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return source
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(bearer|token|api[-_ ]?key|authorization)\s*[:=]?\s*\S+/gi, "$1 [redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

async function recordFailedAccountObservation(input: {
  monthStart: string;
  intervalStart: string;
  intervalEnd: string;
  error: unknown;
}): Promise<void> {
  await pool.query(
    `insert into usage_account_observation
       (billing_period_start,total_cost_usd,interval_start,interval_end,
        fetched_at,source_status,error)
     values ($1::date,null,$2::timestamptz,$3::timestamptz,now(),'failed',$4)
     on conflict (billing_period_start) do update set
       total_cost_usd=coalesce(usage_account_observation.total_cost_usd,excluded.total_cost_usd),
        interval_start=case when usage_account_observation.total_cost_usd is null
          then excluded.interval_start else usage_account_observation.interval_start end,
        interval_end=case when usage_account_observation.total_cost_usd is null
          then excluded.interval_end else usage_account_observation.interval_end end,
        fetched_at=case when usage_account_observation.total_cost_usd is null
          then excluded.fetched_at else usage_account_observation.fetched_at end,
        source_status=case when usage_account_observation.total_cost_usd is null
          then 'failed' else usage_account_observation.source_status end,
       error=excluded.error`,
    [input.monthStart, input.intervalStart, input.intervalEnd, sanitizedFailure(input.error)],
  );
}

async function reconcileAccountTotal(input: {
  monthStart: string;
  effectiveStart: string;
  effectiveEnd: string;
  upstreamUsd: number;
  intervalStart: string;
  intervalEnd: string;
}): Promise<ReconciliationDelta> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const previous = await client.query(
      `select mismatch_count from ingest_reconciliation
       where month_start=$1::date and scope='account' and scope_id='enterprise'
       for update`,
      [input.monthStart],
    );
    const stored = await client.query(
      `select coalesce(sum(total_cost_usd),0)::float8 as total
       from usage_account_day where usage_date >= $1::date and usage_date < $2::date`,
      [input.effectiveStart, input.effectiveEnd],
    );
    const result = reconciliationRow({
      monthStart: input.monthStart,
      scope: "account",
      scopeId: "enterprise",
      upstreamUsd: input.upstreamUsd,
    }, Number(stored.rows[0]?.total ?? 0), Number(previous.rows[0]?.mismatch_count ?? 0));
    await client.query(
      `insert into usage_account_observation
         (billing_period_start,total_cost_usd,interval_start,interval_end,
          fetched_at,source_status,error)
       values ($1::date,$2,$3::timestamptz,$4::timestamptz,now(),'complete',null)
       on conflict (billing_period_start) do update set
         total_cost_usd=excluded.total_cost_usd,
         interval_start=excluded.interval_start,
         interval_end=excluded.interval_end,
         fetched_at=excluded.fetched_at,
         source_status='complete',
         error=null`,
      [input.monthStart, input.upstreamUsd, input.intervalStart, input.intervalEnd],
    );
    await saveReconciliation(client, result);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const UNIT_CTE = `
  with months as (
    select month_start::date
    from generate_series(date_trunc('month',$1::date),date_trunc('month',$2::date),
                         interval '1 month') month_start
  ), units as (
    select month_start,'account'::text scope,'enterprise'::text scope_id,
           month_start::text||'|account|enterprise' unit_key
    from months
    union all
    select month_start,'workspace',workspace_id,
           month_start::text||'|workspace|'||workspace_id
    from months cross join unnest($3::text[]) workspace_id
  ), pending as (
    select u.* from units u
    left join ingest_reconciliation r
      on r.month_start=u.month_start and r.scope=u.scope and r.scope_id=u.scope_id
    where (
        r.checked_at is null
        or (r.checked_at at time zone 'UTC')::date < $2::date
        or ($4::boolean and (
          (u.scope='workspace' and exists (
            select 1 from usage_workspace_day f
            where f.workspace_id=u.scope_id
              and f.usage_date >= greatest(u.month_start,$1::date)
              and f.usage_date < case
                when u.month_start=date_trunc('month',$2::date) then $2::date - 2
                else u.month_start + interval '1 month'
              end
              and f.fetched_at > r.checked_at
          ))
          or (u.scope='account' and exists (
            select 1 from usage_account_day f
            where f.usage_date >= greatest(u.month_start,$1::date)
              and f.usage_date < case
                when u.month_start=date_trunc('month',$2::date) then $2::date - 2
                else u.month_start + interval '1 month'
              end
              and f.fetched_at > r.checked_at
          ))
        ))
      )
      and (u.month_start < date_trunc('month',$2::date)
           or ($2::date - 2) > greatest(u.month_start,$1::date))
  )`;

async function pendingUnits(
  workspaceIds: string[],
  today: string,
  cursor: string,
  current: boolean,
  limit: number,
  includeChangedFacts: boolean,
): Promise<ReconciliationUnit[]> {
  const comparison = current ? "=" : "<";
  const result = await pool.query(
    `${UNIT_CTE}
     select to_char(month_start,'YYYY-MM-DD') as month_start,scope,scope_id,unit_key from pending
     where month_start ${comparison} date_trunc('month',$2::date)
     order by case when unit_key > $5 then 0 else 1 end,unit_key
     limit $6`,
    [CUTOFF, today, workspaceIds, includeChangedFacts, cursor, limit],
  );
  return result.rows.map((row): ReconciliationUnit => ({
    monthStart: databaseDate(row.month_start),
    scope: row.scope,
    scopeId: row.scope_id,
    unitKey: row.unit_key,
  }));
}

export async function remainingReconciliationCount(
  workspaceIds: string[],
  today: string,
  includeChangedFacts = false,
): Promise<number> {
  const result = await pool.query(
    `${UNIT_CTE} select count(*)::int as count from pending`,
    [CUTOFF, today, workspaceIds, includeChangedFacts],
  );
  return Number(result.rows[0]?.count ?? 0);
}

type ReconciliationLane = "current" | "older";
type CursorState = {
  current: string;
  older: string;
  nextLane: ReconciliationLane;
};

function parseCursor(value: unknown): CursorState {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return {
      current: typeof parsed.current === "string" ? parsed.current : "",
      older: typeof parsed.older === "string" ? parsed.older : "",
      nextLane: parsed.nextLane === "older" ? "older" : "current",
    };
  } catch {
    return { current: "", older: "", nextLane: "current" };
  }
}

async function saveCursor(cursor: CursorState): Promise<void> {
  await pool.query(
    `insert into ingest_cursor(stage,cursor,updated_at) values ($1,$2,now())
     on conflict (stage) do update set cursor=excluded.cursor,updated_at=excluded.updated_at`,
    [CURSOR_STAGE, JSON.stringify(cursor)],
  );
}

/**
 * Reconciles a bounded, restart-safe slice. Failed units advance the fairness
 * cursor but not checked_at, so they remain eligible without starving peers.
 */
export async function reconcileSlice(
  workspaceIds: string[],
  today: string,
  fetchTotal: ReconciliationFetchTotal,
  includeChangedFacts = false,
): Promise<ReconciliationSliceResult> {
  const started = Date.now();
  const stats = { calls: 0 };
  const result: ReconciliationSliceResult = {
    attempted: 0,
    failed: 0,
    calls: 0,
    remaining: 0,
    reconciliations: [],
  };
  const cursorResult = await pool.query(
    "select cursor from ingest_cursor where stage=$1",
    [CURSOR_STAGE],
  );
  const cursor = parseCursor(cursorResult.rows[0]?.cursor);
  const [current, older] = await Promise.all([
    pendingUnits(
      workspaceIds,
      today,
      cursor.current,
      true,
      MAX_UNITS,
      includeChangedFacts,
    ),
    pendingUnits(
      workspaceIds,
      today,
      cursor.older,
      false,
      MAX_UNITS,
      includeChangedFacts,
    ),
  ]);
  const units: ReconciliationUnit[] = [];
  let currentIndex = 0;
  let olderIndex = 0;
  let lane = cursor.nextLane;
  while (units.length < MAX_UNITS &&
         (currentIndex < current.length || olderIndex < older.length)) {
    if (lane === "current" && currentIndex < current.length) {
      units.push(current[currentIndex++]!);
    } else if (lane === "older" && olderIndex < older.length) {
      units.push(older[olderIndex++]!);
    } else if (currentIndex < current.length) {
      units.push(current[currentIndex++]!);
    } else {
      units.push(older[olderIndex++]!);
    }
    lane = lane === "current" ? "older" : "current";
  }

  for (const unit of units) {
    if (Date.now() - started >= MAX_SLICE_MS ||
        stats.calls + REQUEST_ATTEMPTS_PER_UNIT > MAX_REQUEST_ATTEMPTS) break;
    const bounds = reconciliationBounds(unit.monthStart, today);
    if (!bounds) continue;
    result.attempted += 1;
    const startTime = `${bounds.effectiveStart}T00:00:00.000Z`;
    const endTime = `${bounds.effectiveEnd}T00:00:00.000Z`;
    try {
      const upstream = await fetchTotal(
        startTime,
        endTime,
        unit.scope === "workspace" ? unit.scopeId : undefined,
        stats,
      );
      const reconciliation = unit.scope === "workspace"
        ? await reconcileWorkspaceTotal({
          monthStart: unit.monthStart,
          effectiveStart: bounds.effectiveStart,
          effectiveEnd: bounds.effectiveEnd,
          workspaceId: unit.scopeId,
          upstreamUsd: upstream.totalCostUsd,
        })
        : await reconcileAccountTotal({
          monthStart: unit.monthStart,
          effectiveStart: bounds.effectiveStart,
          effectiveEnd: bounds.effectiveEnd,
          upstreamUsd: upstream.totalCostUsd,
          intervalStart: upstream.intervalStart,
          intervalEnd: upstream.intervalEnd,
        });
      result.reconciliations.push(reconciliation);
    } catch (error) {
      result.failed += 1;
      if (unit.scope === "account") {
        try {
          await recordFailedAccountObservation({
            monthStart: unit.monthStart,
            intervalStart: startTime,
            intervalEnd: endTime,
            error,
          });
        } catch {
          // The failed unit remains pending; observation failure must not end the slice.
        }
      }
    }
    const attemptedLane: ReconciliationLane =
      unit.monthStart === `${today.slice(0, 7)}-01` ? "current" : "older";
    if (attemptedLane === "current") {
      cursor.current = unit.unitKey;
    } else {
      cursor.older = unit.unitKey;
    }
    cursor.nextLane = attemptedLane === "current" ? "older" : "current";
    await saveCursor(cursor);
  }
  result.calls = stats.calls;
  result.remaining = await remainingReconciliationCount(
    workspaceIds,
    today,
    includeChangedFacts,
  );
  return result;
}