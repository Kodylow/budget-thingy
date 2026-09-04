import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import {
  applyTestMigrations,
  assertAuthRepairMigrationOrder,
  prepareTestMigrationStatements,
  type TestMigration,
} from "./migration-safety";

describe("test migration safety", () => {
  const createdSchemas: string[] = [];

  afterAll(async () => {
    const client = await pool.connect();
    try {
      for (const schema of createdSchemas) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      client.release();
    }
  });

  async function applyAuthRepairToScenario(
    scenario: "missing" | "legacy",
  ): Promise<{ columns: string[]; indexes: string[] }> {
    const baseSchema = process.env.DATABASE_SCHEMA;
    if (!baseSchema || !/^[a-z_][a-z0-9_]{0,50}$/.test(baseSchema)) {
      throw new Error("Expected a safe isolated test database schema");
    }
    const schema = `${baseSchema}_${scenario}`;
    createdSchemas.push(schema);
    const repairSql = readFileSync(
      new URL(
        "../../../../lib/db/drizzle/0005_repair_app_admin_authorization.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      if (scenario === "legacy") {
        await client.query(`
          CREATE TABLE app_admins (
            user_id varchar PRIMARY KEY NOT NULL,
            email varchar NOT NULL,
            created_by varchar,
            created_at timestamp with time zone DEFAULT now() NOT NULL
          )
        `);
      }
      await applyTestMigrations(client, [{
        idx: 5,
        tag: "0005_repair_app_admin_authorization",
        sql: repairSql,
      }]);
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = 'app_admins'
          ORDER BY column_name`,
        [schema],
      );
      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = $1
            AND tablename = 'app_admins'
          ORDER BY indexname`,
        [schema],
      );
      return {
        columns: columns.rows.map((row) => row.column_name),
        indexes: indexes.rows.map((row) => row.indexname),
      };
    } finally {
      await client.query(`SET search_path TO "${baseSchema}", public`);
      client.release();
    }
  }

  it("keeps the production auth repair newer than the rebased baseline", () => {
    const migrationsRoot = new URL("../../../../lib/db/drizzle/", import.meta.url);
    const journal = JSON.parse(
      readFileSync(new URL("meta/_journal.json", migrationsRoot), "utf8"),
    ) as { entries: Array<Omit<TestMigration, "sql">> };
    const migrations = journal.entries.map((entry) => ({
      ...entry,
      sql: readFileSync(new URL(`${entry.tag}.sql`, migrationsRoot), "utf8"),
    }));

    expect(() => assertAuthRepairMigrationOrder(migrations)).not.toThrow();
  });

  it("detects an auth repair that would be skipped by the migration clock", () => {
    expect(() => assertAuthRepairMigrationOrder([
      { idx: 0, tag: "0000_baseline", when: 20, sql: "SELECT 1" },
      {
        idx: 1,
        tag: "0005_repair_app_admin_authorization",
        when: 10,
        sql: `
          CREATE TABLE IF NOT EXISTS "app_admins" (
            "user_id" varchar PRIMARY KEY,
            "email" varchar NOT NULL,
            "created_by" varchar
          );
          ALTER TABLE "app_admins" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;
          ALTER TABLE "app_admins" ADD COLUMN IF NOT EXISTS "revoked_by" varchar;
          CREATE UNIQUE INDEX IF NOT EXISTS "app_admins_bootstrap_email_unique"
            ON "app_admins" ("email");
        `,
      },
    ])).toThrow("must be newer than every prior migration");
  });

  it.each(["missing", "legacy"] as const)(
    "applies the auth repair to an %s app-admin table",
    async (scenario) => {
      const result = await applyAuthRepairToScenario(scenario);
      expect(result.columns).toEqual([
        "created_at",
        "created_by",
        "email",
        "revoked_at",
        "revoked_by",
        "user_id",
      ]);
      expect(result.indexes).toContain("app_admins_bootstrap_email_unique");
      expect(result.indexes).toContain("app_admins_pkey");
    },
  );

  it("skips only the known historical public reset", () => {
    expect(prepareTestMigrationStatements([{
      idx: 0,
      tag: "0000_baseline",
      sql: `
        DROP SCHEMA IF EXISTS "public" CASCADE;
        --> statement-breakpoint
        CREATE SCHEMA "public";
        --> statement-breakpoint
        CREATE TABLE "safe_table" ("id" integer);
      `,
    }])).toEqual(['CREATE TABLE "safe_table" ("id" integer);']);
  });

  it.each([
    'CREATE TABLE public.danger ("id" integer);',
    'ALTER TABLE "public"."danger" ADD COLUMN value text;',
    'DROP TABLE IF EXISTS public.danger;',
    'TRUNCATE TABLE public.danger;',
    'ALTER TABLE danger SET SCHEMA public;',
  ])("rejects public-schema SQL before executing any statement: %s", async (dangerousSql) => {
    const query = vi.fn(async () => undefined);
    await expect(applyTestMigrations({ query }, [{
      idx: 2,
      tag: "0002_future",
      sql: `
        CREATE TABLE "would_run_first" ("id" integer);
        --> statement-breakpoint
        ${dangerousSql}
      `,
    }])).rejects.toThrow("Refusing to run public-schema SQL");
    expect(query).not.toHaveBeenCalled();
  });
});