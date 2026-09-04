import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  teamBudgetAdjustmentsTable,
  teamBudgetSyncStateTable,
  teamBudgetUpstreamSyncTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
} from "@workspace/db";
import {
  applyAnnualTeamBudgetBackfill,
} from "@workspace/db/seed-teams";
import { __setDirectoryCacheForTests } from "./enterprise";
import { setReplitBudgetTransportForTests } from "./replit-budgets";

import {
  applyTeamBudgetLimits,
  buildSnapshotRows,
  calculateTeamTargetAmount,
  getEffectiveTeamBudgets,
  getVisibleEffectiveTeamBudgetMap,
  isAssignableTeamLimitGroup,
  parseAirtableBudgetRecord,
  parseSubmissionPeriod,
  refreshTeamBudgetSnapshot,
  reconcileTeamBudgetsUpstream,
  setAirtableBudgetFetcherForTests,
  setTeamBudgetDirectoryFetcherForTests,
  startTeamBudgetSyncJob,
  TEAM_BUDGET_SYNC_INTERVAL_MS,
  TEAM_BUDGET_UPSTREAM_REFRESH_INTERVAL_MS,
  TEAM_BUDGET_SOURCE,
  updateTeamMonthlyLimit,
} from "./team-budgets";

const PREFIX = "__task158_test__";
const EXISTING = `${PREFIX} Existing`;
const NEW_TEAM = `${PREFIX} New`;
const RENAMED_TEAM = `${PREFIX} Renamed`;
const HIDDEN = `${PREFIX} Hidden`;

describe("annual allocation seed", () => {
  it("seeds canonical DXP and Non-DXP budgets idempotently", async () => {
    const [existingFinance] = await db
      .select()
      .from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, "Finance"));

    expect(existingFinance).toBeDefined();

    await db
      .insert(teamBudgetsTable)
      .values({
        teamName: "Growth Strategy & Operations",
        amountUsd: 18736.77,
        originalAmountUsd: 0,
      })
      .onConflictDoUpdate({
        target: teamBudgetsTable.teamName,
        set: { amountUsd: 18736.77, originalAmountUsd: 0 },
      });
    await db
      .update(teamBudgetsTable)
      .set({ amountUsd: 12345.67, originalAmountUsd: 1, isHidden: true })
      .where(eq(teamBudgetsTable.teamName, "Finance"));

    try {
      await applyAnnualTeamBudgetBackfill();
      await applyAnnualTeamBudgetBackfill();

      const splitBudgets = await db
        .select()
        .from(teamBudgetsTable)
        .where(inArray(teamBudgetsTable.teamName, [
          "Growth Strategy & Operations",
          "DXP",
          "Non-DXP",
        ]));
      const [preservedFinance] = await db
        .select()
        .from(teamBudgetsTable)
        .where(eq(teamBudgetsTable.teamName, "Finance"));

      expect(splitBudgets).toHaveLength(2);
      expect(splitBudgets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          teamName: "DXP",
          amountUsd: 18736.77,
          originalAmountUsd: 18736.77,
        }),
        expect.objectContaining({
          teamName: "Non-DXP",
          amountUsd: 0,
          originalAmountUsd: 0,
        }),
      ]));
      expect(preservedFinance).toMatchObject({
        amountUsd: 12345.67,
        originalAmountUsd: 1,
        isHidden: true,
      });
    } finally {
      await db
        .update(teamBudgetsTable)
        .set({
          amountUsd: existingFinance!.amountUsd,
          originalAmountUsd: existingFinance!.originalAmountUsd,
          isHidden: existingFinance!.isHidden,
        })
        .where(eq(teamBudgetsTable.teamName, "Finance"));
    }
  });
});

