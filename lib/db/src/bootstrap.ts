import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import * as tables from "./schema/index.js";
import { SchemaContractError, validateSchemaContract } from "./schema-contract.js";
import { seedCanonicalRows } from "./seed-teams.js";

export interface MigrationSource {
  idx: number;
  tag: string;
  sql: string;
}
interface Migration extends MigrationSource {
  when: number;
  hash: string;
}

export class BootstrapSafetyError extends Error {}
const recovery = " No changes were committed. Verify the selected database/schema and restore its matching Drizzle journal from a verified backup. For an imported database, reconcile schema and history in a disposable copy with an operator before retrying. Never reset the journal or drop a schema to bypass this check.";
function refuse(reason: string): never {
  throw new BootstrapSafetyError(`Database setup refused: ${reason}.${recovery}`);
}

/**
 * The historical SQL and hash remain immutable. The supported runner never
 * executes its obsolete public reset, even for an empty database. This same
 * policy is used in production and isolated tests; search_path alone is unsafe.
 */
export function prepareMigrationStatements(migrations: readonly MigrationSource[]): string[] {
  return migrations.flatMap((migration) =>
    migration.sql.split("--> statement-breakpoint").map((s) => s.trim()).filter((statement) => {
      if (!statement) return false;
      if (migration.idx === 0 && migration.tag === "0000_wise_rockslide" &&
        ['DROP SCHEMA IF EXISTS "public" CASCADE;', 'CREATE SCHEMA "public";'].includes(statement)) {
        return false;
      }
      if (/\bpublic\b/i.test(statement) || /\b(?:DROP|CREATE|ALTER)\s+SCHEMA\b/i.test(statement) ||
        /\b(?:SET\s+(?:LOCAL\s+)?search_path|set_config\s*\()/i.test(statement)) {
        refuse(`unsafe schema-qualified SQL in ${migration.tag}`);
      }
      return true;
    }),
  );
}

export async function readMigrations(): Promise<Migration[]> {
  const folder = new URL("../drizzle/", import.meta.url);
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", folder), "utf8")) as {
    dialect: string; entries: { idx: number; tag: string; when: number }[];
  };
  if (journal.dialect !== "postgresql" || !journal.entries?.length) refuse("invalid local migration manifest");
  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const [position, entry] of journal.entries.entries()) {
    if (entry.idx !== position || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      !Number.isSafeInteger(entry.when) || seen.has(entry.tag)) refuse("invalid local migration identity");
    if (position >= 5 && entry.when <= Math.max(...migrations.map((m) => m.when))) {
      refuse("forward migrations must be newer than every historical migration");
    }
    seen.add(entry.tag);
    const sql = await readFile(new URL(`${entry.tag}.sql`, folder), "utf8");
    migrations.push({ ...entry, sql, hash: createHash("sha256").update(sql).digest("hex") });
  }
  prepareMigrationStatements(migrations);
  return migrations;
}

const identifier = (name: string) => `"${name}"`;

