# PostgreSQL query warning verification

## Cause

The warning belonged to two database read paths, not to an HTTP route. The
configuration snapshot loader started six Drizzle statements concurrently
inside one repeatable-read transaction. The directory family backfill likewise
started two reads concurrently inside one transaction. A Drizzle transaction is
pinned to one `pg` client, and recent `pg` versions deprecate relying on that
client's implicit queue for overlapping queries.

The usage snapshot read path was also inspected because it runs on the admin
home/idle refresh path. Its checked-out repeatable-read client already sequences
its statements and was not a remaining owner.

## Disposable pre-fix reproduction

At `2026-09-08T04:41:47Z`, the isolated API harness started its temporary
PostgreSQL cluster and ran a test-local copy of the former configuration
transaction: the same six table reads under repeatable-read with `Promise.all`.
The pre-query diagnostic observed **five** same-client overlap arrivals while
the first query was pending. Sanitized stacks owned the calls to
`db-query-sequencing.test.ts`'s reproduction transaction, through Drizzle's
node-postgres prepared-query execution and `Promise.all`. This establishes the
configuration transaction shape as the warning owner rather than inferring it
only from source text.

The diagnostic deliberately did not forward those calls concurrently to `pg`;
it chained all six onto one promise tail. Thus the reproduction records the
condition that causes the `pg` deprecation warning without intentionally
triggering unsafe driver behavior or touching a live database. The equivalent
test finished at approximately `2026-09-08T04:41:51Z`.

## Fix and checks

- Both owning transaction callbacks now await statements in order.
- Transaction boundaries and repeatable-read isolation are unchanged, so each
  snapshot remains atomic.
- The disposable PostgreSQL integration diagnostic widens each checked-out
  client's in-flight window, records a sanitized call stack if a second query
  arrives, and serializes every waiter on a per-client promise tail. Multiple
  waiters therefore cannot wake together and reach `pg`.
- The same check starts independent transactions concurrently and requires
  at least two checked-out clients. The current configuration loader plus three
  independent backfills produced **zero** same-client overlaps, proving that
  only same-client overlap is removed; pool-level concurrency remains.
- Existing configuration tests cover a commit racing a snapshot and concurrent
  writers. Existing per-worker schema setup installs canonical seed data and
  confines cleanup to the disposable cluster.

Verification after the queue correction: the focused diagnostic file passed
**2/2 tests**. At `2026-09-08T04:42:10Z`, the broader DB-focused run passed
**27/27 tests across 3 files**; API and DB TypeScript checks also passed.

No migration, seed operation, or shared/live database modification is required.