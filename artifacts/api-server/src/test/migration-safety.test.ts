import { describe, expect, it, vi } from "vitest";
import {
  applyTestMigrations,
  prepareTestMigrationStatements,
} from "./migration-safety";

describe("test migration safety", () => {
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