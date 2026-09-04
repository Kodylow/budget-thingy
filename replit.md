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
- `lib/db/src/schema/` — DB tables for pools, notification recipients/history, editor access, teams, auth, and durable usage caches
- `artifacts/api-server/src/lib/enterprise.ts` — Replit Enterprise API client, serial rate-limited usage queue, directory + spend caches
- `artifacts/api-server/src/lib/checker.ts` — background threshold checker (every 10 min) + manual check
- `artifacts/api-server/src/lib/email.ts` — AgentMail sending layer with a success-only 10-minute sender-inbox lookup cache
- `artifacts/api-server/src/routes/monitor.ts` — all budget-monitor routes
- `artifacts/budget-monitor/` — web frontend (dashboard `/`, alerts `/alerts`, settings `/settings`); theme in `src/index.css`

## Architecture decisions

- Enterprise `/usage` is rate-limited (~100 req/min): every usage call goes through ONE serial priority queue (`enterprise.ts`) with pacing, Retry-After backoff, and X-RateLimit awareness. Never call `/usage` outside the queue.
- Group spend loads progressively: `/api/groups` returns immediately with `spendLoaded=false` per group plus `isComplete`/`pendingCount`; the frontend polls every 8s until complete. Null spend is "loading", never $0.
- Spend cache TTL 10 min; directory (workspaces/groups/members) TTL 15 min; both in-memory, warmed on server start.
- Dashboard group lists include custom/SCIM groups only. Team and org spend rollups deduplicate overlapping members by deterministic first-group attribution (workspace, group name, then group ID); group rows, drill-downs, and alerts keep raw per-group spend.
- Billing period = the `interval.startTime` the Enterprise API resolves for `billingPeriod=current`; threshold fire state is keyed by (groupId, periodStart, threshold) in `fired_thresholds` so each threshold emails at most once per period and resets automatically on a new period.
- If email isn't connected or no admin emails exist, crossed thresholds are NOT marked fired — they retry once email is configured.
- One email per check per group (highest due threshold) to avoid alert storms when a budget is first set on an already-over group.
- Real production alerts use RBAC-derived recipients. Every manual test path is independently authorized to the persisted Kody identity and fixes delivery to `kody.low@repl.it` without writing Email Activity, fired-threshold, or delivery-claim state.
- Non-production sends are redirected to `kody.low@repl.it` and subjects receive a `[DEV]` prefix. Test sends also retain their `[TEST]` prefix.
- Set `APP_BASE_URL` to the deployed app origin/base path to add safe group/team links to alert email; leave it unset to omit links.
- Managed account editors are keyed by stable Replit user ID. The designated bootstrap editor is added once from an exact, verified OIDC email; a durable consumed marker prevents later logins from undoing admin revocation. Only true Enterprise account admins can manage the allowlist.
- Team alerts use the same member-deduplicated, cross-workspace attribution as dashboard team totals. Checks defer when required member or extra-workspace data is incomplete.
- Workspace admins see read-only pools and rollups for teams represented in their scope. Account-wide alerts for teams spanning additional workspaces are omitted from their history to avoid exposing cross-workspace spend.

## Product

- Dashboard: all Enterprise groups with spend for a selectable range (billing period / MTD / YTD / custom dates), inline budget set/edit/remove, remaining budget, % used with color-coded threshold badges and progress bars, account-wide summary stats, per-group refresh.
- Group drill-down (`/groups/:groupId`): per-member allocated budget (platform user limit or workspace default), usage, remaining, % used, role; reconciliation footer (member spend + unattributed = group total).
- Budgets merge two sources: app budgets (set in this tool, used for email alerting) and platform budgets read from the Enterprise `/budgets` API (`workspace_group_limit`); `budgetSource` distinguishes them. Platform budgets are read-only here.
- Alerts: group/team history with configured pool and spend, plus an account-operator "run check now" action and Kody-only fixed-recipient activity examples.
- Settings: true-admin-only notification recipients, managed editor allowlist, and system status; the persisted Kody identity also has the predefined email-test console.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run codegen before touching server or frontend code. Avoid `format: email` in the spec — Orval emits `zod.email()` which doesn't exist in zod v3 index typings.
- Express 5: async handlers must be `Promise<void>`; use `res.status().json(); return;`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
