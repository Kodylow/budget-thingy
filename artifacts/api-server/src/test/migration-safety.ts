export interface TestMigration {
  idx: number;
  tag: string;
  sql: string;
  when?: number;
}

interface MigrationClient {
  query(statement: string): Promise<unknown>;
}

const HISTORICAL_PUBLIC_RESET = new Set([
  'DROP SCHEMA IF EXISTS "public" CASCADE;',
  'CREATE SCHEMA "public";',
]);

const AUTH_REPAIR_MIGRATION = "0005_repair_app_admin_authorization";

export function assertAuthRepairMigrationOrder(
  migrations: readonly TestMigration[],
): void {
  const repairIndex = migrations.findIndex(
    (migration) => migration.tag === AUTH_REPAIR_MIGRATION,
  );
  if (repairIndex < 0) {
    throw new Error(`Missing required migration ${AUTH_REPAIR_MIGRATION}`);
  }

  const seenTags = new Set<string>();
  for (const [position, migration] of migrations.entries()) {
    if (migration.idx !== position) {
      throw new Error(`Migration journal index drift at ${migration.tag}`);
    }
    if (seenTags.has(migration.tag)) {
      throw new Error(`Duplicate migration tag ${migration.tag}`);
    }
    seenTags.add(migration.tag);
  }

  const repair = migrations[repairIndex]!;
  const priorTimes = migrations
    .slice(0, repairIndex)
    .map((migration) => migration.when)
    .filter((when): when is number => typeof when === "number");
  if (
    typeof repair.when !== "number" ||
    (priorTimes.length > 0 && repair.when <= Math.max(...priorTimes))
  ) {
    throw new Error(
      `${AUTH_REPAIR_MIGRATION} must be newer than every prior migration`,
    );
  }

  const requiredSql = [
    /CREATE TABLE IF NOT EXISTS "app_admins"/,
    /ADD COLUMN IF NOT EXISTS "revoked_at"/,
    /ADD COLUMN IF NOT EXISTS "revoked_by"/,
    /CREATE UNIQUE INDEX IF NOT EXISTS "app_admins_bootstrap_email_unique"/,
  ];
  if (requiredSql.some((pattern) => !pattern.test(repair.sql))) {
    throw new Error(`${AUTH_REPAIR_MIGRATION} is missing idempotent auth repair SQL`);
  }
}

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