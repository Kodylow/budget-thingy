---
name: Upstream team limit targets
description: Safety rules for assigning, reconciling, and updating explicit Replit Member-group limits from local team allocations.
---

Stored `(workspace_id, group_id)` target identities are authoritative for platform-limit writes and downstream team attribution. Runtime name/family inference must not select write targets. Only explicitly assigned non-legacy Member/Members groups are writable; legacy workspace copies are display-only and use same-name fallback solely for attribution. The legacy workspace receives a workspace-default per-user cap, never group limits.

**Why:** Duplicate role-family names across workspaces made runtime inference ambiguous and could enforce a hard-blocking limit on the wrong group. Explicit identities make every write auditable.

**How to apply:** Read upstream state on schedule without writing. Apply limits only after an explicit true-admin action, revalidate that each selected target remains enabled, and address the target by workspace and group ID. Split a team limit across enabled targets unless a target has an override.