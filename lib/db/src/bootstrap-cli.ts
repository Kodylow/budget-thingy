import pg from "pg";
import { bootstrapDatabase, BootstrapSafetyError } from "./bootstrap.js";

const mode = process.argv[2];
if (!["setup", "migrate", "seed"].includes(mode ?? "") || !process.env.DATABASE_URL) {
  console.error("Usage: bootstrap-cli.ts setup|migrate|seed; configure DATABASE_URL using workspace secrets.");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const result = await bootstrapDatabase(pool, {
      schema: process.env.DATABASE_SCHEMA,
      seed: mode === "setup",
      seedOnly: mode === "seed",
    });
    console.log(JSON.stringify({ status: "complete", ...result }));
    if (result.seed?.legacyBudgetRequiresReview) {
      console.warn("Legacy Growth Strategy & Operations allocation preserved: operator review required; setup never retires operator-owned data.");
    }
  } catch (error) {
    console.error(error instanceof BootstrapSafetyError ? error.message :
      "Database setup could not connect. Verify database availability and credentials through workspace secrets. No setup SQL was applied.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}