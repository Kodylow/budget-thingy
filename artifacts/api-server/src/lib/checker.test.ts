import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@workspace/db/schema";

const { pglite, testDb } = await vi.hoisted(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@workspace/db/schema");
  const pglite = new PGlite();
  return { pglite, testDb: drizzle(pglite, { schema }) };
});

vi.mock("@workspace/db", async () => {
  const actualSchema = await import("@workspace/db/schema");
  return {
    ...actualSchema,
    db: testDb,
    pool: {
      query: (text: string, values?: unknown[]) => pglite.query(text, values),
    },
  };
});

const sendEmailMock = vi.fn();
vi.mock("./email", async () => {
  const actual = await vi.importActual<typeof import("./email")>("./email");
  return {
    buildAlertEmail: actual.buildAlertEmail,
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
    isEmailConfigured: () => true,
  };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface TestGroup {
  id: string;
  workspaceId: string;
  name: string;
}

const GROUP: TestGroup = {
  id: "grp-1",
  workspaceId: "ws-1",
  name: "Engineering",
};
let groups: TestGroup[] = [GROUP];
let groupMembers = new Map<string, string[]>([[GROUP.id, ["u-1"]]]);

vi.mock("./enterprise", async () => {
  const actual = await vi.importActual<typeof import("./enterprise")>("./enterprise");
  return {
    ...actual,
    getDirectory: async () => ({
      fetchedAt: Date.now(),
      groups,
      allGroups: groups,
      groupMembers,
      members: new Map(),
      workspaces: new Map([
        ["ws-1", { id: "ws-1", name: "Acme Workspace" }],
        ["ws-2", { id: "ws-2", name: "Beta Workspace" }],
      ]),
      budgets: {
        groupLimits: new Map(),
        userLimits: new Map(),
        workspaceDefaults: new Map(),
      },
    }),
    getBillingPeriod: () => ({
      start: PERIOD_START,
      end: PERIOD_END,
      label: "July 2099",
    }),
  };
});

import {
  evaluateGroup,
  getFiredThresholds,
  getFiredThresholdsBatch,
  runCheck,
  THRESHOLDS,
} from "./checker";
import { invalidateUsageSnapshotMemo } from "./usage-store";
import type { EnterpriseGroup } from "./enterprise";

const NOW = new Date("2099-07-15T12:00:00.000Z");
const PERIOD_START = "2099-07-01T00:00:00.000Z";
const PERIOD_END = "2099-08-01T00:00:00.000Z";
const USAGE_DATE = "2099-07-15";
const DATA_AS_OF = new Date("2099-07-15T12:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await pglite.exec(`
    DROP TABLE IF EXISTS alerts, alert_delivery_claims, fired_thresholds,
      group_budgets, team_budget_adjustments, team_budget_sync_state,
      team_budgets, team_limit_targets, workspace_default_limit_targets,
      team_budget_upstream_sync, admin_emails, budget_checker_state,
      api_project_metadata, usage_member_day, usage_project_day,
      usage_workspace_day, usage_account_day CASCADE;
    CREATE TABLE alerts (
      id SERIAL PRIMARY KEY, group_id TEXT NOT NULL, group_name TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'group', entity_id TEXT NOT NULL DEFAULT '',
      entity_name TEXT NOT NULL DEFAULT '', workspace_ids TEXT[] NOT NULL DEFAULT '{}',
      threshold INTEGER NOT NULL, spend_usd DOUBLE PRECISION NOT NULL,
      budget_usd DOUBLE PRECISION NOT NULL, recipients TEXT[] NOT NULL,
      status TEXT NOT NULL, error_message TEXT, data_as_of TIMESTAMPTZ,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE alert_delivery_claims (
      id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      billing_period TEXT NOT NULL, threshold INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed', claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(entity_type, entity_id, billing_period, threshold)
    );
    CREATE TABLE fired_thresholds (
      id SERIAL PRIMARY KEY, group_id TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'group', entity_id TEXT NOT NULL DEFAULT '',
      billing_period TEXT NOT NULL, threshold INTEGER NOT NULL,
      fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(entity_type, entity_id, billing_period, threshold)
    );
    CREATE TABLE group_budgets (
      id SERIAL PRIMARY KEY, group_id TEXT NOT NULL UNIQUE,
      amount_usd DOUBLE PRECISION NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE team_budgets (
      team_name TEXT PRIMARY KEY, original_amount_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      amount_usd DOUBLE PRECISION NOT NULL, monthly_limit_usd DOUBLE PRECISION,
      monthly_limit_source TEXT NOT NULL DEFAULT 'derived',
      is_hidden BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE team_budget_adjustments (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source TEXT NOT NULL DEFAULT 'airtable',
      source_record_id TEXT NOT NULL, source_team_status TEXT, source_team_name TEXT,
      team_name TEXT, amount_usd DOUBLE PRECISION, submission_period TEXT,
      match_state TEXT NOT NULL, error_message TEXT, source_updated_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE team_budget_sync_state (
      id INTEGER PRIMARY KEY, last_attempt_at TIMESTAMPTZ, last_successful_at TIMESTAMPTZ,
      last_error TEXT, record_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0, issue_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE team_limit_targets (
      team_name TEXT NOT NULL, workspace_id TEXT NOT NULL, group_id TEXT NOT NULL,
      group_name TEXT NOT NULL, monthly_limit_usd DOUBLE PRECISION,
      is_enabled BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY(workspace_id, group_id)
    );
    CREATE TABLE workspace_default_limit_targets (
      workspace_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      monthly_limit_usd DOUBLE PRECISION NOT NULL DEFAULT 1,
      is_enabled BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE team_budget_upstream_sync (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, team_name TEXT NOT NULL,
      workspace_id TEXT, target_group_id TEXT, target_group_name TEXT,
      target_type TEXT NOT NULL DEFAULT 'group', desired_amount_usd DOUBLE PRECISION NOT NULL,
      upstream_amount_usd DOUBLE PRECISION, status TEXT NOT NULL DEFAULT 'failed',
      reason TEXT, last_attempt_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE admin_emails (
      id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE budget_checker_state (
      id TEXT PRIMARY KEY DEFAULT 'singleton', last_successful_evaluation_at TIMESTAMPTZ,
      last_evaluated_data_as_of TIMESTAMPTZ, last_attempt_at TIMESTAMPTZ,
      last_skip_reason TEXT
    );
    CREATE TABLE api_project_metadata (
      workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT,
      creator_id TEXT, fetched_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(workspace_id, project_id)
    );
    CREATE TABLE usage_member_day (
      workspace_id TEXT NOT NULL, usage_date DATE NOT NULL, user_id TEXT NOT NULL,
      total_cost_usd DOUBLE PRECISION NOT NULL, ai_cost_usd DOUBLE PRECISION NOT NULL,
      metrics_json JSONB NOT NULL, fetched_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(workspace_id, usage_date, user_id)
    );
    CREATE TABLE usage_project_day (
      workspace_id TEXT NOT NULL, usage_date DATE NOT NULL, project_id TEXT NOT NULL,
      total_cost_usd DOUBLE PRECISION NOT NULL, metrics_json JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(workspace_id, usage_date, project_id)
    );
    CREATE TABLE usage_workspace_day (
      workspace_id TEXT NOT NULL, usage_date DATE NOT NULL,
      total_cost_usd DOUBLE PRECISION NOT NULL, member_attributable_usd DOUBLE PRECISION NOT NULL,
      member_unattributable_usd DOUBLE PRECISION NOT NULL, metrics_json JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL, error TEXT,
      PRIMARY KEY(workspace_id, usage_date)
    );
    CREATE TABLE usage_account_day (
      usage_date DATE PRIMARY KEY, total_cost_usd DOUBLE PRECISION NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL
    );
    INSERT INTO group_budgets(group_id, amount_usd) VALUES ('grp-1', 1000);
    INSERT INTO admin_emails(email) VALUES ('admin@example.com');
  `);
  groups = [GROUP];
  groupMembers = new Map([[GROUP.id, ["u-1"]]]);
  sendEmailMock.mockReset().mockResolvedValue({ ok: true });
  invalidateUsageSnapshotMemo();
});

afterEach(() => {
  vi.useRealTimers();
});

async function insertCompleteUsage(
  byWorkspace: Record<string, Array<{ userId: string; spendUsd: number }>>,
): Promise<void> {
  let accountTotal = 0;
  for (const workspaceId of ["ws-1", "ws-2"]) {
    const members = byWorkspace[workspaceId] ?? [];
    const total = members.reduce((sum, member) => sum + member.spendUsd, 0);
    accountTotal += total;
    for (const member of members) {
      await pglite.query(
        `INSERT INTO usage_member_day
          (workspace_id,usage_date,user_id,total_cost_usd,ai_cost_usd,metrics_json,fetched_at)
         VALUES ($1,$2,$3,$4,$4,'{}',$5)`,
        [workspaceId, USAGE_DATE, member.userId, member.spendUsd, DATA_AS_OF],
      );
    }
    for (let day = 1; day <= 15; day++) {
      const usageDate = `2099-07-${String(day).padStart(2, "0")}`;
      const dailyTotal = usageDate === USAGE_DATE ? total : 0;
      await pglite.query(
        `INSERT INTO usage_workspace_day
          (workspace_id,usage_date,total_cost_usd,member_attributable_usd,
           member_unattributable_usd,metrics_json,fetched_at,status)
         VALUES ($1,$2,$3,$3,0,'{}',$4,'complete')`,
        [workspaceId, usageDate, dailyTotal, DATA_AS_OF],
      );
    }
  }
  for (let day = 1; day <= 15; day++) {
    const usageDate = `2099-07-${String(day).padStart(2, "0")}`;
    await pglite.query(
      `INSERT INTO usage_account_day(usage_date,total_cost_usd,fetched_at)
       VALUES ($1,$2,$3)`,
      [usageDate, usageDate === USAGE_DATE ? accountTotal : 0, DATA_AS_OF],
    );
  }
  invalidateUsageSnapshotMemo();
}

describe("checker Postgres snapshot cutover", () => {
  it("uses Postgres daily facts and not legacy canonical usage", async () => {
    await insertCompleteUsage({
      "ws-1": [{ userId: "u-1", spendUsd: 800 }],
    });
    const alerts = await evaluateGroup(GROUP as EnterpriseGroup);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      entityType: "group",
      entityId: "grp-1",
      spendUsd: 800,
      threshold: 75,
      dataAsOf: DATA_AS_OF,
    });
  });

  it("marks every crossed threshold while emailing only the highest once", async () => {
    await insertCompleteUsage({
      "ws-1": [{ userId: "u-1", spendUsd: 1200 }],
    });
    const first = await evaluateGroup(GROUP as EnterpriseGroup);
    expect(first[0]?.threshold).toBe(100);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await getFiredThresholds(GROUP.id, PERIOD_START)).toEqual(THRESHOLDS);
    expect(await evaluateGroup(GROUP as EnterpriseGroup)).toEqual([]);
  });

  it("loads fired state with one set-based read", async () => {
    await pglite.exec(`
      INSERT INTO fired_thresholds(group_id,entity_type,entity_id,billing_period,threshold)
      VALUES ('grp-1','group','grp-1','${PERIOD_START}',50),
             ('grp-2','group','grp-2','${PERIOD_START}',75)
    `);
    expect(await getFiredThresholdsBatch(
      ["grp-2", "grp-1", "missing", "grp-1"],
      PERIOD_START,
    )).toEqual(new Map([
      ["grp-2", [75]],
      ["grp-1", [50]],
      ["missing", []],
    ]));
  });

  it("skips incomplete Postgres coverage and preserves durable success", async () => {
    await insertCompleteUsage({
      "ws-1": [{ userId: "u-1", spendUsd: 100 }],
    });
    const successful = await runCheck();
    expect(successful.skipped).toBe(false);

    await pglite.exec(`DELETE FROM usage_workspace_day WHERE workspace_id='ws-2'`);
    invalidateUsageSnapshotMemo();
    const skipped = await runCheck();
    expect(skipped).toMatchObject({
      skipped: true,
      checkedGroups: 0,
      checkedTeams: 0,
      skipReason: "Postgres usage snapshot is incomplete",
    });
    const [state] = await testDb.select().from(schema.budgetCheckerStateTable);
    expect(state?.lastSuccessfulEvaluationAt?.getTime())
      .toBe(successful.evaluatedAt?.getTime());
    expect(state?.lastEvaluatedDataAsOf).toEqual(DATA_AS_OF);
  });

  it("accounts for the same user independently in distinct workspaces", async () => {
    groups = [
      { id: "g-a", workspaceId: "ws-1", name: "Alpha" },
      { id: "g-b", workspaceId: "ws-2", name: "Beta" },
    ];
    groupMembers = new Map([
      ["g-a", ["shared"]],
      ["g-b", ["shared"]],
    ]);
    await pglite.exec(`
      DELETE FROM group_budgets;
      INSERT INTO team_limit_targets(workspace_id,group_id,group_name,team_name)
      VALUES ('ws-1','g-a','Alpha','Platform'),('ws-2','g-b','Beta','Platform');
      INSERT INTO team_budgets(team_name,original_amount_usd,amount_usd)
      VALUES ('Platform',1000,1000);
    `);
    await insertCompleteUsage({
      "ws-1": [{ userId: "shared", spendUsd: 300 }],
      "ws-2": [{ userId: "shared", spendUsd: 300 }],
    });
    const result = await runCheck();
    expect(result.checkedTeams).toBe(1);
    expect(result.alerts[0]).toMatchObject({
      entityType: "team",
      entityId: "Platform",
      spendUsd: 600,
      threshold: 50,
    });
  });

  it("attributes identical nonlegacy group names by workspace and group identity", async () => {
    groups = [
      { id: "g-a", workspaceId: "ws-1", name: "Shared Name" },
      { id: "g-b", workspaceId: "ws-2", name: "Shared Name" },
    ];
    groupMembers = new Map([["g-a", ["u-a"]], ["g-b", ["u-b"]]]);
    await pglite.exec(`
      DELETE FROM group_budgets;
      INSERT INTO team_limit_targets(workspace_id,group_id,group_name,team_name)
      VALUES ('ws-1','g-a','Shared Name','Team A'),('ws-2','g-b','Shared Name','Team B');
      INSERT INTO team_budgets(team_name,original_amount_usd,amount_usd)
      VALUES ('Team A',1000,1000),('Team B',1000,1000);
    `);
    await insertCompleteUsage({
      "ws-1": [{ userId: "u-a", spendUsd: 600 }],
      "ws-2": [{ userId: "u-b", spendUsd: 600 }],
    });
    const result = await runCheck();
    expect(result.checkedTeams).toBe(2);
    expect(result.alerts.map((alert) => alert.entityId).sort())
      .toEqual(["Team A", "Team B"]);
  });

  it("keeps group and team threshold identities independent", async () => {
    groups = [
      GROUP,
      { id: "g-a", workspaceId: "ws-1", name: "Alpha" },
    ];
    groupMembers = new Map([
      [GROUP.id, ["u-1"]],
      ["g-a", ["u-2"]],
    ]);
    await pglite.exec(`
      INSERT INTO team_limit_targets(workspace_id,group_id,group_name,team_name)
      VALUES ('ws-1','g-a','Alpha','Platform');
      INSERT INTO team_budgets(team_name,original_amount_usd,amount_usd)
      VALUES ('Platform',1000,1000);
    `);
    await insertCompleteUsage({
      "ws-1": [
        { userId: "u-1", spendUsd: 600 },
        { userId: "u-2", spendUsd: 600 },
      ],
    });
    const result = await runCheck();
    expect(result.alerts.map((alert) => alert.entityType).sort())
      .toEqual(["group", "team"]);
    expect(await getFiredThresholds(GROUP.id, PERIOD_START, "group")).toEqual([50]);
    expect(await getFiredThresholds("Platform", PERIOD_START, "team")).toEqual([50]);
  });
});