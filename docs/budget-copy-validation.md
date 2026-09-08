# Budget copy cleanup validation

Validated 2026-09-08.

## Scope

Trimmed repeated page copy and Data quality explanations; retained financial
basis labels, periods, explicit missing values, limit-write confirmation and
recovery details. Cached request failures use the existing shared error toast
with Retry rather than repeated page banners. Initial-load and mutation
recovery controls remain.

The API changes are qualification text only. The existing OpenAPI specification
was not changed. Regenerating its stale clients was necessary to validate the
merged funding-mapping, limit-target and historical-reporting baseline.

## Checks

- Frontend Vitest: **418 passed, 6 existing failures** across 73 files.
- Workspace typecheck: **passed** after regenerating the existing API clients.
- Budget Monitor production build: **passed**, with the existing bundle-size warning.
- API production build: **passed**.
- Affected API suites: **51 passed** in `monitor.groups-detail-budget.test.ts`
  and `monitor.scoped-accounting.http.test.ts`.
- Focused persistent browser test: **passed** in
  `artifacts/budget-monitor/e2e/copy-cache-refresh.spec.ts`.
- Safety review: passed after restoring concise limit-policy/recovery boundaries,
  unassigned-spend reconciliation and historical-evidence qualifications.

## Unrelated baseline failures

The initial clean-checkout frontend run had **411 passed and the same 6 failures**:

- `reporting-navigation.test.ts`: forecast date preservation, personal-project
  period preservation, and two My Team date/horizon assertions.
- `dashboard-spec.test.tsx`: custom-range initialization and the old `Limits`
  navigation label (the current label is `Usage Limits`).

These were not repaired as part of the copy cleanup.

## Browser coverage and safety

All browser requests used intercepted synthetic API fixtures, not live account
data or business mutations.

- Desktop Org Insights: observed zero remains `$0.00`; missing remaining is
  `Unavailable`.
- Desktop Spend: cached zero-spend rows remain during failed polling and its
  automatic retry; exactly one “Couldn’t refresh data.” toast and one Retry
  action appear. Retry recovers and clears the notice.
- Mobile member Home: personal Agent zero and selected-period labels remain;
  no Data quality/admin controls are exposed.
- Effective admin: Data quality opens from the account menu. Unit coverage also
  verifies a real admin with effective-member access cannot expose its notes.

The initial browser failure was a fixture error: it did not exercise a terminal
cached TanStack query failure. The persistent test now loads successfully first,
fails both polling attempts without reloading, then recovers via the toast.

The frontend workflow was restarted and serves successfully. The API workflow
was already stopped and was deliberately not started: startup immediately
resumes durable limit operations and usage ingestion, which this task did not
authorize. API validation used isolated test storage and builds instead. The
unmocked preview therefore displays the sign-in/reconnect shell until the API
is started separately.