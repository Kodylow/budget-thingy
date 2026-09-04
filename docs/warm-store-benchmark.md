# Current authenticated read-path benchmark

This benchmark covers all 16 paths in the current runner: generated Dashboard,
all active Spend JSON and CSV views, full-term and billing group detail, group
projects, canonical cluster headline/projects, the Set Limits workspace read
model, and the allocation read model. It performs GET requests only. It measures
the durable Postgres store; it is not a production capacity claim.

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
- decoded bytes and `Content-Length` when present, content encoding,
  Cache-Control, and every distinct Server-Timing value;
- process event-loop delay for the complete run (not per endpoint).

The optional ingestion-active profile runs the same eight-request batches while
`ingest:once` is active. Before measurement, the runner requests the full-term
group list, candidate group detail paths, and current authorization to select an
authorized representative family cluster and writable Set Limits workspace.
That capability is used only for the Set Limits GET; the runner never calls a
prepare, commit, retry, refresh, or other mutation endpoint. Paths are then
measured serially, so route-cache-cold
samples are order-dependent and are not process-cold. A true process-cold
measurement requires restarting the API immediately before the runner.

## Fixture and method

Measured September 4, 2026 at 15:27:22 UTC against the current development
snapshot:

- reporting range: Full term, all-authorized scope;
- representative group: `KBE16XLQ`;
- representative workspace: `ntcqubwqvl`;
- managed API workflow restarted immediately before measurement;
- ingestion-active profile disabled, although Dashboard Server-Timing values
  show repeated persisted-accounting rebuilds during the run;
- 1 recorded route-cache-cold request, 2 unrecorded warmups, 20 recorded
  sequential requests, and 8 recorded concurrent requests per endpoint;
- nearest-rank percentile method.

Payload sizes ranged from 8,159 bytes for Dashboard to 577,431 bytes for
project CSV. Every response supplied `Content-Length`, matching the decoded
size, and reported identity encoding.

## Last measured result (before the current Dashboard cache)

| Endpoint | Decoded bytes | Warm requests | Warm p50 / p95 | Concurrent requests | Concurrent p50 / p95 | Server-Timing |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Dashboard | 8,159–8,236 | 20 | 848.9 / 943.0 ms | 8 | 102.8 / 178.2 ms | `accounting` |
| Spend pools JSON | 14,719 | 20 | 4.1 / 4.9 ms | 8 | 15.0 / 23.9 ms | `spend` |
| Spend groups JSON | 14,864 | 20 | 3.7 / 4.4 ms | 8 | 12.0 / 20.8 ms | `spend` |
| Spend people JSON | 15,019 | 20 | 4.8 / 15.7 ms | 8 | 13.0 / 22.4 ms | `spend` |
| Spend projects JSON | 16,315 | 20 | 3.8 / 4.4 ms | 8 | 13.1 / 27.6 ms | `spend` |
| Pools CSV | 11,110 | 20 | 4.1 / 4.6 ms | 8 | 11.9 / 21.3 ms | `spend` |
| Groups CSV | 21,773 | 20 | 3.8 / 4.5 ms | 8 | 11.4 / 19.5 ms | `spend` |
| People CSV | 117,162 | 20 | 5.7 / 6.4 ms | 8 | 17.9 / 33.6 ms | `spend` |
| Projects CSV | 577,431 | 20 | 12.9 / 15.0 ms | 8 | 45.8 / 83.2 ms | `spend` |
| Group detail, full term | 51,553–51,554 | 20 | 32.3 / 38.1 ms | 8 | 128.2 / 215.7 ms | `group` |
| Group detail, billing | 46,624–46,627 | 20 | 17.2 / 20.6 ms | 8 | 84.8 / 127.9 ms | `group` |
| Group projects, full term | 70,274 | 20 | 16.8 / 20.1 ms | 8 | 80.9 / 147.9 ms | **missing** |

Spend remains close to the previous September 4 reference: warm medians are
3.7–12.9 ms, and project CSV remains the largest payload. Full-term and billing
group detail are both reported now; the prior table omitted billing detail even
though the runner measured it. Group projects still does not emit
Server-Timing, and the table marks that miss rather than treating it as zero.

Dashboard does not reproduce the prior 25.5 / 27.8 ms warm reference. Fifteen
of 20 sequential responses reported `accounting` durations around 798–933 ms,
then five were around 19–22 ms. This produces 848.9 / 943.0 ms and indicates
generation invalidation or overlapping startup work despite the optional
ingestion profile being disabled. No capacity or regression-cause claim is made
from this run; it is the current observed result and should be investigated
separately rather than hidden by reusing the older number.

The Dashboard implementation has since gained a bounded response cache and
phase-level Server-Timing, and the runner has gained the four read paths listed
above. No populated authenticated fixture was available to this change set, so
the table remains the September 4 pre-change measurement. In particular, this
document does **not** claim that the new implementation meets the <150 ms warm
p95 target. Rerun both the stable profile and `BENCHMARK_WITH_INGEST=1` before
making that claim.

Route-cache-cold results are reported by the runner but are sensitive to which
lower-level snapshot was warmed by the preceding endpoint. They are not used as
an optimization claim. Aggregate event-loop delay for the complete run was mean
20.1 ms, p95 20.5 ms, and max 26.8 ms. This is process-wide evidence, not an
endpoint-specific attribution. The ingestion-active profile was not run and no
ingestion-active number is claimed.

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

- Dashboard and Spend cache keys include identity, preview/capabilities,
  effective authorized scope, canonical query, resolved reporting window,
  directory/limit generation, the process usage generation, and a content
  revision of allocation, target, mapping, and adjustment rows.
- The cache is capped at 256 LRU entries, uses a 30-second fresh interval and a
  two-minute same-key stale-success interval, and deduplicates cold misses and
  refreshes.
- Dashboard caches the validated serialized response. Stale success is
  available only under the exact same identity, scope, range, generation, and
  allocation-revision key.
- Unit-level usage invalidations are coalesced while the process owns an
  ingestion cycle, then published once when that cycle exits. This reduces
  process-local generation churn, but is not a transactional cross-process
  database generation: a first-time uncached scope can still observe committed
  units while ingestion is active. Dashboard suppresses refresh of an available
  same-key stale response during that local publication window.
- Scope resolution happens before independent stored reads are started, and
  the prepared directory/effective authorization context is reused by a miss.
- Dashboard Server-Timing separates `authorization`, `stored-read`, cache
  lookup (`hit`, `stale`, `in-flight`, or `miss`), `accounting`, `rollups`,
  serialized `response` assembly, and total route time. On a response-cache hit,
  accounting, rollups, and response assembly report zero for that request.