async function validateJournal(
  client: PoolClient, schema: string, journalSchema: string, migrations: Migration[],
): Promise<Migration[]> {
  const relation = await client.query<{ relkind: string }>(
    `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname='__drizzle_migrations'`, [journalSchema],
  );
  let recorded: { hash: string; created_at: string }[] = [];
  if (relation.rowCount) {
    if (relation.rows[0]!.relkind !== "r") refuse("migration journal is not an ordinary table");
    const columns = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='__drizzle_migrations'`, [journalSchema],
    );
    for (const [name, type] of [["id", "integer"], ["hash", "text"], ["created_at", "bigint"]]) {
      if (!columns.rows.some((c) => c.column_name === name && c.data_type === type)) {
        refuse("migration journal has an incompatible shape");
      }
    }
    recorded = (await client.query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at FROM ${identifier(journalSchema)}.__drizzle_migrations ORDER BY id`,
    )).rows;
  }
  if (!recorded.length) {
    // Inspect catalog objects, not just table rows: an empty sentinel table,
    // view, sequence, function or user-defined type is still populated storage.
    const occupied = await client.query<{ occupied: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND NOT ($1=$2 AND c.relname IN
            ('__drizzle_migrations','__drizzle_migrations_id_seq','__drizzle_migrations_pkey'))
        UNION ALL
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
        UNION ALL
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname=$1 AND t.typrelid=0 AND t.typelem=0
      ) AS occupied`, [schema, journalSchema],
    );
    if (occupied.rows[0]?.occupied) refuse("target schema is populated but has no usable migration journal");
    return [];
  }
  const applied: Migration[] = [];
  let previousIndex = -1;
  let highWater = -Infinity;
  for (const row of recorded) {
    const match = migrations.find((m) => m.hash === row.hash && String(m.when) === String(row.created_at));
    if (!match || match.idx <= previousIndex) refuse("migration journal contains unknown, changed, duplicated or out-of-order history");
    // Drizzle may skip older timestamps after a rebased baseline. It cannot
    // legitimately skip a newer migration and then record one after it.
    if (migrations.slice(previousIndex + 1, match.idx).some((m) => m.when > highWater)) {
      refuse("migration journal omits required recorded history");
    }
    // Only a contiguous old prefix may precede the known clock skip to 0005.
    // A history such as 0000,0002 is not a supported Drizzle upgrade path.
    if (match.idx > previousIndex + 1 && !(match.idx === 5 && previousIndex >= 0 && previousIndex <= 3)) {
      refuse("migration journal contains an unsupported partial legacy history");
    }
    applied.push(match);
    previousIndex = match.idx;
    highWater = Math.max(highWater, match.when);
  }
  return applied;
}

export interface BootstrapOptions {
  schema?: string;
  seed?: boolean;
  seedOnly?: boolean;
}

/** The advisory lock, preflight, migrations, journal writes and seed share one transaction/client. */
export async function bootstrapDatabase(pool: Pool, options: BootstrapOptions = {}) {
  const started = performance.now();
  const schema = options.schema ?? "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_") || schema === "information_schema" || schema === "drizzle") {
    refuse("invalid target schema");
  }
  const journalSchema = schema === "public" ? "drizzle" : schema;
  const migrations = await readMigrations();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '60s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(1788600000, hashtext($1))", [schema]);
    await client.query(`SET LOCAL search_path TO ${identifier(schema)}`);
    const recorded = await validateJournal(client, schema, journalSchema, migrations);
    await validateSchemaContract(client, schema, recorded);
    // Match the historical Drizzle high-water rule, rather than renumbering or
    // backdating history. New forward repairs cover skipped additive entries.
    const lastWhen = Math.max(-Infinity, ...recorded.map((m) => m.when));
    const pending = migrations.filter((m) => m.when > lastWhen);
    if (options.seedOnly && (!recorded.length || pending.length)) {
      refuse("seed requires a fully migrated database; run the explicit setup command first");
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(schema)}`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(journalSchema)}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${identifier(journalSchema)}.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
    for (const migration of pending) {
      for (const statement of prepareMigrationStatements([migration])) await client.query(statement);
      await client.query(`INSERT INTO ${identifier(journalSchema)}.__drizzle_migrations (hash,created_at) VALUES ($1,$2)`, [migration.hash, migration.when]);
    }
    await validateSchemaContract(client, schema, [...recorded, ...pending]);
    const seed = options.seed || options.seedOnly
      ? await seedCanonicalRows(drizzle(client, { schema: tables }))
      : undefined;
    await client.query("COMMIT");
    return { applied: pending.map((m) => m.tag), seed, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof BootstrapSafetyError) throw error;
    if (error instanceof SchemaContractError) throw new BootstrapSafetyError(error.message);
    // PostgreSQL errors can include values/connection details. Keep diagnostics
    // static at the supported boundary, including connection failures in CLI.
    throw new BootstrapSafetyError(`Database setup failed and was rolled back. Check database permissions, schema compatibility, and migration SQL in a disposable copy.${recovery}`);
  } finally {
    client.release();
  }
}