describe("team budget Airtable parsing", () => {
  const existingTeams = new Set([EXISTING, "DXP"]);

  it("normalizes submission months so lexical order is chronological", () => {
    const inputs = ["December 2025", "2026-02-18", "January, 2026", "2025-11", "Aug 2026"];
    expect(inputs.map(parseSubmissionPeriod).sort()).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-08",
    ]);
    expect(parseSubmissionPeriod("13/2026")).toBeNull();
    expect(parseSubmissionPeriod("not a month")).toBeNull();
  });

  it("accepts currency strings and maps the legacy DXP team name exactly", () => {
    const parsed = parseAirtableBudgetRecord({
      id: "valid-existing",
      fields: {
        "Approval Status": "Approved",
        "Team Status": "Existing",
        "Existing Team Name": "Growth Strategy & Operations",
        "Total Credit Amount": " $1,234.50 ",
        "Submission Month/Year": "February 2026",
      },
    }, existingTeams);

    expect(parsed).toMatchObject({
      sourceRecordId: "valid-existing",
      sourceTeamName: "Growth Strategy & Operations",
      teamName: "DXP",
      amountUsd: 1234.5,
      submissionPeriod: "2026-02",
      matchState: "accepted",
      errorMessage: null,
    });
  });

  it("maps both approved split-team Airtable labels exactly", () => {
    const dxp = parseAirtableBudgetRecord({
      id: "dxp",
      fields: {
        "Team Status": "Existing",
        "Existing Team Name": "Growth Strategy & Operations DXP",
        "Total Credit Amount": 13000,
        "Submission Month/Year": "Aug 2026",
      },
    }, existingTeams);
    const nonDxp = parseAirtableBudgetRecord({
      id: "non-dxp",
      fields: {
        "Team Status": "Existing",
        "Existing Team Name": "Growth Strategy & Operations Non-DXP",
        "Total Credit Amount": 8000,
        "Submission Month/Year": "Aug 2026",
      },
    }, new Set([...existingTeams, "Non-DXP"]));

    expect(dxp).toMatchObject({
      teamName: "DXP",
      amountUsd: 13000,
      submissionPeriod: "2026-08",
      matchState: "accepted",
    });
    expect(nonDxp).toMatchObject({
      teamName: "Non-DXP",
      amountUsd: 8000,
      submissionPeriod: "2026-08",
      matchState: "accepted",
    });
  });

  it("accepts an explicitly new team without fuzzy-matching an existing one", () => {
    const parsed = parseAirtableBudgetRecord({
      id: "valid-new",
      fields: {
        "Approval Status": "Approved",
        "Team Status": "New",
        "New Team Name": NEW_TEAM,
        "Total Credit Amount": 75,
        "Submission Month/Year": "2026-03-04",
      },
    }, existingTeams);

    expect(parsed).toMatchObject({
      teamName: NEW_TEAM,
      amountUsd: 75,
      submissionPeriod: "2026-03",
      matchState: "accepted",
    });
  });

  it("quarantines malformed, unknown, and ambiguous records rather than allocating them", () => {
    const malformed = parseAirtableBudgetRecord({
      id: "",
      fields: {
        "Team Status": "",
        "Total Credit Amount": "-20",
        "Submission Month/Year": "whenever",
      },
    }, existingTeams);
    expect(malformed.matchState).toBe("invalid");
    expect(malformed.teamName).toBeNull();
    expect(malformed.errorMessage).toContain("Missing Airtable record identity");
    expect(malformed.errorMessage).toContain("positive number");
    expect(malformed.errorMessage).toContain("valid month and year");

    const unknown = parseAirtableBudgetRecord({
      id: "unknown-existing",
      fields: {
        "Team Status": "Existing",
        "Existing Team Name": `${PREFIX} Typo`,
        "Total Credit Amount": 20,
        "Submission Month/Year": "March 2026",
      },
    }, existingTeams);
    expect(unknown.matchState).toBe("unmatched");
    expect(unknown.teamName).toBeNull();
    expect(unknown.errorMessage).toContain("has no exact match");

    const ambiguous = parseAirtableBudgetRecord({
      id: "ambiguous",
      fields: {
        "Team Status": "Existing",
        "Existing Team Name": EXISTING,
        "New Team Name": NEW_TEAM,
        "Total Credit Amount": 20,
        "Submission Month/Year": "March 2026",
      },
    }, existingTeams);
    expect(ambiguous.matchState).not.toBe("accepted");
    expect(ambiguous.teamName).toBeNull();
    expect(ambiguous.errorMessage).toContain("Existing records require only Existing Team Name");
  });

  it("rejects unsupported statuses, status/name mismatches, and new-name collisions", () => {
    const unsupported = parseAirtableBudgetRecord({
      id: "unsupported-status",
      fields: {
        "Team Status": "Maybe",
        "New Team Name": NEW_TEAM,
        "Total Credit Amount": 20,
        "Submission Month/Year": "March 2026",
      },
    }, existingTeams);
    expect(unsupported.matchState).toBe("invalid");
    expect(unsupported.errorMessage).toContain('Team Status must be exactly "Existing" or "New"');

    const mismatched = parseAirtableBudgetRecord({
      id: "mismatched-status",
      fields: {
        "Team Status": "Existing",
        "New Team Name": NEW_TEAM,
        "Total Credit Amount": 20,
        "Submission Month/Year": "March 2026",
      },
    }, existingTeams);
    expect(mismatched.matchState).toBe("invalid");
    expect(mismatched.errorMessage).toContain("Existing records require only Existing Team Name");

    const collision = parseAirtableBudgetRecord({
      id: "new-name-collision",
      fields: {
        "Team Status": "New",
        "New Team Name": EXISTING,
        "Total Credit Amount": 20,
        "Submission Month/Year": "March 2026",
      },
    }, existingTeams);
    expect(collision.matchState).toBe("invalid");
    expect(collision.errorMessage).toContain("already exists");
  });

  it("includes only approved Finance Approval records while retaining approved issues", () => {
    const makeRecord = (id: string, approvalStatus: unknown, amount: unknown = 20) => ({
      id,
      fields: {
        "Approval Status": approvalStatus,
        "Team Status": "Existing",
        "Existing Team Name": EXISTING,
        "Total Credit Amount": amount,
        "Submission Month/Year": "March 2026",
      },
    });
    const rows = buildSnapshotRows([
      makeRecord("approved", "Approved"),
      makeRecord("approved-normalized", " approved "),
      makeRecord("approved-malformed", "Approved", "not money"),
      makeRecord("pending", "Pending"),
      makeRecord("rejected", "Rejected"),
      makeRecord("blank", ""),
      makeRecord("other", "Finance approved"),
    ], existingTeams);

    expect(rows.map((row) => row.sourceRecordId)).toEqual([
      "approved",
      "approved-normalized",
      "approved-malformed",
    ]);
    expect(rows.filter((row) => row.matchState === "accepted")).toHaveLength(2);
    expect(rows.find((row) => row.sourceRecordId === "approved-malformed")).toMatchObject({
      source: TEAM_BUDGET_SOURCE,
      teamName: null,
      matchState: "unmatched",
    });
  });
});

