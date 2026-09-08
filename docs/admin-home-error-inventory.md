# Admin Home and idle error inventory

All times below are UTC on 2026-09-08. Evidence is development-only.
No production logs, credentials, identity/session contents, OAuth queries, or
financial payloads are included.

## Findings

| Class / severity | Route and evidence window | Cause or remaining uncertainty | Remediation and verification |
| --- | --- | --- | --- |
| Wrong default landing / functional defect | `/`, prior implementation and focused role fixtures | Personal Home mounted for account reporting viewers | Resolve effective `canViewAccountUsage` before mounting either data page. One canonical Org Insights landing/nav/brand target. Root mounting and navigation tests pass; real authorized desktop/mobile checks passed. No entitlement changes. |
| Historical membership 404 / uncorrelated transient | `/api/me/membership-context`, 04:31:44; later 200 at 04:31:54 and 04:32:54 | No request ID on the browser 404; serving process/proxy cannot be established retrospectively. A startup/old-process race is possible, not proven. | Existing route and auth boundary verified; signed-out request is 401 with request ID, not a missing route. No blanket 404 retry or speculative proxy change. Not reproduced as an ongoing failure. |
| Recovered startup auth failure / transient availability | `/api/auth/user`, historical 502 at 04:31:52, recovered 04:31:53 | API startup coincided with failure; not continued login failure | Existing coalesced auth recovery and scope cleanup retained and tested. Authorized sessions survived subsequent ordinary API restarts; no destructive logout observed. |
| Repeated process-root 404 / noisy liveness-compatible traffic | `GET /`, reproduced 04:36–04:47, including request `a8e37ee4-41ab-4100-8699-f5b878cddaa1` at 04:43:45.347 | Fresh requests classified as Undici/Fetch, CORS mode, no navigation/forwarded/referrer headers. Actual external caller ownership is not established. | Exact non-document GET/HEAD process root has a documented health alias; `/api` and `/api/healthz` also use the existing contract. Root document navigation and arbitrary missing application/API paths remain errors. At 04:47:46.467 request `ab6f59d2-4cc4-44f8-b641-c039d6df9b49` returned 200. Later observed root requests also returned 200, not false 404 alarms. |
| Untyped Org ingestion conflict / reproduced recovery defect | `/api/org-insights`, generic 503 at 04:43:12 and 04:43:14; request IDs `004385b2-5d55-403e-979c-2167b2210cd6`, `5c546b1a-9d78-4a80-a326-664c88898f87` | A valid consistency guard returned generic 503 instead of the existing typed refresh contract, bypassing bounded client recovery | Shared usage-generation guard before/after composition; exact `REPORTING_USAGE_REFRESHING` plus Retry-After 2. Authorization and query validation still precede admission. Configuration conflicts remain distinct. Typed startup 503 recovered automatically in browser around 04:50:24–04:50:29. API regression verifies recovery and denied access. |
| Historical team ingestion transitions / expected transient, previously reported as failures | `/api/reporting/teams/[redacted]`, earlier conversation before retained fresh window | Generation publication temporarily disallows inconsistent reads | Existing team guards, bounded server-paced retries and authorized cache behavior preserved. Shared transition tests pass. This is not a claim of reproducing every earlier team 503. |
| Successful partial-data qualifications / informational financial limitations | `/api/org-insights` 200 during 04:50–05:01; earlier dashboard/report observations historical | Missing facts, incomplete coverage and explicitly unavailable derived results, not transport failure | Qualifiers and nulls remain in UI and bounded diagnostics; every request remains recorded. Repeated identical browser qualification warnings emit only on change. Server per-request data-quality warnings remain available. No financial calculations or fabricated zeros introduced by this work. |
| Same-client overlapping query warning / genuine DB deprecation | API startup and disposable DB tests; reproduction 04:41:47, corrected check 04:42:10 | Parallel reads on one pinned transaction client in configuration snapshot and family-mapping backfill | Sequence only those client-owned reads. Repeatable-read transaction and atomicity preserved; independent pooled work remains concurrent. Disposable diagnostic reproduced five overlaps before the fix and none after. Final full API suite had no such warnings. |
| Paired server requests / initially ambiguous diagnostic, not a proven app fanout | `/api/org-insights`, pairs around 04:55–04:57 and 05:00 | Aggregate server traffic includes more than one client; a browser worker reset left prior-context cleanup unknown | Source audit found one hook/key/60-second polling owner. Narrow retained-page listener captured one request/response at 05:00:51.793–05:00:54.848, ID `e1c5910d-33b5-4894-b97f-47b2fca366c3`; the other server request was not from that page listener. No reproduced per-page duplicate retry fanout, so no speculative polling rewrite. |
| Vite reconnects, auth-state traces, benchmark output / diagnostic | Workflow restarts and test runs | Expected development/tool output | Not classified as new idle failures; no blanket log suppression. The earlier investigated login-click issue was not reopened. |

## Observation and verification

- Live authorized default landing, desktop/mobile first nav item, mobile brand link,
  Help navigation and explicit login return to `/help` passed.
- Role fixtures cover account administrator, existing managed-account viewer,
  ordinary account viewer, scoped member/team/workspace admin previews,
  unresolved/revoked access, and absence of personal Home/query mounts.
- Initial scheduler ingestion at 04:50:13–04:50:26 completed 63/63 live units,
  zero failures. The authorized Org page recovered automatically, then stayed usable
  across repeated normal UI polling through 04:58:01. Chart/table, partial-data
  qualifications and automatic Updating states were observed.
- **Timing correction:** The 04:57 requests were UI polls, not a second ten-minute
  ingestion cycle. That periodic cycle was not reached before restoring the
  temporary test issuer. Do not describe it as verified periodic ingestion.
- Ordinary API configuration was restored afterward. A slower subsequent startup
  ingestion ran 04:58:43–05:00:13 (63/63 successful, zero failures); typed refresh
  responses were still distinct from failures. The retained authorized page
  subsequently returned 200 at 05:00:54 with usable qualified content. This
  longer restart window is recorded separately from the bounded idle run.
- Focused client/navigation checks: 77 tests passed after the final recovery change.
  Earlier auth lifecycle, freshness and diagnostic checks: 75 passed.
- Full API check: **63 files / 736 tests passed**, including the transaction and
  request-diagnostic regressions. No same-client deprecation appeared.
- Full frontend check: **76 files passed; 2 files failed (6 tests)** in unchanged
  `reporting-navigation.test.ts` and `home-components/budget-panels.test.ts`.
  These existing expectation mismatches are separate from the task's passing
  targeted checks. Wholesale browser-suite restoration remains out of scope.
- Workspace typecheck, diff checks and focused code review passed. A signed-out
  preview screenshot rendered the login boundary normally; authorized-page
  verification used the private tester, not exported screenshots of real data.

## Boundaries

There is no claim that all historical errors were root-caused or that production
was checked. Root caller ownership and the old uncorrelated membership 404 remain
uncertain. No new grants, database/financial settings, deployment configuration,
or published application changes were made.

Supporting details: [API findings](idle-api-findings.md),
[browser evidence](admin-home-browser-verification.md),
[database sequencing](db-query-warning-verification.md).