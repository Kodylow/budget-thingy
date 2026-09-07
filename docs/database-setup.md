# Safe database setup and releases

## Explicit commands

A routine merge only updates code. Its short post-merge hook does not install
dependencies, change the lockfile, run SQL, or install business defaults.

Before an intentional dependency/setup/release operation, install the committed
resolution from the repository root:

```sh
pnpm install --frozen-lockfile
```

Configure `DATABASE_URL` through the environment's secret manager. Do not paste
connection strings into tickets, command output, or this document. The default
application target is `public`; an explicitly configured `DATABASE_SCHEMA`
selects a separate schema with no fallback to `public`.

| Operation | Command |
| --- | --- |
| Fresh empty database, or explicit schema upgrade **and** missing canonical defaults | `pnpm --filter @workspace/db run setup` |
| Schema release without changing canonical configuration | `pnpm --filter @workspace/db run migrate` |
| Install missing canonical defaults on a fully migrated database | `pnpm --filter @workspace/db run seed` |
| Generate a migration for review (does not apply it) | `pnpm --filter @workspace/db run generate` |

For a release, review generated SQL and the journal, take a verified backup using
the database operator's normal procedure, verify the selected environment, and
run `migrate` explicitly before starting code that requires the new schema.
Run `setup` instead only when adding missing defaults is also intended.
Do not use raw `drizzle-kit migrate`, `push`, or `push --force`: they bypass the
safety contract. The old push scripts have been removed.

## Supported states and refusal

- **Empty target, absent or empty journal:** setup creates the schema and
  migration journal, applies reviewed migration SQL, then installs defaults.
  An unrelated table with zero rows still means the target is *not empty*.
- **Recognized recorded baseline:** the stored hashes, timestamps, index order,
  and required catalog structure must agree with this checkout. Checks include
  column types/defaults/nullability/identity, constraints and validation state,
  index definitions/predicates, and configuration functions/enabled triggers. Setup
  applies only pending migrations and then additive seeds.
- **Historical clock variants:** both a baseline-only history and the recorded
  baseline followed by 0001–0004 are supported. The historical baseline timestamp
  is newer than those four entries. The runner retains Drizzle's maximum-recorded-
  timestamp selection rule; it does not invent missing journal rows. Forward
  repairs cover skipped policy tables, alert columns/indexes, authorization, and
  the historical allocation-audit gap.
- **Imported/populated target without a usable journal, changed hashes,
  unknown timestamps, missing required history, or incompatible schema:** fail
  closed, before applying setup SQL. The database is not automatically repaired,
  cleared, adopted, or assigned a fabricated journal.

If refused, check that the target is correct, restore its **matching** journal
from a verified backup when available, and reconcile the import's schema and
history in a disposable copy with a database operator. A data-only import is not
automatically an initialized database. Do not delete the journal, copy an
unrelated journal, or drop/recreate a schema to make the check pass. Unsupported
histories require a reviewed migration/import plan; there is no force flag.

The historical migration files and their hashes remain unchanged. The supported
runner explicitly omits only the two obsolete public-schema reset statements
in the known baseline; it never drops/recreates the target schema. This is a
production policy, not a test-only rewrite. Other schema-changing or public-
qualified migration statements are refused. New repairs have later timestamps;
existing entries must never be reordered, renumbered, or backdated.

### Reviewing a new migration

This supported contract targets **PostgreSQL 16**. Other major versions refuse
before setup DDL; supporting a new major requires validating its catalog
representation and migration behavior, not removing the version check.

After adding reviewed migration SQL and a journal entry newer than all prior
timestamps, regenerate the hash-bound catalog contract from the repository root:

```sh
node lib/db/scripts/generate-schema-contract.mjs
```

The generator uses only its own temporary PostgreSQL 16 cluster and has no
`DATABASE_URL` input. `POSTGRES_BIN` may select the directory containing local
PostgreSQL binaries. Review and commit `lib/db/src/schema-contract.generated.ts`
alongside the migration, then run the focused tests and workspace typecheck.
The guard refuses a stale or missing contract before applying SQL. Independent
migration deltas preserve forward-repair postconditions even on histories that
skipped older entries. A migration with new prerequisites may require extending
the generator's disposable fixtures; never generate expectations from a shared
database or weaken the runtime check to accept its current state.

## Transactions, concurrency, and configuration

The runner acquires a transaction-scoped advisory lock for the target schema
before inspecting its journal. Preflight, all pending migrations, journal
inserts, and canonical seeds share the same connection and transaction. Other
supported setup/migrate/seed commands for that target wait for the first one.
A SQL error or failed seed rolls everything back; a terminated connection also
releases the lock and rolls its transaction back. Lock waits are bounded to 60
seconds and individual SQL statements to 120 seconds. Raw external DDL clients
do not cooperate with this lock; operators must not run them concurrently.

Canonical seeding uses four bounded bulk INSERT statements and one legacy-row
lookup, rather than per-row inserts in separate transactions. Conflicts do
nothing: existing allocation amounts, visibility, family assignments, limit
targets, administrator history, accepted adjustments, usage facts, and sessions
are not overwritten. Intentionally deleted canonical rows are considered
missing and will be recreated by an explicit seed.

Database-owned configuration revision triggers commit with these writes. A
complete seed advances that revision three times (one per covered statement),
including conflict-only reruns; rollback publishes no revision changes.
No process-local cache notification substitutes for the committed revision.

### Legacy Growth Strategy & Operations identity

The approved DXP and Non-DXP defaults and group mappings are retained. Generic
seeding no longer deletes a legacy allocation. There is no trustworthy
provenance that distinguishes a stale seed row from later operator-owned data,
so setup reports `legacyBudgetRequiresReview` and preserves the row.

If that warning appears, an authorized operator must inspect its saved values,
mapping/target references, audits and accepted adjustments before deciding
whether retirement is still appropriate. Use the application's existing
audited allocation/visibility controls where appropriate. Any actual deletion
or reassignment requires a separately approved, narrowly scoped and recorded
transition, not a recurring seed rule. This change does not perform retirement
or change approved allocation values.
