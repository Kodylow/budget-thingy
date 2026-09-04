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

For parent workspaces that contain several Comcast team families, match the full normalized workspace name as a bounded prefix only when no exact team-name match exists, then use explicit Comcast group membership to select the child team. That child-team ownership outranks incidental local groups such as PREPROD.

**Why:** A shared workspace can contain both operational groups and several business teams; workspace name alone identifies the parent but not the child cost center.

**How to apply:** Prefer exact workspace/team matches. For a parent-only match, require the user's group membership to disambiguate child teams, preserve the cross-workspace ownership through canonical per-user attribution, and leave unmatched users unattributed.

Treat project identity as `(workspace ID, project ID)`, never project ID alone.

**Why:** Enterprise project IDs are workspace-scoped and may collide across workspaces; a global key silently overwrites attribution.

**How to apply:** Qualify every project attribution, creator, and metric lookup before combining workspace snapshots or filtering project responses.

Treat directory family identity as `(workspace ID, normalized family key)`, never the family key alone. Legacy families may inherit a team only when a named override applies or all matching nonlegacy families resolve to one team; ambiguity must remain unassigned.

**Why:** Same-named families can exist in independent workspaces with different teams. Global family matching can misattribute spend and grant cross-workspace access; arbitrary legacy inheritance turns that accounting bug into an authorization leak.

**How to apply:** Keep target resolution and team-admin scope workspace-qualified. Cross the workspace boundary only for the explicit legacy exception, and fail closed when its nonlegacy team is not unique.
