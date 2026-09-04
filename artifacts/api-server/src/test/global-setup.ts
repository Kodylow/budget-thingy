import { randomUUID } from "node:crypto";

export default async function setup() {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const schemaPrefix = `vitest_${runId}_`;
  process.env.VITEST_DATABASE_SCHEMA_PREFIX = schemaPrefix;

  return async () => {
    const { pool } = await import("@workspace/db");
    try {
      const result = await pool.query<{ nspname: string }>(
        `SELECT nspname
           FROM pg_namespace
          WHERE left(nspname, length($1)) = $1`,
        [schemaPrefix],
      );
      for (const { nspname } of result.rows) {
        if (!nspname.startsWith(schemaPrefix)) {
          throw new Error(`Refusing to drop unexpected test schema: ${nspname}`);
        }
        await pool.query(`DROP SCHEMA ${quoteIdentifier(nspname)} CASCADE`);
      }
    } finally {
      await pool.end();
    }
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
