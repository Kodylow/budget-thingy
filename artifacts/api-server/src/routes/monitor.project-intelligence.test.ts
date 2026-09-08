import { describe, expect, test } from "vitest";
import {
  isStaleButSpending,
  projectSpendRowIdentity,
  projectSpendRowsForUsage,
  type SpendRow,
} from "../services/scoped-accounting";
import { filterAndSortSpendRows } from "./monitor.spend-tables";

function row(
  id: string,
  updatedAt: string | null,
  options: Partial<SpendRow> = {},
): SpendRow {
  return {
    id: `project:workspace:${id}`,
    projectId: id,
    kind: "project",
    name: id,
    workspaceId: "workspace",
    workspaceName: "Workspace",
    spendUsd: 0,
    agentSpendUsd: 0,
    otherServicesUsd: 0,
    allocationUsd: null,
    remainingUsd: null,
    percentUsed: null,
    status: "attributed",
    memberCount: null,
    ownerName: null,
    limitState: "not_applicable",
    limitObservationStatus: "not_applicable",
    sharedPool: false,
    usageObserved: true,
    updatedAt,
    hasDeployment: false,
    staleButSpending: false,
    ...options,
  };
}

describe("project intelligence qualification", () => {
  test("keeps actual project ID distinct from workspace-qualified row ID", () => {
    expect(projectSpendRowIdentity("workspace-123", "actual-project-uuid"))
      .toEqual({
        id: "project:workspace-123:actual-project-uuid",
        projectId: "actual-project-uuid",
      });
  });

  test("current-month projection preserves differing daily team attribution", () => {
    const projectKey = "workspace\u0000actual-project";
    const day = (
      groupId: string,
      amount: number,
    ) => ({
      projectAttribution: {
        aiSpendByProject: new Map([[projectKey, amount]]),
        nonAiSpendByProject: new Map(),
        projectToGroup: new Map([[projectKey, groupId]]),
        creatorByProject: new Map([[projectKey, "shared-member"]]),
        isComplete: true,
      },
    });
    const usage = {
      groups: [{ id: "selected-group", workspaceId: "workspace" }],
      workspaceIds: new Set(["workspace"]),
      projectMetadata: {
        byWorkspace: new Map([[
          "workspace",
          new Map([[
            "actual-project",
            {
              creatorId: "shared-member",
              title: "Project",
              fetchedAt: new Date("2026-06-30T00:00:00.000Z"),
            },
          ]]),
        ]]),
        freshnessByWorkspace: new Map(),
      },
      snapshot: {
        window: {
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-03T00:00:00.000Z",
        },
        dailyWorkspaces: new Map([
          ["2026-06-01", new Map([["workspace", {}]])],
          ["2026-06-02", new Map([["workspace", {}]])],
        ]),
        coverage: {
          failedWorkspaceDays: [],
          missingWorkspaceDays: [],
        },
      },
    };
    const selected = {
      authz: {
        userId: "admin",
        roles: ["team_admin"],
        workspaceIds: [],
        groupUserIds: { "selected-group": ["shared-member"] },
      },
      usage,
      dir: { workspaces: new Map() },
    };
    const rows = projectSpendRowsForUsage(
      selected as never,
      usage as never,
      new Map([
        ["2026-06-01", day("selected-group", 4)],
        ["2026-06-02", day("other-team-group", 6)],
      ]) as never,
      new Map([["actual-project", { workspaceId: "workspace" }]]),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: "project:workspace:actual-project",
        projectId: "actual-project",
        spendUsd: 4,
      }),
    ]);
  });

  test("uses an inclusive exact 30 elapsed-day boundary", () => {
    const cutoff = "2026-07-02T12:34:56.000Z";
    expect(isStaleButSpending(cutoff, 0.01, cutoff)).toBe(true);
    expect(isStaleButSpending("2026-07-02T12:34:56.001Z", 1, cutoff))
      .toBe(false);
  });

  test("never treats missing, invalid, future, or zero-spend facts as stale", () => {
    const cutoff = "2026-07-02T00:00:00.000Z";
    expect(isStaleButSpending(null, 1, cutoff)).toBe(false);
    expect(isStaleButSpending("invalid", 1, cutoff)).toBe(false);
    expect(isStaleButSpending("2027-01-01T00:00:00.000Z", 1, cutoff))
      .toBe(false);
    expect(isStaleButSpending("2020-01-01T00:00:00.000Z", 0, cutoff))
      .toBe(false);
    expect(isStaleButSpending("2020-01-01T00:00:00.000Z", null, cutoff))
      .toBe(false);
  });

  test("applies deployment and stale filters before stable date paging", () => {
    const rows = [
      row("null", null, { hasDeployment: true, staleButSpending: true }),
      row("same-b", "2026-01-01T00:00:00.000Z", {
        hasDeployment: true, staleButSpending: true,
      }),
      row("same-a", "2026-01-01T00:00:00.000Z", {
        hasDeployment: true, staleButSpending: true,
      }),
      row("new", "2026-02-01T00:00:00.000Z", {
        hasDeployment: false, staleButSpending: true,
      }),
    ];
    const filtered = filterAndSortSpendRows(rows, {
      deployedOnly: true,
      staleButSpending: true,
      sort: "updated_at_asc",
    });
    expect(filtered.map((item) => item.projectId))
      .toEqual(["same-a", "same-b", "null"]);
  });
});