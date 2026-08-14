import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "@workspace/db/schema";
import { computeDedupedUsageRollup } from "./usage-rollup";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Real Postgres semantics (including the unique index on fired_thresholds)
// via an in-memory PGlite database, so dedup behavior is tested for real.
const { pglite, testDb } = await vi.hoisted(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@workspace/db/schema");
  const pglite = new PGlite();
  return { pglite, testDb: drizzle(pglite, { schema }) };
});

vi.mock("@workspace/db", async () => {
  const actualSchema = await import("@workspace/db/schema");
  return { ...actualSchema, db: testDb, pool: null };
});

const sendEmailMock = vi.fn();
const isEmailConfiguredMock = vi.fn();
vi.mock("./email", async () => {
  const actual =
    await vi.importActual<typeof import("./email")>("./email");
  return {
    buildAlertEmail: actual.buildAlertEmail,
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
    isEmailConfigured: () => isEmailConfiguredMock(),
  };
});

// ---------------------------------------------------------------------------
// Enterprise mock: raw group spend is driven by getSpendMock; team rollups are
// driven by fixture member-usage maps run through the REAL deduping rollup so
// cross-workspace member overlap is exercised authentically.
// ---------------------------------------------------------------------------

const getSpendMock = vi.fn();
let periodStartAfterRawRefresh: string | null = null;
let rawSpendRefreshGroupIds: string[] = [];

// groupId -> Map<userId, spendUsd> member usage fixture for the team range.
let memberUsageFixture = new Map<string, Map<string, number>>();
// userId -> extra-workspace spend fixture.
let extraSpendFixture = new Map<string, number>();
let extraSpendComplete = true;
let extraSpendAfterForce: Map<string, number> | null = null;
let lastExtraWorkspaceForce = false;
// directory groups fixture (defaults to the single group used by group tests).
let directoryGroups: EnterpriseGroup[] = [];
// groupId -> member userId[] fixture.
let groupMembersFixture = new Map<string, string[]>();
let billingStart: string | null = null;

