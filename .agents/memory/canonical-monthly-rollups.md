---
name: Canonical monthly rollups
description: Safety boundaries for reusing precomputed monthly group-user spend attribution.
---

Materialized canonical attribution may be combined only when every requested
range segment exactly matches a committed month boundary and the current
attribution-input fingerprint. Account-wide, full-directory reads can reuse
those rows; workspace-scoped or detail-specific reads must retain their scoped
recomputation unless a separately scoped materialization model is introduced.

**Why:** Canonical ownership depends on the complete visible group/workspace
universe. Filtering an account-wide result after attribution can leak hidden
scope into ownership and totals, while partial or stale month reuse can mix
different membership and creator identities.

**How to apply:** When adding a new range or serving surface, use persisted
months only if the range is covered by contiguous committed segments, all input
fingerprints still match, and the caller uses the full directory. Preserve
authoritative-only user rows separately from residual group amounts.