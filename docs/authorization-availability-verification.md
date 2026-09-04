# Authorization availability repair verification

Verified on 2026-09-04 without recording tokens, cookies, session material,
connection details, or data for unrelated users.

## Root cause

- The migration journal's baseline timestamp was newer than the two original
  application-admin migrations. A database that had recorded that baseline
  could therefore skip the older revocation-column and bootstrap-index
  migrations.
- Authorization queried those missing objects. The API caught the resulting
  database errors and converted them to `null`, which the middleware and browser
  rendered as a genuine access denial.
- The reported caller's stable ID was present in the persisted Enterprise
  directory under the same ID, with active administrative workspace
  memberships. No user-specific bypass was added.

## Safe runtime evidence

- The production read replica exposed a fresh persisted directory row for the
  reported caller, with active administrative memberships.
- The same read replica did not expose an `app_admins` table and did not return a
  persisted `users` row for that ID at verification time. This is stricter
  schema/data drift than the earlier runtime observation of an `app_admins`
  table missing only revocation columns and its bootstrap index.
- After the correction is merged and published, the designated bootstrap
  identity must complete the existing verified OIDC sign-in flow. The caller
  diagnostic reports `verified_oidc_sign_in_required` when that safe remediation
  is needed; it never grants from an unverified email or hardcoded ID.

## Corrected behavior

- A newer idempotent forward migration establishes the base app-admin table when
  absent, then repairs the revocation columns and bootstrap uniqueness index
  whether the original migrations ran or were skipped. A journal regression
  check requires that correction to remain newer than every prior entry.
- Directory, app-admin, and final authorization lookups now report success,
  absence, or failure independently in the caller-only diagnostic.
- Anonymous, denied, and temporarily unavailable outcomes remain distinct.
  Dependency failures return retryable HTTP 503 responses.
- The server listens only after persisted directory hydration completes. Missing
  or failed hydration remains an explicit unavailable state.
- The browser clears protected identity and query state while authorization is
  unresolved, retries temporary failures at most three times, and renders a
  separate unavailable screen with manual Retry and Log out actions.

## Validation

- API typecheck: passed
- API tests: 25 files, 327 tests passed
- API production build: passed
- Database package typecheck: passed
- Shared auth library declaration build: passed
- Group Budget Monitor typecheck: passed
- Group Budget Monitor tests: 21 files, 94 tests passed
- Group Budget Monitor production build: passed with `PORT` and `BASE_PATH`
  supplied as required by its Vite configuration
- Development workflows: restarted successfully; API logged that it began
  listening after directory hydration
- Anonymous `/api/auth/user`: HTTP 200 signed-out envelope
- Browser preview: signed-out gate rendered with no current console errors