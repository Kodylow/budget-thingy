import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { schemaContract } from "./schema-contract.generated.js";

export interface AppliedSchemaMigration {
  idx: number;
  tag: string;
  hash: string;
  when: number;
}

type ContractValue = string | boolean | null | readonly ContractValue[];
type ContractCategory = Record<string, ContractValue>;
type ContractShape = Record<string, ContractCategory>;
type ContractDelta = {
  set?: ContractShape;
  remove?: Record<string, readonly string[]>;
};

const mismatchPrefix = "Database setup refused: recorded migration history is not compatible with the target schema";
const recovery = " No changes were committed. Restore the matching schema from a verified backup or reconcile it in a disposable database before retrying.";

/** Contains only fixed text and checked-in catalog identifiers, never database values. */
export class SchemaContractError extends Error {}

function mismatch(kind: string, name: string): never {
  throw new SchemaContractError(`${mismatchPrefix} (${kind}: ${name}).${recovery}`);
}

function staleManifest(): never {
  throw new SchemaContractError(
    "Database setup refused: the checked-in schema contract is missing or stale. Run node lib/db/scripts/generate-schema-contract.mjs, review and commit the generated contract, then retry. No database changes were committed.",
  );
}

function normalize(value: string | null, schema: string): string | null {
  if (value === null) return null;
  const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replaceAll(`"${schema}".`, '"__schema__".')
    .replace(new RegExp(`\\b${escaped}\\.`, "g"), "__schema__.");
}

async function verifyGeneratedManifest() {
  const folder = new URL("../drizzle/", import.meta.url);
  let journal: { dialect?: string; entries?: { idx: number; tag: string; when: number }[] };
  try {
    journal = JSON.parse(await readFile(new URL("meta/_journal.json", folder), "utf8")) as typeof journal;
  } catch {
    staleManifest();
  }
  if (journal.dialect !== "postgresql" || !journal.entries ||
    journal.entries.length !== schemaContract.migrations.length) staleManifest();
  for (let position = 0; position < journal.entries.length; position++) {
    const local = journal.entries[position]!;
    const generated = schemaContract.migrations[position];
    if (!generated || local.idx !== generated.idx || local.tag !== generated.tag || local.when !== generated.when) {
      staleManifest();
    }
    let sql: string;
    try {
      sql = await readFile(new URL(`${local.tag}.sql`, folder), "utf8");
    } catch {
      staleManifest();
    }
    if (createHash("sha256").update(sql).digest("hex") !== generated.hash) staleManifest();
  }
}

function validateHistory(applied: readonly AppliedSchemaMigration[]) {
  if (!applied.length) return;
  let nextLegacy = 0;
  let forwardStarted = false;
  let nextForward = 5;
  for (const migration of applied) {
    const generated = schemaContract.migrations[migration.idx];
    if (!generated || migration.idx !== generated.idx || migration.tag !== generated.tag ||
      migration.hash !== generated.hash || migration.when !== generated.when) staleManifest();
    if (!forwardStarted && migration.idx === nextLegacy && migration.idx <= 4) {
      nextLegacy++;
      continue;
    }
    if (!forwardStarted && migration.idx === 5 && nextLegacy > 0) forwardStarted = true;
    if (!forwardStarted || migration.idx !== nextForward) mismatch("migration history", "order");
    nextForward++;
  }
}

function expectedShape(applied: readonly AppliedSchemaMigration[]): ContractShape {
  const expected = structuredClone(schemaContract.baseline) as unknown as ContractShape;
  for (const migration of applied) {
    if (migration.idx === 0) continue;
    const delta = (schemaContract.deltas as unknown as Record<string, ContractDelta>)[migration.idx];
    if (!delta) staleManifest();
    for (const [category, entries] of Object.entries(delta.set ?? {})) {
      Object.assign(expected[category] ??= {}, entries);
    }
    for (const [category, keys] of Object.entries(delta.remove ?? {})) {
      for (const key of keys) delete expected[category]?.[key];
    }
  }
  return expected;
}

