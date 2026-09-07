# Acquisition and recovery reliability

## Reliability contract

- A row in a usage fact table is the last successful observation. A failed
  refresh does not rewrite its amount, `fetched_at`, status, member rows, or
  project rows.
- The latest failed unit attempts are recorded in the existing durable
  `ingest_run.error` field as a bounded `failed-units:` ledger. `started_at` and
  `finished_at` describe the attempt, while fact `fetched_at` describes the last
  success.
- A cold failure has no fact and therefore cannot be interpreted as an
  authoritative zero. An explicit, structurally complete provider response
  containing zero amounts is accepted and published as zero.
- Every workspace member and project page must explicitly echo the requested
  UTC interval and contain finite non-negative numeric
  totals, valid group keys and metrics, and explicit pagination state. Missing,
  string, negative, non-finite, cursorless, repeated-cursor, and
  aggregate-changing pages fail the whole workspace-day replacement.
- Daily and reconciliation intervals are rejected when the provider returns
  bounds different from those requested.
- Workspace-day replacement remains one transaction. Provider retries remain
  bounded at three attempts, page traversal remains bounded at 200 pages, and
  queue admission remains bounded by unit, call, and duration budgets.
- The PostgreSQL advisory lock remains the single cycle owner. Failed cursors
  advance for fairness, while durable failed-unit keys remain eligible until a
  newer successful fact exists. Account-day failures now participate in the
  same recovery lane.
- Cycle completion is qualified as `healthy`, `recovering`, or `degraded`.
  Remaining live and backfill counts are separate from failed units, so a
  bounded pass is not reported as complete coverage.
- A failed account reconciliation preserves a prior complete observation's
  value, successful timestamp, interval, and source status. The failure remains
  visible in its error field; a cold failed observation remains failed.

## Storage and status coordination

No schema or migration change is required. Unit-attempt keys use the existing
bounded `ingest_run.error` field, and stage-level attempt times, calls, failures,
and remaining work use existing `ingest_run` columns.

The operator status owner can expose the following without an OpenAPI storage
change:

- latest successful acquisition stage: newest finished live/backfill run with
  at least one successful unit (this is not labeled as a fact observation);
- latest attempt: latest `ingest_run.finished_at`;
- latest attempt failures: `ingest_run.failures`;
- retryable unit keys/count: newline entries after `failed-units:`, filtered
  against facts with newer `fetched_at`;
- recovery progress: `units`, `calls`, and `remaining`;
- cycle health: degraded when failures are nonzero, recovering when remaining
  work is nonzero, otherwise healthy.

The existing `/status` contract is now used by Settings to expose a compact
Usage acquisition row. It separates latest attempt from the last successful
live/backfill acquisition stage, shows
healthy/recovering/degraded/running/stale state and backfill remaining, and
places all bounded stage/scope/day failed-attempt detail behind a native
disclosure rather than adding a permanent banner. Recent run and current-month
reconciliation disclosures make the latest 20-run response reachable.
Failed-unit ledgers are not mistaken for whole-run failure when some units
succeeded, and old failures/backlog retire after newer facts/stage runs. Status
backlog discovery uses the current directory workspace set; if directory
loading is unavailable, the endpoint remains available and uses stored
workspace facts as its bounded fallback. Rate-window telemetry is returned as
unknown (`null`) because run call count is not a measured per-minute peak.
Project-metadata detail failure no longer makes acquisition status unavailable;
the existing project-enrichment fields represent this as no verified status
with pending work, and Settings labels that state Unknown.

## Limitations

- The compact failed-unit ledger is intentionally bounded by queue admission,
  but it is operational text rather than a normalized attempt-history table.
  It provides latest retry state, not unlimited per-unit attempt history.
- A process/database failure between publishing a fact and finishing its
  `ingest_run` can cause a harmless replay. Atomic fact replacement makes that
  replay idempotent.
- Provider responses that omit interval metadata are accepted because existing
  provider compatibility permits omission; returned interval metadata, when
  present, must match exactly.
- Validation proves structural completeness and pagination termination. It
  cannot prove that an upstream provider omitted an entity while presenting a
  formally complete response.
- Legacy `status='failed'` rows remain retryable and are replaced only by a
  successful acquisition.