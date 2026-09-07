# Full analytics sync

Run from the workspace root:

```sh
pnpm --filter @workspace/api-server run ingest:full
```

`ingest:once` now uses the same **data-only** behavior by default. No allocation
import, threshold evaluation, alert delivery, team-limit reconciliation, or
member-limit enforcement is called by this command. It does not migrate or seed
the database. Use an already provisioned database and the existing Enterprise
API configuration.

## What it synchronizes

- Refreshes and validates the complete workspace/member/group directory and
  records the current UTC roster using the existing immutable-roster rules.
- Observes current billing metadata, preserving its existing two-observation
  adoption rule.
- Drains missing, stale, and failed account/workspace usage days from
  **2026-05-20** through the UTC date on which the command started. Workspace
  member/project breakdowns retain atomic replacement: a failed refresh never
  deletes the last-good data.
- Refreshes the three-day live tail when its successful fetch predates the
  command's fixed freshness boundary (start time minus ten minutes).
- Drains pending monthly reconciliation, including historical facts updated
  after a previous check. Live-tail days are excluded from reconciliation.
  If reconciliation marks facts stale, the command returns to usage ingestion.
- Refreshes project metadata for every expected workspace. Completion requires
  a successful persisted refresh within the existing 15-minute TTL, including
  successful empty listings. A recent failed/deferred attempt is **not** success.

The scope/date and live freshness boundary are fixed per invocation, so advancing
time does not continuously refill the usage queue. Rerun after midnight for the
new UTC day's scope. Metadata freshness is checked at completion.
Reconciliation completion means all expected observations are current; it does
not assert that provider totals are identical to local totals. Existing
reconciliation deltas and mismatch rules remain authoritative.

## Progress, stopping, and resuming

The command prints JSON progress records (`event: "full_data_sync"`) at startup,
after directory discovery, after each bounded slice, and at termination. Each
includes a run ID, stage, outcome, cumulative attempt/success/failure counts and
actual remaining counts for live usage, backfill, reconciliation, and metadata.
`usageCalls` counts daily usage and reconciliation requests, not directory,
billing or metadata requests. Unknown counts are `null`, never fabricated zeros.
Earlier failures may remain in cumulative counters after a successful retry;
completion is decided from durable coverage, not those cumulative counters.

The latest acquired owner's progress is saved in `ingest_cursor` under
`full-sync-status`; bounded usage/reconciliation slice audits remain in
`ingest_run`. A lock contender does not overwrite the active owner's status.
For a read-only status check:

```sql
select cursor::jsonb, updated_at
from ingest_cursor
where stage = 'full-sync-status';
```

Default time budget: **60 minutes**. To change it:

```sh
pnpm --filter @workspace/api-server run ingest:full --max-minutes=120
```

SIGINT/SIGTERM and time budgets stop admission between bounded slices; already
admitted work settles before the advisory lock is released. A slice can exceed
the overall time budget while finishing its bounded, atomic work. Three
consecutive slices with provider failures, or three slices without successful
progress, stop the command instead of looping indefinitely. Project deadline
deferrals are retried without treating the failed-attempt cooldown as success;
repeated deferrals exit incomplete.

| Exit | Outcome | Meaning |
| --- | --- | --- |
| 0 | `completed` | All expected data coverage and freshness checks passed |
| 1 | `failed` | Configuration, provider, or persistence failure; inspect the reason |
| 2 | `lock_not_acquired` | Another ingest owner is running; no work performed |
| 3 | `deferred` | Time budget, interruption, or repeated lack of progress |

Rerun the **same command** to resume. Durable successful facts, failure records,
reconciliation checkpoints and selection cursors determine what remains; no
reset or seed is needed. A forced process kill may leave the last progress record
marked `running`, so do not interpret that record alone as a live process. The
database advisory lock remains the ownership authority.

## Explicit business operations and scheduler

To deliberately run the former one-cycle behavior:

```sh
pnpm --filter @workspace/api-server run ingest:business-cycle
# Equivalent: ingest:once --business-cycle
```

This runs a bounded scheduler cycle **including** threshold checks/alerts,
optional allocation import, team-limit drift refresh, and member-limit policy
enforcement. Its exit 0 means the bounded cycle succeeded, not a full drain.
It cannot be combined with data-sync flags.

The existing startup/ten-minute scheduler is unchanged. Full sync holds its
existing `usage-ingest` advisory lock, uses the same shared provider admission and
bounded workers, and does not start a second scheduler. A scheduled cycle that
finds the lock busy skips that cycle. After the full-sync owner releases the lock,
the scheduler can still perform its normal business operations on the updated
data; a data-only command does not disable the application's scheduler.