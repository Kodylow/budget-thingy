---
name: Demand-driven usage sync
description: How visible reporting ranges should be scheduled relative to historical maintenance.
---

When a selected reporting range contains missing scopes, the normal user flow must enqueue those cold scopes once; a retry path that only handles failed or partial work is insufficient. Usage for an opened group or cluster should be promoted ahead of account-wide and historical maintenance.

**Why:** A dashboard can correctly report hundreds of pending scopes forever while the workers process unrelated daily-fact backfill if no demand-driven path schedules never-run scopes. Large enqueue storms can also hide the useful start, finish, and failure telemetry.

**How to apply:** Any new pending/loading state needs a corresponding demand trigger for missing data, not only failures. Keep visible detail work interactive, keep historical work in lower-priority workloads, and summarize or sample bulk enqueue logs while retaining complete execution and failure logs.