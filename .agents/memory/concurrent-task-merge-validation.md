---
name: Concurrent task merge validation
description: How to handle another project task merging while work touches overlapping shared files.
---

After another task merges, treat prior validation as stale when both tasks touched shared authentication, authorization, contracts, generated clients, or route files. Re-read the current files and rerun generation, type checks, tests, and workflow startup before completion.

**Why:** Automatic branch reconciliation can land between a successful local check and the completion gate, producing mixed implementations or stale generated outputs even though the earlier tree passed.

**How to apply:** Watch task-state updates during overlapping work. If a related task merges, inspect the current diff against the merged base and validate the post-merge tree rather than relying on earlier results.