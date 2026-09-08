# Idle API investigation

This document preserves the initial investigation and targeted evidence.
Final classifications and later runtime results are consolidated in
[Admin Home error inventory](admin-home-error-inventory.md).

## 2026-09-08T04:37:58Z — static baseline

- **API root:** the API artifact configuration explicitly publishes only the
  `/api` service path and sets its preview path to `/api`; its configured
  production startup probe is `/api/healthz`. The router previously defined
  only `GET /api/healthz`, so exact `GET /api` returned Express's fallback
  status. Artifact preview access is therefore a concrete configured caller of
  `/api`, but repository configuration cannot prove it originated every
  historical request.
- **Narrow correction:** exact non-document `GET /` and `HEAD /`, plus exact
  `GET /api` and `GET /api/`, now return the same parsed health state as
  `GET /api/healthz` (`HEAD` has no body). Process-root requests identified as
  document navigation by `Sec-Fetch-Mode: navigate` or an HTML `Accept` value
  deliberately fall through to 404, so incorrect browser routing is not masked.
  Unknown application paths remain 404. Unknown signed-out monitor paths retain
  the existing 401 from the auth boundary; focused authorized routing coverage
  verifies they fall through as 404. There is no catch-all success route.
- **Exact-root source classification:** successful `/api` root requests emit
  only an allowlisted caller kind (`browser`, `curl`, `go-http-client`,
  `node-undici`, or `unknown`), an allowlisted `Sec-Fetch-Mode`,
  `isNavigation`, and booleans for forwarded-header and referrer presence. No
  raw user agent, address, referrer, URL, credential, identity, or payload is
  logged. `Sec-Fetch-Mode: navigate` is explicitly represented by
  `isNavigation: true`, allowing a post-restart baseline to distinguish preview
  navigation from non-navigation probing.
- **Request correlation:** request IDs are created before CORS, auth, and
  routing, and are exposed as `x-request-id`. Completion diagnostics contain
  only request ID, sanitized endpoint template, method, status, and duration.
  Query strings are removed and recognized identity/opaque route segments are
  replaced with `[redacted]`. Evidence in this document intentionally records
  request ID only as `[present]`, not its value.
- **Membership route:** `GET /api/me/membership-context` is mounted behind
  `requireAuth`. A signed-out targeted request reaches the shared auth boundary
  (401, request ID `[present]`); an unknown monitor path does likewise because
  the boundary precedes its child routes. The reported historical
  membership 404-without-request-ID followed by 200 was not reproduced and
  predates or bypasses the currently observable middleware contract; its cause
  remains uncertain.
- **Startup readiness:** the process binds its HTTP listener only after
  directory cache initialization, app-admin seeding, and durable-operation
  resumption. A gateway can consequently emit a transient startup 502 before
  the process is listening. The reported recovered auth 502 was not reproduced.
  No readiness behavior was changed because recovery is expected and no
  persistent failure was proven.
- **Usage refresh transition:** reporting routes explicitly return 503 with
  `Retry-After: 2` and code `REPORTING_USAGE_REFRESHING` while a usage generation
  is being published. Existing focused API coverage verifies rejection of the
  intermediate generation and recovery on the committed generation. Client
  transition logic checks both the 503 status and exact code and bounds retries.
  No change was made because the reviewed transition is already explicit and
  access failures are not retried as refreshes.
- **Scheduled refresh cadence:** source inspection shows one initial usage
  cycle after post-listen checker hydration, followed by a fixed 10-minute
  interval (`BACKGROUND_CYCLE_INTERVAL_MINUTES = 10`). A two-minute idle
  observation is therefore not guaranteed to cross a scheduled refresh; use
  at least one full 10-minute interval plus cycle duration when the parent
  performs the eventual authorized observation.

## 2026-09-08T04:36:34Z–04:37:11Z — parent-supplied runtime baseline

The parent agent reported repeated idle root 404s, a signed-out auth response
of 200, and a live ingestion summary of 63/63 units with zero failures. This
subagent did not open the workflow or browser-console log files, per delegated
scope. No credentials, identities, payloads, or concrete request IDs are
recorded here. The root 404 report is consistent with the proven missing exact
`/api` route and configured `/api` artifact preview, but the caller identity
remains uncertain until the new bounded classification is observed after a
parent-controlled restart.

## 2026-09-08T04:43:45Z–04:43:47Z — classified process-root baseline

The parent-reported fresh records prove the repeated requests target process
root `/`, not `/api`. Both had request ID `[present]`, caller kind `unknown`,
`Sec-Fetch-Mode: cors`, `isNavigation: false`, no forwarded-header presence,
and no referrer presence. This shape is consistent with a programmatic Fetch
caller, but is not sufficient to identify its owner. The allowlist now
recognizes the standard Node/Undici user agent as `node-undici` without
recording it raw. Read-only project configuration identifies `/api/healthz` as
the production startup probe and `/api` as the artifact preview/service path;
no repository-local configuration was found that declares a `/` probe. The
external caller remains uncertain pending the post-restart classification.

## Verification status

Targeted route diagnostics verify exact-root health, continued unknown-route
failure behavior, request-ID presence, the signed-out membership auth boundary,
and endpoint sanitization without logging credentials, identities, response
payloads, or financial values.

- `2026-09-08T04:45:09Z`: focused root/request diagnostics — **passed**, 4/4.
- `2026-09-08T04:42:14Z`: authorized unknown-route diagnostic — **passed**,
  1/1 targeted (116 unrelated cases skipped).
- `2026-09-08T04:44:48Z`: API TypeScript check — **passed**.

Runtime workflow logs were not inspected and no workflow was restarted during
this investigation.