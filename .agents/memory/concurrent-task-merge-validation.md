---
name: Concurrent task merge validation
description: How to handle another project task merging while work touches overlapping shared files.
---

After another task merges, treat prior validation as stale when both tasks touched shared authentication, authorization, contracts, generated clients, or route files. Re-read the current files and rerun generation, type checks, tests, and workflow startup before completion.

**Why:** Automatic branch reconciliation can land between a successful local check and the completion gate, producing mixed implementations or stale generated outputs even though the earlier tree passed.

**How to apply:** Watch task-state updates during overlapping work. If a related task merges, inspect the current diff against the merged base and validate the post-merge tree rather than relying on earlier results.

For merges that add database columns, verify the expected live schema after the post-merge setup even when the migration command reports success. A migration journal can be ahead of the actual development schema after an interrupted or reset upgrade.

**Why:** A successful migration report once left newly required alert columns absent, causing otherwise healthy API routes to return 503 responses.

**How to apply:** Check the expected columns or relations directly after schema-changing merges. In development, reconcile the database to the checked-in schema with the project's non-interactive schema-push command when the journal and live schema disagree; use the production migration workflow for production.