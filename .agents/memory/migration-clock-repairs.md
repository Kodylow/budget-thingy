---
name: Migration clock repairs
description: How to repair additive migrations skipped after a rebased baseline received a newer journal timestamp.
---

When a rebased baseline is newer than additive migrations in the migration
journal, repair with a new idempotent forward migration whose timestamp is newer
than every prior entry. Do not reorder or rewrite migrations that may already be
recorded.

**Why:** Timestamp-based migration runners can treat older journal entries as
already superseded after the newer baseline is recorded, leaving production
schema behind the source schema even though fresh databases look correct.

**How to apply:** For additive schema recovery, use replay-safe `IF NOT EXISTS`
DDL and add a regression assertion covering both the repair contents and its
position on the migration clock.