---
name: Overlapping group rollups
description: Attribution rule for deduplicating spend across custom groups
---

Rollup spend must count each member once. Order custom groups by workspace, case-insensitive group name, then stable group ID; attribute an overlapping member to the first group in that order.

**Why:** Enterprise members can belong to multiple custom groups, so summing raw group totals inflates team and organization spend. A stable rule also prevents totals from shifting when API list order changes.

**How to apply:** Use member-level usage only for team and organization rollups. Keep raw per-group usage for group budgets, threshold alerts, history, and drill-down reconciliation.