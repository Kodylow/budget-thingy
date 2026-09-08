// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildUnassignedDetail,
  unassignedDetailObservation,
} from "./monitor.org-insights";

const authz = {
  roles: ["account"],
  workspaceIds: [],
};

function pool(overrides) {
  return {
    id: "pool:group:unused",
    workspaceId: null,
    workspaceName: null,
    spendUsd: 0,
    ...overrides,
  };
}

function rollup(spendByGroup) {
  return {
    aiSpendByGroup: new Map(Object.entries(spendByGroup)
      .map(([id, spend]) => [id, new Map([["user", spend]])])),
    nonAiSpendByGroup: new Map(Object.keys(spendByGroup)
      .map((id) => [id, new Map()])),
  };
}

describe("Org Insights unassigned detail", () => {
  it.each([
    {
      label: "observed no-group-only workspace",
      workspaceIds: new Set(["no-groups"]),
      coverage: {
        requestedDays: 1,
        requestedWorkspaceDays: 1,
        presentWorkspaceDays: 1,
        failedWorkspaceDays: [],
        missingWorkspaceDays: [],
        presentAccountDays: 1,
        missingAccountDays: [],
      },
      expected: "complete",
    },
    {
      label: "unavailable grouped workspace and observed groupless workspace",
      workspaceIds: new Set(["grouped", "no-groups"]),
      coverage: {
        requestedDays: 1,
        requestedWorkspaceDays: 2,
        presentWorkspaceDays: 1,
        failedWorkspaceDays: [{ workspaceId: "grouped" }],
        missingWorkspaceDays: [],
        presentAccountDays: 1,
        missingAccountDays: [],
      },
      expected: "partial",
    },
    {
      label: "observed grouped workspace and missing groupless workspace",
      workspaceIds: new Set(["grouped", "no-groups"]),
      coverage: {
        requestedDays: 1,
        requestedWorkspaceDays: 2,
        presentWorkspaceDays: 1,
        failedWorkspaceDays: [],
        missingWorkspaceDays: [{ workspaceId: "no-groups" }],
        presentAccountDays: 1,
        missingAccountDays: [],
      },
      expected: "partial",
    },
  ])("uses all workspace coverage for $label", ({ workspaceIds, coverage, expected }) => {
    expect(unassignedDetailObservation({
      accountSpendUsd: 10,
      workspaceIds,
      coverage,
    })).toBe(expected);
  });

  it("splits canonical non-team sources by workspace and reconciles funded/no-group usage", () => {
    const detail = buildUnassignedDetail({
      accountSpendUsd: 67,
      authz,
      observation: "partial",
      groups: [
        { id: "assigned", name: "Assigned", workspaceId: "a" },
        { id: "same-a", name: "Same name", workspaceId: "a" },
        { id: "same-b", name: "Same name", workspaceId: "b" },
      ],
      workspaceNames: new Map([["a", "Alpha"], ["b", "Beta"]]),
      daily: new Map([["2026-06-17", rollup({
        assigned: 10,
        "same-a": 30,
        "same-b": 20,
      })]]),
      poolRows: [
        // An unavailable assigned balance is still assigned spend.
        pool({
          id: "pool:team:assigned",
          spendUsd: 10,
          usageObserved: false,
          sourceGroupIds: ["assigned"],
        }),
        // One merged canonical pool can contain physical groups in two workspaces.
        // Duplicate source inventory must not duplicate spend.
        pool({
          id: "pool:group:a:same-a",
          spendUsd: 50,
          sourceGroupIds: ["same-a", "same-b", "same-a"],
        }),
        // A group allocation does not make this a team assignment.
        pool({
          id: "pool:unbudgeted:a",
          workspaceId: "a",
          workspaceName: "Alpha",
          spendUsd: 7,
        }),
      ],
    });

    expect(detail.observation).toBe("partial");
    expect(detail.workspaces).toEqual([
      {
        workspaceId: "a",
        workspaceName: "Alpha",
        spendUsd: 37,
        rows: [
          {
            id: "group:a:same-a",
            groupName: "Same name",
            source: "unmapped_group",
            spendUsd: 30,
          },
          {
            id: "no-group:a",
            groupName: null,
            source: "no_group",
            spendUsd: 7,
          },
        ],
      },
      {
        workspaceId: "b",
        workspaceName: "Beta",
        spendUsd: 20,
        rows: [{
          id: "group:b:same-b",
          groupName: "Same name",
          source: "unmapped_group",
          spendUsd: 20,
        }],
      },
    ]);
    expect(detail.workspaces.reduce((sum, workspace) =>
      sum + workspace.spendUsd, 0)).toBe(57);
  });

  it("keeps excluded/assigned amounts out and locates only a genuine difference at null", () => {
    const detail = buildUnassignedDetail({
      accountSpendUsd: 20,
      authz,
      observation: "complete",
      groups: [
        { id: "assigned", name: "Assigned", workspaceId: "a" },
        { id: "unmapped", name: "Unmapped", workspaceId: "a" },
      ],
      daily: new Map([["2026-06-17", rollup({
        assigned: 8,
        unmapped: 9,
        // Excluded usage is intentionally absent from eligible group maps.
      })]]),
      poolRows: [
        pool({ id: "pool:team:assigned", spendUsd: 8 }),
        pool({
          id: "pool:group:a:unmapped",
          workspaceId: "a",
          workspaceName: "Alpha",
          spendUsd: 9,
          allocationUsd: 100,
          sourceGroupIds: ["unmapped"],
        }),
      ],
    });

    expect(detail.workspaces).toEqual([
      {
        workspaceId: "a",
        workspaceName: "Alpha",
        spendUsd: 9,
        rows: [{
          id: "group:a:unmapped",
          groupName: "Unmapped",
          source: "unmapped_group",
          spendUsd: 9,
        }],
      },
      {
        workspaceId: null,
        workspaceName: null,
        spendUsd: 3,
        rows: [{
          id: "unresolved-difference",
          groupName: null,
          source: "unresolved_difference",
          spendUsd: 3,
        }],
      },
    ]);
  });

  it("returns no rows when detail observation is unavailable", () => {
    expect(buildUnassignedDetail({
      accountSpendUsd: 12,
      authz,
      observation: "unavailable",
      groups: [],
      daily: new Map(),
      poolRows: [],
    })).toEqual({ observation: "unavailable", workspaces: [] });
  });

  it("reconciles rounded rows and workspace subtotals exactly at 1e-8", () => {
    const detail = buildUnassignedDetail({
      accountSpendUsd: 0.00000003,
      authz,
      observation: "complete",
      groups: [
        { id: "a", name: "A", workspaceId: "workspace" },
        { id: "b", name: "B", workspaceId: "workspace" },
      ],
      daily: new Map([["2026-06-17", rollup({
        a: 0.000000014,
        b: 0.000000014,
      })]]),
      poolRows: [
        pool({
          id: "pool:group:workspace:a",
          sourceGroupIds: ["a"],
        }),
        pool({
          id: "pool:group:workspace:b",
          sourceGroupIds: ["b"],
        }),
      ],
    });

    expect(detail.workspaces[0].rows.map((row) => row.spendUsd))
      .toEqual([0.00000002, 0.00000001]);
    expect(detail.workspaces[0].spendUsd).toBe(0.00000003);
    expect(detail.workspaces.reduce((sum, workspace) =>
      sum + workspace.spendUsd, 0)).toBe(0.00000003);
  });
});