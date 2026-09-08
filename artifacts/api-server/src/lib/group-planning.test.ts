import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  configurationRevisionTable,
  db,
  groupPlanAuditsTable,
  groupPlansTable,
} from "@workspace/db";
import {
  allocateCentsByWeight,
  calculateFundingEnvelope,
  overlappingRosterWeights,
  remainingFundingMonthWeights,
  saveGroupPlan,
} from "./group-planning";

const TEST_WORKSPACE = "__task60_plan_workspace";
const TEST_GROUP = "__task60_plan_group";

afterEach(async () => {
  await db.delete(groupPlanAuditsTable).where(and(
    eq(groupPlanAuditsTable.workspaceId, TEST_WORKSPACE),
    eq(groupPlanAuditsTable.groupId, TEST_GROUP),
  ));
  await db.delete(groupPlansTable).where(and(
    eq(groupPlansTable.workspaceId, TEST_WORKSPACE),
    eq(groupPlansTable.groupId, TEST_GROUP),
  ));
});

describe("group planning funding arithmetic", () => {
  const year = {
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEndExclusive: "2027-01-01T00:00:00.000Z",
    allocationUsdCents: 12_000_000,
  };

  it("recommends an even January share before spend", () => {
    expect(calculateFundingEnvelope({
      ...year,
      now: new Date("2026-01-15T12:00:00.000Z"),
      priorSpendUsdCents: 0,
    }).amountUsdCents).toBe(1_000_000);
  });

  it("redistributes January under- and overspend in February", () => {
    expect(calculateFundingEnvelope({
      ...year,
      now: new Date("2026-02-05T12:00:00.000Z"),
      priorSpendUsdCents: 500_000,
    }).amountUsdCents).toBe(1_045_455);
    expect(calculateFundingEnvelope({
      ...year,
      now: new Date("2026-02-05T12:00:00.000Z"),
      priorSpendUsdCents: 1_500_000,
    }).amountUsdCents).toBe(954_545);
  });

  it("prorates actual partial boundary months", () => {
    const weights = remainingFundingMonthWeights({
      now: new Date("2026-05-25T00:00:00.000Z"),
      periodStart: "2026-05-20T00:00:00.000Z",
      periodEndExclusive: "2026-07-11T00:00:00.000Z",
    });
    expect(weights?.current).toBeCloseTo(12 / 31, 12);
    expect(weights?.total).toBeCloseTo(12 / 31 + 1 + 10 / 31, 12);
  });

  it("returns explicit unavailable and exhausted states", () => {
    expect(calculateFundingEnvelope({
      ...year,
      now: new Date("2025-12-31T12:00:00.000Z"),
      priorSpendUsdCents: 0,
    }).status).toBe("not_started");
    expect(calculateFundingEnvelope({
      ...year,
      now: new Date("2026-03-05T12:00:00.000Z"),
      priorSpendUsdCents: null,
    }).status).toBe("missing_history");
    expect(calculateFundingEnvelope({
      ...year,
      now: new Date("2026-03-05T12:00:00.000Z"),
      priorSpendUsdCents: 13_000_000,
    })).toMatchObject({ status: "exhausted", amountUsdCents: 0 });
  });
});

describe("group planning roster and cent reconciliation", () => {
  it("shares an overlapping workspace/user across mapped groups", () => {
    const weights = overlappingRosterWeights([
      { id: "a", workspaceId: "w", eligibleUserIds: ["u1", "u2"] },
      { id: "b", workspaceId: "w", eligibleUserIds: ["u2", "u3"] },
      { id: "c", workspaceId: "other", eligibleUserIds: ["u2"] },
    ]);
    expect(weights).toEqual(new Map([
      ["a", 1.5],
      ["b", 1.5],
      ["c", 1],
    ]));
  });

  it("reconciles largest remainders exactly and stably", () => {
    const allocated = allocateCentsByWeight(100, [
      { id: "b", weight: 1 },
      { id: "a", weight: 1 },
      { id: "c", weight: 1 },
    ]);
    expect([...allocated.values()].reduce((sum, cents) => sum + cents, 0)).toBe(100);
    expect(allocated).toEqual(new Map([["b", 33], ["a", 34], ["c", 33]]));
  });

  it("gives zero-member groups no recommendation", () => {
    expect(allocateCentsByWeight(101, [
      { id: "empty", weight: 0 },
      { id: "active", weight: 2 },
    ])).toEqual(new Map([["empty", 0], ["active", 101]]));
  });
});

describe("audited group plan persistence", () => {
  it("persists integer cents and rejects stale row edits", async () => {
    const [clock] = await db.select().from(configurationRevisionTable);
    const expectedConfigurationRevision = clock!.revision.toString();
    const common = {
      workspaceId: TEST_WORKSPACE,
      groupId: TEST_GROUP,
      teamName: "Task 60",
      fundingPeriodStart: "2026-05-20",
      fundingPeriodEnd: "2027-05-20",
      expectedConfigurationRevision,
      mappingIdentity: "mapping-v1",
      actorUserId: "planner",
    };
    const created = await saveGroupPlan({
      ...common,
      amountUsdCents: 100_000,
      expectedPlanRevision: null,
    });
    expect(created).toMatchObject({
      status: "ok",
      plan: { amountUsdCents: 100_000, revision: 1 },
    });
    const updated = await saveGroupPlan({
      ...common,
      amountUsdCents: 120_000,
      expectedPlanRevision: 1,
    });
    expect(updated).toMatchObject({
      status: "ok",
      plan: { amountUsdCents: 120_000, revision: 2 },
    });
    expect(await saveGroupPlan({
      ...common,
      amountUsdCents: 130_000,
      expectedPlanRevision: 1,
    })).toEqual({ status: "conflict" });
    const audits = await db.select().from(groupPlanAuditsTable).where(and(
      eq(groupPlanAuditsTable.workspaceId, TEST_WORKSPACE),
      eq(groupPlanAuditsTable.groupId, TEST_GROUP),
    ));
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      previousAmountUsdCents: 100_000,
      newAmountUsdCents: 120_000,
      previousRevision: 1,
      newRevision: 2,
    });
  });

  it("allows explicit reconfirmation under a changed mapping identity", async () => {
    const [clock] = await db.select().from(configurationRevisionTable);
    const expectedConfigurationRevision = clock!.revision.toString();
    const base = {
      workspaceId: TEST_WORKSPACE,
      groupId: TEST_GROUP,
      teamName: "Task 60",
      fundingPeriodStart: "2026-05-20",
      fundingPeriodEnd: "2027-05-20",
      expectedConfigurationRevision,
      actorUserId: "planner",
    };
    await saveGroupPlan({
      ...base,
      mappingIdentity: "before-away-and-back",
      amountUsdCents: 100,
      expectedPlanRevision: null,
    });
    expect(await saveGroupPlan({
      ...base,
      mappingIdentity: "after-away-and-back",
      amountUsdCents: 100,
      expectedPlanRevision: 1,
    })).toMatchObject({
      status: "ok",
      plan: { mappingIdentity: "after-away-and-back", revision: 2 },
    });
  });
});