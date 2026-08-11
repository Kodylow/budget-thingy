---
name: Replit Enterprise usage API
description: Rate-limit and query semantics of api.replit.com/v1 usage/groups endpoints
---

- `/usage` is rate-limited ~100 req/min. Rule: all usage calls go through one serial queue with pacing + Retry-After backoff; honor X-RateLimit-Remaining/Reset headers.
- **Why:** parallel per-group usage calls trip 429s immediately at ~220 groups; a serial queue with ~700ms pacing stays safely under budget.
- **How to apply:** never add a second call site for `/usage`; enqueue via the queue in the enterprise client. UI must tolerate progressive loading (isComplete/pendingCount + client polling).
- `groupId` filter on `/usage` requires `workspaceId`; `billingPeriod=current|previous` resolves the account's real billing interval (use the returned `interval.startTime` as the period key).
- Queue callers need unambiguous results: return `fresh_cache | queued | duplicate_queued` (not boolean) and fan out completion callbacks to duplicate callers, or consumers (e.g. snapshot writers) persist stale values when a fetch is already in flight.
- OpenAPI spec download: https://api.replit.com/v1 spec was cached at /tmp/openapi.json (re-fetch if missing).
- Orval + zod v3: avoid `format: email` in the OpenAPI spec — generates `zod.email()` which fails typecheck.
- Per-user usage: one `/usage?groupBy=member` call per group returns all members (paginated — pace the pages like queue tasks). `/budgets` exposes platform budgets: account controls, workspace default user limits, `workspace_group_limit`, `workspace_user_limit` (all per billing_cycle). `/members` gives username/email/name + per-workspace role/isDisabled.
- Orval: an operation with both path AND query params generates colliding names (zod path-params const vs query-params type); resolve with an explicit re-export in lib/api-zod/src/index.ts.
- Spec URL: https://api.replit.com/openapi.json (no auth needed).