async function actualShape(client: PoolClient, schema: string): Promise<ContractShape> {
  const actual: ContractShape = {
    relations: {}, columns: {}, constraints: {}, indexes: {}, triggers: {}, functions: {},
  };
  for (const row of (await client.query<{ name: string; kind: string }>(
    `SELECT c.relname AS name,c.relkind AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1`, [schema],
  )).rows) actual.relations[row.name] = row.kind;

  for (const row of (await client.query<{
    table_name: string; name: string; type: string; not_null: boolean; identity: string; default: string | null;
  }>(
    `SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
            a.attnotnull AS not_null,a.attidentity AS identity,
            pg_get_expr(d.adbin,d.adrelid,true) AS default
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`, [schema],
  )).rows) actual.columns[`${row.table_name}.${row.name}`] =
    [row.type, row.not_null, row.identity, normalize(row.default, schema)];

  for (const row of (await client.query<{
    table_name: string; name: string; type: string; definition: string; validated: boolean;
  }>(
    `SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,k.convalidated AS validated,
            pg_get_constraintdef(k.oid,true) AS definition
       FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND k.contype IN ('p','u','c','f')`, [schema],
  )).rows) actual.constraints[`${row.table_name}.${row.name}`] =
    [row.type, normalize(row.definition, schema), row.validated];

  for (const row of (await client.query<{
    table_name: string; name: string; valid: boolean; definition: string; predicate: string | null;
  }>(
    `SELECT t.relname AS table_name,i.relname AS name,x.indisvalid AS valid,
            pg_get_indexdef(i.oid,0,true) AS definition,
            pg_get_expr(x.indpred,x.indrelid,true) AS predicate
       FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
       JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1`, [schema],
  )).rows) actual.indexes[`${row.table_name}.${row.name}`] =
    [normalize(row.definition, schema), normalize(row.predicate, schema), row.valid];

  for (const row of (await client.query<{
    table_name: string; name: string; definition: string; enabled: string;
  }>(
    `SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,
            pg_get_triggerdef(t.oid,true) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal`, [schema],
  )).rows) actual.triggers[`${row.table_name}.${row.name}`] =
    [normalize(row.definition, schema), row.enabled];

  for (const row of (await client.query<{
    name: string; arguments: string; result: string; language: string; definition: string;
  }>(
    `SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_get_function_result(p.oid) AS result,l.lanname AS language,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1`, [schema],
  )).rows) actual.functions[`${row.name}(${row.arguments})`] =
    [row.result, row.language, normalize(row.definition, schema)];
  return actual;
}

function belongsToTable(key: string, table: string) {
  return key === table || key.startsWith(`${table}.`);
}

/**
 * Read-only compatibility check for a journaled schema. Extra untracked objects
 * are intentionally tolerated; every object promised by recorded migrations is
 * required to retain its generated PostgreSQL 16 catalog definition.
 */
export async function validateSchemaContract(
  client: PoolClient,
  schema: string,
  applied: AppliedSchemaMigration[],
): Promise<void> {
  await verifyGeneratedManifest();
  validateHistory(applied);
  const version = await client.query<{ major: number }>(
    "SELECT current_setting('server_version_num')::integer / 10000 AS major",
  );
  if (version.rows[0]?.major !== schemaContract.postgresMajor) mismatch("PostgreSQL version", "major");
  if (!applied.length) return;
  const expected = expectedShape(applied);
  const actual = await actualShape(client, schema);
  const hasRepair5 = applied.some((migration) => migration.idx >= 5);
  const hasRepair9 = applied.some((migration) => migration.idx >= 9);
  const optionalMissing = new Set<string>();
  const optionalMissingObjects = new Set<string>();
  if (!hasRepair5 && actual.relations.app_admins === undefined) optionalMissing.add("app_admins");
  if (!hasRepair9 && actual.relations.team_budget_allocation_audits === undefined) {
    optionalMissing.add("team_budget_allocation_audits");
  }
  if (!hasRepair9 &&
    actual.indexes["team_budget_allocation_audits.team_budget_allocation_audits_team_created_idx"] === undefined) {
    optionalMissingObjects.add("team_budget_allocation_audits.team_budget_allocation_audits_team_created_idx");
  }
  for (const [category, entries] of Object.entries(expected)) {
    for (const [name, value] of Object.entries(entries)) {
      if ([...optionalMissing].some((table) => belongsToTable(name, table))) continue;
      if (optionalMissingObjects.has(name)) continue;
      if (JSON.stringify(actual[category]?.[name]) !== JSON.stringify(value)) mismatch(category, name);
    }
  }
}