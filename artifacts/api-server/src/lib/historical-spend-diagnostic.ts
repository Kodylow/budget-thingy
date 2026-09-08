import { pool } from "@workspace/db";
import { CUTOFF } from "./ingest-selection";

/** Aggregate-only operator diagnostic. No identities, provider calls, or writes. */
export async function diagnoseHistoricalSpend(
  throughDate = new Date().toISOString().slice(0, 10),
  queryable = pool,
) {
  const end = Date.parse(`${throughDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDate) || !Number.isFinite(end) ||
      new Date(end).toISOString().slice(0, 10) !== throughDate ||
      throughDate < CUTOFF || end - Date.parse(CUTOFF) > 366 * 86_400_000) {
    throw new Error("Diagnostic requires a valid date within 366 days of the ingestion floor.");
  }
  const client = await queryable.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    await client.query("set local statement_timeout = '20s'");
    const values = [CUTOFF, throughDate];
    const usage = await client.query(
      `with directory as (
         select jsonb_object_keys(directory_json->'workspaces') as workspace_id
         from api_directory_cache where id='singleton'
       ), days as (
         select d::date as usage_date from generate_series($1::date,$2::date,'1 day') d
       )
       select
         (select min(usage_date)::text from usage_workspace_day) as actual_first_usage_date,
         (select max(usage_date)::text from usage_workspace_day) as actual_last_usage_date,
         (select count(*)::int from directory) as current_directory_workspaces,
         (select count(*)::int from usage_workspace_day
           where usage_date between $1::date and $2::date) as stored_workspace_days,
         count(*)::int as expected_current_workspace_days,
         count(*) filter(where u.status in ('complete','stale'))::int as observed_workspace_days,
         count(*) filter(where u.usage_date is null)::int as missing_workspace_days,
         count(*) filter(where u.status='failed')::int as failed_workspace_days,
         count(*) filter(where u.status='stale')::int as stale_workspace_days,
         min(u.fetched_at) as oldest_workspace_observation,
         max(u.fetched_at) as newest_workspace_observation,
         (select count(*)::int from days d left join usage_account_day a using(usage_date)
           where a.usage_date is null) as missing_account_days
       from days cross join directory w left join usage_workspace_day u
         on u.workspace_id=w.workspace_id and u.usage_date=days.usage_date`,
      values,
    );
    const failures = await client.query(
      `with failed_units as (
         select split_part(k,'|',1) as usage_date, nullif(split_part(k,'|',2),'') as workspace_id,
           max(finished_at) as attempted_at
         from ingest_run cross join lateral unnest(string_to_array(
           substring(error from char_length('failed-units:')+1), E'\\n')) k
         where failures>0 and error like 'failed-units:%' and finished_at is not null
         group by 1,2
       )
       select count(*) filter(where f.workspace_id is not null)::int as active_workspace_refresh_failures,
         count(*) filter(where f.workspace_id is null)::int as active_account_refresh_failures
       from failed_units f
       left join usage_workspace_day w on f.workspace_id=w.workspace_id and f.usage_date=w.usage_date::text
       left join usage_account_day a on f.workspace_id is null and f.usage_date=a.usage_date::text
       where f.usage_date between $1 and $2 and
         (case when f.workspace_id is null then a.fetched_at else w.fetched_at end is null or
          f.attempted_at > case when f.workspace_id is null then a.fetched_at else w.fetched_at end)`,
      values,
    );
    const roster = await client.query(
      `select min(snapshot_date)::text as first_observed_roster_date,
         max(snapshot_date)::text as last_observed_roster_date,
         count(*)::int as observed_roster_days,
         ($2::date-$1::date+1)-count(*)::int as dates_without_observed_roster
       from group_roster_snapshot_days where snapshot_date between $1::date and $2::date`,
      values,
    );
    const metadata = await client.query(
      `with identities as (
         select distinct workspace_id,project_id from usage_project_day
         where usage_date between $1::date and $2::date
       )
       select count(*)::int as usage_project_workspace_identities,
         count(*) filter(where m.project_id is null)::int as absent_from_current_catalog,
         count(*) filter(where m.creator_id is null)::int as without_current_creator,
         count(*) filter(where m.project_id is null and exists (
           select 1 from api_project_metadata other
           where other.project_id=i.project_id and other.workspace_id<>i.workspace_id
         ))::int as absent_here_but_listed_elsewhere
       from identities i left join api_project_metadata m using(workspace_id,project_id)`,
      values,
    );
    const evidence = await client.query(
      `with identities as (
         select distinct workspace_id,project_id from usage_project_day
         where usage_date between $1::date and $2::date
       ), evidence as (
         select workspace_id,project_id,count(distinct creator_id) as creators
         from api_project_creator_evidence group by workspace_id,project_id
       )
       select count(*) filter(where e.creators=1)::int as unambiguous_observed_creator_identities,
         count(*) filter(where e.creators>1)::int as conflicting_creator_identities,
         count(*) filter(where e.creators is null)::int as identities_without_retained_evidence
       from identities i left join evidence e using(workspace_id,project_id)`,
      values,
    );
    const monthly = await client.query(
      `with w as (
         select date_trunc('month',usage_date)::date as month_start,sum(total_cost_usd) as usd
         from usage_workspace_day where usage_date between $1::date and $2::date group by 1
       ), a as (
         select date_trunc('month',usage_date)::date as month_start,sum(total_cost_usd) as usd
         from usage_account_day where usage_date between $1::date and $2::date group by 1
       )
       select coalesce(w.month_start,a.month_start)::text as month_start,
         round(w.usd::numeric,2) as workspace_gross_usd,round(a.usd::numeric,2) as account_gross_usd,
         round((a.usd-w.usd)::numeric,2) as account_minus_workspace_usd
       from w full join a using(month_start) order by month_start`,
      values,
    );
    const reconciliation = await client.query(
      `select min(checked_at) as oldest_check,max(checked_at) as newest_check,
         count(*)::int as stored_observations,
         count(*) filter(where abs(delta_usd)>1)::int as observations_over_tolerance
       from ingest_reconciliation
       where month_start between date_trunc('month',$1::date) and $2::date`,
      values,
    );
    await client.query("commit");
    return {
      checkedAt: new Date().toISOString(),
      window: { from: CUTOFF, through: throughDate },
      source: "committed Postgres; no fresh upstream comparison",
      usage: usage.rows[0],
      refreshFailures: failures.rows[0],
      roster: roster.rows[0],
      historicalMetadata: metadata.rows[0],
      retainedCreatorEvidence: evidence.rows[0],
      monthlyGrossReconciliation: monthly.rows,
      priorUpstreamReconciliationObservations: reconciliation.rows[0],
      notes: [
        "Expected workspace days use the persisted current directory, not reconstructed historical inventory.",
        "Missing rosters imply current-membership attribution, not missing usage or verified past ownership.",
        "A different workspace's current project listing is not creator evidence for original-workspace charges.",
        "Project amounts overlap workspace/member accounting and must never be added as missing dollars.",
      ],
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}