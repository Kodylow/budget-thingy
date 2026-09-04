# Current authenticated read-path benchmark

This benchmark covers the product's current initial read paths: generated
Dashboard, all active Spend JSON and CSV views, group detail, and group
projects. It measures the durable Postgres store; it is not a production
capacity claim.

## Reproduce

1. Start the managed API workflow with a populated development database.
2. Sign in through the web app. The runner selects the newest usable
   development session and never prints its ID.
3. Run `pnpm --filter @workspace/api-server run benchmark:warm`.
4. To deliberately overlap an ingestion process, run
   `BENCHMARK_WITH_INGEST=1 pnpm --filter @workspace/api-server run benchmark:warm`.

`BENCHMARK_BASE_URL` may point at another local API process, but accepts only an
HTTP loopback URL ending in `/api`. Each endpoint records:

- one route-cache-cold request (lower-level process caches may already be warm);
- two unrecorded warmups and 20 sequential requests;
- one batch of eight concurrent requests;
- decoded and wire-reported bytes, content encoding, Cache-Control,
  Server-Timing, and process event-loop delay.

The optional ingestion-active profile runs the same eight-request batches while
`ingest:once` is active. A true process-cold measurement requires restarting the
API immediately before the runner.

## Fixture and method

Measured September 4, 2026 against the development snapshot:

- reporting range: Full term, all-authorized scope;
- representative group: `KBE16XLQ`;
- representative workspace: `ntcqubwqvl`;
- baseline: clean detached pre-change process on port 8091;
- result: managed post-change workflow after startup ingestion settled;
- identical authenticated session, database, runner, request counts, and
  nearest-rank percentile method.

The persisted fixture had 20 workspaces in the representative query-plan scope,
about 2,160 workspace-day rows and 62,928 required project-day rows. Payload
sizes ranged from 8,238 bytes for Dashboard to 577,431 bytes for project CSV.

## Before and after: warm sequential

| Endpoint | Bytes | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: | ---: |
| Dashboard | 8,238 | 32.2 / 35.7 ms | 25.5 / 27.8 ms |
| Spend pools JSON | 14,717 | 3.6 / 4.6 ms | 3.9 / 4.3 ms |
| Spend groups JSON | 14,864 | 3.6 / 4.0 ms | 3.9 / 4.4 ms |
| Spend people JSON | 15,025 | 3.2 / 3.9 ms | 4.1 / 5.0 ms |
| Spend projects JSON | 16,315 | 2.6 / 4.0 ms | 3.9 / 5.2 ms |
| Pools CSV | 11,107 | 29.6 / 31.2 ms | 3.7 / 4.9 ms |
| Groups CSV | 21,761 | 28.7 / 31.0 ms | 3.7 / 4.3 ms |
| People CSV | 117,160 | 35.0 / 47.7 ms | 5.5 / 9.8 ms |
| Projects CSV | 577,431 | 230.0 / 241.7 ms | 13.2 / 14.6 ms |
| Group detail | 51,781 | 28.4 / 31.8 ms | 29.1 / 44.4 ms |
| Group projects | 70,258 | 16.5 / 18.7 ms | 16.7 / 26.1 ms |

The small JSON differences are runner noise around an already-hot result cache.
The material gain is that CSV now uses the same bounded, authorized cache
implementation as JSON. JSON and CSV keep distinct entries because their parsed
pagination contracts differ. Historical daily facts remain loaded so
membership changes retain their established per-day attribution. Group
detail's warm median is unchanged; its full-term p95 varied in this run, so no
latency improvement is claimed for that cell. Billing detail additionally
reuses its selected usage generation rather than rebuilding the same billing
window.

## Cold, concurrent, and ingestion-active evidence

Route-cache-cold results are reported by the runner but are sensitive to which
lower-level usage snapshot was warmed by the preceding endpoint. They are not
used as an optimization claim. Process-cold behavior is represented only by a
fresh server process and should be compared separately from route-cache misses.

Representative eight-request concurrent p95 changes:

- Dashboard: 245.1 ms to 191.1 ms;
- pools CSV: 209.2 ms to 21.0 ms;
- people CSV: 265.4 ms to 34.7 ms;
- projects CSV: 1,878.4 ms to 94.8 ms.

A managed-workflow run overlapping startup ingestion recorded Dashboard p50
924.3 ms / p95 1,019.5 ms while snapshots were repeatedly invalidated. After
the cycle settled, the same Dashboard cell was 25.5 / 27.8 ms. This is retained
as honest ingestion-active evidence rather than blended into the idle result.
Idle event-loop delay was mean 20.1 ms, p95 20.8 ms, max 21.2 ms; the
ingestion-active run reached a 36.3 ms maximum.

## Storage plans and delivery policy

Representative `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` results:

| Stored read | Rows | Plan | Execution |
| --- | ---: | --- | ---: |
| member aggregate | 646 | aggregate over sequential scan | 1.68 ms |
| workspace days | 2,160 | sequential scan | 0.98 ms |
| project days | 62,928 | sequential scan | 73.81 ms |

No index was added. The member/workspace reads were already sub-2 ms, and the
active all-authorized project view consumes most of the returned project facts;
an index would not remove the measured payload and JSON metric work.

Authenticated JSON and CSV responses send `Cache-Control: private, no-store`
and vary on Authorization, Cookie, and Accept-Encoding. The local loopback
proxy reported identity encoding, so no compression gain is claimed. This API
artifact serves no public assets; hashed browser assets belong to the separate
web artifact and are therefore outside this server-read profile.

## Cache and correctness notes

- Cache keys include identity, preview/capabilities, effective authorized scope,
  canonical query, resolved reporting window, directory/limit generation, and
  the process usage generation.
- The cache is capped at 256 LRU entries, uses a 30-second fresh interval and a
  two-minute same-key stale-success interval, and deduplicates cold misses and
  refreshes.
- Usage ingestion invalidates the generation before subsequent requests can
  reuse an old result. A failed refresh leaves only the already-authorized
  same-key stale success available.
- Scope resolution happens before independent stored reads are started, and
  the prepared directory/effective authorization context is reused by a miss.