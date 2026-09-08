#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pg, { type Pool, type PoolClient } from "pg";
import {
  prepareMigrationStatements,
  readMigrations,
  validateJournal,
  type Migration,
} from "../src/bootstrap.js";
import {
  validateSchemaContract,
  validateSchemaContractSnapshot,
} from "../src/schema-contract.js";

const OLD_FUNDING = {
  idx: 13,
  tag: "0013_funding_group_overrides",
  when: 1788600009000,
  hash: "4dee833198431513b0871350c2c0517cde9fd274c783b8dbf7e2520862f929d5",
} as const;
const NEW_HISTORICAL = {
  idx: 13,
  tag: "0013_historical_project_creator_evidence",
  when: 1788600009000,
} as const;
const NEW_FUNDING = {
  idx: 14,
  tag: "0014_funding_group_overrides",
  when: 1788600010000,
} as const;
const identifier = (name: string) => `"${name}"`;

class ReconciliationError extends Error {}
const refuse = (reason: string): never => {
  throw new ReconciliationError(`Task 31 migration-history reconciliation refused: ${reason}. No reconciliation changes were committed.`);
};

function run(program: string, args: string[], env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() :
      reject(new ReconciliationError(`${program} failed with exit code ${code}${stderr ? "; inspect database operator diagnostics" : ""}`)));
  });
}

function assertIdentity(migration: Migration | undefined, expected: {
  idx: number; tag: string; when: number; hash?: string;
}) {
  if (!migration || migration.idx !== expected.idx || migration.tag !== expected.tag ||
    migration.when !== expected.when || (expected.hash && migration.hash !== expected.hash)) {
    refuse(`checked-in migration ${expected.tag} is not the reviewed source`);
  }
}

function sources(current: Migration[]) {
  const historical = current[13];
  const funding = current[14];
  assertIdentity(historical, NEW_HISTORICAL);
  assertIdentity(funding, { ...NEW_FUNDING, hash: OLD_FUNDING.hash });
  const oldFunding: Migration = {
    ...funding!,
    idx: OLD_FUNDING.idx,
    tag: OLD_FUNDING.tag,
    when: OLD_FUNDING.when,
  };
  return {
    historical: historical!,
    funding: funding!,
    old: [...current.slice(0, 13), oldFunding],
    oldEquivalent: [...current.slice(0, 13), funding!],
  };
}

async function lock(client: PoolClient, schema: string) {
  await client.query("SET LOCAL lock_timeout = '60s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(1788600000, hashtext($1))", [schema]);
  await client.query(`SET LOCAL search_path TO ${identifier(schema)}`);
}

async function verifyOldState(
  client: PoolClient,
  schema: string,
  journalSchema: string,
  old: Migration[],
  oldEquivalent: Migration[],
) {
  const recorded = await validateJournal(client, schema, journalSchema, old);
  if (recorded.length !== old.length) refuse("journal is not the complete reviewed pre-merge history");
  await validateSchemaContractSnapshot(client, schema, oldEquivalent);
  const funding = await client.query<{ id: number }>(
    `SELECT id FROM ${identifier(journalSchema)}.__drizzle_migrations
      WHERE hash=$1 AND created_at=$2`, [OLD_FUNDING.hash, OLD_FUNDING.when],
  );
  if (funding.rowCount !== 1) refuse("reviewed funding journal row is absent or duplicated");
  const maximum = await client.query<{ id: number }>(
    `SELECT max(id)::integer AS id FROM ${identifier(journalSchema)}.__drizzle_migrations`,
  );
  if (funding.rows[0]!.id !== maximum.rows[0]!.id) {
    refuse("reviewed funding journal row is not the final physical history entry");
  }
  const incomingObjects = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.%I',$1,$2)) IS NOT NULL AS present`,
    [schema, "api_project_creator_evidence"],
  );
  if (incomingObjects.rows[0]?.present) {
    refuse("incoming historical-evidence schema is already present without its journal entry");
  }
  return funding.rows[0]!.id;
}

