# OrgBudgetChart runtime investigation

## Scope and recovery implementation

- Confirmed input failure: the unguarded chart-data builder calls `.filter()` on each series' `points`; an old response without `accountPoints` supplies `undefined` for Total and throws a TypeError. Runtime chart validation now rejects that response before calling the builder. This is independent of the historical hook diagnostic.
- Invalid chart inputs produce explicit chart-local unavailability and a user-initiated refetch. A persistent incompatible response remains visibly unavailable, with no synthetic zeroes or selected-team substitution. Valid responses preserve prior selections; removed teams are still pruned.
- Genuine rendering exceptions are caught around the chart only. Local retry refetches before remounting; failed requests and repeated exceptions remain local. The root boundary remains the last safety net.
- Both boundaries use allowlisted error classifications, bounded sanitized frame locations, React/HMR context, and existing route-correlated request IDs. Raw error text, arbitrary stack contents, financial values, and identities are not emitted by this reporter.
- Focused chart/data/report/diagnostic unit tests and TypeScript checking passed. An initial incorrectly filtered unit invocation also ran the broader suite and found six failures in unchanged reporting-navigation and Home budget-panel tests; those unrelated tests were not repaired.
- Managed frontend and API services were started successfully; the proxied screenshot shows the expected signed-out login gate. Authenticated chart visuals were verified with labeled fixture identities and sample data in the focused browser runs, not live financial data.

## Confirmed from retained and current evidence

- The workspace lock resolves `react` once at 19.1.0, `react-dom` once at 19.1.0 with that React peer, and `recharts` once at 2.15.4 with those same peers.
- The installed dependency store has one physical React package and one physical React DOM package. No nested React installation was found.
- Vite already has `resolve.dedupe: ['react', 'react-dom']`. This investigation did not change Vite's React configuration.
- The retained Playwright last-run marker is passing, and retained chart screenshots visibly show native Recharts output from the task 48 state. The focused assertion checks `.recharts-line-curve`, rather than mocked Recharts children or generic SVG paths.
- Task 48 changed the chart to render keyed `Line` elements as a flat array. This matches the retained finding that fragment-wrapped graphical children can pass mocked tests while failing Recharts 2 child registration in a browser.

## Regression coverage added

- Dedicated development- and production-focused configs run only the chart regression. The production config builds and previews the application.
- Both production and development exercise native Recharts line paths, independent Total/team toggles, response replacement, a selected team's removal, and team reorder.
- The development-only identity check reads the already-transformed, versioned imports without dynamically importing a second URL. The React entry used by the chart, Recharts, and the React DOM client all import the same resolved `require_react` chunk.
- The HMR check waits for the actual `vite:afterUpdate` event, not merely the changed module's HTTP response. Its source probe is restored before reconnect testing.
- Closing the Vite websocket caused a document reload in the observed run (`documentCount` 1 to 2 and socket construction count 1 to 2). The test records either reconnect path without retaining a window-local array across reload, then verifies native SVG lines and a team toggle after the reload.
- Missing `accountPoints` is exercised from valid to missing, persistent missing after local retry, and valid recovery. The page shell, cards, table, and navigation remain available while the chart fallback replaces only the chart.
- A development-only source probe throws a genuine chart render exception. The local boundary is shown, the chart root is absent, the application root and Help navigation work, and local retry restores native lines after the source is restored.
- Browser `pageerror` and error-console output are checked for the historical invalid-hook/dispatcher/OrgBudgetChart null or undefined TypeError signatures.

## Final focused browser result

- `pnpm exec playwright test --config playwright.chart.development.config.ts`: **4 passed**.
- `pnpm exec playwright test --config playwright.chart.production.config.ts`: **2 passed, 2 development-only skipped**.
- A subsequent evidence-only rerun of the development identity/HMR/reconnect case passed and wrote the reconnect counts above.
- Production emitted existing sourcemap-location and large-chunk warnings; there was no build failure or chart browser failure.
- Sample-data screenshots (no real user data) were captured as:
  - `e2e/evidence/org-budget-chart-development-native.png`
  - `e2e/evidence/org-budget-chart-development-fallback.png`
  - `e2e/evidence/org-budget-chart-production-native.png`
  - `e2e/evidence/org-budget-chart-production-fallback.png`
- `org-budget-chart.tsx` contains neither the HMR listener nor the forced exception after the pass; both test probes were restored.

## Hypotheses not established as root cause

- A duplicate React runtime is not supported by the current install, lockfile, dedupe configuration, or the shared transformed `require_react` chunk. A historical stale optimized-dependency graph remains possible, but there is no retained failing trace or module graph that proves it.
- Recharts child discovery explains the historical axes-without-series symptom, but does not by itself explain an Invalid hook call.
- Render-time selection reconciliation in the task 48 chart is a plausible update/removal stress point, but it is not evidence of a second React identity. The new response-replacement regression is intended to distinguish that state path from HMR/reconnect behavior.

The historical Invalid hook call was not reproduced in the final development HMR, forced reconnect/reload, malformed response, or genuine local chart exception paths.