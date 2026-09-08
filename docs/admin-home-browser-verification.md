# Budget Monitor browser verification

## Scope

Focused live verification of the authorized Organization Insights recovery path after
the typed Org refresh patch. Existing desktop/mobile/navigation checks were not
rerun. No database writes, access changes, grants/revocations, financial-data
mutations, provider-button interactions, or credentials were used.

The API test issuer override was restored only for this verification. The observed
API restart/re-auth setup timestamp was `2026-09-08T04:50:21.994Z`; the supported
viewer session reached `/org-insights` at `2026-09-08T04:50:26.091Z`.

## Recovery result

- `/` canonicalized to `/org-insights`.
- Authentication succeeded once in the reused test context after the permitted
  override restart.
- The initial post-restart request returned a typed retryable response:
  `2026-09-08T04:50:24.524Z GET /api/org-insights 503
  errorCode=api_usage_refreshing requestID=not-exposed-to-browser-log`.
- Without clicking Refresh, the page recovered to a usable cached/partial
  Organization Budget Overview. The chart and All Teams table rendered and the
  page had no error/retry panel. Partial-data and unavailable-field states were
  preserved rather than showing fabricated values.
- The automatic update transition was observed twice:
  - `2026-09-08T04:54:40.050Z` UI entered `Updating`; by
    `2026-09-08T04:55:05.476Z` it had completed.
  - `2026-09-08T04:56:47.402Z` UI entered `Updating`; by
    `2026-09-08T04:57:08.845Z` it had completed.
- The initial scheduler ingestion completed during the API process startup
  window `04:50:13`–`04:50:26` with `63/63` usage units successful. The later
  `04:57:48` requests were normal UI polls, not scheduled ingestion; the
  periodic ten-minute cycle was not reached before the ordinary-issuer restore.
  The normal-poll requests completed successfully:
  - `2026-09-08T04:57:51.374Z GET /api/org-insights 200
    requestID=963eeb3e-b6c7-48d9-930f-1464dacd09f0`
  - `2026-09-08T04:57:51.374Z GET /api/org-insights 200
    requestID=5591a330-f0bd-462e-ac7d-0bd42b5d9db5`
- At `2026-09-08T04:58:01.524Z`, the live page still showed the chart, heading,
  table, and no error panel. `Updating` was false. The UI remained `Partial
  data`; this is a usable cached/qualified result, not a claim that all derived
  budget fields are complete.

## Idle observations

The same live authorized Org page was observed with passive waits no longer than
20 seconds per browser call. Sixteen named observations were recorded from
`04:50:45.981Z` through `04:58:01.524Z`; the heading/chart stayed visible and no
logout, navigation, manual retry, or manual Refresh occurred.

Server-log request evidence was sanitized to method/path/status/request ID and
counts only:

- `GET /api/org-insights 200`: 6 server-log completions in the normal-poll
  excerpts (two server requests at each of approximately 04:55:45, 04:56:48,
  and 04:57:51). These are not labeled scheduled ingestion.
- `GET /api/org-insights 503 errorCode=api_usage_refreshing`: 1 browser-observed
  startup response at approximately 04:50:24.
- `GET /api/auth/user 200`: authorization checks succeeded; no identity,
  cookie, or payload details are recorded here.
- No personal-scope endpoint or `viewScope=my` request was observed during this
  Org-only pass.

## Findings and limitations

- **Recovery behavior:** PASS. The typed startup 503 no longer produced the
  generic retry-only failure; the UI retained usable chart/table content and
  later Org requests completed with HTTP 200.
- **Normal polling:** PASS for request completion and UI usability. The
  approximately 04:57:48–04:57:51 normal UI poll responses were authorized
  HTTP 200s and the page stayed usable afterward with chart visible and
  Updating false. The ten-minute scheduled cycle was not verified.
- **Data completeness:** Partial. The API/UI continued to mark some derived
  values unavailable (`missing_value`, `incomplete_usage`, and
  `explicit_unavailable` were the server-side error categories). No financial
  payloads are reproduced in this document.
- **Paired-request scope:** The server log excerpts show two concurrent
  `/api/org-insights` requests at each of three normal-poll timestamps, but
  server logs alone do not identify whether they came from one page or multiple
  clients. A listener attached to the one retained Org page (no reload or new
  page) observed zero Org requests during interval 1 and exactly one request
  plus one response during interval 2:
  `2026-09-08T05:00:51.793Z GET /api/org-insights` followed by
  `2026-09-08T05:00:54.848Z GET /api/org-insights 200
  requestID=e1c5910d-33b5-4894-b97f-47b2fca366c3`. It therefore does not prove
  duplicate fanout from this page; the paired server requests remain
  uncorrelated to a client.
- **Polling bound:** Observation stopped shortly after the normal-poll window,
  well within the requested 11-minute bound. Audio/animation timing was not
  tested.
- The tester restored the ordinary API workflow without the temporary issuer
  override after writing this document (listener at 04:58:43.205, confirmation
  around 04:58:47.775). No persistent application configuration was changed.