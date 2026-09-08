import React from 'react';
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from 'react-dom/server';
import { OrgBudgetChart, OrgTeamsTable } from "./org-insights-components";
import { OrgBudgetOverviewResponse } from "@workspace/api-client-react";

vi.mock("wouter", () => ({
  Link: ({ children, href }: any) => <a href={href}>{children}</a>,
  useSearch: () => "",
}));

const mockData: OrgBudgetOverviewResponse = {
  periodStart: "2026-05-20",
  periodEnd: "2027-05-20",
  asOf: "2026-06-15",
  complete: true,
  reporting: {
    acquisitionCoverage: "complete",
    rosterAttributionBasis: "observed_roster",
    creatorCoverage: "complete",
    creatorAttributionBasis: "not_applicable",
    freshness: "fresh",
    valueBasis: "verified",
    comparisonsVerified: true,
  },
  qualification: null,
  summary: {
    accountSpendUsd: 15000,
    teamAllocationUsd: 100000,
    remainingUsd: 85000,
    teamsOverBudget: 1,
    unassignedSpendUsd: 0,
    fundedTeamCount: 3,
    resolvedTeamCount: 3,
    unresolvedTeamCount: 0,
  },
  unassignedDetail: {
    observation: "complete",
    workspaces: [],
  },
  accountPoints: [
    { date: "2026-05-20", spendUsd: 0 },
    { date: "2026-06-10", spendUsd: 15000 },
  ],
  teams: [
    {
      id: "team.A.[special]", // tests safe keys
      name: "Engineering",
      allocationUsd: 50000,
      spendUsd: 60000, // over budget
      remainingUsd: -10000,
      percentUsed: 120, // >100%
      complete: true,
      reporting: {
        acquisitionCoverage: "complete", rosterAttributionBasis: "observed_roster",
        creatorCoverage: "complete", creatorAttributionBasis: "not_applicable", freshness: "fresh",
        valueBasis: "verified", comparisonsVerified: true,
      },
      points: [
        { date: "2026-05-20", spendUsd: 0 },
        { date: "2026-05-30", spendUsd: 20000 },
        { date: "2026-06-10", spendUsd: 60000 },
      ],
    },
    {
      id: "team-B",
      name: "Marketing",
      allocationUsd: 20000,
      spendUsd: 10000,
      remainingUsd: 10000,
      percentUsed: 50,
      complete: false, // partial data should show dotted
      reporting: {
        acquisitionCoverage: "complete", rosterAttributionBasis: "current_membership",
        creatorCoverage: "complete", creatorAttributionBasis: "not_applicable", freshness: "fresh",
        valueBasis: "current_membership_qualified", comparisonsVerified: false,
      },
      points: [
        { date: "2026-05-20", spendUsd: 0 },
        { date: "2026-05-25", spendUsd: null }, // testing null gap
        { date: "2026-06-10", spendUsd: 10000 },
      ],
    },
    {
      id: "team-zero",
      name: "Zero Budget Team",
      allocationUsd: 0,
      spendUsd: 500,
      remainingUsd: -500,
      percentUsed: null,
      complete: true,
      reporting: {
        acquisitionCoverage: "complete", rosterAttributionBasis: "observed_roster",
        creatorCoverage: "complete", creatorAttributionBasis: "not_applicable", freshness: "fresh",
        valueBasis: "verified", comparisonsVerified: true,
      },
      points: [
        { date: "2026-06-10", spendUsd: 500 },
      ],
    }
  ]
};

describe("OrgBudgetChart", () => {
  it("renders the chart shell without crashing (including >100% domains and null gaps)", () => {
    const html = renderToStaticMarkup(<OrgBudgetChart data={mockData} onRetry={async () => {}} />);
    expect(html).toContain("Budget Trajectory");
    expect(html).toContain("Total eligible account spend");
    expect(html).not.toContain("historical rosters were not observed");
  });

  it("keeps zero-allocation teams consistent with funded summaries and the teams table", () => {
    const zeroData = { ...mockData, teams: [mockData.teams[2]] };
    const html = renderToStaticMarkup(<OrgBudgetChart data={zeroData} onRetry={async () => {}} />);
    expect(html).toContain(">Total</span>");
    expect(html).toContain(">Zero Budget Team</span>");
  });
});

describe("OrgTeamsTable", () => {
  it.each([
    ["qualified recorded spend", 13115.74, 1609.81, 11505.93, 12.273897927, "$11,505.93", "12.3%"],
    ["known zero spend", 100, 0, 100, 0, "$100.00", "0.0%"],
    ["zero allocation", 0, 500, -500, null, "-$500.00", "Not applicable"],
    ["zero allocation and spend", 0, 0, 0, null, "$0.00", "Not applicable"],
    ["overspend", 100, 150, -50, 150, "-$50.00", "150.0%"],
    ["missing spend", 100, null, null, null, "Unavailable", "Unavailable"],
    ["missing allocation", null, 50, null, null, "Unavailable", "Unavailable"],
    ["zero allocation with missing spend", 0, null, null, null, "Unavailable", "Unavailable"],
  ])("renders %s without client-side accounting", (_name, allocationUsd, spendUsd, remainingUsd, percentUsed, remaining, utilization) => {
    const team = {
      ...mockData.teams[1], allocationUsd, spendUsd, remainingUsd, percentUsed,
    } as OrgBudgetOverviewResponse["teams"][number];
    const html = renderToStaticMarkup(<OrgTeamsTable teams={[team]} />);
    expect(html).toContain(remaining);
    expect(html).toContain(utilization);
    expect(html).not.toContain("Partial data");
    expect(html).not.toContain("Current-membership qualified");
    expect(html).not.toContain("Infinity");
    if (spendUsd === null) expect(html).not.toContain("Not applicable");
    if (allocationUsd === null) expect(html).toContain("Not set");
  });

  it("does not compute a fallback when the API withholds a value", () => {
    const html = renderToStaticMarkup(<OrgTeamsTable teams={[{
      ...mockData.teams[1], remainingUsd: null, percentUsed: null,
    }]} />);
    expect(html.match(/Unavailable/g)).toHaveLength(2);
  });

  it("renders all teams including zero budget teams", () => {
    const html = renderToStaticMarkup(<OrgTeamsTable teams={mockData.teams} />);

    expect(html).toContain("Engineering");
    expect(html).toContain("Marketing");
    expect(html).toContain("Zero Budget Team");

    // Checks over budget percentages render without crashing
    expect(html).toContain("120.0%");
  });
});
