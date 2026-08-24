---
name: Workspace-aware rollups
description: Attribution and completeness rules for spend across workspaces and custom groups
---

Treat each `(workspace, user)` as the exact identity for dashboard rollups. The complete workspace-member payload is authoritative; group-filter observations are provisional only. Sum distinct workspaces even when their values are equal.

**Why:** Enterprise members can belong to multiple custom groups, group-filter observations can drift during serialized fetches, and equal dollar values in separate workspaces are independent charges.

**How to apply:** Within each workspace, order custom groups by case-insensitive name then stable ID and attribute a member to the first matching group. Put unmatched directory/usage members and workspace no-user charges in that workspace's synthetic No group row. Workspace-scoped callers may only receive rows from authorized workspaces. Team checks must defer until every authoritative workspace payload is available.

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
