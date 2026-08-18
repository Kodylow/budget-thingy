---
name: Overlapping group rollups
description: Attribution and deduplication rules for spend across custom groups
---

Rollup spend must count each member once. Order custom groups by workspace, case-insensitive group name, then stable group ID; attribute an overlapping member to the first group in that order.

**Why:** Enterprise members can belong to multiple custom groups, so summing raw group totals inflates team and organization spend. A stable rule also prevents totals from shifting when API list order changes.

**How to apply:** Use member-level usage only for team and organization rollups. Keep raw per-group usage for group budgets, threshold alerts, history, and drill-down reconciliation.

**Exception — per-user views (User Activity page and /export/users.csv):**
The Replit usage API returns WORKSPACE-level spend per user, not group-level. Every group inside the same workspace reports the EXACT SAME dollar amount for a given user. Summing across all groups in a workspace multiplies that spend by the number of groups the user belongs to.

Correct per-user total = **max spend per (user, workspaceId)** summed across distinct workspaces.
- Groups in DIFFERENT workspaces are always independent pools — same-named groups in different workspaces are separate usage buckets and must be summed, never name-deduped.
- Plus extra-workspace spend (account-wide, only shown to account admins).
- The displayed group/team is the one with the HIGHEST single-group spend for that user.

Implementation lives in monitor.ts Pass 1.5 (two copies — `/users/activity` and `/export/users.csv`):
- `userWorkspaceMaxSpend` / `csvWorkspaceMaxSpend`: `Map<userId, Map<workspaceId, maxSpend>>`
- After the group loop, set `attr.spendUsd = [...wsMap.values()].reduce((sum, s) => sum + s, 0)`

**Why this matters:** An enterprise user in N groups within the same workspace would otherwise show N× their real spend. The max-per-workspace / sum-across-workspaces pattern is the correct aggregation and is validated by the test suite in `monitor.users-activity.test.mjs`.
