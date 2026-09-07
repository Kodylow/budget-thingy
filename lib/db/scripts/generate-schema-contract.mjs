#!/usr/bin/env node
/**
 * Regenerates src/schema-contract.generated.ts from the immutable migrations.
 *
 * This script deliberately has no DATABASE_URL support.  It creates and destroys
 * its own PostgreSQL cluster under the OS temporary directory so generation can
 * never inspect or mutate a shared database.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const drizzle = join(root, "drizzle");
const output = join(root, "src", "schema-contract.generated.ts");
const postgresProgram = (name) => process.env.POSTGRES_BIN ? join(process.env.POSTGRES_BIN, name) : name;
const work = await mkdtemp(join(tmpdir(), "budget-schema-contract-"));
const data = join(work, "data");
const socket = join(work, "socket");

function run(program, args) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`${program} failed (${code}): ${stderr}`)));
  });
}

function statements(sql, idx) {
  return sql.split("--> statement-breakpoint").map((part) => part.trim()).filter((part) =>
    part && !(idx === 0 && [
      'DROP SCHEMA IF EXISTS "public" CASCADE;',
      'CREATE SCHEMA "public";',
    ].includes(part)),
  );
}

const normalize = (value, schema) => value == null ? null : value
  .replaceAll(`"${schema}".`, '"__schema__".')
  .replace(new RegExp(`\\b${schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`, "g"), "__schema__.");

async function snapshot(client, schema) {
  const result = { relations: {}, columns: {}, constraints: {}, indexes: {}, triggers: {}, functions: {} };
  for (const row of (await client.query(
    `SELECT c.relname AS name,c.relkind AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`, [schema],
  )).rows) result.relations[row.name] = row.kind;

  for (const row of (await client.query(
    `SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
            a.attnotnull AS not_null,a.attidentity AS identity,
            pg_get_expr(d.adbin,d.adrelid,true) AS default
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`, [schema],
  )).rows) {
    result.columns[`${row.table_name}.${row.name}`] =
      [row.type, row.not_null, row.identity, normalize(row.default, schema)];
  }

  for (const row of (await client.query(
    `SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,k.convalidated AS validated,
            pg_get_constraintdef(k.oid,true) AS definition
       FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND k.contype IN ('p','u','c','f')
      ORDER BY c.relname,k.conname`, [schema],
  )).rows) result.constraints[`${row.table_name}.${row.name}`] =
    [row.type, normalize(row.definition, schema), row.validated];

  for (const row of (await client.query(
    `SELECT t.relname AS table_name,i.relname AS name,x.indisvalid AS valid,
            pg_get_indexdef(i.oid,0,true) AS definition,
            pg_get_expr(x.indpred,x.indrelid,true) AS predicate
       FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
       JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 ORDER BY t.relname,i.relname`, [schema],
  )).rows) result.indexes[`${row.table_name}.${row.name}`] =
    [normalize(row.definition, schema), normalize(row.predicate, schema), row.valid];

  for (const row of (await client.query(
    `SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,
            pg_get_triggerdef(t.oid,true) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [schema],
  )).rows) result.triggers[`${row.table_name}.${row.name}`] =
    [normalize(row.definition, schema), row.enabled];

  for (const row of (await client.query(
    `SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_get_function_result(p.oid) AS result,l.lanname AS language,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 ORDER BY p.proname,arguments`, [schema],
  )).rows) result.functions[`${row.name}(${row.arguments})`] =
    [row.result, row.language, normalize(row.definition, schema)];
  return result;
}

function delta(before, after) {
  const set = {};
  const remove = {};
  for (const category of Object.keys(after)) {
    const changed = Object.fromEntries(Object.entries(after[category])
      .filter(([key, value]) => JSON.stringify(before[category][key]) !== JSON.stringify(value)));
    const deleted = Object.keys(before[category]).filter((key) => !(key in after[category]));
    if (Object.keys(changed).length) set[category] = changed;
    if (deleted.length) remove[category] = deleted;
  }
  return { set, remove };
}

let client;
try {
  await run(postgresProgram("initdb"), ["-D", data, "-U", "contract_generator", "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run("mkdir", ["-p", socket]);
  await run(postgresProgram("pg_ctl"), ["-D", data, "-o", `-k ${socket} -h ''`, "-w", "start"]);
  client = new pg.Client({ host: socket, database: "postgres", user: "contract_generator" });
  await client.connect();
  const serverMajor = Number((await client.query(
    "SELECT current_setting('server_version_num')::integer / 10000 AS major",
  )).rows[0]?.major);
  if (serverMajor !== 16) {
    throw new Error(`Schema contracts must be generated with PostgreSQL 16 (found ${serverMajor || "unknown"})`);
  }

  const journal = JSON.parse(await readFile(join(drizzle, "meta", "_journal.json"), "utf8"));
  const migrations = await Promise.all(journal.entries.map(async (entry) => {
    const sql = await readFile(join(drizzle, `${entry.tag}.sql`), "utf8");
    return { ...entry, sql, hash: createHash("sha256").update(sql).digest("hex") };
  }));
  const execute = async (migration) => {
    for (const statement of statements(migration.sql, migration.idx)) await client.query(statement);
  };
  const reset = async () => {
    await client.query('DROP SCHEMA IF EXISTS "contract" CASCADE');
    await client.query('CREATE SCHEMA "contract"');
    await client.query('SET search_path TO "contract"');
    await execute(migrations[0]);
  };

  await reset();
  const baseline = await snapshot(client, "contract");
  const deltas = {};
  for (const migration of migrations.slice(1)) {
    await reset();
    const before = await snapshot(client, "contract");
    await execute(migration);
    deltas[migration.idx] = delta(before, await snapshot(client, "contract"));
  }
  const manifest = {
    version: 1,
    postgresMajor: 16,
    migrations: migrations.map(({ idx, tag, when, hash }) => ({ idx, tag, when, hash })),
    baseline,
    deltas,
  };
  await writeFile(output,
    `// Generated by scripts/generate-schema-contract.mjs; do not edit.\n` +
    `export const schemaContract = ${JSON.stringify(manifest)} as const;\n`,
  );
  console.log(`Wrote ${output}`);
} finally {
  if (client) await client.end().catch(() => {});
  let running = false;
  try {
    await run(postgresProgram("pg_ctl"), ["-D", data, "status"]);
    running = true;
  } catch { /* No running postmaster to stop (including failed initialization). */ }
  // If stopping fails, preserve the directory instead of deleting live storage.
  if (running) await run(postgresProgram("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(work, { recursive: true, force: true });
}