describe("team budget synchronization schedule", () => {
  it("exposes nonlegacy custom candidates but excludes admin and viewer groups", () => {
    const group = (name: string, type = "custom", workspaceId = "workspace") => ({
      id: name,
      workspaceId,
      name,
      type,
    });
    for (const name of [
      "BnD Analytics Team",
      "BnD Executives",
      "BnD Production Team",
      "Executive Group",
    ]) {
      expect(isAssignableTeamLimitGroup(group(name))).toBe(true);
    }
    expect(isAssignableTeamLimitGroup(group("Finance - Admin"))).toBe(false);
    expect(isAssignableTeamLimitGroup(group("Finance-Viewers"))).toBe(false);
    expect(isAssignableTeamLimitGroup(group("Legacy Team", "custom", "1awqan"))).toBe(false);
  });

  it("splits team limits across enabled targets while preserving overrides", () => {
    expect(calculateTeamTargetAmount(10, 3, null)).toBe(3.33);
    expect(calculateTeamTargetAmount(10, 3, 7.25)).toBe(7.25);
  });

  it("uses an hourly interval", () => {
    expect(TEAM_BUDGET_SYNC_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(TEAM_BUDGET_UPSTREAM_REFRESH_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("schedules an hourly refresh without blocking server startup", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (() => ({ unref: () => undefined })) as unknown as typeof setTimeout,
    );

    startTeamBudgetSyncJob();
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), TEAM_BUDGET_SYNC_INTERVAL_MS);
    expect(timeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      TEAM_BUDGET_UPSTREAM_REFRESH_INTERVAL_MS,
    );

    timeoutSpy.mockRestore();
  });
});

