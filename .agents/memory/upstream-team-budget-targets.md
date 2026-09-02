---
name: Upstream team budget targets
description: Safety rules for resolving and updating Replit Member-group budgets from local team allocations.
---

Resolve every upstream team-budget target from a forced-fresh live directory read. Legacy name-only assignments are usable only when the exact assigned live name belongs to one workspace; cross-workspace reuse must remain unresolved. Only the sole Member or Members sibling in that live role family is eligible.

**Why:** Cached group IDs and account-wide name-only mappings can become stale or collide after renames, deletion/recreation, or reuse in another workspace. Guessing in those cases can enforce a budget on the wrong group.

**How to apply:** Before any team-budget mutation, refresh the directory, combine it with stored assignments, and require one unambiguous Member target. A scoped budgets key may be preferred over the connector only when a separate non-secret write-approval flag is explicitly enabled; otherwise it remains read-only. Keep local budget history independent from upstream availability.