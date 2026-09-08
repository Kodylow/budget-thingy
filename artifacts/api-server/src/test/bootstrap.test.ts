import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const databases = new Set<string>();

interface CliResult {
  stdout: string;
  stderr: string;
}

function cliMetrics(result: CliResult): {
  applied: string[];
  durationMs: number;
} {
  const line = result.stdout.split("\n").find((output) =>
    output.trimStart().startsWith('{"status":"complete"')
  );
  if (!line) throw new Error("Database CLI did not emit completion metrics");
  return JSON.parse(line) as { applied: string[]; durationMs: number };
}

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  release(): void;
}

interface DatabasePool {
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
}

async function snapshotNonSeedData(client: DatabaseClient) {
  return (await client.query(`
    SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM team_budget_allocation_audits t) AS audits,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM team_budget_adjustments t) AS adjustments,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY usage_date) FROM usage_account_day t) AS usage,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY sid) FROM sessions t) AS sessions
  `)).rows;
}

interface MigrationFixture {
  idx: number;
  tag: string;
  when: number;
  sql: string;
  hash: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrl(database: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

async function createDatabase(): Promise<{ name: string; url: string }> {
  const name = `bootstrap_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await pool.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  databases.add(name);
  return { name, url: databaseUrl(name) };
}

async function readMigrationFixtures(): Promise<MigrationFixture[]> {
  const root = new URL("../../../../lib/db/drizzle/", import.meta.url);
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", root), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string; when: number }> };
  return Promise.all(journal.entries.map(async (entry) => {
    const sql = await readFile(new URL(`${entry.tag}.sql`, root), "utf8");
    return {
      ...entry,
      sql,
      hash: createHash("sha256").update(sql).digest("hex"),
    };
  }));
}

async function createLegacyFixture(
  history: "baseline-only" | "through-1" | "through-2" | "through-3" | "through-4",
  options: { failSeed?: boolean } = {},
): Promise<{
  database: { name: string; url: string };
  migrations: MigrationFixture[];
  originalJournal: Array<Record<string, unknown>>;
}> {
  const database = await createDatabase();
  const migrations = await readMigrationFixtures();
  const recorded = history === "baseline-only"
    ? migrations.slice(0, 1)
    : migrations.slice(0, Number(history.slice(-1)) + 1);

  await inDatabase(database.url, async (client) => {
    // This is a newly-created database on the disposable test postmaster. Run
    // the immutable historical SQL verbatim, including its obsolete public
    // reset, to model history without weakening the production runner.
    for (const migration of recorded) {
      for (const statement of migration.sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
    }
    await client.query("CREATE SCHEMA drizzle");
    await client.query(
      `CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`,
    );
    for (const migration of recorded) {
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [migration.hash, migration.when],
      );
    }
    await client.query(
      `INSERT INTO public.team_budgets
        (team_name, original_amount_usd, amount_usd)
       VALUES ('Operator Legacy Allocation', 777, 654.32)`,
    );

    if (history === "baseline-only") {
      // These exact historical omissions are supported because forward
      // migrations 0005 and 0009 repair them additively.
      await client.query("DROP TABLE public.app_admins");
      await client.query("DROP TABLE public.team_budget_allocation_audits");
    }
    if (options.failSeed) {
      await client.query(`
        CREATE FUNCTION public.reject_canonical_seed()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'intentional canonical seed rejection';
        END
        $$
      `);
      await client.query(`
        CREATE TRIGGER reject_canonical_seed
        BEFORE INSERT ON public.team_limit_targets
        FOR EACH ROW EXECUTE FUNCTION public.reject_canonical_seed()
      `);
    }
  });

  const originalJournal = await inDatabase(database.url, async (client) =>
    (await client.query(
      `SELECT id, hash::text AS hash, created_at::text AS created_at
         FROM drizzle.__drizzle_migrations
        ORDER BY id`,
    )).rows
  );
  return { database, migrations, originalJournal };
}

async function runDbCli(
  command: "setup" | "migrate",
  url: string,
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url,
  };
  delete env.DATABASE_SCHEMA;
  const { stdout, stderr } = await execFileAsync(
    "pnpm",
    ["--filter", "@workspace/db", "run", command],
    {
      cwd: workspaceRoot,
      env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return { stdout, stderr };
}

async function inDatabase<T>(
  url: string,
  callback: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const PoolConstructor = pool.constructor as unknown as new (
    options: { connectionString: string },
  ) => DatabasePool;
  const isolatedPool = new PoolConstructor({ connectionString: url });
  const client = await isolatedPool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
    await isolatedPool.end();
  }
}

async function expectCliFailure(url: string): Promise<string> {
  try {
    await runDbCli("setup", url);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
  }
  throw new Error("Expected database setup to fail");
}

afterAll(async () => {
  for (const database of databases) {
    await pool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [database],
    );
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
  }
});

describe.sequential("production database bootstrap CLI", () => {
  it("sets up an empty public schema and is repeatable without rewriting history", {
    timeout: 60_000,
  }, async () => {
    const database = await createDatabase();
    const initialSetup = cliMetrics(await runDbCli("setup", database.url));
    console.info(
      `bootstrap CLI initial setup: ${initialSetup.durationMs}ms, ${initialSetup.applied.length} migrations`,
    );

    const before = await inDatabase(database.url, async (client) => {
      await client.query(
        `INSERT INTO public.group_budgets (group_id, amount_usd)
         VALUES ('bootstrap-preservation-sentinel', 123.45)`,
      );
      await client.query(`
        INSERT INTO team_budget_allocation_audits
          (team_name, field, old_value, new_value, actor_user_id)
          VALUES ('Finance', 'annualAllocationUsd', '1', '777', 'test-operator');
        INSERT INTO team_budget_adjustments
          (source_record_id, team_name, amount_usd, match_state, is_active)
          VALUES ('test-accepted-credit', 'Finance', 42, 'accepted', true);
        INSERT INTO usage_account_day (usage_date, total_cost_usd, fetched_at)
          VALUES ('2026-08-01', 19.95, now());
        INSERT INTO sessions (sid, sess, expire)
          VALUES ('test-preserved-session', '{"test":true}', '2099-01-01');
      `);
      const preserved = await snapshotNonSeedData(client);
      const journal = await client.query(
        `SELECT id, hash::text AS hash, created_at::text AS created_at
           FROM drizzle.__drizzle_migrations
          ORDER BY id`,
      );
      const seeds = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.team_budgets",
      );
      return { journal: journal.rows, seeds: Number(seeds.rows[0]?.count), preserved };
    });

    expect(before.journal.length).toBeGreaterThan(0);
    expect(before.seeds).toBeGreaterThan(0);
    const repeatedSetup = cliMetrics(await runDbCli("setup", database.url));
    console.info(
      `bootstrap CLI repeated setup: ${repeatedSetup.durationMs}ms, ${repeatedSetup.applied.length} migrations`,
    );

    const after = await inDatabase(database.url, async (client) => {
      const journal = await client.query(
        `SELECT id, hash::text AS hash, created_at::text AS created_at
           FROM drizzle.__drizzle_migrations
          ORDER BY id`,
      );
      const sentinel = await client.query<{ amount_usd: number }>(
        `SELECT amount_usd
           FROM public.group_budgets
          WHERE group_id = 'bootstrap-preservation-sentinel'`,
      );
      return { journal: journal.rows, sentinel: sentinel.rows[0], preserved: await snapshotNonSeedData(client) };
    });
    expect(after.journal).toEqual(before.journal);
    expect(after.sentinel?.amount_usd).toBe(123.45);
    expect(after.preserved).toEqual(before.preserved);
  });

  it("migrate installs schema without canonical seed data", {
    timeout: 60_000,
  }, async () => {
    const database = await createDatabase();
    await runDbCli("migrate", database.url);
    const seededRows = await inDatabase(database.url, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.team_budgets",
      );
      return Number(result.rows[0]?.count);
    });
    expect(seededRows).toBe(0);
  });

  it.each(["missing", "empty"] as const)(
    "refuses a populated database with an %s migration journal",
    { timeout: 60_000 },
    async (scenario) => {
      const database = await createDatabase();
      await runDbCli("setup", database.url);
      await inDatabase(database.url, async (client) => {
        await client.query(
          "CREATE TABLE public.bootstrap_no_journal_sentinel (value text NOT NULL)",
        );
        if (scenario === "missing") {
          await client.query("DROP SCHEMA drizzle CASCADE");
        } else {
          await client.query("TRUNCATE drizzle.__drizzle_migrations");
        }
      });

      const failure = await expectCliFailure(database.url);
      expect(failure).toMatch(/journal|migration|populated|refus/i);
      const preserved = await inDatabase(database.url, async (client) => {
        const result = await client.query<{ table_name: string | null }>(
          "SELECT to_regclass('public.bootstrap_no_journal_sentinel')::text AS table_name",
        );
        return result.rows[0]?.table_name;
      });
      expect(preserved).toBe("bootstrap_no_journal_sentinel");
    },
  );

  it("refuses a migration journal whose recorded hash was edited", {
    timeout: 60_000,
  }, async () => {
    const database = await createDatabase();
    await runDbCli("setup", database.url);
    await inDatabase(database.url, async (client) => {
      await client.query(
        `UPDATE drizzle.__drizzle_migrations
            SET hash = 'deliberately-invalid-migration-hash'
          WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)`,
      );
    });
    expect(await expectCliFailure(database.url)).toMatch(/hash|history|migration/i);
  });

  it("refuses a migration journal whose recorded timestamp was edited", {
    timeout: 60_000,
  }, async () => {
    const database = await createDatabase();
    await runDbCli("setup", database.url);
    await inDatabase(database.url, async (client) => {
      await client.query(
        `UPDATE drizzle.__drizzle_migrations
            SET created_at = created_at + 1
          WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)`,
      );
    });
    expect(await expectCliFailure(database.url)).toMatch(
      /unknown|changed|history|migration/i,
    );
  });

  it("refuses an incompatible recorded baseline without making changes", {
    timeout: 60_000,
  }, async () => {
    const database = await createDatabase();
    await runDbCli("setup", database.url);
    const before = await inDatabase(database.url, async (client) => {
      await client.query(
        `CREATE FUNCTION public.bootstrap_sentinel()
         RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 42'`,
      );
      await client.query("DROP TABLE public.alerts");
      const journal = await client.query(
        `SELECT id, hash::text AS hash, created_at::text AS created_at
           FROM drizzle.__drizzle_migrations
          ORDER BY id`,
      );
      return journal.rows;
    });

    expect(await expectCliFailure(database.url)).toMatch(
      /baseline|target schema|match/i,
    );
    const after = await inDatabase(database.url, async (client) => {
      const journal = await client.query(
        `SELECT id, hash::text AS hash, created_at::text AS created_at
           FROM drizzle.__drizzle_migrations
          ORDER BY id`,
      );
      const sentinel = await client.query<{ value: number }>(
        "SELECT public.bootstrap_sentinel() AS value",
      );
      const alerts = await client.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.alerts')::text AS table_name",
      );
      return {
        journal: journal.rows,
        sentinel: sentinel.rows[0]?.value,
        alerts: alerts.rows[0]?.table_name,
      };
    });
    expect(after.journal).toEqual(before);
    expect(after.sentinel).toBe(42);
    expect(after.alerts).toBeNull();
  });

  it.each([
    {
      name: "missing primary key",
      mutate: "ALTER TABLE public.group_budgets DROP CONSTRAINT group_budgets_pkey",
    },
    {
      name: "changed partial unique index predicate",
      mutate: `
        DROP INDEX public.app_admins_bootstrap_email_unique;
        CREATE UNIQUE INDEX app_admins_bootstrap_email_unique
          ON public.app_admins (lower(btrim(email)))
      `,
    },
    {
      name: "missing check constraint",
      mutate: `
        ALTER TABLE public.group_user_limit_policies
          DROP CONSTRAINT group_user_limit_policies_positive_amount
      `,
    },
    {
      name: "missing configuration function and triggers",
      mutate: "DROP FUNCTION public.advance_configuration_revision() CASCADE",
    },
    {
      name: "changed column default and nullability",
      mutate: `
        ALTER TABLE public.notification_settings
          ALTER COLUMN automated_email_enabled DROP DEFAULT,
          ALTER COLUMN automated_email_enabled DROP NOT NULL
      `,
    },
    {
      name: "view masquerading as a required table",
      mutate: `
        DROP TABLE public.notification_settings;
        CREATE VIEW public.notification_settings AS
          SELECT
            'singleton'::varchar AS id,
            false::boolean AS automated_email_enabled,
            now()::timestamptz AS updated_at
          WHERE false
      `,
    },
  ])(
    "migrate and setup refuse catalog drift: $name",
    { timeout: 60_000 },
    async ({ mutate }) => {
      const database = await createDatabase();
      await runDbCli("setup", database.url);
      const before = await inDatabase(database.url, async (client) => {
        await client.query(
          `INSERT INTO public.group_budgets (group_id, amount_usd)
           VALUES ('schema-contract-sentinel', 918.27)`,
        );
        await client.query(mutate);
        return (await client.query(
          `SELECT id, hash::text AS hash, created_at::text AS created_at
             FROM drizzle.__drizzle_migrations
            ORDER BY id`,
        )).rows;
      });

      for (const command of ["migrate", "setup"] as const) {
        let failure = "";
        try {
          await runDbCli(command, database.url);
        } catch (error) {
          const rejected = error as Error & { stdout?: string; stderr?: string };
          failure =
            `${rejected.message}\n${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`;
        }
        expect(failure).toMatch(
          /refus|schema|catalog|contract|incompatible|recorded/i,
        );
        const unchanged = await inDatabase(database.url, async (client) => {
          const journal = await client.query(
            `SELECT id, hash::text AS hash, created_at::text AS created_at
               FROM drizzle.__drizzle_migrations
              ORDER BY id`,
          );
          const sentinel = await client.query<{ amount_usd: number }>(
            `SELECT amount_usd
               FROM public.group_budgets
              WHERE group_id = 'schema-contract-sentinel'`,
          );
          return {
            journal: journal.rows,
            amount: sentinel.rows[0]?.amount_usd,
          };
        });
        expect(unchanged.journal).toEqual(before);
        expect(unchanged.amount).toBe(918.27);
      }
    },
  );

  it("refuses malformed partial legacy history with authentic identities", {
    timeout: 60_000,
  }, async () => {
    const fixture = await createLegacyFixture("baseline-only");
    const migration2 = fixture.migrations[2]!;
    await inDatabase(fixture.database.url, async (client) => {
      for (const statement of migration2.sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [migration2.hash, migration2.when],
      );
    });
    const before = await inDatabase(fixture.database.url, async (client) =>
      (await client.query(
        `SELECT id, hash::text AS hash, created_at::text AS created_at
           FROM drizzle.__drizzle_migrations
          ORDER BY id`,
      )).rows
    );

    for (const command of ["migrate", "setup"] as const) {
      let failure = "";
      try {
        await runDbCli(command, fixture.database.url);
      } catch (error) {
        const rejected = error as Error & { stdout?: string; stderr?: string };
        failure =
          `${rejected.message}\n${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`;
      }
      expect(failure).toMatch(/history|journal|omit|required|refus/i);
      const unchanged = await inDatabase(fixture.database.url, async (client) => {
        const journal = await client.query(
          `SELECT id, hash::text AS hash, created_at::text AS created_at
             FROM drizzle.__drizzle_migrations
            ORDER BY id`,
        );
        const allocation = await client.query<{ amount_usd: number }>(
          `SELECT amount_usd
             FROM public.team_budgets
            WHERE team_name = 'Operator Legacy Allocation'`,
        );
        return {
          journal: journal.rows,
          amount: allocation.rows[0]?.amount_usd,
        };
      });
      expect(unchanged.journal).toEqual(before);
      expect(unchanged.amount).toBe(654.32);
    }
  });

  it.each(["baseline-only", "through-1", "through-2", "through-3", "through-4"] as const)(
    "upgrades authentic %s legacy history without rewriting recorded identities",
    { timeout: 60_000 },
    async (history) => {
      const fixture = await createLegacyFixture(history);
      await runDbCli("setup", fixture.database.url);

      const state = await inDatabase(fixture.database.url, async (client) => {
        const journal = await client.query(
          `SELECT id, hash::text AS hash, created_at::text AS created_at
             FROM drizzle.__drizzle_migrations
            ORDER BY id`,
        );
        const relations = await client.query<{
          policies: string | null;
          assignments: string | null;
          audits: string | null;
          admins: string | null;
        }>(`
          SELECT
            to_regclass('public.group_user_limit_policies')::text AS policies,
            to_regclass('public.member_limit_policy_assignments')::text AS assignments,
            to_regclass('public.team_budget_allocation_audits')::text AS audits,
            to_regclass('public.app_admins')::text AS admins
        `);
        const alertColumns = await client.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'alerts'
              AND column_name IN ('alert_type', 'blocked_member_count')
            ORDER BY column_name`,
        );
        const allocation = await client.query<{ amount_usd: number }>(
          `SELECT amount_usd FROM public.team_budgets
            WHERE team_name = 'Operator Legacy Allocation'`,
        );
        const alertIndex = await client.query<{ columns: string[]; unique: boolean }>(`
          SELECT array_agg(a.attname::text ORDER BY k.ordinality) AS columns, i.indisunique AS unique
          FROM pg_index i
          CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indexrelid = 'public.alert_delivery_claims_unique'::regclass
          GROUP BY i.indisunique
        `);
        return {
          journal: journal.rows,
          relations: relations.rows[0],
          alertColumns: alertColumns.rows.map((row) => row.column_name),
          allocation: allocation.rows[0]?.amount_usd,
          alertIndex: alertIndex.rows[0],
        };
      });

      expect(state.journal.slice(0, fixture.originalJournal.length))
        .toEqual(fixture.originalJournal);
      if (history !== "through-4") {
        const skipped = new Set(
          fixture.migrations.slice(fixture.originalJournal.length, 5)
            .map((migration) => String(migration.when)),
        );
        expect(state.journal.some((row) =>
          skipped.has(String(row.created_at))
        )).toBe(false);
      }
      expect(state.relations).toEqual({
        policies: "group_user_limit_policies",
        assignments: "member_limit_policy_assignments",
        audits: "team_budget_allocation_audits",
        admins: "app_admins",
      });
      expect(state.alertColumns).toEqual(["alert_type", "blocked_member_count"]);
      expect(state.allocation).toBe(654.32);
      expect(state.alertIndex).toEqual({
        columns: ["entity_type", "entity_id", "alert_type", "billing_period", "threshold"],
        unique: true,
      });
    },
  );

  it("rolls migrations and journal back when canonical CLI seed fails", {
    timeout: 60_000,
  }, async () => {
    const fixture = await createLegacyFixture("baseline-only", {
      failSeed: true,
    });
    expect(await expectCliFailure(fixture.database.url)).toMatch(
      /failed|rolled back|migration SQL|schema compatibility/i,
    );
    const state = await inDatabase(fixture.database.url, async (client) => {
      const journal = await client.query(
        `SELECT id, hash::text AS hash, created_at::text AS created_at
           FROM drizzle.__drizzle_migrations
          ORDER BY id`,
      );
      const repaired = await client.query<{
        policies: string | null;
        audits: string | null;
        admins: string | null;
      }>(`
        SELECT
          to_regclass('public.group_user_limit_policies')::text AS policies,
          to_regclass('public.team_budget_allocation_audits')::text AS audits,
          to_regclass('public.app_admins')::text AS admins
      `);
      const allocation = await client.query<{ amount_usd: number }>(
        `SELECT amount_usd FROM public.team_budgets
          WHERE team_name = 'Operator Legacy Allocation'`,
      );
      return {
        journal: journal.rows,
        repaired: repaired.rows[0],
        allocation: allocation.rows[0]?.amount_usd,
      };
    });
    expect(state.journal).toEqual(fixture.originalJournal);
    expect(state.repaired).toEqual({
      policies: null,
      audits: null,
      admins: null,
    });
    expect(state.allocation).toBe(654.32);
  });

  it("serializes concurrent setup processes", {
    timeout: 60_000,
  }, async () => {
    const database = await createDatabase();
    await Promise.all([
      runDbCli("setup", database.url),
      runDbCli("setup", database.url),
    ]);
    const duplicateHistory = await inDatabase(database.url, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM (
             SELECT hash, created_at
               FROM drizzle.__drizzle_migrations
              GROUP BY hash, created_at
             HAVING count(*) > 1
           ) duplicates`,
      );
      return Number(result.rows[0]?.count);
    });
    expect(duplicateHistory).toBe(0);
  });
});