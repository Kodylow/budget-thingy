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
  qualification: null,
  summary: {
    accountSpendUsd: 15000,
    teamAllocationUsd: 100000,
    remainingUsd: 85000,
    teamsOverBudget: 1,
    unassignedSpendUsd: 0,
  },
  teams: [
    {
      id: "team.A.[special]", // tests safe keys
      name: "Engineering",
      allocationUsd: 50000,
      spendUsd: 60000, // over budget
      remainingUsd: -10000,
      percentUsed: 120, // >100%
      complete: true,
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
      points: [
        { date: "2026-05-20", spendUsd: 0 },
        { date: "2026-05-25", spendUsd: null }, // testing null gap
        { date: "2026-06-10", spendUsd: 10000 },
      ],
    },
    {
      id: "team-zero",
      name: "Zero Budget Team",
      allocationUsd: 0, // Should be excluded from chart
      spendUsd: 500,
      remainingUsd: -500,
      percentUsed: null,
      complete: true,
      points: [
        { date: "2026-06-10", spendUsd: 500 },
      ],
    }
  ]
};

describe("OrgBudgetChart", () => {
  it("renders the chart shell without crashing (including >100% domains and null gaps)", () => {
    const html = renderToStaticMarkup(<OrgBudgetChart data={mockData} />);

    // Title is present
    expect(html).toContain("Teams Budget Trajectory");
    // Explicit label check
    expect(html).toContain("Planning benchmark, not a forecast.");
  });

  it("shows empty state when no teams are eligible", () => {
    const emptyData = { ...mockData, teams: [mockData.teams[2]] }; // Only zero budget team
    const html = renderToStaticMarkup(<OrgBudgetChart data={emptyData} />);
    expect(html).toContain("No teams with funded budgets found");
  });
});

describe("OrgTeamsTable", () => {
  it("renders all teams including zero budget teams", () => {
    const html = renderToStaticMarkup(<OrgTeamsTable teams={mockData.teams} />);

    expect(html).toContain("Engineering");
    expect(html).toContain("Marketing");
    expect(html).toContain("Zero Budget Team");

    // Checks over budget percentages render without crashing
    expect(html).toContain("120.0%");
  });
});
