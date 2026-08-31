import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  groupTeamsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetSyncStateTable,
  teamBudgetsTable,
} from "@workspace/db";
import { applyAnnualTeamBudgetBackfill } from "@workspace/db/seed-teams";

import {
  getEffectiveTeamBudgets,
  getVisibleEffectiveTeamBudgetMap,
  parseAirtableBudgetRecord,
  parseSubmissionPeriod,
  refreshTeamBudgetSnapshot,
  setAirtableBudgetFetcherForTests,
  startTeamBudgetSyncJob,
  TEAM_BUDGET_SYNC_INTERVAL_MS,
} from "./team-budgets";

const PREFIX = "__task158_test__";
const EXISTING = `${PREFIX} Existing`;
const NEW_TEAM = `${PREFIX} New`;
const RENAMED_TEAM = `${PREFIX} Renamed`;
const HIDDEN = `${PREFIX} Hidden`;

describe("annual allocation seed", () => {
  it("splits the legacy Growth Strategy pool into the canonical DXP and Non-DXP rows", async () => {
    const groupName = "AZ-Replit - Growth Strategy & Operations - Admin";
    const [existingFinance] = await db
      .select()
      .from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, "Finance"));

    expect(existingFinance).toBeDefined();

    await db
      .insert(groupTeamsTable)
      .values({ groupName, teamName: "Growth Strategy & Operations" })
      .onConflictDoUpdate({
        target: groupTeamsTable.groupName,
        set: { teamName: "Growth Strategy & Operations" },
      });
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

      const assignments = await db
        .select()
        .from(groupTeamsTable)
        .where(eq(groupTeamsTable.groupName, groupName));
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

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.teamName).toBe("DXP");
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
        originalAmountUsd: 140525.76,
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
});

describe("team budget synchronization schedule", () => {
  it("uses an hourly interval", () => {
    expect(TEAM_BUDGET_SYNC_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("schedules an hourly refresh without blocking server startup", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (() => ({ unref: () => undefined })) as unknown as typeof setTimeout,
    );

    startTeamBudgetSyncJob();
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), TEAM_BUDGET_SYNC_INTERVAL_MS);

    timeoutSpy.mockRestore();
  });
});

describe.sequential("effective team budget persistence", () => {
  let priorAdjustments: Array<typeof teamBudgetAdjustmentsTable.$inferSelect> = [];
  let priorSyncState: Array<typeof teamBudgetSyncStateTable.$inferSelect> = [];

  beforeAll(async () => {
    priorAdjustments = await db
      .select()
      .from(teamBudgetAdjustmentsTable)
      .where(eq(teamBudgetAdjustmentsTable.source, "airtable"));
    priorSyncState = await db.select().from(teamBudgetSyncStateTable);

    await db.delete(teamBudgetAdjustmentsTable).where(eq(teamBudgetAdjustmentsTable.source, "airtable"));
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
    await db.delete(teamBudgetAdjustmentsTable).where(eq(teamBudgetAdjustmentsTable.source, "airtable"));
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
    expect(existing?.amountUsd).toBe(100);

    const visible = await getVisibleEffectiveTeamBudgetMap();
    expect(visible.get(EXISTING)).toBe(155);
    expect(visible.has(HIDDEN)).toBe(false);
  });

  it("refresh is idempotent and a failed refresh preserves the last good snapshot", async () => {
    const records = [
      {
        id: `${PREFIX}-sync-existing`,
        fields: {
          "Team Status": "Existing",
          "Existing Team Name": EXISTING,
          "Total Credit Amount": 40,
          "Submission Month/Year": "April 2026",
        },
      },
      {
        id: `${PREFIX}-sync-new`,
        fields: {
          "Team Status": "New",
          "New Team Name": NEW_TEAM,
          "Total Credit Amount": 60,
          "Submission Month/Year": "May 2026",
        },
      },
    ];
    setAirtableBudgetFetcherForTests(async () => records);

    expect(await refreshTeamBudgetSnapshot()).toMatchObject({
      ok: true,
      recordCount: 2,
      acceptedCount: 2,
      issueCount: 0,
    });
    expect(await refreshTeamBudgetSnapshot()).toMatchObject({
      ok: true,
      recordCount: 2,
      acceptedCount: 2,
      issueCount: 0,
    });

    let snapshot = await getEffectiveTeamBudgets();
    expect(snapshot.adjustments.filter((row) => row.sourceRecordId.startsWith(PREFIX))).toHaveLength(2);
    expect(snapshot.teams.find((team) => team.teamName === EXISTING)?.effectiveAmountUsd).toBe(140);
    expect(snapshot.teams.find((team) => team.teamName === NEW_TEAM)?.effectiveAmountUsd).toBe(60);

    setAirtableBudgetFetcherForTests(async () => {
      throw new Error("simulated Airtable outage");
    });
    expect(await refreshTeamBudgetSnapshot()).toMatchObject({
      ok: false,
      recordCount: 2,
      acceptedCount: 2,
      issueCount: 0,
      error: "simulated Airtable outage",
    });

    snapshot = await getEffectiveTeamBudgets();
    expect(snapshot.adjustments.filter((row) => row.sourceRecordId.startsWith(PREFIX))).toHaveLength(2);
    expect(snapshot.teams.find((team) => team.teamName === EXISTING)?.effectiveAmountUsd).toBe(140);
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