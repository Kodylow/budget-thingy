import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

test("creator evidence migration is replay-safe and retains conflicting observations", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE api_project_metadata (
        workspace_id text NOT NULL,
        project_id text NOT NULL,
        creator_id text,
        fetched_at timestamptz NOT NULL,
        PRIMARY KEY (workspace_id, project_id)
      );
      INSERT INTO api_project_metadata VALUES
        ('existing-workspace', 'existing-project', 'existing-owner', '2026-07-01');
    `);
    const migration = readFileSync(
      new URL(
        "../../../../lib/db/drizzle/0013_historical_project_creator_evidence.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await database.exec(migration);
    await database.exec(migration);
    await database.exec(`
      INSERT INTO api_project_creator_evidence
        (workspace_id, project_id, creator_id, first_observed_at, last_observed_at)
      VALUES
        ('source', 'moved', 'old-owner', '2026-08-01', '2026-08-01'),
        ('destination', 'moved', 'new-owner', '2026-09-01', '2026-09-01'),
        ('source', 'changed', 'old-owner', '2026-08-01', '2026-08-01'),
        ('source', 'changed', 'new-owner', '2026-09-01', '2026-09-01');
    `);
    const result = await database.query(`
      SELECT workspace_id, project_id, creator_id, provenance
      FROM api_project_creator_evidence
      ORDER BY workspace_id, project_id, creator_id
    `);
    expect(result.rows).toHaveLength(5);
    expect(result.rows).toContainEqual({
      workspace_id: "existing-workspace",
      project_id: "existing-project",
      creator_id: "existing-owner",
      provenance: "current_catalog_observation",
    });
    expect(result.rows).toContainEqual({
      workspace_id: "source",
      project_id: "moved",
      creator_id: "old-owner",
      provenance: "current_catalog_observation",
    });
    expect(result.rows).toContainEqual({
      workspace_id: "destination",
      project_id: "moved",
      creator_id: "new-owner",
      provenance: "current_catalog_observation",
    });
  } finally {
    await database.close();
  }
}, 30_000);