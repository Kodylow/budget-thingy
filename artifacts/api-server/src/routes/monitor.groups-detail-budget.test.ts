import { describe, expect, it } from "vitest";
import { buildFixedTeamBudgetTracking } from "./monitor.groups-detail";
import { reportingSemanticsForGroups } from "../services/scoped-accounting";

const now = new Date("2026-05-21T18:00:00.000Z");
const spend = new Map([
  ["2026-05-20", 10],
  ["2026-05-21", 15],
]);
const otherWorkspace = {
  reporting: {
    acquisitionCoverage: "complete",
    rosterAttributionBasis: "observed_roster",
    creatorCoverage: "not_applicable",
    creatorAttributionBasis: "not_applicable",
    freshness: "fresh",
    comparisonsVerified: true,
    workspaceAcquisitionCoverage: new Map([["other", "complete"]]),
  },
  projectAttribution: {
    nonAiSpendByProject: new Map(),
    projectToGroup: new Map(),
    creatorBasisByProject: new Map(),
  },
} as any;

describe("fixed team budget tracking", () => {
  it("enables exact balances for complete full-team usage", () => {
    expect(buildFixedTeamBudgetTracking({
      dailySpend: spend,
      unavailableDays: new Set(),
      scopeComplete: true,
      usageObserved: true,
      allocationUsd: 100,
      canonicalSpendUsd: 25,
      now,
    })).toMatchObject({
      periodStart: "2026-05-20",
      periodEnd: "2027-05-20",
      asOf: "2026-05-21",
      spendUsd: 25,
      remainingUsd: 75,
      percentUsed: 25,
      usageComplete: true,
      benchmarkEligible: true,
      comparisonsMatchBudgetWindow: true,
      qualification: null,
      points: [
        { date: "2026-05-20", spendUsd: 10 },
        { date: "2026-05-21", spendUsd: 25 },
      ],
    });
  });

  it.each([
    {
      name: "incomplete usage",
      scopeComplete: true,
      unavailableDays: new Set(["2026-05-20"]),
      allocationUsd: 100,
    },
    {
      name: "partial scope",
      scopeComplete: false,
      unavailableDays: new Set<string>(),
      allocationUsd: 100,
    },
    {
      name: "missing allocation",
      scopeComplete: true,
      unavailableDays: new Set<string>(),
      allocationUsd: null,
    },
  ])("withholds comparisons for $name", ({
    scopeComplete,
    unavailableDays,
    allocationUsd,
  }) => {
    const result = buildFixedTeamBudgetTracking({
      dailySpend: spend,
      unavailableDays,
      scopeComplete,
      usageObserved: true,
      allocationUsd,
      canonicalSpendUsd: 25,
      now,
    });

    expect(result.remainingUsd).toBeNull();
    expect(result.percentUsed).toBeNull();
    expect(result.benchmarkEligible).toBe(
      scopeComplete &&
        allocationUsd !== null &&
        allocationUsd > 0,
    );
    expect(result.qualification).not.toBeNull();
    if (!scopeComplete) expect(result.allocationUsd).toBeNull();
    if (unavailableDays.size > 0) {
      expect(result.points).toEqual([
        { date: "2026-05-20", spendUsd: 10 },
        { date: "2026-05-21", spendUsd: 25 },
      ]);
    }
  });

  it.each([0, -10])(
    "keeps an available %s allocation accurate without a benchmark",
    (allocationUsd) => {
      expect(buildFixedTeamBudgetTracking({
        dailySpend: spend,
        unavailableDays: new Set(),
        scopeComplete: true,
        usageObserved: true,
        allocationUsd,
        canonicalSpendUsd: 25,
        now,
      })).toMatchObject({
        allocationUsd,
        remainingUsd: allocationUsd - 25,
        percentUsed: null,
        benchmarkEligible: false,
      });
    },
  );

  it("tracks the selected domain but withholds mismatched budget comparisons", () => {
    expect(buildFixedTeamBudgetTracking({
      dailySpend: new Map([["2026-05-21", 15]]),
      unavailableDays: new Set(),
      scopeComplete: true,
      usageObserved: true,
      allocationUsd: 100,
      canonicalSpendUsd: 15,
      now,
      reportingStart: "2026-05-21T00:00:00.000Z",
      reportingEndExclusive: "2026-05-22T00:00:00.000Z",
      reportingLabel: "May 21",
      comparisonsMatchBudgetWindow: false,
    })).toMatchObject({
      periodStart: "2026-05-20",
      periodEnd: "2027-05-20",
      reportingStart: "2026-05-21",
      reportingEnd: "2026-05-21",
      reportingLabel: "May 21",
      allocationUsd: 100,
      spendUsd: 15,
      remainingUsd: null,
      percentUsed: null,
      benchmarkEligible: false,
      comparisonsMatchBudgetWindow: false,
      points: [{ date: "2026-05-21", spendUsd: 15 }],
    });
  });

  it("preserves the known annual plan when usage coverage is partial", () => {
    expect(buildFixedTeamBudgetTracking({
      dailySpend: spend,
      unavailableDays: new Set(["2026-05-20"]),
      scopeComplete: true,
      usageObserved: true,
      allocationUsd: 100,
      canonicalSpendUsd: 25,
      now,
      workspaceCount: 2,
    })).toMatchObject({
      budgetKind: "annual",
      workspaceCount: 2,
      allocationUsd: 100,
      remainingUsd: null,
      percentUsed: null,
      usageComplete: false,
      benchmarkEligible: true,
    });
  });

  it("uses monthly Agent semantics without manufacturing missing cycle usage", () => {
    expect(buildFixedTeamBudgetTracking({
      dailySpend: new Map(),
      unavailableDays: new Set(["2026-05-20", "2026-05-21"]),
      scopeComplete: true,
      usageObserved: false,
      allocationUsd: 40,
      canonicalSpendUsd: 0,
      now,
      budgetKind: "monthly_agent",
      workspaceCount: 2,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      periodLabel: "May 2026 billing cycle",
      reportingStart: "2026-05-20T00:00:00.000Z",
      reportingEndExclusive: "2026-05-22T00:00:00.000Z",
    })).toMatchObject({
      budgetKind: "monthly_agent",
      workspaceCount: 2,
      allocationUsd: 40,
      spendUsd: null,
      remainingUsd: null,
      percentUsed: null,
      usageComplete: false,
      benchmarkEligible: false,
      points: [
        { date: "2026-05-20", spendUsd: null },
        { date: "2026-05-21", spendUsd: null },
      ],
    });
  });

  it("preserves a verified zero monthly Agent total", () => {
    expect(buildFixedTeamBudgetTracking({
      dailySpend: new Map([["2026-05-20", 0]]),
      unavailableDays: new Set(),
      scopeComplete: true,
      usageObserved: true,
      allocationUsd: 40,
      canonicalSpendUsd: 0,
      now,
      budgetKind: "monthly_agent",
      reportingStart: "2026-05-20T00:00:00.000Z",
      reportingEndExclusive: "2026-05-21T00:00:00.000Z",
    })).toMatchObject({
      spendUsd: 0,
      remainingUsd: 40,
      percentUsed: 0,
      points: [{ date: "2026-05-20", spendUsd: 0 }],
    });
  });

  it("renders current-membership spend and the annual plan without claiming exact balances", () => {
    const result = buildFixedTeamBudgetTracking({
      dailySpend: spend,
      unavailableDays: new Set(),
      scopeComplete: true,
      usageObserved: true,
      allocationUsd: 100,
      canonicalSpendUsd: 25,
      now,
      reporting: {
        acquisitionCoverage: "complete",
        rosterAttributionBasis: "current_membership",
        creatorCoverage: "complete",
        creatorAttributionBasis: "not_applicable",
        freshness: "fresh",
        valueBasis: "current_membership_qualified",
        comparisonsVerified: false,
      },
    });
    expect(result.points).toEqual([
      { date: "2026-05-20", spendUsd: 10 },
      { date: "2026-05-21", spendUsd: 25 },
    ]);
    expect(result.spendUsd).toBe(25);
    expect(result.remainingUsd).toBeNull();
    expect(result.percentUsed).toBeNull();
    expect(result.benchmarkEligible).toBe(true);
    expect(result.reporting.valueBasis).toBe("current_membership_qualified");
  });

  it("retains the full GPO allocation and term even when historical comparisons are qualified", () => {
    const result = buildFixedTeamBudgetTracking({
      dailySpend: new Map([["2026-09-08", 2512.05]]),
      unavailableDays: new Set(["2026-05-20"]),
      scopeComplete: true,
      usageObserved: true,
      allocationUsd: 9368.38,
      canonicalSpendUsd: 2512.05,
      now: new Date("2026-09-08T12:00:00Z"),
      reporting: {
        acquisitionCoverage: "partial",
        rosterAttributionBasis: "current_membership",
        creatorCoverage: "complete",
        creatorAttributionBasis: "not_applicable",
        freshness: "fresh",
        valueBasis: "current_membership_qualified",
        comparisonsVerified: false,
      },
    });
    expect(result).toMatchObject({
      allocationUsd: 9368.38,
      periodStart: "2026-05-20",
      periodEnd: "2027-05-20",
      asOf: "2026-09-08",
      benchmarkEligible: true,
      remainingUsd: null,
      percentUsed: null,
    });
    expect(result.points.at(-1)).toEqual({ date: "2026-09-08", spendUsd: 2512.05 });
  });

  it("does not manufacture actual usage when showing a known annual plan", () => {
    const result = buildFixedTeamBudgetTracking({
      dailySpend: new Map(),
      unavailableDays: new Set(["2026-05-20", "2026-05-21"]),
      scopeComplete: true,
      usageObserved: false,
      allocationUsd: 9368.38,
      canonicalSpendUsd: 0,
      now,
    });
    expect(result).toMatchObject({
      benchmarkEligible: true,
      spendUsd: null,
      remainingUsd: null,
      percentUsed: null,
    });
    expect(result.points.every(point => point.spendUsd === null)).toBe(true);
  });

  it("keeps known cumulative values after source gaps and reconciles the final point", () => {
    const result = buildFixedTeamBudgetTracking({
      dailySpend: new Map([
        ["2026-05-21", 0],
        ["2026-05-23", 7],
      ]),
      unavailableDays: new Set(["2026-05-20", "2026-05-22"]),
      scopeComplete: true,
      usageObserved: true,
      allocationUsd: 100,
      canonicalSpendUsd: 7,
      now: new Date("2026-05-23T18:00:00.000Z"),
    });
    expect(result.points).toEqual([
      { date: "2026-05-20", spendUsd: null },
      { date: "2026-05-21", spendUsd: 0 },
      { date: "2026-05-22", spendUsd: 0 },
      { date: "2026-05-23", spendUsd: 7 },
    ]);
    expect(result.points.at(-1)?.spendUsd).toBe(result.spendUsd);
  });
});

describe("empty reporting scopes", () => {
  it("keeps an empty daily source unavailable", () => {
    expect(reportingSemanticsForGroups(new Map(), [])).toEqual({
      acquisitionCoverage: "unavailable",
      rosterAttributionBasis: "observed_roster",
      creatorCoverage: "not_applicable",
      creatorAttributionBasis: "not_applicable",
      freshness: "unavailable",
      valueBasis: "unavailable",
      comparisonsVerified: false,
    });
  });

  it("does not borrow another workspace's observed usage", () => {
    expect(reportingSemanticsForGroups(
      new Map([["2026-05-20", otherWorkspace]]),
      [],
    )).toMatchObject({
      acquisitionCoverage: "unavailable",
      freshness: "unavailable",
      valueBasis: "unavailable",
      comparisonsVerified: false,
    });
  });
});