async function reconcile(pool: Pool, current: Migration[], schema = "public") {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_") ||
    schema === "information_schema" || schema === "drizzle") refuse("invalid target schema");
  const journalSchema = schema === "public" ? "drizzle" : schema;
  const { historical, old, oldEquivalent } = sources(current);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lock(client, schema);
    const oldFundingId = await verifyOldState(client, schema, journalSchema, old, oldEquivalent);
    for (const statement of prepareMigrationStatements([historical])) await client.query(statement);

    const moved = await client.query<{ id: number }>(
      `UPDATE ${identifier(journalSchema)}.__drizzle_migrations
          SET id=nextval(pg_get_serial_sequence($1,'id')), created_at=$2
        WHERE id=$3 AND hash=$4 AND created_at=$5 RETURNING id`,
      [`${journalSchema}.__drizzle_migrations`, NEW_FUNDING.when, oldFundingId,
        OLD_FUNDING.hash, OLD_FUNDING.when],
    );
    if (moved.rowCount !== 1 || moved.rows[0]!.id <= oldFundingId) {
      refuse("funding journal row could not be moved without replacement");
    }
    await client.query(
      `INSERT INTO ${identifier(journalSchema)}.__drizzle_migrations (id,hash,created_at)
       VALUES ($1,$2,$3)`,
      [oldFundingId, historical.hash, historical.when],
    );
    const recorded = await validateJournal(client, schema, journalSchema, current);
    if (recorded.length !== current.length) refuse("reconciled journal is incomplete");
    await validateSchemaContract(client, schema, recorded);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createOldFixture(pool: Pool, current: Migration[]) {
  const { old } = sources(current);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('SET LOCAL search_path TO "public"');
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(`CREATE TABLE "drizzle".__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
    for (const migration of old) {
      for (const statement of prepareMigrationStatements([migration])) await client.query(statement);
      await client.query(
        'INSERT INTO "drizzle".__drizzle_migrations (hash,created_at) VALUES ($1,$2)',
        [migration.hash, migration.when],
      );
    }
    await client.query(
      `INSERT INTO funding_group_overrides (workspace_id,group_id,team_name)
       VALUES ('rehearsal-workspace','rehearsal-group','Rehearsal Team')`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rehearse(current: Migration[]) {
  const work = await mkdtemp(join(tmpdir(), "task31-rehearsal-"));
  const data = join(work, "data");
  const socket = join(work, "socket");
  const bin = (name: string) => process.env.POSTGRES_BIN ? join(process.env.POSTGRES_BIN, name) : name;
  let started = false;
  try {
    await run(bin("initdb"), ["-D", data, "-U", "task31_rehearsal", "--no-locale", "--encoding=UTF8", "--auth=trust"]);
    await mkdir(socket);
    await run(bin("pg_ctl"), ["-D", data, "-o", `-k ${socket} -h ''`, "-w", "start"]);
    started = true;
    const pool = new pg.Pool({ host: socket, database: "postgres", user: "task31_rehearsal", max: 1 });
    try {
      await createOldFixture(pool, current);
      await reconcile(pool, current);
      const canary = await pool.query(
        `SELECT count(*)::integer AS count FROM funding_group_overrides
          WHERE workspace_id='rehearsal-workspace' AND group_id='rehearsal-group'
            AND team_name='Rehearsal Team'`,
      );
      if (canary.rows[0]?.count !== 1) refuse("disposable rehearsal did not preserve its application-data canary");
    } finally {
      await pool.end();
    }
  } finally {
    if (started) await run(bin("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

async function backupDevelopmentDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "task31-development-backup-"));
  await chmod(directory, 0o700);
  const file = join(directory, "before-reconciliation.dump");
  try {
    // pg_dump reads the runtime-managed PG* variables. No credential is placed
    // in argv, output, or the repository.
    await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`]);
    await chmod(file, 0o600);
    if ((await stat(file)).size === 0) refuse("development backup is empty");
    await run("pg_restore", ["--list", file]);
    return file;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const execute = process.argv.slice(2);
if (execute.length !== 1 || execute[0] !== "--execute-development") {
  console.error("Usage: reconcile-task31-migration-history.ts --execute-development");
  process.exitCode = 1;
} else if (!process.env.DATABASE_URL) {
  console.error("Configure the development DATABASE_URL through workspace secrets.");
  process.exitCode = 1;
} else if (process.env.REPLIT_DEPLOYMENT) {
  console.error("Refusing to run migration-history reconciliation in a deployment.");
  process.exitCode = 1;
} else {
  const current = await readMigrations();
  if (createHash("sha256").update(current[14]!.sql).digest("hex") !== OLD_FUNDING.hash) {
    refuse("renamed funding SQL is not byte-for-byte identical to the applied source");
  }
  await rehearse(current);
  const target = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
  let backup: string | undefined;
  try {
    const client = await target.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await lock(client, process.env.DATABASE_SCHEMA ?? "public");
      const { old, oldEquivalent } = sources(current);
      await verifyOldState(
        client,
        process.env.DATABASE_SCHEMA ?? "public",
        (process.env.DATABASE_SCHEMA ?? "public") === "public" ? "drizzle" : process.env.DATABASE_SCHEMA!,
        old,
        oldEquivalent,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    backup = await backupDevelopmentDatabase();
    await reconcile(target, current, process.env.DATABASE_SCHEMA);
    console.log(JSON.stringify({
      status: "reconciled",
      rehearsal: "passed",
      backupVerified: true,
      backup,
      existingApplicationDataPreserved: true,
    }));
  } finally {
    await target.end();
  }
}