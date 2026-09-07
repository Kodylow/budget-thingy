import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

test("additive intelligence migration preserves legacy rows and is replay-safe", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE api_project_metadata (
        workspace_id text NOT NULL, project_id text NOT NULL, title text,
        creator_id text, has_deployment boolean, fetched_at timestamptz NOT NULL,
        PRIMARY KEY (workspace_id, project_id)
      );
      INSERT INTO api_project_metadata VALUES
        ('sample-workspace', 'sample-project', 'Existing project', 'sample-owner', true, '2026-01-01');
    `);
    const migration = readFileSync(
      new URL("../../../../lib/db/drizzle/0012_richer_project_metadata.sql", import.meta.url),
      "utf8",
    );
    await database.exec(migration);
    await database.exec(migration);
    const result = await database.query(`
      SELECT title, creator_id, has_deployment, created_at, updated_at,
        deployments, deployments_observed_at FROM api_project_metadata
    `);
    expect(result.rows).toEqual([{
      title: "Existing project",
      creator_id: "sample-owner",
      has_deployment: true,
      created_at: null,
      updated_at: null,
      deployments: null,
      deployments_observed_at: null,
    }]);
  } finally {
    await database.close();
  }
});