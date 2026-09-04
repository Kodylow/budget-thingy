# Authenticated warm-store benchmark

This benchmark measures sequential development requests against the durable Postgres usage store. It is not a cold-start, concurrency, load, or production-capacity test.

## Reproduce

1. Start the managed API and web workflows with a configured development database and Enterprise API credentials.
2. Sign in through the web app. The runner uses the newest unexpired development session from the local database and never prints the session ID.
3. Confirm the store is populated. If needed, run `pnpm --filter @workspace/api-server run ingest:once` and wait for a successful cycle.
4. Run `pnpm --filter @workspace/api-server run benchmark:warm`.

The runner first calls full-term groups to select one real, accessible group. For each measured endpoint it then sends two unrecorded warm-up requests followed by 20 recorded sequential requests. p50 and p95 use the nearest-rank method over request wall time.
It defaults to the managed development API on port 8080. `BENCHMARK_BASE_URL` accepts only an HTTP loopback URL ending in `/api`, so the local development session can never be forwarded to another host.

Measured parameters:

- `GET /api/groups?rangeType=full-term`
- `GET /api/summary?rangeType=billing`
- `GET /api/groups/{accessibleGroupId}?rangeType=full-term`

To measure browser time-to-numbers, open an authenticated dashboard, select Full term, open the browser Performance panel, start a recording, and hard-refresh. Stop after numbers paint. The app emits both `dashboard-final-fetch-complete` / `dashboard-numbers-painted` marks and these measures:

- `dashboard-fetch-complete-to-numbers-painted`
- `dashboard-navigation-to-numbers-painted`

Record the final development measurements below after running the procedure. The full-term groups target is warm p95 below 300 ms.

## Latest results

Measured September 4, 2026 in the Replit development workflows against the populated development Postgres store. The runner used the newest unexpired authenticated development session, two warm-up requests per endpoint, 20 sequential measured requests, and representative accessible group `KBE16XLQ`.

The initial full-term groups result was p50 408.5 ms / p95 443.8 ms, which missed the target. A one-request Node CPU profile showed repeated durable-row parsing and `computeHistoricalSnapshotUsageRollups` work dominated active request time. The remediation memoizes historical daily rollups by immutable usage snapshot and authorization/directory scope; ingestion already replaces the snapshot identity when committed facts change.

Final API results after remediation:

| Endpoint | Samples | p50 | p95 |
| --- | ---: | ---: | ---: |
| `GET /api/groups?rangeType=full-term` | 20 | 42.2 ms | 49.6 ms |
| `GET /api/summary?rangeType=billing` | 20 | 14.4 ms | 19.8 ms |
| `GET /api/groups/KBE16XLQ?rangeType=full-term` | 20 | 28.4 ms | 34.5 ms |

Browser hard-refresh result:

- Environment: authenticated Replit development preview, dashboard Full term range.
- Method: one browser Performance recording and hard refresh after explicitly selecting Full term. `dashboard-navigation-to-numbers-painted` spans navigation start through the second animation frame after the final dashboard data commits.
- `dashboard-navigation-to-numbers-painted`: 680.2 ms.
- `dashboard-fetch-complete-to-numbers-painted`: 47.3 ms.
- Numeric summary cards and the populated workspace table were visible after refresh. No browser page errors, failed requests, console errors, or backend errors were observed; a partial-usage freshness notification remained visible while the usable numbers stayed painted.