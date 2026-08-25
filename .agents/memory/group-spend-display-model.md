---
name: Group spend display model
description: Account anchor and reconciliation rules versus scoped and drill-down accounting.
---

# Group spend display model

## The rule

Dashboard Total Spend and every visible group/team row use the canonical workspace-aware member rollup. For account-wide callers, the unfiltered Enterprise usage total is reconciliation metadata that explains any difference from the canonical rollup.

All headline group, team, budget, trend, cluster, and threshold-alert surfaces must consume that same range-scoped canonical rollup. Project attribution and per-person usage remain explanatory detail models, never substitutes for budget or alert accounting.

Workspace-scoped callers must never receive the account anchor or its residual. Their dashboard retains the canonical rollup recomputed only over their visible workspace scope.

**Why:**
One server-owned model prevents percentages and remaining budget from disagreeing between dashboard, trends, clusters, and alerts. The unfiltered account total remains a completeness/reconciliation anchor, while scoped admins must remain isolated from enterprise-wide figures.

**How to apply:**
Use canonical group/team maps for summary totals, every rollup, budget, and alert calculation; defer rather than calculate from incomplete usage. Expose the account anchor only as account-wide reconciliation metadata. Label stored alert values as send-time snapshots and project tables as attribution.
