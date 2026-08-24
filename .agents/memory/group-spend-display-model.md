---
name: Group spend display model
description: Account anchor and reconciliation rules versus scoped and drill-down accounting.
---

# Group spend display model

## The rule

For account-wide callers, the dashboard Total Spend is the durable unfiltered Enterprise usage total. The visible team and unassigned-group rows retain their current rollup accounting, and one explicit residual bridges those rows to the account anchor.

Member and cluster drill-down pages continue to show per-person usage. Existing group/team threshold alerts intentionally continue to use their legacy raw/member accounting until alert behavior is separately migrated.

Workspace-scoped callers must never receive the account anchor or its residual. Their dashboard retains the scoped rollup plus scoped unattributed-project treatment.

**Why:**
No filtered group/member/project model reliably captures ungrouped users, unattributed charges, and former members. Replit Settings uses the unfiltered account total, while scoped admins must remain isolated from enterprise-wide figures.

**How to apply:**
Use the account anchor only for account-wide summary totals. Compute its residual against the exact top-level rows displayed, render loading until the anchor exists, and keep scoped, drill-down, trend, budget, and alert semantics unchanged.
