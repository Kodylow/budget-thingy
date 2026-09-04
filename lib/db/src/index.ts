import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseSchema = process.env.DATABASE_SCHEMA;
if (databaseSchema && !/^[a-z_][a-z0-9_]{0,62}$/.test(databaseSchema)) {
  throw new Error("DATABASE_SCHEMA must be a safe PostgreSQL identifier");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: databaseSchema
    ? `-c search_path=${databaseSchema},public`
    : undefined,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
