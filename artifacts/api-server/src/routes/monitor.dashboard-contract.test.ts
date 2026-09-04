import { describe, expect, test } from "vitest";
import {
  GetDashboardResponse,
  ListSpendGroupsResponse,
  ListSpendPeopleResponse,
  ListSpendPoolsResponse,
  ListSpendProjectsResponse,
} from "@workspace/api-zod";
import monitorRouter from "./monitor";

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

  test("generated response validators accept truthful integration shapes only", () => {
    expect(GetDashboardResponse).toBeDefined();
    expect(ListSpendPoolsResponse).toBeDefined();
    expect(ListSpendGroupsResponse).toBeDefined();
    expect(ListSpendPeopleResponse).toBeDefined();
    expect(ListSpendProjectsResponse).toBeDefined();
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
          error: null,
        },
      },
    })).not.toThrow();
  });
});