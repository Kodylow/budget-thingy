import { pool } from "@workspace/db";

export type QueueUnit =
  | { type: "workspace"; workspaceId: string; usageDate: string }
  | { type: "account"; usageDate: string };

export const CUTOFF = "2026-05-20";
const FULL_SYNC_STAGE = "full-sync";

export function unitKey(unit: QueueUnit): string {
  return `${unit.usageDate}|${unit.type === "workspace" ? unit.workspaceId : ""}`;
}

export async function saveIngestCursor(stage: string, cursor: string): Promise<void> {
  await pool.query(
    `insert into ingest_cursor(stage,cursor,updated_at) values($1,$2,now())
     on conflict(stage) do update set cursor=excluded.cursor,updated_at=excluded.updated_at`,
    [stage, cursor],
  );
}

/** Newest day first on a fresh cursor; circular descending order thereafter
 * gives every workspace and all three live dates a turn, including failures.
 * A new UTC day joins the same ring rather than resetting historical progress. */
export async function selectLiveSlice(
  workspaceIds: string[],
  today: string,
  limit: number,
): Promise<{ units: QueueUnit[]; remaining: number }> {
  const result = await pool.query(
    `with candidates as (
       select d.usage_date::date::text as usage_date, w.workspace_id
       from generate_series($1::date - 2,$1::date,'1 day'::interval) d(usage_date)
       cross join (select unnest($2::text[]) workspace_id union all select null) w
     ), keyed as (
       select *,usage_date || '|' || coalesce(workspace_id,'') as key from candidates
     )
     select *,count(*) over()::integer as remaining from keyed
     order by (key < coalesce((select cursor from ingest_cursor where stage='live'),'~')) desc,
              key desc
     limit $3`,
    [today, workspaceIds, limit],
  );
  return {
    units: result.rows.map((row): QueueUnit => row.workspace_id === null
      ? { type: "account", usageDate: row.usage_date }
      : { type: "workspace", workspaceId: row.workspace_id, usageDate: row.usage_date }),
    remaining: Number(result.rows[0]?.remaining ?? 0),
  };
}

/**
 * Selects one bounded, circular slice of every account/workspace day that a
 * full sync still needs. The live tail is part of the same candidate set, so a
 * missing or failed live unit cannot appear in two lanes.
 */
export async function selectFullSyncSlice(
  workspaceIds: string[],
  today: string,
  liveFreshAfter: Date,
  limit: number,
): Promise<{
  units: QueueUnit[];
  remaining: number;
  remainingLiveCount: number;
  remainingBackfillCount: number;
}> {
  if (today < CUTOFF) {
    return {
      units: [],
      remaining: 0,
      remainingLiveCount: 0,
      remainingBackfillCount: 0,
    };
  }
  const result = await pool.query(
    `with failed_attempts as (
       select trim(failed_key) as key,max(r.finished_at) as failed_at
       from ingest_run r
       cross join lateral regexp_split_to_table(
         substring(r.error from length('failed-units:') + 1), E'\\n'
       ) failed_key
       where r.finished_at is not null and r.error like 'failed-units:%'
       group by trim(failed_key)
     ), days as (
       select usage_date::date
       from generate_series($1::date,$2::date,'1 day'::interval) usage_date
     ), workspaces as (
       select distinct workspace_id from unnest($3::text[]) workspace_id
     ), candidates as (
       select d.usage_date::text as usage_date,w.workspace_id
       from days d cross join workspaces w
       left join usage_workspace_day u
         on u.workspace_id=w.workspace_id and u.usage_date=d.usage_date
       left join failed_attempts f
         on f.key=d.usage_date::text || '|' || w.workspace_id
       where u.usage_date is null
          or u.status in ('stale','failed')
          or (f.failed_at is not null and
              (u.fetched_at is null or f.failed_at > u.fetched_at))
          or (d.usage_date >= $2::date - 2 and
              (u.fetched_at is null or u.fetched_at < $4::timestamptz))
       union all
       select d.usage_date::text,null::text
       from days d
       left join usage_account_day a on a.usage_date=d.usage_date
       left join failed_attempts f on f.key=d.usage_date::text || '|'
       where a.usage_date is null
          or (f.failed_at is not null and
              (a.fetched_at is null or f.failed_at > a.fetched_at))
          or (d.usage_date >= $2::date - 2 and
              (a.fetched_at is null or a.fetched_at < $4::timestamptz))
     ), keyed as (
       select *,usage_date || '|' || coalesce(workspace_id,'') as key
       from candidates
     )
     select *,
       count(*) over()::integer as remaining,
       count(*) filter (where usage_date::date >= $2::date - 2)
         over()::integer as remaining_live_count,
       count(*) filter (where usage_date::date < $2::date - 2)
         over()::integer as remaining_backfill_count
     from keyed
     order by
       (key > coalesce((select cursor from ingest_cursor where stage=$5),'')) desc,
       key
     limit $6`,
    [CUTOFF, today, workspaceIds, liveFreshAfter, FULL_SYNC_STAGE, limit],
  );
  return {
    units: result.rows.map((row): QueueUnit => row.workspace_id === null
      ? { type: "account", usageDate: row.usage_date }
      : { type: "workspace", workspaceId: row.workspace_id, usageDate: row.usage_date }),
    remaining: Number(result.rows[0]?.remaining ?? 0),
    remainingLiveCount: Number(result.rows[0]?.remaining_live_count ?? 0),
    remainingBackfillCount: Number(result.rows[0]?.remaining_backfill_count ?? 0),
  };
}

