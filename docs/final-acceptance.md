# Final current acceptance

Verified September 4, 2026 against the final merged development tree. The
commands below use isolated API worker schemas, both required frontend
timezones, and a production Vite build for browser acceptance.

## Reproduce

```sh
pnpm run typecheck
PORT=4173 BASE_PATH=/budget-monitor pnpm run build
pnpm --filter @workspace/budget-monitor run test:utc
pnpm --filter @workspace/budget-monitor run test:los-angeles
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/budget-monitor run test:routes
pnpm --filter @workspace/api-server run benchmark:warm
```

Playwright requires its matching Chromium binary. Install it once with:

```sh
pnpm --filter @workspace/budget-monitor exec playwright install chromium
```

## Acceptance coverage

- Dashboard tests exercise the generated scope, UTC period, cards, trend,
  breakdown, accounting, metadata, partial/stale state, and one committed
  generation rather than the deleted monolithic Dashboard table.
- Spend tests exercise authorized tabs, query gating, server paging, large
  100-row pages, qualified IDs, shared pools, unavailable limits, known zero
  handling, JSON/CSV selection parity, density, sorting, export, drill-through,
  return navigation, responsive layout, and keyboard focus.
- Authorization covers account, workspace admin, team admin, member, genuine
  denial, signed-out, temporary authorization unavailability, valid builder
  preview, and invalid/revoked builder preview.
- Browser transition checks assert protected Dashboard and Spend content is
  absent during unavailable and invalid-preview gates. Same-scope successful
  content remains coherent during refresh, while identity, scope, preview, and
  revocation boundaries clear protected query state.
- API tests keep malformed preview/query, anonymous, forbidden, and unavailable
  dependency outcomes distinct as HTTP 400, 401, 403, and 503.
- Persisted-limit tests distinguish unavailable observations, transient failure
  with retained known values, authoritative empty success, inherited values,
  explicit zero, and acknowledged writes racing refresh.
- Accounting tests cover internal exclusions, overlapping membership,
  workspace-authoritative rollups, shared canonical pools, partial coverage,
  and UTC/DST bucket behavior.
- Benchmark evidence covers every current runner endpoint and reports request
  counts, decoded and wire-reported payload sizes, Server-Timing presence or
  absence, aggregate event-loop delay, and nearest-rank p50/p95.

All acceptance fixtures are read-only. They do not send live email and do not
mutate live Replit limits.

## Current results

- Whole-workspace typecheck and production builds: passed. The web build
  requires explicit `PORT` and `BASE_PATH`; omitting them fails configuration
  before compilation by design.
- Frontend UTC: 24 files, 116 tests passed.
- Frontend America/Los_Angeles: 24 files, 116 tests passed.
- API isolated-schema integration suite: 31 files, 377 tests passed.
- Production-build Chromium route suite: 14 tests passed, including all role
  gates, valid and invalid builder preview, authorization unavailable, current
  Dashboard/Spend navigation, large paging, CSV, focus, and mobile layout.
- Current benchmark: 12 endpoints, 348 recorded requests plus warmups and
  authorized fixture selection. Performance numbers and limitations are in
  [`warm-store-benchmark.md`](./warm-store-benchmark.md).
- Both managed workflows restarted cleanly after the final edits. The live
  signed-out gate is captured at `screenshots/final-acceptance.jpg`; authenticated
  and role-specific visuals use deterministic production-build browser fixtures.

Vite emitted non-fatal sourcemap location warnings for three generated UI
modules during browser builds. They did not produce browser console failures or
test failures, but source-level mapping for errors originating in those modules
would be incomplete.