describe("effective team budget persistence", () => {
  let priorAdjustments: Array<typeof teamBudgetAdjustmentsTable.$inferSelect> = [];
  let priorSyncState: Array<typeof teamBudgetSyncStateTable.$inferSelect> = [];

  beforeAll(async () => {
    __setDirectoryCacheForTests({ groups: [], members: new Map() });
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: [] }));
    setReplitBudgetTransportForTests(
      async () => new Response(JSON.stringify({ error: "not connected" }), { status: 401 }),
      false,
    );
    priorAdjustments = await db
      .select()
      .from(teamBudgetAdjustmentsTable)
      .where(inArray(teamBudgetAdjustmentsTable.source, ["airtable", TEAM_BUDGET_SOURCE]));
    priorSyncState = await db.select().from(teamBudgetSyncStateTable);

    await db.delete(teamBudgetAdjustmentsTable).where(
      inArray(teamBudgetAdjustmentsTable.source, ["airtable", TEAM_BUDGET_SOURCE]),
    );
    await db.delete(teamBudgetSyncStateTable);
    await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
      EXISTING,
      NEW_TEAM,
      RENAMED_TEAM,
      HIDDEN,
    ]));
    await db.insert(teamBudgetsTable).values([
      { teamName: EXISTING, amountUsd: 100, originalAmountUsd: 100 },
      { teamName: HIDDEN, amountUsd: 900, originalAmountUsd: 900, isHidden: true },
    ]);
  });

  afterAll(async () => {
    setAirtableBudgetFetcherForTests(null);
    await reconcileTeamBudgetsUpstream();
    setReplitBudgetTransportForTests(null);
    setTeamBudgetDirectoryFetcherForTests(null);
    __setDirectoryCacheForTests(null);
    await db.delete(teamBudgetAdjustmentsTable).where(
      inArray(teamBudgetAdjustmentsTable.source, ["airtable", TEAM_BUDGET_SOURCE]),
    );
    await db.delete(teamBudgetSyncStateTable);
    await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
      EXISTING,
      NEW_TEAM,
      RENAMED_TEAM,
      HIDDEN,
    ]));

    if (priorAdjustments.length) {
      await db.insert(teamBudgetAdjustmentsTable).values(priorAdjustments.map(({ id: _id, ...row }) => row));
    }
    if (priorSyncState.length) {
      await db.insert(teamBudgetSyncStateTable).values(priorSyncState);
    }
  });

  it("sums every accepted record onto the immutable original and ignores issues", async () => {
    await db.insert(teamBudgetAdjustmentsTable).values([
      {
        source: "airtable",
        sourceRecordId: `${PREFIX}-accepted-jan`,
        sourceTeamName: EXISTING,
        teamName: EXISTING,
        amountUsd: 25,
        submissionPeriod: "2026-01",
        matchState: "accepted",
      },
      {
        source: "airtable",
        sourceRecordId: `${PREFIX}-accepted-feb`,
        sourceTeamName: EXISTING,
        teamName: EXISTING,
        amountUsd: 30,
        submissionPeriod: "2026-02",
        matchState: "accepted",
      },
      {
        source: "airtable",
        sourceRecordId: `${PREFIX}-issue`,
        sourceTeamName: EXISTING,
        teamName: null,
        amountUsd: 999,
        submissionPeriod: "2026-03",
        matchState: "unmatched",
        errorMessage: "test issue",
      },
    ]);

    const snapshot = await getEffectiveTeamBudgets();
    const existing = snapshot.teams.find((team) => team.teamName === EXISTING);
    expect(existing?.originalAmountUsd).toBe(100);
    expect(existing?.effectiveAmountUsd).toBe(155);
    expect(existing?.annualAllocationUsd).toBe(155);
    expect(existing?.monthlyLimitUsd).toBe(12.92);
    expect(existing?.monthlyLimitSource).toBe("derived");
    expect(existing?.amountUsd).toBe(100);

    const visible = await getVisibleEffectiveTeamBudgetMap();
    expect(visible.get(EXISTING)).toBe(155);
    expect(visible.has(HIDDEN)).toBe(false);

    await db.delete(teamBudgetAdjustmentsTable).where(inArray(
      teamBudgetAdjustmentsTable.sourceRecordId,
      [
        `${PREFIX}-accepted-jan`,
        `${PREFIX}-accepted-feb`,
        `${PREFIX}-issue`,
      ],
    ));
  });

  it("persists a manual monthly limit until explicitly reset to derived", async () => {
    let updated = await updateTeamMonthlyLimit(EXISTING, 7.25);
    expect(updated).toMatchObject({
      monthlyLimitUsd: 7.25,
      monthlyLimitSource: "manual",
    });
    updated = await updateTeamMonthlyLimit(EXISTING, null);
    expect(updated).toMatchObject({
      monthlyLimitUsd: 8.33,
      monthlyLimitSource: "derived",
    });
  });

  it("refresh is idempotent, preserves legacy history, and a failure preserves the last good snapshot", async () => {
    await db.insert(teamBudgetAdjustmentsTable).values({
      source: "airtable",
      sourceRecordId: `${PREFIX}-legacy`,
      sourceTeamName: EXISTING,
      teamName: EXISTING,
      amountUsd: 10,
      submissionPeriod: "2026-03",
      matchState: "accepted",
    });
    const records = [
      {
        id: `${PREFIX}-sync-existing`,
        fields: {
          "Approval Status": "Approved",
          "Team Status": "Existing",
          "Existing Team Name": EXISTING,
          "Total Credit Amount": 40,
          "Submission Month/Year": "April 2026",
        },
      },
      {
        id: `${PREFIX}-sync-new`,
        fields: {
          "Approval Status": " Approved ",
          "Team Status": "New",
          "New Team Name": NEW_TEAM,
          "Total Credit Amount": 60,
          "Submission Month/Year": "May 2026",
        },
      },
      {
        id: `${PREFIX}-sync-pending`,
        fields: {
          "Approval Status": "Pending",
          "Team Status": "New",
          "New Team Name": `${PREFIX} Pending`,
          "Total Credit Amount": 500,
          "Submission Month/Year": "May 2026",
        },
      },
      {
        id: `${PREFIX}-sync-malformed-approved`,
        fields: {
          "Approval Status": "Approved",
          "Team Status": "Existing",
          "Existing Team Name": `${PREFIX} Typo`,
          "Total Credit Amount": 500,
          "Submission Month/Year": "May 2026",
        },
      },
    ];
    setAirtableBudgetFetcherForTests(async () => records);

    expect(await refreshTeamBudgetSnapshot()).toMatchObject({
      ok: true,
      recordCount: 3,
      acceptedCount: 2,
      issueCount: 1,
    });
    expect(await refreshTeamBudgetSnapshot()).toMatchObject({
      ok: true,
      recordCount: 3,
      acceptedCount: 2,
      issueCount: 1,
    });

    let snapshot = await getEffectiveTeamBudgets();
    expect(snapshot.adjustments.filter((row) => row.sourceRecordId.startsWith(PREFIX))).toHaveLength(4);
    expect(snapshot.teams.find((team) => team.teamName === EXISTING)?.effectiveAmountUsd).toBe(150);
    expect(snapshot.teams.find((team) => team.teamName === NEW_TEAM)?.effectiveAmountUsd).toBe(60);
    expect(snapshot.adjustments.find(
      (row) => row.sourceRecordId === `${PREFIX}-legacy`,
    )?.source).toBe("airtable");
    expect(snapshot.adjustments.filter(
      (row) => row.source === TEAM_BUDGET_SOURCE,
    )).toHaveLength(3);
    expect(snapshot.adjustments.find(
      (row) => row.sourceRecordId === `${PREFIX}-sync-malformed-approved`,
    )).toMatchObject({ teamName: null, matchState: "unmatched" });
    expect(snapshot.adjustments.some(
      (row) => row.sourceRecordId === `${PREFIX}-sync-pending`,
    )).toBe(false);
    expect(snapshot.teams.some((team) => team.teamName === `${PREFIX} Pending`)).toBe(false);

    setAirtableBudgetFetcherForTests(async () => {
      throw new Error("simulated Airtable outage");
    });
    expect(await refreshTeamBudgetSnapshot()).toMatchObject({
      ok: false,
      recordCount: 3,
      acceptedCount: 2,
      issueCount: 1,
      error: "simulated Airtable outage",
    });

    snapshot = await getEffectiveTeamBudgets();
    expect(snapshot.adjustments.filter((row) => row.sourceRecordId.startsWith(PREFIX))).toHaveLength(4);
    expect(snapshot.teams.find((team) => team.teamName === EXISTING)?.effectiveAmountUsd).toBe(150);
    expect(snapshot.sync?.lastSuccessfulAt).not.toBeNull();
    expect(snapshot.sync?.lastError).toBe("simulated Airtable outage");
  });

  it("removes unassigned source-created teams after a record rename or removal", async () => {
    setAirtableBudgetFetcherForTests(async () => []);
    expect((await refreshTeamBudgetSnapshot()).ok).toBe(true);

    const sourceRecordId = `${PREFIX}-rename-source`;
    setAirtableBudgetFetcherForTests(async () => [{
      id: sourceRecordId,
      fields: {
        "Approval Status": "Approved",
        "Team Status": "New",
        "New Team Name": NEW_TEAM,
        "Total Credit Amount": 60,
        "Submission Month/Year": "May 2026",
      },
    }]);
    expect((await refreshTeamBudgetSnapshot()).ok).toBe(true);
    expect((await getEffectiveTeamBudgets()).teams.some((team) => team.teamName === NEW_TEAM)).toBe(true);

    setAirtableBudgetFetcherForTests(async () => [{
      id: sourceRecordId,
      fields: {
        "Approval Status": "Approved",
        "Team Status": "New",
        "New Team Name": RENAMED_TEAM,
        "Total Credit Amount": 60,
        "Submission Month/Year": "May 2026",
      },
    }]);
    expect((await refreshTeamBudgetSnapshot()).ok).toBe(true);
    let snapshot = await getEffectiveTeamBudgets();
    expect(snapshot.teams.some((team) => team.teamName === NEW_TEAM)).toBe(false);
    expect(snapshot.teams.find((team) => team.teamName === RENAMED_TEAM)?.effectiveAmountUsd).toBe(60);

    setAirtableBudgetFetcherForTests(async () => []);
    expect((await refreshTeamBudgetSnapshot()).ok).toBe(true);
    snapshot = await getEffectiveTeamBudgets();
    expect(snapshot.teams.some((team) => team.teamName === RENAMED_TEAM)).toBe(false);
  });
});

