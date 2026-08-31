---
name: Startup data backfills
description: How durable data transformations must be applied in the API startup path.
---

`drizzle-kit push` reconciles schema but does not execute committed SQL migration data statements. Any required transformation of existing rows must also run through a narrow, idempotent, transactional startup hook after schema push and before the server accepts traffic.

**Why:** A migration can appear complete in source and tests while deployed databases receive only new columns and tables. Importing a broad standalone seed is also unsafe because it can overwrite later administrator changes, and direct-execution guards based on `import.meta.url` can misfire after bundling.

**How to apply:** Keep runtime backfills limited to immutable fields, missing rows, and legacy identities being migrated; preserve existing editable values and visibility unless a specific invariant requires otherwise. Do not rerun broad mapping seeds at startup. If a seed module is importable by bundled server code, guard its CLI entrypoint using the actual script filename and verify the built workflow stays running.