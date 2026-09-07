# Group Budget Monitor

Monitors spending by group and team across the Comcast Replit Enterprise account, lets authorized operators set allocated pools, and emails configured recipients when an entity crosses 50/75/90/100% of its pool.

## Run & Operate

- Fresh empty database setup: run `pnpm install --frozen-lockfile`, then `pnpm --filter @workspace/db run setup`. Populated imports require their matching migration journal; see [safe database setup](docs/database-setup.md).
- Routine merges do not install dependencies, migrate, or seed. Explicit schema releases use `pnpm --filter @workspace/db run migrate`; canonical defaults are installed only with `setup` or `seed`.
- On Replit, start the registered API Server and Group Budget Monitor artifact workflows; they inject the required ports and routing paths.
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/budget-monitor run dev` — run the web frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run generate` — generate a migration for review; use the guarded `migrate` command to apply it. Do not use raw Drizzle migrate/push or reset migration journals.
- Required env: `DATABASE_URL` — Postgres connection string; `REPLIT_ENTERPRISE_API_KEY` — Replit Enterprise API key (secret)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Frontend: React + Vite, wouter, TanStack Query, shadcn/ui
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth); codegen → `lib/api-client-react` (hooks) and `lib/api-zod` (validation)
- `lib/db/src/schema/` — DB tables for allocations, notifications, access, canonical team settings, auth, and durable daily usage facts
- `artifacts/api-server/src/lib/ingest.ts` — the single scheduled ingest owner: directory refresh, daily usage replacement/backfill, reconciliation, threshold checks, and limit-policy work
- `artifacts/api-server/src/lib/usage-store.ts` — memoized, DB-first reads over durable member/project/workspace/account daily facts, including coverage and freshness classification
- `artifacts/api-server/src/lib/enterprise.ts` and `enterprise-directory-merge.ts` — Enterprise API admission plus canonical workspace → team → family → role-group directory construction
- `artifacts/api-server/src/lib/checker.ts`, `notification-settings.ts`, and `email.ts` — threshold evaluation, the durable automated-email kill switch, recipient resolution, and AgentMail delivery
- `artifacts/api-server/src/routes/monitor.ts` — authenticated route composition; concrete owners are the `monitor.groups-*`, `monitor.summary`, `monitor.teams`, `monitor.limits`, `monitor.alerts`, `monitor.admin`, `monitor.directory`, and export route modules
- `artifacts/budget-monitor/` — web frontend (dashboard `/`, alerts `/alerts`, settings `/settings`); theme in `src/index.css`

## Architecture decisions

- Enterprise traffic uses shared, header-driven rate-budget admission for interactive, scheduled, and backfill work. Every caller honors Retry-After and rate-limit reset boundaries; scheduled ingestion may fetch several independent workspace-days concurrently within that shared budget.
- One advisory-locked ingest cycle runs at startup and every 10 minutes. It validates the fresh UTC roster, publishes three-day live usage in atomic slices, attempts billing metadata, rotates bounded current/older backfill and retries, reconciles pending units, runs dependent checks, and finally attempts optional project enrichment. Durable selection cursors survive restarts; facts and successful reconciliation checkpoints—not slice completion—determine remaining work.
- Operator analytics sync: `pnpm --filter @workspace/api-server run ingest:full` (also the default `ingest:once`) is data-only and resumable. Explicit business-cycle behavior remains under `ingest:business-cycle`; the scheduler is unchanged. See `docs/full-data-sync.md` for coverage, progress, exit codes, and safe interruption.
- Usage reads are durable-store first. A successful Postgres snapshot remains readable while refresh runs or fails; responses separately report missing/failed coverage, partial state, data age, and staleness. In-process memoization is invalidated after committed ingestion.
- Ingestion request/time targets stop admission between atomic units, not midway through workspace-day replacement. Logs distinguish soft call targets from finite reserved pagination/retry ceilings. Do not describe soft targets as hard provider quotas; shared Enterprise admission and Retry-After remain authoritative.
- Directory data is refreshed on a 15-minute freshness boundary, persisted, and returned stale-first so request authorization and views do not inherit Enterprise API latency.
- Data views poll every 60 seconds independently of the ingest cadence. Numeric values from successful responses stay visible during refreshes; partial, stale, and request failures use deduplicated transient toasts that clear silently on recovery.
- Canonical accounting is workspace-qualified. Stable group ownership deduplicates overlapping members, unmatched member/workspace charges remain visible in synthetic `No group` rows, and project attribution is explanatory rather than the source for allocations or alerts.
- Billing period = the `interval.startTime` the Enterprise API resolves for `billingPeriod=current`; threshold fire state is keyed by (groupId, periodStart, threshold) in `fired_thresholds` so each threshold emails at most once per period and resets automatically on a new period.
- Automated alert delivery is disabled by default and controlled by the persisted `automated_email_enabled` kill switch. When it is off, or email/recipients are unavailable, thresholds are not marked fired and can be evaluated again after operators restore delivery.
- One email per check per group (highest due threshold) to avoid alert storms when a budget is first set on an already-over group.
- Real production alerts use RBAC-derived recipients. Manual test delivery and any non-production fixed-recipient delivery use the verified address configured in `BOOTSTRAP_ADMIN_EMAIL`; they do not write Email Activity, fired-threshold, or delivery-claim state.
- There is no personal default bootstrap or test recipient. If `BOOTSTRAP_ADMIN_EMAIL` is unset, the special test-email path is disabled. Non-production subjects receive a `[DEV]` prefix, and test sends also retain their `[TEST]` prefix.
- Set `APP_BASE_URL` to the deployed app origin/base path to add safe group/team links to alert email; leave it unset to omit links.
- Managed account editors are keyed by stable Replit user ID. When configured, the bootstrap editor is added once from the exact, verified OIDC email in `BOOTSTRAP_ADMIN_EMAIL`; a durable consumed marker prevents later logins from undoing admin revocation. An unset value grants no bootstrap access. Only true Enterprise account admins can manage the allowlist.
- `APP_ADMIN_USER_IDS` is a comma-separated list of stable Replit user IDs seeded into the app-admin allowlist at server startup (and defensively at login). Seeded rows carry the placeholder email `seed-admin:<userId>` with no creator, and seeded users resolve as true account admins so a locked-out repl owner can reach the Access page. Seeding only inserts missing rows: revocation wins over seeding, so a seed ID revoked on the Access page is not re-granted on restart. Set it in development and production (currently `48871191`).
- Team alerts use the same canonical, workspace-qualified rollup as dashboard team totals. Checks defer when required workspace facts are incomplete.
- Workspace admins see read-only pools and rollups for teams represented in their scope. Account-wide alerts for teams spanning additional workspaces are omitted from their history to avoid exposing cross-workspace spend.
- Authorization is scope plus capability, not a page-wide role shortcut: account, workspace-admin, team-admin, and member scopes are unions; true account admins retain access/settings and upstream group-limit authority, while managed editors receive only their explicit operational capabilities.
- Annual team allocations are durable planning baselines plus approved adjustments. Derived or manual monthly Agent limits are a separate enforcement model; reconciliation is read-only and only an explicit authorized upstream apply can change a Replit hard-blocking limit.
- Starting allocations use the user-approved 29-team list in `lib/db/data/starting-team-allocations.json` ($771,620.02; PREPROD hidden). “Consumer Solutions” is a confirmed alias of the canonical “Customer Solutions” team, not another allocation.
- Monthly planning additions are entered locally until Airtable is explicitly configured. Opening allocations are undated, not repeated monthly. The one-time import scripts are not startup jobs and must not overwrite later administrator edits.