vi.mock("./enterprise", () => ({
  isConfigured: () => true,
  getSpend: (groupId: string) => getSpendMock(groupId),
  getDirectory: async () => ({
    groups: directoryGroups,
    members: new Map(),
    workspaces: new Map([
      ["ws-1", { id: "ws-1", name: "Acme Workspace" }],
      ["ws-2", { id: "ws-2", name: "Beta Workspace" }],
    ]),
    groupMembers: groupMembersFixture,
  }),
  getBillingPeriod: () => ({ label: "July 2026", start: billingStart }),
  // Spend is provided synchronously via getSpendMock, so report a fresh cache to
  // let runCheck's spend-refresh wait resolve immediately.
  queueGroupSpendFetch: (group: EnterpriseGroup) => {
    rawSpendRefreshGroupIds.push(group.id);
    if (periodStartAfterRawRefresh) billingStart = periodStartAfterRawRefresh;
    return "fresh_cache";
  },
  queueMemberUsageFetch: () => false,
  queueExtraWorkspacesFetch: (
    _dir: unknown,
    _range: unknown,
    _priority: number,
    force: boolean,
  ) => {
    lastExtraWorkspaceForce = force;
    if (force && extraSpendAfterForce) {
      extraSpendFixture = new Map(extraSpendAfterForce);
    }
  },
  getMemberUsage: (groupId: string, _rangeKey: string) => {
    const byUser = memberUsageFixture.get(groupId);
    return byUser ? { byUser, unattributableTotalCostUsd: 0, totalCostUsd: 0 } : undefined;
  },
  getExtraWorkspaceSpend: () => ({
    byUser: extraSpendFixture,
    isComplete: extraSpendComplete,
    loadedCount: 0,
    totalCount: 0,
  }),
  // Real dedup rollup driven by the fixtures above.
  getDedupedUsageRollup: (
    groups: EnterpriseGroup[],
    _rangeKey: string,
    extraSpendByUser?: ReadonlyMap<string, number>,
    _groupMembers?: ReadonlyMap<string, readonly string[]>,
  ) => {
    // Fold extra-workspace spend into each user's observed member usage before
    // deduping so a user's cross-workspace spend is attributed to their first group.
    const usageByGroup = new Map<
      string,
      { byUser: Map<string, number>; unattributableTotalCostUsd: number }
    >();
    for (const g of groups) {
      const base = memberUsageFixture.get(g.id);
      if (!base) continue;
      const byUser = new Map<string, number>();
      for (const [uid, s] of base) {
        byUser.set(uid, s + (extraSpendByUser?.get(uid) ?? 0));
      }
      usageByGroup.set(g.id, { byUser, unattributableTotalCostUsd: 0 });
    }
    return computeDedupedUsageRollup(
      groups.map((g) => ({ id: g.id, workspaceId: g.workspaceId, name: g.name })),
      usageByGroup,
    );
  },
  resolveRange: () => ({ key: "billing:from-cutoff", label: "July 2026", type: "billing" }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { evaluateGroup, getFiredThresholds, runCheck, THRESHOLDS } from "./checker";
import type { EnterpriseGroup } from "./enterprise";

const GROUP: EnterpriseGroup = {
  id: "grp-1",
  workspaceId: "ws-1",
  name: "Engineering",
} as EnterpriseGroup;

const PERIOD_JUL = "2026-07-01T00:00:00Z";
const PERIOD_AUG = "2026-08-01T00:00:00Z";

// ---------------------------------------------------------------------------
// Schema + fixtures
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await pglite.exec(`
    DROP TABLE IF EXISTS alerts;
    DROP TABLE IF EXISTS alert_delivery_claims;
    DROP TABLE IF EXISTS fired_thresholds;
    DROP TABLE IF EXISTS group_budgets;
    DROP TABLE IF EXISTS team_budgets;
    DROP TABLE IF EXISTS group_teams;
    DROP TABLE IF EXISTS admin_emails;
    CREATE TABLE alerts (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'group',
      entity_id TEXT NOT NULL DEFAULT '',
      entity_name TEXT NOT NULL DEFAULT '',
      workspace_ids TEXT[] NOT NULL DEFAULT '{}',
      threshold INTEGER NOT NULL,
      spend_usd DOUBLE PRECISION NOT NULL,
      budget_usd DOUBLE PRECISION NOT NULL,
      recipients TEXT[] NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE alert_delivery_claims (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      billing_period TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX alert_delivery_claims_unique
      ON alert_delivery_claims (entity_type, entity_id, billing_period, threshold);
    CREATE TABLE fired_thresholds (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'group',
      entity_id TEXT NOT NULL DEFAULT '',
      billing_period TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      fired_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX fired_thresholds_unique
      ON fired_thresholds (entity_type, entity_id, billing_period, threshold);
  `);
  // group_budgets / team_budgets / group_teams / admin_emails.
  await pglite.exec(`
    CREATE TABLE group_budgets (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL UNIQUE,
      amount_usd DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE team_budgets (
      team_name TEXT PRIMARY KEY,
      amount_usd DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE group_teams (
      group_name TEXT PRIMARY KEY,
      team_name TEXT NOT NULL
    );
    CREATE TABLE admin_emails (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO group_budgets (group_id, amount_usd) VALUES ('grp-1', 1000);
    INSERT INTO admin_emails (email) VALUES ('admin@example.com');
  `);
  sendEmailMock.mockReset().mockResolvedValue({ ok: true });
  isEmailConfiguredMock.mockReset().mockReturnValue(true);
  getSpendMock.mockReset();
  memberUsageFixture = new Map();
  extraSpendFixture = new Map();
  extraSpendComplete = true;
  extraSpendAfterForce = null;
  lastExtraWorkspaceForce = false;
  groupMembersFixture = new Map();
  directoryGroups = [GROUP];
  billingStart = PERIOD_JUL;
  periodStartAfterRawRefresh = null;
  rawSpendRefreshGroupIds = [];
});

function setSpend(spendUsd: number, periodStart = PERIOD_JUL) {
  getSpendMock.mockReturnValue({ spendUsd, periodStart });
}

// ---------------------------------------------------------------------------
// Group behavior (raw group spend) — unchanged evaluation semantics
// ---------------------------------------------------------------------------

describe("threshold dedup per (group, period, threshold)", () => {
  it("fires a threshold exactly once for the same period", async () => {
    setSpend(520); // 52% -> 50 due
    const first = await evaluateGroup(GROUP);
    expect(first).toHaveLength(1);
    expect(first[0]!.threshold).toBe(50);
    expect(first[0]!.entityType).toBe("group");
    expect(first[0]!.entityId).toBe("grp-1");
    expect(first[0]!.entityName).toBe("Engineering");
    expect(first[0]!.workspaceIds).toEqual(["ws-1"]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const second = await evaluateGroup(GROUP);
    expect(second).toHaveLength(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50]);
  });

  it("fires the next threshold when spend grows, without re-firing earlier ones", async () => {
    setSpend(520);
    await evaluateGroup(GROUP);
    setSpend(780); // 78% -> 75 newly due
    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.threshold).toBe(75);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50, 75]);
    // No change -> nothing fires
    const again = await evaluateGroup(GROUP);
    expect(again).toHaveLength(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("dedup is scoped per group", async () => {
    setSpend(520);
    await evaluateGroup(GROUP);
    await pglite.exec(
      `INSERT INTO group_budgets (group_id, amount_usd) VALUES ('grp-2', 1000)`,
    );
    const other = { ...GROUP, id: "grp-2", name: "Design" };
    const alerts = await evaluateGroup(other);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.groupId).toBe("grp-2");
  });

  it("unique index makes concurrent duplicate inserts harmless", async () => {
    setSpend(520);
    // Simulate a race: two evaluations for the same state, second insert is a no-op.
    await evaluateGroup(GROUP);
    await testDb
      .insert(schema.firedThresholdsTable)
      .values({
        groupId: "grp-1",
        entityType: "group",
        entityId: "grp-1",
        billingPeriod: PERIOD_JUL,
        threshold: 50,
      })
      .onConflictDoNothing();
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50]);
  });
});

