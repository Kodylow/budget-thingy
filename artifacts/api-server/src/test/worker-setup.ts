import { afterAll } from "vitest";

const schemaPrefix = process.env.VITEST_DATABASE_SCHEMA_PREFIX;
const workerId = process.env.VITEST_POOL_ID;

if (!schemaPrefix || !workerId) {
  throw new Error(
    "API tests require the Vitest database global setup and worker identity",
  );
}

const schemaName = `${schemaPrefix}${workerId.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName)) {
  throw new Error(`Invalid generated test database schema: ${schemaName}`);
}

process.env.DATABASE_SCHEMA = schemaName;

const [{ bootstrapDatabase }, { pool }] = await Promise.all([
  import("@workspace/db/bootstrap"),
  import("@workspace/db"),
]);
await bootstrapDatabase(pool, { schema: schemaName, seed: true });

afterAll(async () => {
  await pool.end();
});