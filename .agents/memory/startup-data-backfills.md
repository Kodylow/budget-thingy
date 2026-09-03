---
name: Startup data backfills
description: How durable data transformations must be applied in the API startup path.
---

Schema reconciliation must run outside application prestart. Any required transformation of existing rows must still run through a narrow, idempotent, transactional hook, but non-critical backfills run after the listening socket opens and before dependent background jobs begin.

**Why:** A migration can appear complete in source and tests while deployed databases receive only new columns and tables. Importing a broad standalone seed is also unsafe because it can overwrite later administrator changes, and direct-execution guards based on `import.meta.url` can misfire after bundling.

**How to apply:** Keep runtime backfills limited to immutable fields, missing rows, and legacy identities being migrated; preserve existing editable values and visibility unless a specific invariant requires otherwise. Never put schema push or full-table usage transforms on the listen-critical path. Do not rerun broad mapping seeds at startup.