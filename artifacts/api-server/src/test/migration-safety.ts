export interface TestMigration {
  idx: number;
  tag: string;
  sql: string;
}

interface MigrationClient {
  query(statement: string): Promise<unknown>;
}

const HISTORICAL_PUBLIC_RESET = new Set([
  'DROP SCHEMA IF EXISTS "public" CASCADE;',
  'CREATE SCHEMA "public";',
]);

export function prepareTestMigrationStatements(
  migrations: readonly TestMigration[],
): string[] {
  const statements: string[] = [];

  for (const migration of migrations) {
    for (const rawStatement of migration.sql.split("--> statement-breakpoint")) {
      const statement = rawStatement.trim();
      if (!statement) continue;
      if (migration.idx === 0 && HISTORICAL_PUBLIC_RESET.has(statement)) {
        continue;
      }
      if (/\bpublic\b/i.test(statement)) {
        throw new Error(
          `Refusing to run public-schema SQL from test migration ${migration.tag}`,
        );
      }
      statements.push(statement);
    }
  }

  return statements;
}

export async function applyTestMigrations(
  client: MigrationClient,
  migrations: readonly TestMigration[],
): Promise<void> {
  const statements = prepareTestMigrationStatements(migrations);
  for (const statement of statements) {
    await client.query(statement);
  }
}