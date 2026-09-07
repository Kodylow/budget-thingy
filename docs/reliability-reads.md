# Reliable usage reads

Usage reports are assembled from daily member, project, workspace, and
optionally account facts. These tables are written atomically per ingest unit,
but a report spans several tables. Atomic writes alone therefore do not make a
multi-query report coherent.

## Database snapshot

`usage-store.ts` checks out one pool client and executes all table reads in a
short, read-only, repeatable-read transaction. PostgreSQL consequently gives
every query in one report the same committed snapshot, even when another
client commits an ingest unit between table reads. The transaction contains no
provider calls or other network work. It commits after the reads and always
releases the client; read failures attempt a rollback and remain visible to the
caller.

## Cache publication

Snapshot entries are promise-deduplicated and bounded to 128 LRU entries.
Entries expire after 30 seconds by default. Expiration reloads the underlying
tables rather than merely reclassifying the prior object. This bounds how long
a commit made by another process can remain invisible to a warmed process.
Rejected loads are removed immediately.

The process generation used by prepared route caches has the same bounded
lifetime. Local ingest invalidations still publish immediately after the
admitted batch finishes. An expiry observed while a local generation update is
active is deferred and coalesced with that update, so intermediate committed
slices are not advertised as the completed generation.

These are freshness bounds, not distributed commit notifications. A response
started before a commit may validly return the older committed snapshot; a
subsequent generation/TTL reload observes the new commit. No old snapshot is
relabeled as a newer locally published generation.

## Metric-specific readiness and scope

The snapshot exposes `workspaceStatus` and `workspaceDataAsOf` independently
from aggregate/account readiness. Missing or old account-day anchors therefore
do not make known workspace metrics unavailable. Account-wide readers retain
the combined `status` and `dataAsOf`.

Authorization-aware reporting callers pass `includeAccountAnchor: false` for
workspace, team, member, and preview scopes. The store then does not query
account-day facts, returns no account days, excludes account days from
coverage, and derives the overall status from workspace facts. Account-wide
callers opt in. This avoids putting privileged account reconciliation anchors
into a workspace-scoped snapshot, while preserving account reconciliation for
authorized account views.

Failed acquisition attempts are recorded separately from last-good facts in
`ingest_run.error`. The same repeatable-read load reads that ledger, filters it
to the requested date/workspace scope, and exposes only failed units newer
than their corresponding successful fact. Such a snapshot is stale (or
partial when facts are also missing) and carries a compact last-good
qualification. A later successful fact clears the active failure qualifier;
the operator run history remains the durable audit trail. The SQL aggregates
the latest attempt per requested unit before returning rows; it does not apply
a global recent-run cap that could hide an older active failure behind
unrelated runs.

Workspace acquisition statuses remain compatible with the existing persisted
values: `complete`, `stale`, and `failed`. Read reliability does not infer new
ingest states or alter acquisition schemas.