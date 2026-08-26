---
name: Historical membership attribution
description: Rules for capturing immutable daily group rosters and applying them to historical usage.
---

Capture at most one immutable group-membership roster per UTC day, and only
after a fresh directory read explicitly returned membership for every custom
group. A partial refresh must leave no completion marker and retry later.

**Why:** Missing group-membership results are indistinguishable from empty
groups after persistence. Freezing a transient API failure would permanently
rewrite historical group and team attribution.

**How to apply:** Use stable group and user IDs, commit all roster rows and the
day-complete marker atomically, and dedupe overlapping users in the canonical
stable group order. Historical dates with completed rosters use those rosters;
the current UTC day remains live, and dates before roster coverage retain the
legacy behavior rather than pretending membership can be reconstructed.