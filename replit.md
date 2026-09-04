# Group Budget Monitor

Monitors spending by group and team across the Comcast Replit Enterprise account, lets authorized operators set allocated pools, and emails configured recipients when an entity crosses 50/75/90/100% of its pool.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/budget-monitor run dev` — run the web frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
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
- `docs/warm-store-benchmark.md` — reproducible authenticated API and browser warm-store benchmark procedure and latest results

## Architecture decisions

- Enterprise traffic uses shared, header-driven rate-budget admission for interactive, scheduled, and backfill work. Every caller honors Retry-After and rate-limit reset boundaries; scheduled ingestion may fetch several independent workspace-days concurrently within that shared budget.
- One advisory-locked ingest cycle runs at startup and every 10 minutes. It refreshes the canonical directory when needed, atomically replaces each workspace-day's member/project facts in one transaction, upserts aggregate daily facts, performs bounded backfill, and only then runs dependent reconciliation/check work.
- Usage reads are durable-store first. A successful Postgres snapshot remains readable while refresh runs or fails; responses separately report missing/failed coverage, partial state, data age, and staleness. In-process memoization is invalidated after committed ingestion.
- Directory data is refreshed on a 15-minute freshness boundary, persisted, and returned stale-first so request authorization and views do not inherit Enterprise API latency.
- Data views poll every 60 seconds independently of the ingest cadence. Numeric values from successful responses stay visible during refreshes; partial, stale, and request failures use deduplicated transient toasts that clear silently on recovery.
- Canonical accounting is workspace-qualified. Stable group ownership deduplicates overlapping members, unmatched member/workspace charges remain visible in synthetic `No group` rows, and project attribution is explanatory rather than the source for allocations or alerts.
- Billing period = the `interval.startTime` the Enterprise API resolves for `billingPeriod=current`; threshold fire state is keyed by (groupId, periodStart, threshold) in `fired_thresholds` so each threshold emails at most once per period and resets automatically on a new period.
- Automated alert delivery is disabled by default and controlled by the persisted `automated_email_enabled` kill switch. When it is off, or email/recipients are unavailable, thresholds are not marked fired and can be evaluated again after operators restore delivery.
- One email per check per group (highest due threshold) to avoid alert storms when a budget is first set on an already-over group.
- Real production alerts use RBAC-derived recipients. Every manual test path is independently authorized to the persisted Kody identity and fixes delivery to `kody.low@repl.it` without writing Email Activity, fired-threshold, or delivery-claim state.
- Non-production sends are redirected to `kody.low@repl.it` and subjects receive a `[DEV]` prefix. Test sends also retain their `[TEST]` prefix.
- Set `APP_BASE_URL` to the deployed app origin/base path to add safe group/team links to alert email; leave it unset to omit links.
- Managed account editors are keyed by stable Replit user ID. The designated bootstrap editor is added once from an exact, verified OIDC email; a durable consumed marker prevents later logins from undoing admin revocation. Only true Enterprise account admins can manage the allowlist.
- Team alerts use the same canonical, workspace-qualified rollup as dashboard team totals. Checks defer when required workspace facts are incomplete.
- Workspace admins see read-only pools and rollups for teams represented in their scope. Account-wide alerts for teams spanning additional workspaces are omitted from their history to avoid exposing cross-workspace spend.
- Authorization is scope plus capability, not a page-wide role shortcut: account, workspace-admin, team-admin, and member scopes are unions; true account admins retain access/settings and upstream group-limit authority, while managed editors receive only their explicit operational capabilities.
- Annual team allocations are durable planning baselines plus approved adjustments. Derived or manual monthly Agent limits are a separate enforcement model; reconciliation is read-only and only an explicit authorized upstream apply can change a Replit hard-blocking limit.

## Product

- Dashboard: canonical workspace → team → family → role-group spend for a selectable range (billing period / MTD / YTD / custom dates), allocations, remaining budget, % used, account-wide summary stats, and a `Data as of` usage timestamp.
- Group drill-down (`/groups/:groupId`): per-member Monthly Agent limit (workspace user limit or workspace default), usage, remaining, % used, role; reconciliation footer (member spend + unattributed = group total). Monthly Agent limit · resets on billing cycle day · hard block.
- Group accounting merges two sources: app allocations (set in this tool, used for email alerting) and platform limits read from the Enterprise `/budgets` API (`workspace_group_limit`); `budgetSource` distinguishes them. Platform limits are Monthly Agent limits that reset on the billing cycle day and hard-block paid services.
- Alerts: group/team history with configured pool and spend, plus an account-operator "run check now" action and Kody-only fixed-recipient activity examples.
- Settings: true-admin-only notification recipients, managed editor allowlist, and system status; the persisted Kody identity also has the predefined email-test console.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run codegen before touching server or frontend code. Avoid `format: email` in the spec — Orval emits `zod.email()` which doesn't exist in zod v3 index typings.
- Express 5: async handlers must be `Promise<void>`; use `res.status().json(); return;`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
