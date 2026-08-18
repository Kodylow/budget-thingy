---
name: Group spend display model
description: Two-tier spend model for dashboard vs detail pages — which field to use where and why.
---

# Group spend display model

## The rule

There are now **two spend figures** for every group/team, used in different contexts:

| Context | Field | Source | Semantic |
|---|---|---|---|
| Budget accounting, alerts, remaining, % used | `rollupSpendUsd` / `combinedSpend` | `getDedupedUsageRollup` | Each user globally attributed to exactly one group; value-based Set dedup across same-workspace groups |
| Display (dashboard team headers, cluster-detail total) | `teamRawSpend[name]` / `totalMembersSpend + totalUnattributedSpend` | per-member `getMemberUsage`, seenUserIds within team | Sum of each team member's actual workspace spend, regardless of global attribution |
| Display (individual group member rows) | `memberUsage.byUser.get(userId)` | raw API usage | Per-person workspace spend; members attributed to other groups show real spend, not $0 |

## Why the split

The Replit usage API returns workspace-level spend per user — every group in the same workspace reports the same amount for a given user. The rollup deduplicates globally (each user counted once across all groups), which is correct for budget accounting but makes a user show $0 in groups where their spend is attributed elsewhere.

For admin visibility, showing $0 is confusing. The raw member spend and team-level seenUserIds aggregation fix this at the display layer without changing budget accounting.

## Key invariant: don't mix tiers

- Budget alerts fire against `getSpend(g.id, "billing:from-cutoff")` — the raw API group total. Never compare raw member spend against budget thresholds.
- `remainingUsd`, `percentUsed` on group detail pages use `attributed.spendUsd` (rollup). These are for budget tracking.
- `teamRawSpend` in `/groups` response is for display only — team header rows and table footer totals.

## How: backend computation

- `rawMemberSpendUsd` per group: sum of `getMemberUsage(srcId).byUser.get(userId)` for all current members + `unattributableTotalCostUsd` (ex-members). Computed in GET /groups.
- `teamRawSpend[teamName]`: seenUserIds across all team's constituent groups + unattributable per source group. Computed after the groups array is built in GET /groups.
- `unattributedSpendUsd` in GET /groups/:groupId: computed from `attributed.byUser` (not raw member spend) so it only represents genuine ex-member spend.

**Why:**
An early attempt used raw member spend for `unattributedSpendUsd`, which caused it to go to $0 (raw member spend ≥ attributed total for members in multiple groups). Reverted to use `attributedCurrentMembersSpend` for the unattributed calculation.
