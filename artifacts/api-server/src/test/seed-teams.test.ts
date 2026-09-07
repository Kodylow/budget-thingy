import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  configurationRevisionTable,
  db,
  familyTeamMappingsTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
  workspaceDefaultLimitTargetsTable,
} from "@workspace/db";
import {
  applyAnnualTeamBudgetBackfill,
  LEGACY_WORKSPACE_ID,
  seedDatabase,
  SEEDED_TEAM_LIMIT_TARGETS,
} from "@workspace/db/seed-teams";

async function configurationRevision(): Promise<bigint> {
  const [row] = await db.select().from(configurationRevisionTable);
  if (!row) throw new Error("Missing configuration revision singleton");
  return row.revision;
}

describe.sequential("canonical database seed", () => {
  it("is repeatable, batched, and preserves operator-managed conflicts", async () => {
    const target = SEEDED_TEAM_LIMIT_TARGETS[0]!;
    const familyKey = "comcast advertising";
    const [savedBudget] = await db
      .select()
      .from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, "DXP"));
    const [savedTarget] = await db
      .select()
      .from(teamLimitTargetsTable)
      .where(sql`${teamLimitTargetsTable.workspaceId} = ${target.workspaceId}
        and ${teamLimitTargetsTable.groupId} = ${target.groupId}`);
    const [savedFamily] = await db
      .select()
      .from(familyTeamMappingsTable)
      .where(sql`${familyTeamMappingsTable.workspaceId} = ${target.workspaceId}
        and ${familyTeamMappingsTable.familyKey} = ${familyKey}`);
    const [savedDefault] = await db
      .select()
      .from(workspaceDefaultLimitTargetsTable)
      .where(eq(workspaceDefaultLimitTargetsTable.workspaceId, LEGACY_WORKSPACE_ID));
    if (!savedBudget || !savedTarget || !savedFamily || !savedDefault) {
      throw new Error("Expected worker setup to install canonical seed rows");
    }

    await db.update(teamBudgetsTable).set({
      amountUsd: 77,
      originalAmountUsd: 66,
      monthlyLimitUsd: 55,
      monthlyLimitSource: "manual",
      isHidden: true,
    }).where(eq(teamBudgetsTable.teamName, "DXP"));
    await db.update(teamLimitTargetsTable).set({
      teamName: "__operator_target__",
      assignmentSource: "manual",
      monthlyLimitUsd: 44,
      isEnabled: false,
    }).where(sql`${teamLimitTargetsTable.workspaceId} = ${target.workspaceId}
      and ${teamLimitTargetsTable.groupId} = ${target.groupId}`);
    await db.update(familyTeamMappingsTable).set({
      teamName: "__operator_family__",
    }).where(sql`${familyTeamMappingsTable.workspaceId} = ${target.workspaceId}
      and ${familyTeamMappingsTable.familyKey} = ${familyKey}`);
    await db.update(workspaceDefaultLimitTargetsTable).set({
      displayName: "__operator_default__",
      monthlyLimitUsd: 33,
      isEnabled: false,
    }).where(eq(workspaceDefaultLimitTargetsTable.workspaceId, LEGACY_WORKSPACE_ID));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const before = await configurationRevision();
      const first = await seedDatabase();
      const afterFirst = await configurationRevision();
      const second = await seedDatabase();
      const afterSecond = await configurationRevision();

      expect(first).toMatchObject({
        writeStatements: 4,
        configurationRevisionAdvances: 3,
      });
      expect(second).toEqual(first);
      // One batched INSERT touches each of the three trigger-covered seed
      // tables. The workspace-default insert has no configuration trigger.
      expect(afterFirst - before).toBe(3n);
      expect(afterSecond - afterFirst).toBe(3n);

      const [budget] = await db.select().from(teamBudgetsTable)
        .where(eq(teamBudgetsTable.teamName, "DXP"));
      const [seedTarget] = await db.select().from(teamLimitTargetsTable)
        .where(sql`${teamLimitTargetsTable.workspaceId} = ${target.workspaceId}
          and ${teamLimitTargetsTable.groupId} = ${target.groupId}`);
      const [family] = await db.select().from(familyTeamMappingsTable)
        .where(sql`${familyTeamMappingsTable.workspaceId} = ${target.workspaceId}
          and ${familyTeamMappingsTable.familyKey} = ${familyKey}`);
      const [workspaceDefault] = await db.select().from(workspaceDefaultLimitTargetsTable)
        .where(eq(workspaceDefaultLimitTargetsTable.workspaceId, LEGACY_WORKSPACE_ID));

      expect(budget).toMatchObject({
        amountUsd: 77,
        originalAmountUsd: 66,
        monthlyLimitUsd: 55,
        monthlyLimitSource: "manual",
        isHidden: true,
      });
      expect(seedTarget).toMatchObject({
        teamName: "__operator_target__",
        assignmentSource: "manual",
        monthlyLimitUsd: 44,
        isEnabled: false,
      });
      expect(family?.teamName).toBe("__operator_family__");
      expect(workspaceDefault).toMatchObject({
        displayName: "__operator_default__",
        monthlyLimitUsd: 33,
        isEnabled: false,
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
      await db.update(teamBudgetsTable).set(savedBudget)
        .where(eq(teamBudgetsTable.teamName, savedBudget.teamName));
      await db.update(teamLimitTargetsTable).set(savedTarget)
        .where(sql`${teamLimitTargetsTable.workspaceId} = ${savedTarget.workspaceId}
          and ${teamLimitTargetsTable.groupId} = ${savedTarget.groupId}`);
      await db.update(familyTeamMappingsTable).set(savedFamily)
        .where(sql`${familyTeamMappingsTable.workspaceId} = ${savedFamily.workspaceId}
          and ${familyTeamMappingsTable.familyKey} = ${savedFamily.familyKey}`);
      await db.update(workspaceDefaultLimitTargetsTable).set(savedDefault)
        .where(eq(
          workspaceDefaultLimitTargetsTable.workspaceId,
          savedDefault.workspaceId,
        ));
    }
  });

  it("rolls every canonical seed write back when a later batch fails", async () => {
    await db.delete(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, "Non-DXP"));
    await db.execute(sql`
      CREATE FUNCTION reject_seed_target_batch() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'intentional seed rollback test';
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER reject_seed_target_batch
      BEFORE INSERT ON team_limit_targets
      FOR EACH STATEMENT EXECUTE FUNCTION reject_seed_target_batch()
    `);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = await configurationRevision();
    try {
      await expect(seedDatabase()).rejects.toThrow("Failed query");
      const [nonDxp] = await db.select().from(teamBudgetsTable)
        .where(eq(teamBudgetsTable.teamName, "Non-DXP"));
      expect(nonDxp).toBeUndefined();
      expect(await configurationRevision()).toBe(before);
    } finally {
      log.mockRestore();
      await db.execute(sql`DROP TRIGGER reject_seed_target_batch ON team_limit_targets`);
      await db.execute(sql`DROP FUNCTION reject_seed_target_batch()`);
      await applyAnnualTeamBudgetBackfill();
    }
  });
});