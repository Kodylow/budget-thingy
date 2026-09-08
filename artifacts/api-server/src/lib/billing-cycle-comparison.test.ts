import { describe, expect, it } from "vitest";
import {
  billingCycleWindows,
  buildBillingCyclePoints,
  isFutureOnlyComparisonSelection,
  selectedComparisonWindows,
} from "./billing-cycle-comparison";
import {
  hasImmutableTeamRoster,
  ownAuthorizedTeamGroups,
  personalDailyComparison,
} from "../routes/monitor.billing-cycles";

describe("billingCycleWindows", () => {
  it("uses clamped calendar arithmetic at month and leap-year edges", () => {
    const jan = billingCycleWindows(
      "2028-01-31T00:00:00.000Z",
      "2028-02-29T00:00:00.000Z",
    )!;
    expect(jan.map((cycle) => cycle.startDate)).toEqual([
      "2028-01-31", "2027-12-31", "2027-11-30",
    ]);
    const march = billingCycleWindows(
      "2028-03-31T00:00:00.000Z",
      "2028-04-30T00:00:00.000Z",
    )!;
    expect(march[1]?.startDate).toBe("2028-02-29");
  });

  it("rejects unavailable or non-day-boundary metadata", () => {
    expect(billingCycleWindows("", "")).toBeNull();
    expect(billingCycleWindows(
      "2028-01-01T01:00:00.000Z",
      "2028-02-01T01:00:00.000Z",
    )).toBeNull();
  });
});

describe("selectedComparisonWindows", () => {
  it("identifies a future-only selection for an explicit client error", () => {
    const now = new Date("2028-03-05T18:00:00.000Z");
    expect(isFutureOnlyComparisonSelection(
      "2028-03-05T00:00:00.000Z", now,
    )).toBe(false);
    expect(isFutureOnlyComparisonSelection(
      "2028-03-06T00:00:00.000Z", now,
    )).toBe(true);
  });

  it("uses equal contiguous windows for custom ranges and caps today", () => {
    const windows = selectedComparisonWindows({
      rangeType: "custom",
      selectedStart: "2028-03-01T00:00:00.000Z",
      selectedEndExclusive: "2028-03-11T00:00:00.000Z",
      now: new Date("2028-03-05T18:00:00.000Z"),
    })!;
    expect(windows.map(({ startDate, endDate }) => [startDate, endDate])).toEqual([
      ["2028-03-01", "2028-03-05"],
      ["2028-02-25", "2028-02-29"],
      ["2028-02-20", "2028-02-24"],
    ]);
  });

  it("compares MTD against the same elapsed days in prior months", () => {
    const windows = selectedComparisonWindows({
      rangeType: "mtd",
      selectedStart: "2028-03-01T00:00:00.000Z",
      selectedEndExclusive: "2028-03-31T00:00:00.000Z",
      now: new Date("2028-03-30T12:00:00.000Z"),
    })!;
    expect(windows.map(({ startDate, endDate }) => [startDate, endDate])).toEqual([
      ["2028-03-01", "2028-03-30"],
      ["2028-02-01", "2028-02-29"],
      ["2028-01-01", "2028-01-30"],
    ]);
  });
});

describe("buildBillingCyclePoints", () => {
  it("distinguishes observed zero, gaps, later known cumulative, and future", () => {
    const cycle = billingCycleWindows(
      "2028-01-01T00:00:00.000Z",
      "2028-02-01T00:00:00.000Z",
    )![0]!;
    const personal = new Map([
      ["2028-01-01", { knownSpendUsd: 0, complete: true }],
      ["2028-01-02", { knownSpendUsd: 2, complete: false }],
      ["2028-01-03", { knownSpendUsd: 3, complete: true }],
    ]);
    const result = buildBillingCyclePoints(
      cycle, personal, personal, "2028-01-03");
    expect(result.points.slice(0, 4)).toEqual([
      { day: 1, date: "2028-01-01", personalSpendUsd: 0, teamSpendUsd: 0 },
      { day: 2, date: "2028-01-02", personalSpendUsd: null, teamSpendUsd: null },
      { day: 3, date: "2028-01-03", personalSpendUsd: 5, teamSpendUsd: 5 },
      { day: 4, date: "2028-01-04", personalSpendUsd: null, teamSpendUsd: null },
    ]);
    expect(result.personalComplete).toBe(false);
    expect(result.teamComplete).toBe(false);
  });
});

describe("ownAuthorizedTeamGroups", () => {
  it("does not leak managed, unauthorized, or unrelated team scope", () => {
    const groups = [
      { id: "own-a", teamName: "Funding A" },
      { id: "alias-a", teamName: "Funding A" },
      { id: "managed-b", teamName: "Funding B" },
      { id: "other-c", teamName: "Funding C" },
    ];
    expect(ownAuthorizedTeamGroups(
      groups,
      new Set(["own-a", "alias-a", "managed-b"]),
      new Set(["own-a"]),
    ).map((group) => group.id)).toEqual(["own-a", "alias-a"]);
  });
});

describe("billing-cycle route accounting fixtures", () => {
  it("uses raw personal Agent observations rather than workspace-capped rollups", () => {
    const snapshot = {
      coverage: { failedWorkspaceDays: [], missingWorkspaceDays: [] },
      dailyWorkspaces: new Map([
        ["2028-01-01", new Map([["w1", { totalCostUsd: 2 }]])],
      ]),
      dailyMembers: new Map([
        ["2028-01-01", new Map([
          ["w1", new Map([
            ["u1", {
              totalCostUsd: 9,
              aiCostUsd: 9,
              agentMetricsComplete: true,
            }],
          ])],
        ])],
      ]),
    } as unknown as Parameters<typeof personalDailyComparison>[0];
    expect(personalDailyComparison(
      snapshot, "2028-01-01", new Set(["w1"]), "u1",
    )).toEqual({ knownSpendUsd: 9, complete: true });
  });

  it("requires immutable historical rosters but permits today's live roster", () => {
    const members = new Map([
      ["2028-01-01", new Map([["g1", ["u1"]]])],
    ]);
    expect(hasImmutableTeamRoster(
      "2028-01-01", "2028-01-03", ["g1", "g2"],
      new Set(["2028-01-01"]), members,
    )).toBe(false);
    expect(hasImmutableTeamRoster(
      "2028-01-02", "2028-01-03", ["g1"],
      new Set(), new Map(),
    )).toBe(false);
    expect(hasImmutableTeamRoster(
      "2028-01-03", "2028-01-03", ["g1"],
      new Set(), new Map(),
    )).toBe(true);
  });

  it("keeps a complete observed personal zero distinct from missing", () => {
    const snapshot = {
      coverage: { failedWorkspaceDays: [], missingWorkspaceDays: [] },
      dailyWorkspaces: new Map([
        ["2028-01-01", new Map([["w1", { totalCostUsd: 0 }]])],
      ]),
      dailyMembers: new Map(),
    } as unknown as Parameters<typeof personalDailyComparison>[0];
    expect(personalDailyComparison(
      snapshot, "2028-01-01", new Set(["w1"]), "u1",
    )).toEqual({ knownSpendUsd: 0, complete: true });
    expect(personalDailyComparison(
      snapshot, "2028-01-02", new Set(["w1"]), "u1",
    )).toEqual({ knownSpendUsd: null, complete: false });
  });
});