## Product

- Primary destinations are Overview (attention), Spend (the analytical ledger), and Limits (current-cycle member Agent limits). Support and Management are secondary menus; preserve existing route and query contracts.
- Keep spend drill-downs read-only for people limits and link to the workspace-qualified Limits editor. Use its existing review/commit/retry flow rather than introducing parallel inline or bulk write paths. Preserve ongoing baseline policies as distinct from one-time edits.
- Prefer deleting unreachable or duplicate UI over adding abstraction or automation. Preserve compatibility redirects, accounting qualifications, and authorization boundaries; simpler presentation must not turn unavailable data into zero or “not set.”
- Dashboard: canonical workspace → team → family → role-group spend for a selectable range (billing period / MTD / YTD / custom dates), allocations, remaining budget, % used, account-wide summary stats, and a `Data as of` usage timestamp.
- Group drill-down (`/groups/:groupId`): per-member Monthly Agent limit (workspace user limit or workspace default), usage, remaining, % used, role; reconciliation footer (member spend + unattributed = group total). Monthly Agent limit · resets on billing cycle day · hard block.
- Group accounting merges two sources: app allocations (set in this tool, used for email alerting) and platform limits read from the Enterprise `/budgets` API (`workspace_group_limit`); `budgetSource` distinguishes them. Platform limits are Monthly Agent limits that reset on the billing cycle day and hard-block paid services.
- Alerts: group/team history with configured pool and spend, plus an account-operator "run check now" action and, when configured, bootstrap-admin-only fixed-recipient test examples.
- Settings: true-admin-only notification recipients, managed editor allowlist, and system status; the configured bootstrap administrator can access the predefined email-test console.

## User preferences

- Comcast-inspired operational presentation: monochrome working surfaces, electric blue used selectively, Montserrat headings and Lato body text. This is a dashboard adaptation of public inspiration, not an official Comcast design-system implementation. Keep Budget Monitor identity; use no invented corporate logo or proprietary font binaries.
- Reduce visible decisions: one compact Spend toolbar, a focused Overview rather than a second ledger, and responsive Groups/Members cards for Limits with editing revealed contextually. No reporting-range control in Limits.

## Development identity viewing

- Normal API development startup uses `NODE_ENV=development` and offers an optional **Preview as a person** picker beside normal login. A fresh tab never chooses an identity automatically: search the configured Enterprise directory or click Random. Explicit choices persist in that tab across refreshes. Once inside, the View-As chip switches people or exits preview.
- Real Replit login remains available without disabling development preview. Only explicitly selected preview requests use the development identity; exiting clears preview headers and protected caches and returns to normal authentication. This separation prevents silently mistaking another person's view for the signed-in user's account.
- This mode is strictly read-only: the server rejects mutations even when viewing an administrator or when requests are forged. The directory-derived identity determines actual visible scopes; the chip does not grant builder-preview or account-wide authority.
- **Keep the development preview private. Anyone who can reach it can read data available through its directory picker, without logging in.** This is not a way to share a public demo.
- The server requires explicit development runtime and no deployment marker. Production/test/unset runtime and Replit deployment mode cannot enable the no-login path, including through saved selections, client flags, headers, or cookies. Production frontend builds exclude the chip.
- Unavailable/empty directory data and removed selections fail closed. Retry or choose another available user; no synthetic people or OAuth redirects are substituted.
- Run the standalone browser checks with `pnpm --filter @workspace/budget-monitor exec playwright test --config playwright.development.config.ts`. They use sample identities and do not require OAuth or real directory writes.

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run codegen before touching server or frontend code. Avoid `format: email` in the spec — Orval emits `zod.email()` which doesn't exist in zod v3 index typings.
- Express 5: async handlers must be `Promise<void>`; use `res.status().json(); return;`.