/** SQL limits the returned queue. Missing facts and durable failed-run keys are
 * separate lanes; a newer successful fetched_at retires an attempt failure. */
export async function selectIngestSlice(
  workspaceIds: string[],
  start: string,
  end: string,
  stage: string,
  limit: number,
  failedOnly = false,
): Promise<{ units: QueueUnit[]; remaining: number }> {
  if (end < start) return { units: [], remaining: 0 };
  const result = await pool.query(
    `with failed_attempts as (
       select trim(failed_key) as key,max(r.finished_at) as failed_at
       from ingest_run r
       cross join lateral regexp_split_to_table(
         substring(r.error from length('failed-units:') + 1), E'\\n'
       ) failed_key
       where r.finished_at is not null and r.error like 'failed-units:%'
       group by trim(failed_key)
     ), candidates as (
       select w.workspace_id, d.usage_date::date::text as usage_date
       from unnest($1::text[]) w(workspace_id)
       cross join generate_series($2::date,$3::date,'1 day'::interval) d(usage_date)
       left join usage_workspace_day u
         on u.workspace_id=w.workspace_id and u.usage_date=d.usage_date::date
       left join failed_attempts f
         on f.key=d.usage_date::date::text || '|' || w.workspace_id
        where case when $6 then
          (u.status='failed' or (f.failed_at is not null and
            (u.fetched_at is null or f.failed_at > u.fetched_at)))
         else u.status is null or u.status='stale' end
       union all
       select null::text, d.usage_date::date::text
       from generate_series($2::date,$3::date,'1 day'::interval) d(usage_date)
       left join usage_account_day a on a.usage_date=d.usage_date::date
       left join failed_attempts f on f.key=d.usage_date::date::text || '|'
        where case when $6 then
          f.failed_at is not null and (a.fetched_at is null or f.failed_at > a.fetched_at)
          else a.usage_date is null end
     ), keyed as (
       select *,usage_date || '|' || coalesce(workspace_id,'') as key from candidates
     )
     select *,count(*) over()::integer as remaining from keyed
     order by (key > coalesce((select cursor from ingest_cursor where stage=$4),'')) desc,key
     limit $5`,
    [workspaceIds, start, end, stage, limit, failedOnly],
  );
  return {
    units: result.rows.map((row): QueueUnit => row.workspace_id === null
      ? { type: "account", usageDate: row.usage_date }
      : { type: "workspace", workspaceId: row.workspace_id, usageDate: row.usage_date }),
    remaining: Number(result.rows[0]?.remaining ?? 0),
  };
}