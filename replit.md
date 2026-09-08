# Group Budget Monitor

Internal spending and funding monitor for the Comcast Replit Enterprise account. It combines personal usage, funding-team reporting, monthly Agent limits, and controlled budget alerts.

## Run and navigate

- Use the registered API Server and Group Budget Monitor workflows; they provide ports and routing. Their commands are `pnpm --filter @workspace/api-server run dev` and `pnpm --filter @workspace/budget-monitor run dev`.
- Checks: `pnpm run typecheck`, `pnpm run build`, and the relevant package's `test` script. Do not assume historical test results describe the current tree.
- Fresh empty database setup: `pnpm install --frozen-lockfile`, then `pnpm --filter @workspace/db run setup`. Populated imports require their matching migration journal; see [database setup](docs/database-setup.md).
- Routine merges do not install, migrate, or seed. Schema releases are explicit operator actions using the guarded `migrate` command; never repair migration history with raw push/reset commands.
- [Full data sync](docs/full-data-sync.md) documents the separate data-only operator workflow, not permission to run it.
- Required service configuration includes `DATABASE_URL` and `REPLIT_ENTERPRISE_API_KEY`. Use managed configuration for credentials and identities; no personal defaults belong here.

The workspace uses TypeScript, pnpm, Express, PostgreSQL/Drizzle, and React/Vite. Main locations:

- `artifacts/api-server/`: API, Enterprise ingestion, accounting, authorization, and notifications.
- `artifacts/budget-monitor/`: web app; Home is personal/team context, Org Insights is authorized account reporting, Spend is the analytical ledger, and Limits manages workspace-qualified current-cycle limits.
- `artifacts/budget-walkthrough/`: walkthrough slides.
- `lib/db/`: schema, migrations, and approved seed inputs.
- `lib/api-spec/openapi.yaml`: API contract. Regenerate clients/validators with `pnpm --filter @workspace/api-spec run codegen` after contract edits.

## Product boundaries

- Financial reporting uses canonical workspace-qualified totals. Overlapping memberships must not duplicate charges; unassigned spend stays reconcilable. Project attribution explains usage rather than replacing funding or alert totals.
- Funding teams are defined by committed allocations and workspace/group mappings, not manager hierarchies or guessed names. Personal team context follows the effective person's actual memberships, not every team they administer.
- Annual team allocations are planning baselines plus approved adjustments, separate from monthly Agent enforcement limits. The established funding term is **May 20, 2026–May 20, 2027, inclusive**; it does not roll forward automatically.
- The approved starting allocation source is `lib/db/data/starting-team-allocations.json`: 29 teams, $771,620.02, PREPROD hidden. “Consumer Solutions” aliases “Customer Solutions”; it is not a second allocation. Initialization/imports must not overwrite later administrator edits.
- Planning additions are local until Airtable is explicitly configured. Opening allocations are undated, not recurring monthly amounts. Historical connector handoffs do not establish a live integration.
- Reporting ranges and forecast horizons do not redefine funding terms or billing cycles. Remaining/utilization requires matching scope, period, and sufficient observations; unknown is not zero, unlimited, or “not set.” Known recorded spend remains useful even when attribution is incomplete.
- Full-term and billing-cycle budget comparisons use the whole authorized funding team across its mapped workspaces, with explicit full-team scope—not one workspace's contribution against the full budget. Annual funding uses all-service team spend; monthly limits use Agent-only spend in the verified billing cycle.
- Replit member limits are workspace/user-scoped, not transferable pools. Current-cycle Agent consumption—not selected-range all-service spend—determines their remaining allowance. Read-only reconciliation is not authorization to write upstream limits; preserve explicit authorized application and deliberate operator overrides. Group-limit writes require revalidated explicit workspace/group targets, never name inference; legacy copies remain display-only.
- Access is scope plus server capability, not a broad role label. Stable identity, revocation, and effective preview scope govern both reads and writes. Bootstrap/seed behavior must not undo revocation. Shared-team totals and alerts must not disclose out-of-scope spend; true-admin settings remain separate from managed-editor operations.
- Automated email is disabled by default. Delivery uses configured, authorized recipients; unavailable/disabled delivery must not consume threshold fire state. Manual tests remain distinct from production alert history. Bootstrap and seeded administrator identities are environment configuration, never standing personal values.

## Presentation and privacy

Keep Budget Monitor's Comcast-inspired operational identity, not an invented official design system. Current user-supplied designs and requirements take precedence over optional style defaults; a reference design does not authorize financial or access-model changes.

Detailed coverage, attribution, and methodology explanations belong in the effective-admin-only Data quality panel, **not ordinary chart badges, tooltips, or repeated footnotes**. The user rejected those inline coverage labels. Keep essential periods, value/basis labels, missing-value gaps, “Unavailable,” and actionable errors visible; do not imply that incomplete observations are complete balances.

Development identity viewing is explicit, read-only, and private: anyone reaching that development preview can read data available through its directory picker. Never auto-select a person, grant authority from preview controls, or allow the no-login path in production. Missing identities fail closed, and identity changes must not reuse another person's protected data.

Public walkthroughs and screenshots use clearly labeled sample data, never live identities or financial details.

Historical plans and dated verification reports are evidence, not current instructions or authorization. Consult the current request and task status before acting on them.