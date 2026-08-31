---
name: Group spend display model
description: Account anchor and reconciliation rules versus scoped and drill-down accounting.
---

# Group spend display model

## The rule

Visible group/team rows use the canonical workspace-aware member rollup. For account-wide callers, Dashboard Total Spend uses the unfiltered Enterprise usage gross total; an explicit residual row bridges canonical rows to that anchor. During background sync, render the latest available canonical values as provisional instead of replacing them with loaders; completion controls finality, not visibility.

All headline group, team, budget, trend, cluster, and threshold-alert surfaces must consume that same range-scoped canonical rollup. Group member detail must resolve ownership over the caller's complete visible scope, then slice the requested group; displayed members plus an explicit residual must equal its canonical row. Total-only member surfaces use the authoritative workspace allocation and must not wait for optional AI/non-AI decomposition. Project attribution remains an explanatory model, never a substitute for budget or alert accounting.

Workspace-scoped callers must never receive the account anchor or its residual. Their dashboard retains the canonical rollup recomputed only over their visible workspace scope.

For overlapping memberships, project observation ownership and creator ownership are separate decisions: choose the highest reported project total once, then assign its non-AI portion to the creator's stable canonical group in that workspace. A project winner that excludes the creator does not make the cost unattributable if another current same-workspace group owns that creator.

**Why:**
One server-owned attribution model prevents percentages and remaining budget from disagreeing between dashboard, trends, clusters, and alerts. The unfiltered account total guarantees every dollar is represented, while scoped admins remain isolated from enterprise-wide figures. Large account syncs can remain incomplete for many minutes, so hiding already-available values behind global readiness makes a responsive dashboard appear broken.

Keeping creator ownership aligned with member ownership prevents one overlapping group from being over-allocated while another shows a false residual. A narrow detail-only ownership scope can change the owner of a shared user, so ownership stays caller-visible even when readiness is limited to the requested cluster.

**How to apply:**
Use canonical group/team maps for every row, rollup, budget, trend, alert, and member-detail calculation. When a canonical response contains a value but is not final, show it with provisional styling and keep sync state visible separately; use a loader only before the first value exists. Do not block a total-only display on optional decomposition feeds. For account-wide headline/footer totals, use the gross anchor and render gross minus canonical as the residual row. Expose neither field to scoped viewers. Label stored alert values as send-time snapshots and project tables as attribution.

Use the same stable tie-breaks in APIs and exports. Assert per group and aggregate that attributed users plus residual equal the authoritative total, including duplicate projects, tied observations, overlapping memberships, and winner groups that do not contain the creator.
