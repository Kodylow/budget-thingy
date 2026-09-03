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
// Enterprise mock: canonical group/team rollups are driven by fixture
// member-usage maps run through the real deduping helper. getSpendMock remains
// only as a compatibility fixture for billing-period/raw reconciliation tests.
// ---------------------------------------------------------------------------

const getSpendMock = vi.fn();
let periodStartAfterRawRefresh: string | null = null;
let rawSpendRefreshGroupIds: string[] = [];
let rawSpendCallbacks = new Map<string, () => void>();
let rawSpendFetchResult: "fresh_cache" | "queued" = "fresh_cache";

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
const CHECK_DATA_AS_OF = new Date("2026-07-15T00:00:00.000Z");
let storedSnapshotSkipReason: string | null = null;

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
  getStoredBudgetEvaluationSnapshot: async () => storedSnapshotSkipReason ? ({
    snapshot: null,
    skipReason: storedSnapshotSkipReason,
  }) : ({
    snapshot: {
      directory: {
        fetchedAt: Date.now(),
        groups: directoryGroups,
        allGroups: directoryGroups,
        members: new Map(),
        workspaces: new Map([
          ["ws-1", { id: "ws-1", name: "Acme Workspace" }],
          ["ws-2", { id: "ws-2", name: "Beta Workspace" }],
        ]),
        groupMembers: groupMembersFixture,
        budgets: {
          groupLimits: new Map(),
          userLimits: new Map(),
          workspaceDefaults: new Map(),
        },
      },
      rangeKey: "budget-check:fixture",
      dataAsOf: CHECK_DATA_AS_OF,
    },
    skipReason: null,
  }),
  getBillingPeriod: () => ({ label: "July 2026", start: billingStart }),
  // Spend is provided synchronously via getSpendMock, so report a fresh cache to
  // let runCheck's spend-refresh wait resolve immediately.
  queueGroupSpendFetch: (
    group: EnterpriseGroup,
    _priority: number,
    _force: boolean,
    callback?: () => void,
  ) => {
    rawSpendRefreshGroupIds.push(group.id);
    if (callback) rawSpendCallbacks.set(group.id, callback);
    if (periodStartAfterRawRefresh) billingStart = periodStartAfterRawRefresh;
    return rawSpendFetchResult;
  },
  queueMemberUsageFetch: () => false,
  queueProjectUsageFetch: () => false,
  queueProjectTitlesFetch: () => false,
  queueAllWorkspacesFetch: () => undefined,
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
  getWorkspaceMemberUsage: () =>
    extraSpendComplete
      ? {
          fetchedAt: Date.now(),
          byUser: extraSpendFixture,
          attributableTotalCostUsd: 0,
          unattributableTotalCostUsd: 0,
          totalCostUsd: 0,
        }
      : undefined,
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
    _workspaceIds?: ReadonlySet<string>,
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
        byUser.set(uid, s + (extraSpendFixture.get(uid) ?? 0));
      }
      usageByGroup.set(g.id, { byUser, unattributableTotalCostUsd: 0 });
    }
    return computeDedupedUsageRollup(
      groups.map((g) => ({ id: g.id, workspaceId: g.workspaceId, name: g.name })),
      usageByGroup,
    );
  },
  getCanonicalUsage: (
    groups: EnterpriseGroup[],
    _rangeKey: string,
    _workspaceIds?: ReadonlySet<string>,
    _groupMembers?: ReadonlyMap<string, readonly string[]>,
    _directoryMembers?: unknown,
    teamByGroupName?: ReadonlyMap<string, string>,
    workspaces?: ReadonlyMap<string, { name: string }>,
    _includeAccountMetadata?: boolean,
    requireGroupMemberUsage?: boolean,
  ) => {
    const usageByGroup = new Map<
      string,
      { byUser: Map<string, number>; unattributableTotalCostUsd: number }
    >();
    for (const g of groups) {
      const base = memberUsageFixture.get(g.id);
      if (base) {
        const byUser = new Map<string, number>();
        for (const [uid, s] of base) byUser.set(uid, s + (extraSpendFixture.get(uid) ?? 0));
        usageByGroup.set(g.id, { byUser, unattributableTotalCostUsd: 0 });
      } else {
        const raw = getSpendMock(g.id);
        if (raw) {
          usageByGroup.set(g.id, {
            byUser: new Map([[`canonical:${g.id}`, raw.spendUsd]]),
            unattributableTotalCostUsd: 0,
          });
        }
      }
    }
    const rollup = computeDedupedUsageRollup(
      groups.map((g) => ({ id: g.id, workspaceId: g.workspaceId, name: g.name })),
      usageByGroup,
    );
    const mergeMap = new Map<string, string[]>();
    const hiddenGroupIds = new Set<string>();
    const primaryByGroupId = new Map<string, string>();
    const displayGroups: EnterpriseGroup[] = [];
    for (const group of groups) {
      if (primaryByGroupId.has(group.id)) continue;
      const sameName = groups.filter((candidate) =>
        candidate.name.trim().toLowerCase() === group.name.trim().toLowerCase());
      const body = group.name.replace(/^az-replit\s*[-–]\s*/i, "").toLowerCase().trim();
      const primary = sameName.find((candidate) => {
        const workspaceName = (workspaces?.get(candidate.workspaceId)?.name ?? "").toLowerCase();
        const token = workspaceName.split(/[-\s]+/)[0] ?? "";
        return token.length >= 2 && body.startsWith(token);
      }) ?? sameName.slice().sort(
        (a, b) =>
          (workspaces?.get(a.workspaceId)?.name ?? "").localeCompare(
            workspaces?.get(b.workspaceId)?.name ?? "",
          ) || a.id.localeCompare(b.id),
      )[0]!;
      mergeMap.set(primary.id, sameName.map((candidate) => candidate.id));
      displayGroups.push(primary);
      for (const candidate of sameName) {
        primaryByGroupId.set(candidate.id, primary.id);
        if (candidate.id !== primary.id) hiddenGroupIds.add(candidate.id);
      }
    }
    const spendByPrimaryGroup = new Map(
      displayGroups.map((group) => [
        group.id,
        (mergeMap.get(group.id) ?? [group.id]).reduce(
          (sum, id) => sum + (rollup.byGroup.get(id)?.spendUsd ?? 0),
          0,
        ),
      ]),
    );
    const byTeam = new Map<string, number>();
    for (const group of displayGroups) {
      const team = teamByGroupName?.get(group.name);
      if (team) byTeam.set(
        team,
        (byTeam.get(team) ?? 0) + (spendByPrimaryGroup.get(group.id) ?? 0),
      );
    }
    return {
      ...rollup,
      mergePlan: { mergeMap, hiddenGroupIds, primaryByGroupId },
      displayGroups,
      spendByPrimaryGroup,
      byTeam,
      isComplete:
        extraSpendComplete &&
        (!requireGroupMemberUsage || groups.every((group) => memberUsageFixture.has(group.id))),
      pendingCount:
        (extraSpendComplete ? 0 : 1) +
        (requireGroupMemberUsage
          ? groups.filter((group) => !memberUsageFixture.has(group.id)).length
          : 0),
    };
  },
  buildCanonicalGroupMergePlan: (
    groups: EnterpriseGroup[],
    workspaces?: ReadonlyMap<string, { name: string }>,
  ) => {
    const mergeMap = new Map<string, string[]>();
    const hiddenGroupIds = new Set<string>();
    const primaryByGroupId = new Map<string, string>();
    for (const group of groups) {
      if (primaryByGroupId.has(group.id)) continue;
      const sameName = groups.filter((candidate) =>
        candidate.name.trim().toLowerCase() === group.name.trim().toLowerCase());
      const body = group.name.replace(/^az-replit\s*[-–]\s*/i, "").toLowerCase().trim();
      const primary = sameName.find((candidate) => {
        const workspaceName = (workspaces?.get(candidate.workspaceId)?.name ?? "").toLowerCase();
        const token = workspaceName.split(/[-\s]+/)[0] ?? "";
        return token.length >= 2 && body.startsWith(token);
      }) ?? sameName.slice().sort(
        (a, b) =>
          (workspaces?.get(a.workspaceId)?.name ?? "").localeCompare(
            workspaces?.get(b.workspaceId)?.name ?? "",
          ) || a.id.localeCompare(b.id),
      )[0]!;
      mergeMap.set(primary.id, sameName.map((candidate) => candidate.id));
      for (const candidate of sameName) {
        primaryByGroupId.set(candidate.id, primary.id);
        if (candidate.id !== primary.id) hiddenGroupIds.add(candidate.id);
      }
    }
    return { mergeMap, hiddenGroupIds, primaryByGroupId };
  },
  resolveCanonicalMergedGroupBudget: (
    primaryGroupId: string,
    mergePlan: { mergeMap: Map<string, string[]> },
    budgets: ReadonlyMap<string, number>,
  ) => {
    const primary = budgets.get(primaryGroupId);
    if (primary != null) return { amountUsd: primary, sourceGroupId: primaryGroupId };
    const aliasId = (mergePlan.mergeMap.get(primaryGroupId) ?? [])
      .filter((id) => id !== primaryGroupId && budgets.has(id))
      .sort()[0];
    return aliasId
      ? { amountUsd: budgets.get(aliasId)!, sourceGroupId: aliasId }
      : null;
  },
  resolveRange: () => ({ key: "billing:from-cutoff", label: "July 2026", type: "billing" }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  evaluateGroup,
  getFiredThresholds,
  getFiredThresholdsBatch,
  runCheck,
  startChecker,
  THRESHOLDS,
} from "./checker";
import {
  getCanonicalUsage,
  resolveCanonicalMergedGroupBudget,
  type EnterpriseGroup,
} from "./enterprise";

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
    DROP TABLE IF EXISTS team_budget_adjustments;
    DROP TABLE IF EXISTS team_budget_sync_state;
    DROP TABLE IF EXISTS team_budgets;
    DROP TABLE IF EXISTS group_teams;
    DROP TABLE IF EXISTS admin_emails;
    DROP TABLE IF EXISTS budget_checker_state;
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
      data_as_of TIMESTAMPTZ,
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
      original_amount_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      amount_usd DOUBLE PRECISION NOT NULL,
      is_hidden BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE team_budget_adjustments (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'airtable',
      source_record_id TEXT NOT NULL,
      source_team_status TEXT,
      source_team_name TEXT,
      team_name TEXT,
      amount_usd DOUBLE PRECISION,
      submission_period TEXT,
      match_state TEXT NOT NULL,
      error_message TEXT,
      source_updated_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX team_budget_adjustments_source_identity_idx
      ON team_budget_adjustments (source, source_record_id);
    CREATE TABLE team_budget_sync_state (
      id INTEGER PRIMARY KEY,
      last_attempt_at TIMESTAMPTZ,
      last_successful_at TIMESTAMPTZ,
      last_error TEXT,
      record_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      issue_count INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE budget_checker_state (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      last_successful_evaluation_at TIMESTAMPTZ,
      last_evaluated_data_as_of TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      last_skip_reason TEXT
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
  storedSnapshotSkipReason = null;
  periodStartAfterRawRefresh = null;
  rawSpendRefreshGroupIds = [];
  rawSpendCallbacks = new Map();
  rawSpendFetchResult = "fresh_cache";
});

function setSpend(
  spendUsd: number,
  periodStart = PERIOD_JUL,
  populateMemberUsage = true,
) {
  getSpendMock.mockReturnValue({ spendUsd, periodStart });
  billingStart = periodStart;
  if (populateMemberUsage) {
    for (const group of directoryGroups) {
      const existing = memberUsageFixture.get(group.id);
      if (!existing || existing.has(`canonical:${group.id}`)) {
        memberUsageFixture.set(group.id, new Map([[`canonical:${group.id}`, spendUsd]]));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Group behavior (canonical member-rollup spend)
// ---------------------------------------------------------------------------

describe("threshold dedup per (group, period, threshold)", () => {
  it("loads threshold state for many displayed groups in one set-based read", async () => {
    await pglite.exec(`
      INSERT INTO fired_thresholds
        (group_id, entity_type, entity_id, billing_period, threshold)
      VALUES
        ('grp-1', 'group', 'grp-1', '${PERIOD_JUL}', 50),
        ('grp-2', 'group', 'grp-2', '${PERIOD_JUL}', 75),
        ('other', 'group', 'other', '${PERIOD_AUG}', 90)
    `);
    const fired = await getFiredThresholdsBatch(
      ["grp-2", "grp-1", "missing", "grp-1"],
      PERIOD_JUL,
    );
    expect(fired).toEqual(new Map([
      ["grp-2", [75]],
      ["grp-1", [50]],
      ["missing", []],
    ]));
  });

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
    directoryGroups = [GROUP, other];
    memberUsageFixture.set(other.id, new Map([["canonical:grp-2", 520]]));
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

describe("canonical group alert parity", () => {
  it("uses canonical member rollup rather than divergent raw group spend", async () => {
    setSpend(100); // raw group total would not cross any threshold
    memberUsageFixture.set("grp-1", new Map([["u1", 800]]));
    groupMembersFixture.set("grp-1", ["u1"]);

    const alerts = await evaluateGroup(GROUP);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.spendUsd).toBe(800);
    expect(alerts[0]!.threshold).toBe(75);
  });

  it("defers a group alert while canonical usage is incomplete", async () => {
    setSpend(900);
    memberUsageFixture.set("grp-1", new Map([["u1", 900]]));
    extraSpendComplete = false;

    expect(await evaluateGroup(GROUP)).toEqual([]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await getFiredThresholds("grp-1", PERIOD_JUL)).toEqual([]);
  });

  it("startChecker hydrates state without request-independent ingestion or alert evaluation", async () => {
    const unrelated = {
      ...GROUP,
      id: "unrelated-group",
      workspaceId: "ws-2",
      name: "Unrelated",
    };
    directoryGroups = [GROUP, unrelated];
    groupMembersFixture = new Map([
      [GROUP.id, ["u-primary"]],
      [unrelated.id, ["u-unrelated"]],
    ]);
    memberUsageFixture = new Map([
      [GROUP.id, new Map([["u-primary", 600]])],
      // Workspace data is available, but this unrelated member payload is pending.
    ]);
    setSpend(600, PERIOD_JUL, false);
    rawSpendFetchResult = "queued";
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(
      () => 0 as unknown as ReturnType<typeof setInterval>,
    );
    try {
      startChecker();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rawSpendRefreshGroupIds).toEqual([]);
      expect(rawSpendCallbacks.size).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(await getFiredThresholds(GROUP.id, PERIOD_JUL, "group")).toEqual([]);

      memberUsageFixture.set(unrelated.id, new Map([["u-unrelated", 0]]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(await getFiredThresholds(GROUP.id, PERIOD_JUL, "group")).toEqual([]);
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("alerts the displayed primary with primary plus hidden-alias spend", async () => {
    const primary = {
      ...GROUP,
      id: "z-heuristic-primary",
      name: "AZ-Replit – Acme",
    };
    const alias = { ...primary, id: "a-lexical-alias", workspaceId: "ws-2" };
    directoryGroups = [alias, primary];
    groupMembersFixture = new Map([
      [primary.id, ["u-primary"]],
      [alias.id, ["u-alias"]],
    ]);
    memberUsageFixture = new Map([
      [primary.id, new Map([["u-primary", 45]])],
      [alias.id, new Map([["u-alias", 35]])],
    ]);
    await pglite.exec(
      `INSERT INTO group_budgets (group_id, amount_usd) VALUES ('a-lexical-alias', 100)`,
    );
    setSpend(1);
    const canonical = getCanonicalUsage(
      directoryGroups,
      "billing:from-cutoff",
      new Set(["ws-1", "ws-2"]),
      groupMembersFixture,
      new Map(),
      undefined,
      new Map([
        ["ws-1", { id: "ws-1", name: "Acme Workspace", slug: "acme", memberCount: 0 }],
        ["ws-2", { id: "ws-2", name: "Beta Workspace", slug: "beta", memberCount: 0 }],
      ]),
    );
    expect(canonical.displayGroups.map((group) => group.id)).toEqual([primary.id]);
    expect(canonical.spendByPrimaryGroup.get(primary.id)).toBe(80);
    expect(resolveCanonicalMergedGroupBudget(
      primary.id,
      canonical.mergePlan,
      new Map([[alias.id, 100], [primary.id, 200]]),
    )).toEqual({ amountUsd: 200, sourceGroupId: primary.id });

    const alerts = (await runCheck(true)).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.entityId).toBe(primary.id);
    expect(alerts[0]!.spendUsd).toBe(80);
    expect((alerts[0]!.spendUsd / alerts[0]!.budgetUsd) * 100).toBe(80);
    expect(alerts[0]!.workspaceIds).toEqual(["ws-1", "ws-2"]);
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
      INSERT INTO team_budgets (team_name, original_amount_usd, amount_usd)
      VALUES ('Platform', ${amountUsd}, ${amountUsd});
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
    expect(alert.dataAsOf).toEqual(CHECK_DATA_AS_OF);
    // Both contributing workspaces recorded for scoping.
    expect([...alert.workspaceIds].sort()).toEqual(["ws-1", "ws-2"]);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([50]);
  });

  it("records a skipped attempt without replacing the prior successful evaluation", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 100]])],
      ["gB", new Map([["u3", 100]])],
    ]);
    const successful = await runCheck();
    expect(successful.skipped).toBe(false);
    expect(successful.evaluatedAt).toBeInstanceOf(Date);

    storedSnapshotSkipReason = "Stored usage is missing for workspace_member|ws-2";
    const skipped = await runCheck();
    expect(skipped).toMatchObject({
      checkedGroups: 0,
      checkedTeams: 0,
      skipped: true,
      skipReason: storedSnapshotSkipReason,
      evaluatedAt: null,
      dataAsOf: null,
    });
    const [state] = await testDb.select().from(schema.budgetCheckerStateTable);
    expect(state?.lastSuccessfulEvaluationAt?.getTime()).toBe(successful.evaluatedAt?.getTime());
    expect(state?.lastEvaluatedDataAsOf).toEqual(CHECK_DATA_AS_OF);
    expect(state?.lastSkipReason).toBe(storedSnapshotSkipReason);
  });

  it("preserves durable success when an immediate skipped run races startup hydration", async () => {
    const priorSuccess = new Date("2026-07-14T12:00:00.000Z");
    const priorDataAsOf = new Date("2026-07-14T00:00:00.000Z");
    await testDb.insert(schema.budgetCheckerStateTable).values({
      id: "singleton",
      lastSuccessfulEvaluationAt: priorSuccess,
      lastEvaluatedDataAsOf: priorDataAsOf,
    });
    storedSnapshotSkipReason = "Stored directory is unavailable";

    const skipped = await runCheck();
    expect(skipped.skipped).toBe(true);
    const [state] = await testDb.select().from(schema.budgetCheckerStateTable);
    expect(state?.lastSuccessfulEvaluationAt).toEqual(priorSuccess);
    expect(state?.lastEvaluatedDataAsOf).toEqual(priorDataAsOf);
    expect(state?.lastSkipReason).toBe(storedSnapshotSkipReason);
  });

  it("completes a database-only no-alert evaluation in under one second", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 100]])],
      ["gB", new Map([["u3", 100]])],
    ]);
    const startedAt = performance.now();
    const result = await runCheck();
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(result.skipped).toBe(false);
    expect(rawSpendRefreshGroupIds).toEqual([]);
    expect(lastExtraWorkspaceForce).toBe(false);
  });

  it("uses the stored billing-period anchor when only team pools are configured", async () => {
    await configureTeam(1000);
    billingStart = null;
    billingStart = PERIOD_JUL;
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 400]])],
      ["gB", new Map([["u3", 200]])],
    ]);

    const result = await runCheck(true);
    expect(result.checkedGroups).toBe(0);
    expect(rawSpendRefreshGroupIds).toEqual([]);
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

  it("does not refresh extra-workspace spend before evaluating a team", async () => {
    await configureTeam(1000);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 100]])],
      ["gB", new Map([["u3", 100]])],
    ]);
    // The stored value puts the team at 40%; a newer upstream value must not be
    // fetched or used by the checker.
    extraSpendFixture = new Map([["u1", 200]]);
    extraSpendAfterForce = new Map([["u1", 400]]);

    const result = await runCheck(true);
    expect(lastExtraWorkspaceForce).toBe(false);
    expect(result.checkedTeams).toBe(1);
    expect(result.alerts).toHaveLength(0);
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

  it("reports zero checked entities when workspaces are ready but member canonical input is incomplete", async () => {
    await configureTeam(1000);
    await pglite.exec(`INSERT INTO group_budgets (group_id, amount_usd) VALUES ('gA', 1000)`);
    memberUsageFixture = new Map([
      ["gA", new Map([["u1", 600]])],
      // Workspace payloads are complete, but gB's required member payload is absent.
    ]);
    extraSpendComplete = true;
    setSpend(600, PERIOD_JUL, false);

    const result = await runCheck(true);
    expect(result.checkedGroups).toBe(0);
    expect(result.checkedTeams).toBe(0);
    expect(result.alerts).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await getFiredThresholds("gA", PERIOD_JUL, "group")).toEqual([]);
    expect(await getFiredThresholds("Platform", PERIOD_JUL, "team")).toEqual([]);
  });

  it("defers group and team pools while canonical usage is incomplete", async () => {
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
    expect(result.checkedGroups).toBe(0);
    expect(result.checkedTeams).toBe(0);
    expect(result.alerts).toHaveLength(0);
    expect(await getFiredThresholds("grp-1", PERIOD_JUL, "group")).toEqual([]);
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
      INSERT INTO team_budgets (team_name, original_amount_usd, amount_usd)
      VALUES ('Platform', 1000, 1000);
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

  it("reconciles five dashboard team percentages with checker alerts and defers incomplete data", async () => {
    await pglite.exec(`DELETE FROM group_budgets`);
    const teams = ["Team-1", "Team-2", "Team-3", "Team-4", "Team-5"];
    const expectedSpend = [55, 65, 80, 95, 120];
    directoryGroups = teams.map((team, index) => ({
      id: `five-g${index + 1}`,
      workspaceId: index % 2 === 0 ? "ws-1" : "ws-2",
      name: `Five Group ${index + 1}`,
    } as EnterpriseGroup));
    groupMembersFixture = new Map(
      directoryGroups.map((group, index) => [
        group.id,
        ["overlap-user", `five-u${index + 1}`],
      ]),
    );
    memberUsageFixture = new Map(
      directoryGroups.map((group, index) => [
        group.id,
        new Map([
          ["overlap-user", index === 0 ? 5 : 0],
          [`five-u${index + 1}`, expectedSpend[index]! - (index === 0 ? 5 : 0)],
        ]),
      ]),
    );
    await testDb.insert(schema.groupTeamsTable).values(
      directoryGroups.map((group, index) => ({
        groupName: group.name,
        teamName: teams[index]!,
      })),
    );
    await testDb.insert(schema.teamBudgetsTable).values(
      teams.map((teamName) => ({
        teamName,
        originalAmountUsd: 100,
        amountUsd: 100,
      })),
    );

    const teamMap = new Map(
      directoryGroups.map((group, index) => [group.name, teams[index]!]),
    );

    // A partially loaded dashboard has no trustworthy percentages, and the
    // checker must likewise send none.
    extraSpendComplete = false;
    const deferred = await runCheck(true);
    expect(deferred.checkedTeams).toBe(0);
    expect(deferred.alerts).toEqual([]);
    expect(sendEmailMock).not.toHaveBeenCalled();

    extraSpendComplete = true;
    const dashboardCanonical = getCanonicalUsage(
      directoryGroups,
      "billing:from-cutoff",
      new Set(["ws-1", "ws-2"]),
      groupMembersFixture,
      new Map(),
      teamMap,
      new Map([
        ["ws-1", { id: "ws-1", name: "Acme Workspace", slug: "acme", memberCount: 0 }],
        ["ws-2", { id: "ws-2", name: "Beta Workspace", slug: "beta", memberCount: 0 }],
      ]),
    );
    expect(dashboardCanonical.isComplete).toBe(true);

    const result = await runCheck(true);
    expect(result.checkedTeams).toBe(5);
    expect(result.alerts).toHaveLength(5);

    const dashboardPairs = teams.map((teamName) => ({
      teamName,
      spendUsd: dashboardCanonical.byTeam.get(teamName),
      percentUsed: (dashboardCanonical.byTeam.get(teamName)! / 100) * 100,
    }));
    expect(dashboardPairs).toHaveLength(5);
    dashboardPairs.forEach((pair, index) => {
      expect(pair.teamName).toBe(teams[index]);
      expect(pair.spendUsd).toBe(expectedSpend[index]);
      expect(pair.percentUsed).toBeCloseTo(expectedSpend[index]!);
    });

    for (const pair of dashboardPairs) {
      const alert = result.alerts.find(
        (candidate) => candidate.entityType === "team" && candidate.entityId === pair.teamName,
      );
      expect(alert, `${pair.teamName} checker alert`).toBeDefined();
      expect(alert!.spendUsd).toBe(pair.spendUsd);
      expect((alert!.spendUsd / alert!.budgetUsd) * 100).toBeCloseTo(pair.percentUsed);
    }
  });
});
