---
name: Replit Enterprise usage API
description: Rate-limit and query semantics of api.replit.com/v1 usage/groups endpoints
---

- `/usage` is rate-limited ~100 req/min. Rule: all usage calls go through one serial queue with pacing + Retry-After backoff; honor X-RateLimit-Remaining/Reset headers.
- **Why:** parallel per-group usage calls trip 429s immediately at ~220 groups; a serial queue with ~700ms pacing stays safely under budget.
- **How to apply:** never add a second call site for `/usage`; enqueue via the queue in the enterprise client. UI must tolerate progressive loading (isComplete/pendingCount + client polling).
- `groupId` filter on `/usage` requires `workspaceId`; `billingPeriod=current|previous` resolves the account's real billing interval (use the returned `interval.startTime` as the period key).
- Orval + zod v3: avoid `format: email` in the OpenAPI spec — generates `zod.email()` which fails typecheck.
- Per-user usage: one `/usage?groupBy=member` call per group returns all members (paginated — pace the pages like queue tasks). `/budgets` exposes platform budgets: account controls, workspace default user limits, `workspace_group_limit`, `workspace_user_limit` (all per billing_cycle). `/members` gives username/email/name + per-workspace role/isDisabled.
- `/usage` can return `hasMore: true` with no cursor. **Why:** unbounded time-bisection of a multi-month range can monopolize the serial queue for thousands of calls. **How to apply:** cap shard depth/request count and commit the bounded result as partial.
- Sync ledgers persist terminal outcomes, not running state. **Why:** crashes and replica races can strand/overwrite `syncing`. **How to apply:** publish outcomes under a per-scope lock and reject stale failures.
- A background refresh must not replace a usable successful Postgres snapshot with `syncing` or `failed`. **Why:** reads are DB-first and should stay complete while incremental refreshes run or fail. **How to apply:** only cold scopes block; prioritize cold backfills and retain the last successful usage/metadata state until a new transaction commits.
- Interactive range changes must queue the one-call account total first, workspace rollups second, and group member/project detail last. **Why:** hundreds of equal-priority detail calls can make a valid custom range look stuck for many minutes.
- Team detail readiness is cluster-local, but ownership remains caller-wide. **Why:** unrelated cold groups must not block a team, while stable account-visible ownership keeps its totals aligned with the dashboard.
- Duplicate queued usage work must accept priority promotion. **Why:** a team opened after the dashboard queues a cold range must overtake that background backlog without creating a second API request.
- Orval: an operation with both path AND query params generates colliding names (zod path-params const vs query-params type); resolve with an explicit re-export in lib/api-zod/src/index.ts.
- Spec URL: https://api.replit.com/openapi.json (no auth needed).