describe("team budget upstream reconciliation", () => {
  const TEAM_CLEAR = `${PREFIX} Upstream Clear`;
  const TEAM_SAME = `${PREFIX} Upstream Same`;
  const TEAM_ONE = `${PREFIX} Upstream One`;
  const TEAM_TWO = `${PREFIX} Upstream Two`;
  const teamNames = [TEAM_CLEAR, TEAM_SAME, TEAM_ONE, TEAM_TWO];
  const workspaceId = `${PREFIX}-workspace`;
  const groups = teamNames.flatMap((teamName, index) => {
    const base = `${PREFIX} Family ${index}`;
    return [
      { id: `admin-${index}`, workspaceId, name: `${base} - Admin`, type: "custom" },
      { id: `member-${index}`, workspaceId, name: `${base} - Members`, type: "custom" },
    ];
  });
  const upstream = new Map<string, number | null>();
  let mutations: Array<{ method: string; groupId: string; amountUsd: number | null }> = [];
  let failingGroupId: string | null = null;

  const installTransport = (canWrite: boolean) => {
    setReplitBudgetTransportForTests(async (path, init) => {
      if (init.method === "GET") {
        return Response.json({
          items: [...upstream].map(([groupId, budgetUsd]) => ({
            workspaceId,
            groupId,
            budgetUsd,
          })),
        });
      }
      const body = init.body ? JSON.parse(init.body) as {
        groupId: string;
        amountUsd: number | null;
      } : null;
      const groupId = body?.groupId ?? new URL(`https://test.invalid${path}`).searchParams.get("groupId")!;
      mutations.push({ method: init.method, groupId, amountUsd: body?.amountUsd ?? null });
      if (groupId === failingGroupId) {
        return new Response(JSON.stringify({ error: "simulated mutation failure" }), { status: 500 });
      }
      upstream.set(groupId, body!.amountUsd);
      return new Response(null, { status: 204 });
    }, canWrite);
  };

  beforeAll(async () => {
    await db.delete(teamBudgetAdjustmentsTable).where(inArray(
      teamBudgetAdjustmentsTable.sourceRecordId,
      [`${PREFIX}-upstream-history`],
    ));
    await db.delete(teamBudgetUpstreamSyncTable).where(inArray(
      teamBudgetUpstreamSyncTable.teamName,
      teamNames,
    ));
    await db.delete(teamLimitTargetsTable).where(inArray(
      teamLimitTargetsTable.groupId,
      groups.map((group) => group.id),
    ));
    await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, teamNames));
    await db.insert(teamBudgetsTable).values([
      { teamName: TEAM_CLEAR, amountUsd: 0, originalAmountUsd: 0 },
      { teamName: TEAM_SAME, amountUsd: 10, originalAmountUsd: 10 },
      { teamName: TEAM_ONE, amountUsd: 10, originalAmountUsd: 10 },
      { teamName: TEAM_TWO, amountUsd: 22, originalAmountUsd: 22 },
    ]);
    await db.insert(teamBudgetAdjustmentsTable).values({
      source: "manual-test",
      sourceRecordId: `${PREFIX}-upstream-history`,
      teamName: TEAM_ONE,
      amountUsd: 1,
      submissionPeriod: "2026-01",
      matchState: "accepted",
    });
    await db.insert(teamLimitTargetsTable).values(groups
      .filter((group) => group.id.startsWith("member"))
      .map((group, index) => ({
        groupId: group.id,
        groupName: group.name,
        workspaceId: group.workspaceId,
        teamName: teamNames[index]!,
      })));
    __setDirectoryCacheForTests({
      groups,
      members: new Map(),
    });
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: groups }));
  });

  afterAll(async () => {
    setReplitBudgetTransportForTests(null);
    setTeamBudgetDirectoryFetcherForTests(null);
    __setDirectoryCacheForTests(null);
    await db.delete(teamBudgetAdjustmentsTable).where(eq(
      teamBudgetAdjustmentsTable.sourceRecordId,
      `${PREFIX}-upstream-history`,
    ));
    await db.delete(teamBudgetUpstreamSyncTable).where(inArray(
      teamBudgetUpstreamSyncTable.teamName,
      teamNames,
    ));
    await db.delete(teamLimitTargetsTable).where(inArray(
      teamLimitTargetsTable.groupId,
      groups.map((group) => group.id),
    ));
    await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, teamNames));
  });

  it("reads only explicit member targets and records monthly drift without mutating", async () => {
    upstream.clear();
    upstream.set("member-0", 12);
    upstream.set("member-1", 10.001);
    upstream.set("member-2", 11);
    upstream.set("member-3", 22);
    mutations = [];
    installTransport(true);

    await reconcileTeamBudgetsUpstream();

    expect(mutations).toEqual([]);
    const rows = await db.select().from(teamBudgetUpstreamSyncTable)
      .where(inArray(teamBudgetUpstreamSyncTable.teamName, [TEAM_CLEAR, TEAM_SAME]));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ teamName: TEAM_CLEAR, targetGroupId: "member-0", status: "drift", desiredAmountUsd: 0 }),
      expect.objectContaining({ teamName: TEAM_SAME, targetGroupId: "member-1", status: "drift", desiredAmountUsd: 0.83 }),
    ]));
  });

  it("records drift independently of write scope and performs no mutation", async () => {
    upstream.set("member-1", 2);
    mutations = [];
    installTransport(false);
    await reconcileTeamBudgetsUpstream();
    const rows = await db.select().from(teamBudgetUpstreamSyncTable)
      .where(eq(teamBudgetUpstreamSyncTable.teamName, TEAM_SAME));
    expect(mutations).toHaveLength(0);
    expect(rows.find((row) => row.targetGroupId === "member-1"))
      .toMatchObject({ status: "drift", upstreamAmountUsd: 2, reason: null });
  });

  it("fails a deleted exact target without substituting a same-name group", async () => {
    const admin = groups[2]!;
    const staleMember = {
      ...groups[3]!,
      id: "stale-recreated-member",
    };
    const freshMember = {
      ...groups[3]!,
      id: "fresh-recreated-member",
    };
    __setDirectoryCacheForTests({
      groups: [admin, staleMember],
      members: new Map(),
    });
    setTeamBudgetDirectoryFetcherForTests(async () => ({
      allGroups: [admin, freshMember],
    }));
    upstream.clear();
    mutations = [];
    installTransport(true);

    await reconcileTeamBudgetsUpstream();

    expect(mutations).toEqual([]);
    expect(mutations.some(({ groupId }) => groupId === "stale-recreated-member")).toBe(false);
    const rows = await db.select().from(teamBudgetUpstreamSyncTable)
      .where(eq(teamBudgetUpstreamSyncTable.teamName, TEAM_SAME));
    expect(rows.find((row) => row.targetGroupId === "member-1")).toMatchObject({
      status: "failed",
      targetGroupId: "member-1",
    });
    expect(rows.find((row) => row.targetGroupId === "member-1")?.reason)
      .toContain("missing");

    __setDirectoryCacheForTests({ groups, members: new Map() });
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: groups }));
  });

  it("marks a retyped configured target failed during reconciliation", async () => {
    const retyped = groups.map((group) =>
      group.id === "member-1"
        ? { ...group, name: `${PREFIX} Family 1 - Admin` }
        : group
    );
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: retyped }));
    await reconcileTeamBudgetsUpstream();
    const [row] = await db.select().from(teamBudgetUpstreamSyncTable).where(and(
      eq(teamBudgetUpstreamSyncTable.workspaceId, workspaceId),
      eq(teamBudgetUpstreamSyncTable.targetGroupId, "member-1"),
    ));
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.reason).toContain("no longer an eligible");
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: groups }));
  });

  it("revalidates exact identity immediately before apply and skips a deleted target", async () => {
    upstream.set("member-2", 0);
    mutations = [];
    installTransport(true);
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: groups }));
    await reconcileTeamBudgetsUpstream();
    setTeamBudgetDirectoryFetcherForTests(async () => ({
      allGroups: groups.filter((group) => group.id !== "member-2"),
    }));
    const applied = await applyTeamBudgetLimits({
      targets: [{ workspaceId, groupId: "member-2" }],
    });
    const outcome = applied.teams.flatMap((team) => team.targets)[0];
    expect(outcome).toMatchObject({ targetGroupId: "member-2", outcome: "failed" });
    expect(outcome.error).toContain("missing");
    expect(mutations).toEqual([]);
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: groups }));
  });

  it("revalidates eligibility immediately before apply and skips a retyped target", async () => {
    upstream.set("member-2", 0);
    mutations = [];
    installTransport(true);
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: groups }));
    await reconcileTeamBudgetsUpstream();
    setTeamBudgetDirectoryFetcherForTests(async () => ({
      allGroups: groups.map((group) =>
        group.id === "member-2"
          ? { ...group, name: `${PREFIX} Family 2 - Viewer` }
          : group
      ),
    }));
    const applied = await applyTeamBudgetLimits({
      targets: [{ workspaceId, groupId: "member-2" }],
    });
    const outcome = applied.teams.flatMap((team) => team.targets)[0];
    expect(outcome).toMatchObject({ targetGroupId: "member-2", outcome: "failed" });
    expect(outcome.error).toContain("no longer an eligible");
    expect(mutations).toEqual([]);
    expect((await applyTeamBudgetLimits({ teamNames: [TEAM_ONE] })).teams).toEqual([]);
    const broad = await applyTeamBudgetLimits({ all: true });
    expect(broad.teams.some((team) => team.teamName === TEAM_ONE)).toBe(false);
    expect(mutations.some((mutation) => mutation.groupId === "member-2")).toBe(false);
    setTeamBudgetDirectoryFetcherForTests(async () => ({ allGroups: groups }));
  });

  it("applies only when explicitly requested and reports per-target failures", async () => {
    upstream.set("member-2", 0);
    upstream.set("member-3", 0);
    failingGroupId = "member-3";
    mutations = [];
    installTransport(true);
    await reconcileTeamBudgetsUpstream();
    expect(mutations).toEqual([]);
    const applied = await applyTeamBudgetLimits({ teamNames: [TEAM_ONE, TEAM_TWO, TEAM_TWO] });
    expect(applied.teams.map((team) => team.teamName)).toEqual([TEAM_ONE, TEAM_TWO]);
    expect(applied.teams.find((team) => team.teamName === TEAM_ONE)?.outcome).toBe("success");
    expect(applied.teams.find((team) => team.teamName === TEAM_TWO)?.outcome).toBe("failed");
    expect(upstream.get("member-2")).toBe(0.92);
    expect(upstream.get("member-3")).toBe(0);
    expect(mutations).toEqual(expect.arrayContaining([
      { method: "POST", groupId: "member-2", amountUsd: 0.92 },
      { method: "POST", groupId: "member-3", amountUsd: 1.83 },
    ]));
    expect(await db.select().from(teamBudgetAdjustmentsTable).where(eq(
      teamBudgetAdjustmentsTable.sourceRecordId,
      `${PREFIX}-upstream-history`,
    ))).toHaveLength(1);

    failingGroupId = null;
    mutations = [];
    const retried = await applyTeamBudgetLimits({ teamNames: [TEAM_TWO] });
    expect(retried.teams[0]?.outcome).toBe("success");
    expect(mutations).toEqual([
      { method: "POST", groupId: "member-3", amountUsd: 1.83 },
    ]);
    expect(upstream.get("member-3")).toBe(1.83);
  });
});