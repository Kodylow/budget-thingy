import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { applyTestMigrations, type TestMigration } from "./migration-safety";

const schemaPrefix = process.env.VITEST_DATABASE_SCHEMA_PREFIX;
const workerId = process.env.VITEST_POOL_ID;

if (!schemaPrefix || !workerId) {
  throw new Error(
    "API tests require the Vitest database global setup and worker identity",
  );
}

const schemaName = `${schemaPrefix}${workerId.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName)) {
  throw new Error(`Invalid generated test database schema: ${schemaName}`);
}

process.env.DATABASE_SCHEMA = schemaName;

const { db, pool } = await import("@workspace/db");
const bootstrapClient = await pool.connect();
await bootstrapClient.query("SELECT pg_advisory_lock(hashtext($1))", [schemaName]);
try {
  await bootstrapClient.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await bootstrapClient.query(`SET search_path TO "${schemaName}", public`);
  const ready = await bootstrapClient.query<{ table_name: string | null }>(
    "SELECT to_regclass($1) AS table_name",
    [`${schemaName}.__vitest_schema_ready`],
  );

  if (!ready.rows[0]?.table_name) {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(currentDir, "../../../../lib/db/drizzle");
    const journal = JSON.parse(
      await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const migrations: TestMigration[] = await Promise.all(
      journal.entries.map(async (migration) => ({
        ...migration,
        sql: await readFile(
          path.join(migrationsFolder, `${migration.tag}.sql`),
          "utf8",
        ),
      })),
    );
    await applyTestMigrations(bootstrapClient, migrations);

    // Keep every isolated schema complete when a rebased migration journal has
    // an older migration recorded at the same timestamp.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_budget_allocation_audits (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        team_name text NOT NULL,
        field text NOT NULL,
        old_value jsonb NOT NULL,
        new_value jsonb NOT NULL,
        actor_user_id text NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS team_budget_allocation_audits_team_created_idx
        ON team_budget_allocation_audits (team_name, created_at, id)
    `);

    const {
      applyAnnualTeamBudgetBackfill,
      applyTeamMappingAndLimitTargetSeed,
    } = await import("@workspace/db/seed-teams");
    await applyAnnualTeamBudgetBackfill();
    await applyTeamMappingAndLimitTargetSeed();
    await bootstrapClient.query(
      "CREATE TABLE __vitest_schema_ready (ready boolean PRIMARY KEY DEFAULT true)",
    );
  }
} finally {
  await bootstrapClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
    schemaName,
  ]);
  bootstrapClient.release();
}

afterAll(async () => {
  await pool.end();
});