describe("period rollover reset", () => {
  it("fires the same thresholds again in a new billing period", async () => {
    setSpend(950, PERIOD_JUL); // 95% -> 50,75,90 due
    await evaluateGroup(GROUP);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50, 75, 90]);

    setSpend(600, PERIOD_AUG); // new period, 60% -> 50 due again
    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.threshold).toBe(50);
    expect(await getFiredThresholds("grp-1", PERIOD_AUG)).toEqual([50]);
    // July history untouched
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50, 75, 90]);
  });
});

describe("highest due threshold only (email batching)", () => {
  it("sends one email for the highest threshold but marks all due as fired", async () => {
    setSpend(1200); // 120% -> all four due
    const alerts = await evaluateGroup(GROUP);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const subject = sendEmailMock.mock.calls[0]![1] as string;
    expect(subject).toContain("Allocated pool exceeded");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.threshold).toBe(100);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual(THRESHOLDS);
    // Nothing left to fire
    expect(await evaluateGroup(GROUP)).toHaveLength(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("email wording identifies the group and its allocated pool", async () => {
    setSpend(760); // 76% -> highest due 75
    await evaluateGroup(GROUP);
    const [, subject, html] = sendEmailMock.mock.calls[0]! as [
      string[],
      string,
      string,
    ];
    expect(subject).toContain("Engineering");
    expect(subject).toContain("allocated pool alert");
    expect(html).toContain("Enterprise group <strong>Engineering</strong>");
    expect(html).toContain("Allocated pool");
  });
});

describe("retry when email is unavailable", () => {
  it("does not mark thresholds fired when email is not configured, and retries later", async () => {
    isEmailConfiguredMock.mockReturnValue(false);
    setSpend(800); // 80% -> 50,75 due
    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([]);

    // Email gets connected -> next evaluation fires
    isEmailConfiguredMock.mockReturnValue(true);
    const retried = await evaluateGroup(GROUP);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.threshold).toBe(75);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50, 75]);
  });

  it("uses the mandatory Kody recipient when no additional recipients exist", async () => {
    await pglite.exec(`DELETE FROM admin_emails`);
    setSpend(800);
    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      ["kody.low@repl.it"],
      expect.any(String),
      expect.any(String),
    );
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50, 75]);
  });

  it("records a failed alert but keeps thresholds unfired when sending fails", async () => {
    sendEmailMock.mockResolvedValue({ ok: false, error: "SMTP down" });
    setSpend(800);
    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("failed");
    expect(alerts[0]!.errorMessage).toBe("SMTP down");
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([]);

    // Send recovers -> threshold fires and is then deduped
    sendEmailMock.mockResolvedValue({ ok: true });
    const retried = await evaluateGroup(GROUP);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.status).toBe("sent");
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50, 75]);
    expect(await evaluateGroup(GROUP)).toHaveLength(0);
  });
});

describe("lowering a pool below current spend is evaluated on the next run", () => {
  it("fires newly-crossed thresholds when the group pool is reduced", async () => {
    setSpend(400); // 40% of 1000 -> nothing due
    expect(await evaluateGroup(GROUP)).toHaveLength(0);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([]);

    // Owner lowers the pool to $500 -> spend is now 80% -> 50,75 due
    await pglite.exec(`UPDATE group_budgets SET amount_usd = 500 WHERE group_id = 'grp-1'`);
    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.threshold).toBe(75);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([50, 75]);
  });
});

// ---------------------------------------------------------------------------
// Team behavior: cross-workspace deduped aggregation via runCheck
// ---------------------------------------------------------------------------

