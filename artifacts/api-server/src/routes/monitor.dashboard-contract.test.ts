import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  GetDashboardResponse,
  ListSpendGroupsResponse,
  ListSpendPeopleResponse,
  ListSpendPoolsResponse,
  ListSpendProjectsResponse,
} from "@workspace/api-zod";
import monitorRouter from "./monitor";
import {
  dashboardDrillThrough,
  dashboardQueryError,
} from "./monitor.dashboard";

type RouterLayer = {
  route?: { path?: string };
  handle?: { stack?: RouterLayer[] };
};

function mountedPaths(layers: RouterLayer[]): string[] {
  return layers.flatMap((layer) => [
    ...(typeof layer.route?.path === "string" ? [layer.route.path] : []),
    ...mountedPaths(layer.handle?.stack ?? []),
  ]);
}

describe("dashboard and spend endpoint contracts", () => {
  test("runtime router mounts every JSON and CSV boundary", () => {
    const paths = mountedPaths(
      (monitorRouter as unknown as { stack: RouterLayer[] }).stack,
    );
    expect(paths).toEqual(expect.arrayContaining([
      "/dashboard",
      "/spend/pools",
      "/spend/groups",
      "/spend/people",
      "/spend/projects",
      "/spend/pools.csv",
      "/spend/groups.csv",
      "/spend/people.csv",
      "/spend/projects.csv",
    ]));
  });

  test("generated response validators preserve the complete dashboard generation", () => {
    expect(GetDashboardResponse).toBeDefined();
    expect(ListSpendPoolsResponse).toBeDefined();
    expect(ListSpendGroupsResponse).toBeDefined();
    expect(ListSpendPeopleResponse).toBeDefined();
    expect(ListSpendProjectsResponse).toBeDefined();
    const dashboard = GetDashboardResponse.parse({
      scope: {
        viewScope: "managed",
        label: "Managed scope",
        workspaceIds: ["w1"],
        groupIds: ["g1"],
        isPersonal: false,
      },
      period: {
        start: "2026-09-01T00:00:00.000Z",
        endExclusive: "2026-09-03T00:00:00.000Z",
        timezone: "UTC",
        label: "Custom",
      },
      cardVariant: "usage_analysis",
      cards: [
        { key: "spend", label: "Spend", value: 9, unit: "usd", qualification: null },
        { key: "agent_spend", label: "Agent", value: 6, unit: "usd", qualification: null },
        { key: "other_services", label: "Other", value: 3, unit: "usd", qualification: null },
        { key: "members_with_spend", label: "Members", value: 1, unit: "count", qualification: null },
      ],
      trend: {
        granularity: "day",
        mode: "period",
        buckets: [{
          start: "2026-09-01T00:00:00.000Z",
          endExclusive: "2026-09-02T00:00:00.000Z",
          spendUsd: 9,
          valueUsd: 9,
          isPartial: false,
          isMissing: false,
        }],
      },
      breakdown: [{
        id: "group:w1:g1",
        label: "Group",
        spendUsd: 9,
        kind: "group",
        drillThrough: "/spend?view=groups",
      }],
      accounting: {
        eligibleSpendUsd: 9,
        grossSpendUsd: 10,
        internalExcludedUsd: 1,
        unbudgetedUsd: 0,
        unattributedUsd: 0,
        reconciliationUsd: 0,
        agentSpendUsd: 6,
        otherServicesUsd: 3,
      },
      metadata: {
        generationId: "fixture-generation",
        costBasis: "allocation_eligible_committed",
        status: "partial",
        dataAsOf: "2026-09-02T00:00:00.000Z",
        directoryDataAsOf: "2026-09-02T00:00:00.000Z",
        stale: true,
        coverage: {
          ratio: 0.5,
          requestedDays: 2,
          missingDays: ["2026-09-02"],
          failedWorkspaceDays: [],
        },
        qualifications: ["Partial usage coverage; missing facts are not zero."],
        limitObservation: {
          status: "unavailable",
          observedAt: null,
          lastSuccessfulAt: null,
          lastAttemptAt: null,
          refreshStartedAt: null,
          generation: null,
          error: null,
        },
      },
    });
    expect(dashboard.accounting).toMatchObject({
      agentSpendUsd: 6,
      otherServicesUsd: 3,
    });
    expect(dashboard.metadata).toMatchObject({
      generationId: "fixture-generation",
      status: "partial",
      stale: true,
      limitObservation: { status: "unavailable" },
    });
    expect(() => GetDashboardResponse.parse({
      ...dashboard,
      period: { ...dashboard.period, timezone: "local" },
    })).toThrow();

    expect(() => ListSpendPoolsResponse.parse({
      view: "pools",
      scope: {
        viewScope: "managed",
        label: "Managed scope",
        workspaceIds: ["w1"],
        groupIds: ["g1"],
        isPersonal: false,
      },
      period: {
        start: "2026-09-01T00:00:00.000Z",
        endExclusive: "2026-09-02T00:00:00.000Z",
        timezone: "UTC",
        label: "Custom",
      },
      rows: [{
        id: "pool:team:Shared",
        kind: "pool",
        name: "Shared",
        workspaceId: null,
        workspaceName: null,
        spendUsd: 4,
        agentSpendUsd: 4,
        otherServicesUsd: 0,
        allocationUsd: null,
        remainingUsd: null,
        percentUsed: null,
        status: "shared",
        memberCount: 1,
        ownerName: null,
        limitState: "not_applicable",
        limitObservationStatus: "not_applicable",
        sharedPool: true,
      }],
      page: 1,
      pageSize: 25,
      totalRows: 1,
      filteredRows: 1,
      totals: {
        spendUsd: 4,
        agentSpendUsd: 4,
        otherServicesUsd: 0,
        allocationUsd: 0,
        internalExcludedUsd: 0,
        unbudgetedUsd: 0,
        unattributedUsd: 0,
        reconciliationUsd: 0,
      },
      facets: {
        statuses: { shared: 1 },
        workspaces: [],
      },
      metadata: {
        generationId: "fixture-generation",
        costBasis: "allocation_eligible_committed",
        status: "complete",
        dataAsOf: "2026-09-02T00:00:00.000Z",
        directoryDataAsOf: "2026-09-02T00:00:00.000Z",
        stale: false,
        coverage: {
          ratio: 1,
          requestedDays: 1,
          missingDays: [],
          failedWorkspaceDays: [],
        },
        qualifications: [],
        limitObservation: {
          status: "complete",
          observedAt: 1,
          lastSuccessfulAt: 1,
          lastAttemptAt: 1,
          refreshStartedAt: null,
          generation: "fixture-limits",
          error: null,
        },
      },
    })).not.toThrow();
  });

  test("invalid custom queries are distinct from unavailable stored accounting", () => {
    expect(dashboardQueryError({ rangeType: "custom" }))
      .toBe("Custom ranges require startDate and endDate");
    expect(dashboardQueryError({
      rangeType: "custom",
      startDate: "2026-09-03",
      endDate: "2026-09-01",
    })).toBe("Custom range startDate must not be after endDate");
    expect(dashboardQueryError({
      rangeType: "custom",
      startDate: "2026-02-31",
      endDate: "2026-03-01",
    })).toContain("valid UTC dates");
    expect(dashboardQueryError({
      rangeType: "custom",
      startDate: "2026-09-01",
      endDate: "2026-09-03",
    })).toBeNull();
  });

  test("every drill-through can preserve the resolved scope and UTC window", () => {
    const href = dashboardDrillThrough(
      "all_authorized",
      "2026-09-01T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
      "R&D / Platform",
    );
    const url = new URL(href, "https://example.test");
    expect(url.pathname).toBe("/spend");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      view: "groups",
      viewScope: "all_authorized",
      rangeType: "custom",
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      search: "R&D / Platform",
    });
  });

  test("ordinary dashboard generation is wired only to persisted readers", () => {
    const route = readFileSync(
      new URL("./monitor.dashboard.ts", import.meta.url),
      "utf8",
    );
    const accounting = readFileSync(
      new URL("../services/scoped-accounting.ts", import.meta.url),
      "utf8",
    );
    expect(route).toContain("buildScopedAccounting");
    expect(route).not.toMatch(/getSummary|GetSummary|getTrends|GetTrends/);
    expect(accounting).toContain("getCachedDirectory");
    expect(accounting).not.toMatch(
      /listReplitMemberBudgets|fetchFreshLimitDirectory|getFreshDirectoryForLimitValidation/,
    );
  });
});