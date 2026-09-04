import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const BASELINE_TAG = "0018_billing_period_observation";
const MIGRATIONS_DIR = new URL("../lib/db/drizzle/", import.meta.url);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to apply database migrations");
}

const journal = JSON.parse(
  await readFile(new URL("meta/_journal.json", MIGRATIONS_DIR), "utf8"),
);
const baseline = journal.entries.find((entry) => entry.tag === BASELINE_TAG);
if (!baseline) {
  throw new Error(`Migration journal is missing required baseline ${BASELINE_TAG}`);
}
const migrationSql = await readFile(
  new URL(`${BASELINE_TAG}.sql`, MIGRATIONS_DIR),
  "utf8",
);
const hash = createHash("sha256").update(migrationSql).digest("hex");

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext('drizzle-migrations'))");
  await client.query("create schema if not exists drizzle");
  await client.query(`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
  const ledger = await client.query(
    "select 1 from drizzle.__drizzle_migrations limit 1",
  );
  if (ledger.rowCount === 0) {
    const state = await client.query(`
      select
        to_regclass('public.group_budgets') is not null as has_legacy_schema,
        to_regclass('public.api_billing_period_observation') is not null as has_baseline
    `);
    if (state.rows[0]?.has_baseline) {
      await client.query(
        `insert into drizzle.__drizzle_migrations (hash, created_at)
         values ($1, $2)`,
        [hash, baseline.when],
      );
      console.log(`Recorded existing schema through ${BASELINE_TAG}`);
    } else if (state.rows[0]?.has_legacy_schema) {
      throw new Error(
        `Existing pushed schema does not include ${BASELINE_TAG}; refusing to guess a migration baseline`,
      );
    }
  }
  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}