# Budget Monitor performance baseline

Measured September 4, 2026 in the authenticated Replit development preview
against the populated development Postgres store. These are development
measurements, not production capacity or concurrency claims.

## Validation matrix

| Check | Result |
| --- | --- |
| Workspace and artifact TypeScript checks | Passed |
| Frontend tests in UTC | 93 passed across 21 files |
| Explicit UTC range fixture in `America/Los_Angeles` | 3 passed |
| API tests with isolated per-worker schemas | 356 passed across 30 files |
| Production frontend build | Passed |
| Diff whitespace check | Passed |

No email, manual check, allocation, budget, or upstream limit mutation was
performed during validation.

## Authenticated browser baseline

Fixture observed in the current snapshot:

- 45 budget-pool rows
- 254 members with spend
- $13,608.11 period spend
- $12,533.27 Agent spend
- $1,074.84 other-services spend

Method: normal Kody login, billing-period Dashboard hard refresh, then read the
generation-suffixed Performance marks after the second animation frame. Each
sample made exactly two API requests: `/api/auth/user` and
`/api/dashboard?rangeType=billing`.

| Sample | First useful values painted | All required values painted | Required response completed |
| --- | ---: | ---: | ---: |
| 1 | 129.7 ms | 130.0 ms | 597.3 ms |
| 2 | 118.1 ms | 118.4 ms | 575.8 ms |
| 3 | 103.0 ms | 103.3 ms | 550.5 ms |

The three samples are reported individually; the sample is too small to claim
stable p50 or p95 browser latency. Each refresh decoded 19,726 bytes across the
two API responses. A representative transfer was 8,688 bytes.

The populated Dashboard and Spend table rendered without an uncaught browser
error. Server search narrowed 45 pools to the expected single `DXP` result, and
the matching CSV export completed. Desktop and 390-by-844 responsive screenshots
were captured for the authenticated Dashboard; desktop Spend and signed-out
desktop/mobile screenshots were also captured.

## Authenticated warm-store server baseline

Run:

```sh
pnpm --filter @workspace/api-server run benchmark:warm
```

The runner used two unrecorded warmups and 20 sequential measured requests per
endpoint. It reads the newest unexpired development session without printing
the session ID and accepts only a loopback benchmark URL.

| Endpoint | p50 | p95 | Decoded body |
| --- | ---: | ---: | ---: |
| `/groups?rangeType=full-term` | 54.7 ms | 59.8 ms | 913,899 B |
| `/summary?rangeType=full-term` | 20.0 ms | 22.7 ms | 1,040 B |
| `/summary?rangeType=billing` | 16.2 ms | 19.6 ms | 1,008 B |
| `/teams/budgets` | 234.6 ms | 352.0 ms | 6,670 B |
| `/groups/{groupId}?rangeType=full-term` | 32.8 ms | 39.2 ms | 41,766 B |
| `/directory/workspaces/{workspaceId}/members` | 75.0 ms | 94.8 ms | 83,678 B |

Event-loop delay during the run was 20.1 ms mean, 20.6 ms p95, and 22.0 ms
maximum. The responses were identity encoded and did not expose separate
database or upstream timing headers. The Dashboard also returned successfully
while scheduled ingestion was active and after a normal API workflow restart.

## Frontend bundle

The production build separates the Dashboard and Recharts from the main
application:

- Main JavaScript: 422.83 KB raw / 133.73 KB gzip
- Dashboard page chunk: 11.62 KB raw / 3.95 KB gzip
- Dashboard chart chunk: 383.33 KB raw / 105.73 KB gzip
- Spend page chunk: 12.78 KB raw / 4.49 KB gzip

## Instrumentation contract

Dashboard telemetry is generation aware and records:

- initial-load or range-change start
- required request completion
- first useful values ready and painted
- all required values ready and painted
- range-change completion
- same-scope background-refresh start, ready, and painted

Performance measurements are conditional on their source marks, so missing or
cleared browser marks cannot crash rendering.

## Limitations and next bottlenecks

- Browser sample size is three hard refreshes. Warm navigation, range-change,
  background-refresh, and table-interaction latency were instrumented but not
  collected as stable p50/p95 samples in this pass.
- The authenticated browser pass did not complete every role-preview screenshot
  or every Spend tab interaction. Capability and confidentiality behavior is
  covered by API/middleware tests, including real authenticated HTTP fixtures
  for mixed grants, partial shared pools, family-user qualification, preview
  mutation denial, and JSON/CSV predicate parity.
- The legacy full-term groups payload remains large at about 914 KB. The new
  Dashboard avoids it by using the compact dashboard response; further work on
  legacy/detail routes should prioritize payload shape before micro-optimizing
  rendering.
- Team budgets is the slowest measured warm route at 352.0 ms p95. Directory
  members is below 100 ms p95 but returns about 84 KB, which is why the preview
  picker defers that request until it is opened.