describe("team allocated pool checks", () => {
  // Two groups in different workspaces belong to the same team "Platform".
  const grpA: EnterpriseGroup = { id: "gA", workspaceId: "ws-1", name: "Alpha" } as EnterpriseGroup;
  const grpB: EnterpriseGroup = { id: "gB", workspaceId: "ws-2", name: "Beta" } as EnterpriseGroup;

  async function configureTeam(amountUsd: number) {
    await pglite.exec(`DELETE FROM group_budgets`); // isolate team-only behavior
    await pglite.exec(`
      INSERT INTO group_teams (group_name, team_name) VALUES ('Alpha', 'Platform'), ('Beta', 'Platform');
      INSERT INTO team_budgets (team_name, amount_usd) VALUES ('Platform', ${amountUsd});
    `);
    directoryGroups = [grpA, grpB];
    groupMembersFixture = new Map([
      ["gA", ["u1", "u2"]],
      ["gB", ["u2", "u3"]], // u2 overlaps both groups
    ]);
  }

  it("aggregates deduped cross-workspace team spend and fires against the team pool", async () => {
    await configureTeam(1000);
    // u2 appears in both groups with the same $300 observation (same account-level
    // usage exposed through overlapping filters) -> counted once, attributed to Alpha.
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 200], ["u2", 300]])],
      ["gB", new Map([["u2", 300], ["u3", 100]])],
    ]);
    // Team spend = 200 + 300 + 100 = 600 (u2 counted once) -> 60% -> 50 due.
    const result = await runCheck(true);
    expect(result.checkedGroups).toBe(0);
    expect(result.checkedTeams).toBe(1);
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.entityType).toBe("team");
    expect(alert.entityId).toBe("Platform");
    expect(alert.entityName).toBe("Platform");
    expect(alert.threshold).toBe(50);
    expect(alert.spendUsd).toBeCloseTo(600);
    expect(alert.budgetUsd).toBe(1000);
    // Both contributing workspaces recorded for scoping.
    expect([...alert.workspaceIds].sort()).toEqual(["ws-1", "ws-2"]);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50]);
  });

  it("establishes a billing-period anchor when only team pools are configured", async () => {
    await configureTeam(1000);
    billingStart = null;
    periodStartAfterRawRefresh = PERIOD_JUL;
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 400]])],
      ["gB", new Map([["u3", 200]])],
    ]);

    const result = await runCheck(true);
    expect(result.checkedGroups).toBe(0);
    expect(rawSpendRefreshGroupIds).toContain("gA");
    expect(result.checkedTeams).toBe(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.entityType).toBe("team");
    expect(result.alerts[0]!.threshold).toBe(50);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50]);
  });

  it("adds cross-workspace (extra) spend to the attributed member exactly once", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 100]])],
      ["gB", new Map([["u3", 100]])],
    ]);
    // u1 also has $500 of spend in a workspace without custom groups.
    extraSpendFixture = new Map([["u1", 500]]);
    // Team spend = (100 + 500) + 100 = 700 -> 70% -> 50 due.
    const result = await runCheck(true);
    expect(result.checkedTeams).toBe(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.spendUsd).toBeCloseTo(700);
    expect(result.alerts[0]!.threshold).toBe(50);
  });

  it("force-refreshes extra-workspace spend before evaluating a team", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 100]])],
      ["gB", new Map([["u3", 100]])],
    ]);
    // The previously complete cache would put the team at 40%, while the
    // refreshed upstream value puts it at 60% and should fire 50%.
    extraSpendFixture = new Map([["u1", 200]]);
    extraSpendAfterForce = new Map([["u1", 400]]);

    const result = await runCheck(true);
    expect(lastExtraWorkspaceForce).toBe(true);
    expect(result.checkedTeams).toBe(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.spendUsd).toBeCloseTo(600);
    expect(result.alerts[0]!.threshold).toBe(50);
  });

  it("team thresholds dedup per period and reset on rollover", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 500]])],
      ["gB", new Map([["u3", 450]])],
    ]);
    // 95% -> 50,75,90 due (one email for the highest).
    const first = await runCheck(true);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]!.threshold).toBe(90);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50, 75, 90]);

    // Same period, no change -> nothing new fires.
    const again = await runCheck(true);
    expect(again.alerts).toHaveLength(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // New billing period -> thresholds reset and fire again.
    billingStart = PERIOD_AUG;
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 300]])],
      ["gB", new Map([["u3", 300]])],
    ]);
    const rolled = await runCheck(true); // 60% -> 50 due
    expect(rolled.alerts).toHaveLength(1);
    expect(rolled.alerts[0]!.threshold).toBe(50);
    expect(await getFiredThresholds("Platform", PERIOD_AUG, "team")).toEqual([50]);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50, 75, 90]);
  });

  it("team send failure keeps thresholds unfired and retries next run", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 600]])],
      ["gB", new Map([["u3", 200]])],
    ]);
    sendEmailMock.mockResolvedValue({ ok: false, error: "SMTP down" });
    const failed = await runCheck(true); // 80% -> 50,75 due
    expect(failed.alerts).toHaveLength(1);
    expect(failed.alerts[0]!.status).toBe("failed");
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([]);

    sendEmailMock.mockResolvedValue({ ok: true });
    const retried = await runCheck(true);
    expect(retried.alerts).toHaveLength(1);
    expect(retried.alerts[0]!.status).toBe("sent");
    expect(retried.alerts[0]!.threshold).toBe(75);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50, 75]);
  });

  it("defers team evaluation until extra-workspace attribution is complete", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 600]])],
      ["gB", new Map([["u3", 200]])],
    ]);
    extraSpendComplete = false;
    const deferred = await runCheck(true);
    expect(deferred.checkedTeams).toBe(0);
    expect(deferred.alerts).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([]);

    extraSpendComplete = true;
    const retried = await runCheck(true);
    expect(retried.checkedTeams).toBe(1);
    expect(retried.alerts).toHaveLength(1);
  });

  it("still evaluates independent group pools while team data is incomplete", async () => {
    await configureTeam(1000);
    await pglite.exec(`INSERT INTO group_budgets (group_id, amount_usd) VALUES ('grp-1', 1000)`);
    directoryGroups = [GROUP, ...directoryGroups];
    groupMembersFixture.set("grp-1", ["ug"]);
    memberUsageFixture = new Map([
      ["grp-1", new Map([["ug", 600]])],
      ["gA", new Map([["u1", 600]])],
      ["gB", new Map([["u3", 200]])],
    ]);
    setSpend(600);
    extraSpendComplete = false;

    const result = await runCheck(true);
    expect(result.checkedGroups).toBe(1);
    expect(result.checkedTeams).toBe(0);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.entityType).toBe("group");
    expect(await getFiredThresholds("grp-1", PERIOD_JUL, "group")).toEqual([50]);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([]);
  });

  it("serializes concurrent team evaluations so one threshold sends once", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 600]])],
      ["gB", new Map([["u3", 200]])],
    ]);
    const [first, second] = await Promise.all([runCheck(true), runCheck(true)]);
    // Both callers share the same in-flight result, but delivery happens once.
    expect(first.alerts).toHaveLength(1);
    expect(second.alerts).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50, 75]);
  });

  it("group and team dedup are independent even with the same identifier space", async () => {
    // Group check on grp-1 and a team both crossing 50% do not interfere.
    setSpend(600); // grp-1 at 60% of 1000
    await pglite.exec(`
      INSERT INTO group_teams (group_name, team_name) VALUES ('Alpha', 'Platform');
      INSERT INTO team_budgets (team_name, amount_usd) VALUES ('Platform', 1000);
    `);
    directoryGroups = [GROUP, { id: "gA", workspaceId: "ws-1", name: "Alpha" } as EnterpriseGroup];
    groupMembersFixture = new Map([
      ["grp-1", ["ug"]],
      ["gA", ["u1"]],
    ]);
    // Member usage must be present for every directory group so the team rollup
    // wait resolves; grp-1 is not mapped to a team so it does not affect Platform.
    memberUsageFixture = new Map([
      ["grp-1", new Map([["ug", 600]])],
      ["gA", new Map([["u1", 600]])],
    ]);

    const result = await runCheck(true);
    expect(result.checkedGroups).toBe(1);
    expect(result.checkedTeams).toBe(1);
    const kinds = result.alerts.map((a) => a.entityType).sort();
    expect(kinds).toEqual(["group", "team"]);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL, "group")).toEqual([50]);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50]);
  });

  it("email wording identifies the team and its allocated pool", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 400]])],
      ["gB", new Map([["u3", 400]])],
    ]);
    await runCheck(true); // 80% -> highest due 75
    const [, subject, html] = sendEmailMock.mock.calls[0]! as [
      string[],
      string,
      string,
    ];
    expect(subject).toContain("Platform");
    expect(subject).toContain("allocated pool alert");
    expect(html).toContain("Enterprise team <strong>Platform</strong>");
    expect(html).toContain("Allocated pool");
  });
});
