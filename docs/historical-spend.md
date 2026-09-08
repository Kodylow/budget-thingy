# Historical spend: recorded facts and attribution

## Source of truth and lifecycle

Financial reads use committed PostgreSQL daily usage, never a request-time
Enterprise financial response. The ingestion floor is **May 20, 2026**; the
funding axis remains **May 20, 2026–May 20, 2027**. Changing the selected reporting
window does not change that funding term or any monthly limit.

The single scheduled owner holds the usage-ingest advisory lock. It refreshes
the bounded live tail and rotates through bounded backfill, retry, and
reconciliation slices. A successful workspace/day transaction replaces only
that day's member and project breakdowns and upserts its workspace total.
Replaying a response replaces, rather than adds to, the previous observation.
Failed fetches or transactions retain last-good facts; attempt failures are
recorded separately. Project, member, and workspace breakdowns overlap: they
are not additional independent dollars.

The usage store reads a repeatable-read, read-only transaction. Its bounded
30-second memo caches only database-derived results. Local commits invalidate
it; another process's commits become visible after the bounded lifetime.
Project attribution reads a scoped committed metadata/evidence snapshot and
includes evidence in its revision, rather than relying on process-only
invalidation.

## Four separate reporting dimensions

- **Usage acquisition:** complete, partial, or unavailable, based on persisted
  workspace/day facts—not scheduler cursors or roster coverage.
- **Roster attribution:** observed daily rosters where captured, explicit
  current-membership attribution where no historical roster was captured.
  Today remains live. No historical memberships are invented.
- **Project creator evidence:** resolved workspace-qualified observations,
  missing evidence, or conflicting observations. A successful current catalog
  refresh alone does not establish historical creator coverage.
- **Freshness:** when facts were last successfully acquired and whether a newer
  refresh failed. Stale data can still be known data.

Known cumulative amounts remain visible through attribution gaps and later
source gaps. Before any usage is observed the value is unavailable, not zero.
Current-membership amounts are qualified estimates of attribution; they are
not automatically lower bounds and are not verified historical ownership.
Verified remaining funding, utilization, and pacing stay unavailable when the
needed acquisition or attribution basis is incomplete. Detailed methodology
and reasons belong in the authorized Data quality surface.

## Retained project evidence versus current inventory

`api_project_metadata` is the replaceable current catalog. It can remove
projects, includes current zero-spend projects, and is still used for current
inventory identity election. `api_project_creator_evidence` separately retains
workspace/project/creator observations, their source, and first/last observation
timestamps. Both refresh paths commit evidence with a successful catalog
replacement. Empty listings and removals do not delete evidence or resurrect
removed projects in inventory.

The additive migration copies available current creator observations using
their stored fetch timestamps. That preserves evidence already present; it
does **not** recover deleted history. Observation time is not an effective-from
date. A sole retained creator remains an attribution candidate in the original
workspace. Different observed creators for the same workspace/project resolve
as conflicting and remain unassigned rather than silently moving past charges.
A destination workspace's creator is never borrowed for original-workspace
usage. Previously unseen evidence remains unresolved.

## Bounded, read-only diagnostic

From the repository root:

```sh
pnpm --filter @workspace/api-server diagnose:history 2026-09-08
```

The optional through-date defaults to today and is bounded to 366 days from the
ingestion floor. The diagnostic runs one read-only repeatable-read transaction,
with a 20-second statement timeout. It reports only aggregate counts, dates,
money, and timestamps: no identities, credentials, or raw provider errors.
It separates current-directory expected units, missing/failed acquisition,
active newer refresh failures, observed roster dates, current metadata gaps,
retained evidence conflicts/gaps, monthly stored account/workspace differences,
and timestamps of prior upstream reconciliation observations.

It makes no provider calls. Prior reconciliation observations describe their
checked time, not a fresh upstream verification. Expected workspace/day counts
use current persisted inventory; they do not assert reconstructed workspace
lifetimes.

## Development verification on September 8, 2026

Before and after the evidence migration, development storage contained 2,240
workspace/day facts (20 current workspaces × 112 dates), May 20–September 8,
with no missing or failed units. There were 112 account dates and five observed
roster days, September 4–8; 107 dates had no observed roster.

| Month | Stored workspace gross | Account minus workspace |
| --- | ---: | ---: |
| May 20–31 | $9,882.93 | $0.00 |
| June | $43,487.75 | $4.61 |
| July | $26,688.92 | $0.00 |
| August | $30,137.95 | $0.00 |

The pre-September gross total is **$110,197.55**. These are gross source totals,
not funding-team allocation-eligible totals. June's difference remains an
explicit reconciliation difference and is not distributed into team charges.
September is a live period and can advance independently.

Of 2,572 workspace/project identities in recorded usage, 974 lacked current
metadata; 735 of those appeared in another workspace's catalog. The migration
retained existing evidence for 1,598 of the usage identities. The same 974
remained unresolved, with no conflicting retained creator identities at the
check. No lost ownership history was claimed recovered. These are development
results; no production or fresh upstream verification is claimed.

A database-only Org Insights route check, with provider access forced to fail
and without starting the scheduler, returned HTTP 200 and made **zero provider
calls**. Its 28 team rows totaled **$99,780.56**, equal to the sum of final chart
points at displayed cents. The maximum per-team floating-point difference was
less than $0.0000001. Twenty-seven teams had visible pre-September points; one
had no observable mapped scope and stayed unavailable. The cumulative
allocation-eligible team amounts at month end were $8,658.87 (May),
$43,419.71 (June), $67,848.17 (July), and $95,582.15 (August).
All verified remaining-funding claims stayed withheld. These team amounts use
the reporting allocation/exclusion basis and therefore are not the gross
workspace values above. Acquisition was complete, roster attribution mixed,
creator coverage partial, and values current-membership-qualified; source
freshness aged independently while verification deliberately paused ingestion.

## Safe recovery

Inspect the diagnostic first. Missing rosters or creator evidence alone do not
justify re-ingesting already complete usage. Never reset, reseed, or distribute
unassigned money to improve apparent completeness.

If actual acquisition units need recovery, the existing explicit data-only
command is resumable and shares the scheduled owner's lock:

```sh
pnpm --filter @workspace/api-server ingest:full --max-minutes=5
```

That command performs provider reads and durable data writes; run it only when
recovery is intended. It is not part of a diagnostic. It never invokes the
business-cycle alert, allocation-import, or limit-policy operations. Do not use
`ingest:business-cycle` to repair historical display. Schema application follows
the existing reviewed development setup procedure; publication and production
acceptance are separate work.