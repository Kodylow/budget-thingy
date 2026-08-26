---
name: Group spend display model
description: Account anchor and reconciliation rules versus scoped and drill-down accounting.
---

# Group spend display model

## The rule

Visible group/team rows use the canonical workspace-aware member rollup. For account-wide callers, Dashboard Total Spend uses the unfiltered Enterprise usage gross total; an explicit residual row bridges canonical rows to that anchor. Keep the account dashboard loading until both models are complete.

All headline group, team, budget, trend, cluster, and threshold-alert surfaces must consume that same range-scoped canonical rollup. Project attribution and per-person usage remain explanatory detail models, never substitutes for budget or alert accounting.

Workspace-scoped callers must never receive the account anchor or its residual. Their dashboard retains the canonical rollup recomputed only over their visible workspace scope.

**Why:**
One server-owned attribution model prevents percentages and remaining budget from disagreeing between dashboard, trends, clusters, and alerts. The unfiltered account total guarantees every dollar is represented, while scoped admins remain isolated from enterprise-wide figures.

**How to apply:**
Use canonical group/team maps for every row, rollup, budget, trend, and alert calculation; defer rather than calculate from incomplete usage. For account-wide headline/footer totals, use the gross anchor and render gross minus canonical as the residual row. Expose neither field to scoped viewers. Label stored alert values as send-time snapshots and project tables as attribution.
