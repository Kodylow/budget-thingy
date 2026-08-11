import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "@workspace/db/schema";

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

const getSpendMock = vi.fn();
vi.mock("./enterprise", () => ({
  isConfigured: () => true,
  getSpend: (groupId: string) => getSpendMock(groupId),
  getDirectory: async () => ({
    groups: [GROUP],
    workspaces: new Map([["ws-1", { id: "ws-1", name: "Acme Workspace" }]]),
  }),
  getBillingPeriod: () => ({ label: "July 2026" }),
  queueGroupSpendFetch: () => false,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { evaluateGroup, getFiredThresholds, THRESHOLDS } from "./checker";
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
    DROP TABLE IF EXISTS fired_thresholds;
    DROP TABLE IF EXISTS group_budgets;
    DROP TABLE IF EXISTS admin_emails;
    CREATE TABLE alerts (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      spend_usd DOUBLE PRECISION NOT NULL,
      budget_usd DOUBLE PRECISION NOT NULL,
      recipients TEXT[] NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE fired_thresholds (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      billing_period TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      fired_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX fired_thresholds_unique
      ON fired_thresholds (group_id, billing_period, threshold);
  `);
  // group_budgets / admin_emails: create from actual schema names.
  await pglite.exec(`
    CREATE TABLE group_budgets (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL UNIQUE,
      amount_usd DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
});

function setSpend(spendUsd: number, periodStart = PERIOD_JUL) {
  getSpendMock.mockReturnValue({ spendUsd, periodStart });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("threshold dedup per (group, period, threshold)", () => {
  it("fires a threshold exactly once for the same period", async () => {
    setSpend(520); // 52% -> 50 due
    const first = await evaluateGroup(GROUP);
    expect(first).toHaveLength(1);
    expect(first[0]!.threshold).toBe(50);
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
      .values({ groupId: "grp-1", billingPeriod: PERIOD_JUL, threshold: 50 })
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
    expect(subject).toContain("Budget exceeded");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.threshold).toBe(100);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual(THRESHOLDS);
    // Nothing left to fire
    expect(await evaluateGroup(GROUP)).toHaveLength(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
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

  it("does not mark thresholds fired when there are no admin recipients", async () => {
    await pglite.exec(`DELETE FROM admin_emails`);
    setSpend(800);
    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([]);
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
