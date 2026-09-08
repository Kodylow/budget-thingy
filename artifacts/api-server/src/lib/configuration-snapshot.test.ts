import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import {
  getConfigurationRevision,
  getConfigurationSnapshot,
  resetConfigurationSnapshotForTests,
} from "./configuration-snapshot";

const PREFIX = "__configuration_snapshot_test__";

function asBigInt(revision: string): bigint {
  return BigInt(revision);
}

describe("transactional configuration revision", () => {
  beforeEach(() => {
    resetConfigurationSnapshotForTests();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM group_budgets WHERE group_id LIKE $1", [
      `${PREFIX}%`,
    ]);
  });

  it("advances for DML from any database client", async () => {
    const client = await pool.connect();
    try {
      const before = asBigInt(await getConfigurationRevision());
      const statements = [
        [
          "group_budgets",
          `INSERT INTO group_budgets (group_id, amount_usd)
           SELECT 'unused', 1 WHERE false`,
          "group_id",
        ],
        [
          "team_limit_targets",
          `INSERT INTO team_limit_targets
             (team_name, workspace_id, group_id, group_name)
           SELECT 'unused', 'unused', 'unused', 'unused' WHERE false`,
          "group_id",
        ],
        [
          "team_budgets",
          `INSERT INTO team_budgets (team_name, amount_usd)
           SELECT 'unused', 1 WHERE false`,
          "team_name",
        ],
        [
          "team_budget_adjustments",
          `INSERT INTO team_budget_adjustments (source_record_id, match_state)
           SELECT 'unused', 'invalid' WHERE false`,
          "source_record_id",
        ],
        [
          "family_team_mappings",
          `INSERT INTO family_team_mappings
             (workspace_id, family_key, family_name, is_legacy)
           SELECT 'unused', 'unused', 'unused', false WHERE false`,
          "family_key",
        ],
        [
          "funding_group_overrides",
          `INSERT INTO funding_group_overrides
             (workspace_id, group_id, team_name)
           SELECT 'unused', 'unused', NULL WHERE false`,
          "group_id",
        ],
      ] as const;

      // Statement triggers deliberately include zero-row DML. This verifies
      // every operation without changing canonical fixture rows.
      for (const [table, insert, column] of statements) {
        await client.query(insert);
        await client.query(`UPDATE ${table} SET ${column} = ${column} WHERE false`);
        await client.query(`DELETE FROM ${table} WHERE false`);
      }

      resetConfigurationSnapshotForTests();
      const after = asBigInt(await getConfigurationRevision());
      expect(after - before).toBe(18n);
    } finally {
      client.release();
    }
  });

  it("publishes commits from a second client and never publishes rollbacks", async () => {
    const client = await pool.connect();
    const groupId = `${PREFIX}commit`;
    try {
      await client.query("DELETE FROM group_budgets WHERE group_id = $1", [groupId]);
      resetConfigurationSnapshotForTests();
      const beforeCommit = await getConfigurationRevision();

      await client.query(
        "INSERT INTO group_budgets (group_id, amount_usd) VALUES ($1, $2)",
        [groupId, 11],
      );
      resetConfigurationSnapshotForTests();
      const afterCommit = await getConfigurationRevision();
      expect(asBigInt(afterCommit)).toBeGreaterThan(asBigInt(beforeCommit));

      await client.query("BEGIN");
      await client.query(
        "UPDATE group_budgets SET amount_usd = $2 WHERE group_id = $1",
        [groupId, 99],
      );
      await client.query("ROLLBACK");
      resetConfigurationSnapshotForTests();
      expect(await getConfigurationRevision()).toBe(afterCommit);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("DELETE FROM group_budgets WHERE group_id = $1", [groupId]);
      client.release();
    }
  });

  it("keeps rows and revision consistent across an overlapping commit", async () => {
    const client = await pool.connect();
    const groupId = `${PREFIX}consistent`;
    try {
      await client.query(
        `INSERT INTO group_budgets (group_id, amount_usd)
         VALUES ($1, 1)
         ON CONFLICT (group_id) DO UPDATE SET amount_usd = 1`,
        [groupId],
      );
      resetConfigurationSnapshotForTests();
      const first = await getConfigurationSnapshot();
      expect(first.groupBudgets.find((row) => row.groupId === groupId)?.amountUsd)
        .toBe(1);

      await client.query("BEGIN");
      await client.query(
        "UPDATE group_budgets SET amount_usd = 2 WHERE group_id = $1",
        [groupId],
      );

      // An uncommitted trigger update cannot replace the reusable committed
      // snapshot.
      const during = await getConfigurationSnapshot();
      expect(during).toBe(first);
      expect(during.groupBudgets.find((row) => row.groupId === groupId)?.amountUsd)
        .toBe(1);

      await client.query("COMMIT");
      const after = await getConfigurationSnapshot();
      expect(asBigInt(after.revision)).toBeGreaterThan(asBigInt(first.revision));
      expect(after.groupBudgets.find((row) => row.groupId === groupId)?.amountUsd)
        .toBe(2);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("DELETE FROM group_budgets WHERE group_id = $1", [groupId]);
      client.release();
    }
  });

  it("serializes concurrent writers without losing a revision", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    const firstId = `${PREFIX}concurrent-one`;
    const secondId = `${PREFIX}concurrent-two`;
    try {
      await first.query(
        "DELETE FROM group_budgets WHERE group_id IN ($1, $2)",
        [firstId, secondId],
      );
      resetConfigurationSnapshotForTests();
      const before = asBigInt(await getConfigurationRevision());

      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query(
        "INSERT INTO group_budgets (group_id, amount_usd) VALUES ($1, 1)",
        [firstId],
      );
      const secondInsert = second.query(
        "INSERT INTO group_budgets (group_id, amount_usd) VALUES ($1, 2)",
        [secondId],
      );
      await first.query("COMMIT");
      await secondInsert;
      await second.query("COMMIT");

      resetConfigurationSnapshotForTests();
      const after = asBigInt(await getConfigurationRevision());
      expect(after - before).toBe(2n);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      await first.query(
        "DELETE FROM group_budgets WHERE group_id IN ($1, $2)",
        [firstId, secondId],
      );
      first.release();
      second.release();
    }
  });

  it("fires on TRUNCATE and rolls its revision back transactionally", async () => {
    const client = await pool.connect();
    try {
      resetConfigurationSnapshotForTests();
      const before = await getConfigurationRevision();
      await client.query("BEGIN");
      await client.query("TRUNCATE group_budgets");
      const inside = await client.query<{ revision: string }>(
        "SELECT revision::text AS revision FROM configuration_revision",
      );
      expect(asBigInt(inside.rows[0]!.revision))
        .toBeGreaterThan(asBigInt(before));
      await client.query("ROLLBACK");

      resetConfigurationSnapshotForTests();
      expect(await getConfigurationRevision()).toBe(before);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});