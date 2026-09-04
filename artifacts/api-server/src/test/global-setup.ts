import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export default async function setup() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  await migrate(db, {
    migrationsFolder: path.resolve(currentDir, "../../../../lib/db/drizzle"),
  });

  // A rebased development database may already have a migration recorded at
  // the same historical timestamp. Keep the shared test schema complete even
  // when Drizzle correctly considers that timestamp applied.
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
}