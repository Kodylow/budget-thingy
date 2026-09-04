// @ts-nocheck
import { test, expect } from "vitest";
import {
  computeDedupedMemberCounts,
  computeDedupedUsageRollup,
  computeHistoricalSnapshotUsageRollups,
  computeSnapshotUsageRollup,
  projectAttributionKey,
  usageSnapshotForDay,
} from "./usage-rollup.ts";

const groups = [
  { id: "z-group", workspaceId: "workspace-1", name: "Zeta" },
  { id: "a-group", workspaceId: "workspace-1", name: "Alpha" },
];

test("counts overlapping members once using deterministic first-group attribution", () => {
  const result = computeDedupedUsageRollup(
    groups,
    new Map([
      ["z-group", { byUser: new Map([["shared", 12], ["z-only", 8]]) }],
      ["a-group", { byUser: new Map([["shared", 12], ["a-only", 5]]) }],
    ]),
  );

  expect(result.totalSpendUsd).toBe(25);
  expect(result.totalMemberCount).toBe(3);
  expect(result.byGroup.get("a-group")).toEqual({
    spendUsd: 17,
    memberCount: 2,
    byUser: new Map([["shared", 12], ["a-only", 5]]),
  });
  expect(result.byGroup.get("z-group")).toEqual({
    spendUsd: 8,
    memberCount: 1,
    byUser: new Map([["z-only", 8]]),
  });
  expect(result.isComplete).toBe(true);
});

test("is independent of the incoming group order", () => {
  const usage = new Map([
    ["z-group", { byUser: new Map([["shared", 12]]) }],
    ["a-group", { byUser: new Map([["shared", 12]]) }],
  ]);

  const forward = computeDedupedUsageRollup(groups, usage);
  const reversed = computeDedupedUsageRollup([...groups].reverse(), usage);

  expect([...forward.byGroup]).toEqual([...reversed.byGroup]);
  expect(forward.totalSpendUsd).toBe(reversed.totalSpendUsd);
});

test("reports incomplete member usage without treating missing groups as loaded", () => {
  const result = computeDedupedUsageRollup(
    groups,
    new Map([["a-group", { byUser: new Map([["a-only", 5]]) }]]),
  );

  expect(result.pendingCount).toBe(1);
  expect(result.isComplete).toBe(false);
  expect(result.byGroup.get("z-group")).toEqual({ spendUsd: 0, memberCount: 0, byUser: new Map() });
});

test("deduplicates overlapping users even when their groups roll up to different teams", () => {
  const result = computeDedupedUsageRollup(
    [
      { id: "team-b-group", workspaceId: "workspace-1", name: "Beta" },
      { id: "team-a-group", workspaceId: "workspace-1", name: "Alpha" },
    ],
    new Map([
      ["team-a-group", { byUser: new Map([["shared", 40], ["a-only", 10]]) }],
      ["team-b-group", { byUser: new Map([["shared", 40], ["b-only", 20]]) }],
    ]),
  );

  const teamA = result.byGroup.get("team-a-group");
  const teamB = result.byGroup.get("team-b-group");
  expect(result.totalSpendUsd).toBe(70);
  expect((teamA?.spendUsd ?? 0) + (teamB?.spendUsd ?? 0)).toBe(result.totalSpendUsd);
  expect(teamA).toEqual({
    spendUsd: 50,
    memberCount: 2,
    byUser: new Map([["shared", 40], ["a-only", 10]]),
  });
  expect(teamB).toEqual({
    spendUsd: 20,
    memberCount: 1,
    byUser: new Map([["b-only", 20]]),
  });
});

test("retains per-group spend that cannot be attributed to a member", () => {
  const result = computeDedupedUsageRollup(
    groups,
    new Map([
      [
        "z-group",
        {
          byUser: new Map([["shared", 12], ["z-only", 8]]),
          unattributableTotalCostUsd: 3,
        },
      ],
      [
        "a-group",
        {
          byUser: new Map([["shared", 12], ["a-only", 5]]),
          unattributableTotalCostUsd: 3,
        },
      ],
    ]),
  );

  expect(result.totalSpendUsd).toBe(31);
  expect(result.byGroup.get("a-group")).toEqual({
    spendUsd: 20,
    memberCount: 2,
    byUser: new Map([["shared", 12], ["a-only", 5]]),
  });
  expect(result.byGroup.get("z-group")).toEqual({
    spendUsd: 11,
    memberCount: 1,
    byUser: new Map([["z-only", 8]]),
  });
});

test("counts directory members once even when they have no usage", () => {
  const counts = computeDedupedMemberCounts(
    groups,
    new Map([
      ["z-group", ["shared", "z-only", "zero-spend"]],
      ["a-group", ["shared", "a-only"]],
    ]),
  );

  expect(counts.get("a-group")).toBe(2);
  expect(counts.get("z-group")).toBe(2);
});

function snapshot(overrides = {}) {
  return {
    window: {
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-02T00:00:00.000Z",
    },
    workspaceIds: ["workspace-1", "workspace-2"],
    includesDailyMembers: false,
    status: "complete",
    dataAsOf: "2026-08-02T00:01:00.000Z",
    isLive: false,
    coverage: {
      requestedDays: 1,
      requestedWorkspaceDays: 2,
      presentWorkspaceDays: 2,
      failedWorkspaceDays: [],
      missingWorkspaceDays: [],
      presentAccountDays: 1,
      missingAccountDays: [],
      ratio: 1,
    },
    members: new Map(),
    projects: new Map(),
    workspaces: new Map(),
    daily: new Map(),
    accountDays: new Set(),
    accountTotalUsd: 0,
    ...overrides,
  };
}

test("derives snapshot totals with overlap, creator ownership, and residual spend", () => {
  const result = computeSnapshotUsageRollup({
    snapshot: snapshot({
      members: new Map([
        ["workspace-1", new Map([
          ["shared", { totalCostUsd: 14, aiCostUsd: 10 }],
          ["unmatched", { totalCostUsd: 5, aiCostUsd: 5 }],
        ])],
        ["workspace-2", new Map([
          ["shared", { totalCostUsd: 7, aiCostUsd: 7 }],
        ])],
      ]),
      projects: new Map([
        ["workspace-1", new Map([
          ["project-1", { totalCostUsd: 8, aiCostUsd: 2 }],
          ["orphan", { totalCostUsd: 3, aiCostUsd: 0 }],
        ])],
      ]),
      workspaces: new Map([
        ["workspace-1", {
          totalCostUsd: 30,
          memberAttributableUsd: 27,
          memberUnattributableUsd: 3,
        }],
        ["workspace-2", {
          totalCostUsd: 7,
          memberAttributableUsd: 7,
          memberUnattributableUsd: 0,
        }],
      ]),
      accountTotalUsd: 40,
    }),
    groups: [
      ...groups,
      { id: "workspace-2-group", workspaceId: "workspace-2", name: "Alpha" },
    ],
    membersByGroup: new Map([
      ["a-group", ["shared"]],
      ["z-group", ["shared"]],
      ["workspace-2-group", ["shared"]],
    ]),
    internalUserIds: new Set(),
    projectInfoByWorkspace: new Map([
      ["workspace-1", new Map([
        ["project-1", { creatorId: "shared" }],
        ["orphan", { creatorId: null }],
      ])],
      ["workspace-2", new Map()],
    ]),
  });

  expect(result.byGroup.get("a-group")?.spendUsd).toBe(16);
  expect(result.byGroup.get("z-group")?.spendUsd).toBe(0);
  expect(result.byGroup.get("workspace-2-group")?.spendUsd).toBe(7);
  expect(result.byUser.get("shared")).toBe(23);
  expect(result.aiSpendByUser.get("shared")).toBe(17);
  expect(result.nonAiSpendByUser.get("shared")).toBe(6);
  const projectKey = projectAttributionKey("workspace-1", "project-1");
  expect(result.projectAttribution.projectToGroup.get(projectKey)).toBe("a-group");
  expect(result.projectAttribution.nonAiSpendByProject.get(projectKey)).toBe(6);
  expect(result.ungroupedByWorkspace.get("workspace-1")?.spendUsd).toBe(14);
  expect(result.totalSpendUsd).toBe(37);
  expect(result.accountReconciliationSpendUsd).toBe(3);
  expect(
    [...result.byGroup.values()].reduce((sum, group) => sum + group.spendUsd, 0) +
      [...result.ungroupedByWorkspace.values()].reduce(
        (sum, group) => sum + group.spendUsd,
        0,
      ),
  ).toBe(result.totalSpendUsd);
});

test("does not attribute owning-workspace spend to a legacy-copy family", () => {
  const result = computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: ["owning-workspace", "legacy-workspace"],
      members: new Map([
        ["owning-workspace", new Map([
          ["shared-user", { totalCostUsd: 18, aiCostUsd: 18 }],
        ])],
        ["legacy-workspace", new Map()],
      ]),
      workspaces: new Map([
        ["owning-workspace", {
          totalCostUsd: 18,
          memberAttributableUsd: 18,
          memberUnattributableUsd: 0,
        }],
        ["legacy-workspace", {
          totalCostUsd: 0,
          memberAttributableUsd: 0,
          memberUnattributableUsd: 0,
        }],
      ]),
      accountTotalUsd: 18,
    }),
    groups: [
      {
        id: "owning-family",
        workspaceId: "owning-workspace",
        name: "Finance - Members",
      },
      {
        id: "legacy-copy-family",
        workspaceId: "legacy-workspace",
        name: "Finance - Members",
      },
    ],
    membersByGroup: new Map([
      ["owning-family", ["shared-user"]],
      ["legacy-copy-family", ["shared-user"]],
    ]),
    projectInfoByWorkspace: new Map([
      ["owning-workspace", new Map()],
      ["legacy-workspace", new Map()],
    ]),
  });

  expect(result.byGroup.get("owning-family")?.spendUsd).toBe(18);
  expect(result.byGroup.get("legacy-copy-family")?.spendUsd).toBe(0);
  expect(result.byUser.get("shared-user")).toBe(18);
  expect(result.totalSpendUsd).toBe(18);
});

test("keeps identical project IDs isolated by workspace", () => {
  const result = computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: ["workspace-1", "workspace-2"],
      projects: new Map([
        ["workspace-1", new Map([
          ["shared-project", { totalCostUsd: 11, aiCostUsd: 0 }],
        ])],
        ["workspace-2", new Map([
          ["shared-project", { totalCostUsd: 13, aiCostUsd: 0 }],
        ])],
      ]),
      workspaces: new Map([
        ["workspace-1", {
          totalCostUsd: 11,
          memberAttributableUsd: 11,
          memberUnattributableUsd: 0,
        }],
        ["workspace-2", {
          totalCostUsd: 13,
          memberAttributableUsd: 13,
          memberUnattributableUsd: 0,
        }],
      ]),
      accountTotalUsd: 24,
    }),
    groups: [
      { id: "group-1", workspaceId: "workspace-1", name: "One" },
      { id: "group-2", workspaceId: "workspace-2", name: "Two" },
    ],
    membersByGroup: new Map([
      ["group-1", ["creator-1"]],
      ["group-2", ["creator-2"]],
    ]),
    internalUserIds: new Set(),
    projectInfoByWorkspace: new Map([
      ["workspace-1", new Map([
        ["shared-project", { creatorId: "creator-1" }],
      ])],
      ["workspace-2", new Map([
        ["shared-project", { creatorId: "creator-2" }],
      ])],
    ]),
  });

  expect(result.projectAttribution.projectToGroup.get(
    projectAttributionKey("workspace-1", "shared-project"),
  )).toBe("group-1");
  expect(result.projectAttribution.projectToGroup.get(
    projectAttributionKey("workspace-2", "shared-project"),
  )).toBe("group-2");
  expect(result.byGroup.get("group-1")?.spendUsd).toBe(11);
  expect(result.byGroup.get("group-2")?.spendUsd).toBe(13);
  expect(result.totalSpendUsd).toBe(24);
  expect(result.isComplete).toBe(true);
});

test("marks missing creator metadata incomplete only when non-Agent ownership is needed", () => {
  const result = computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: ["workspace-1"],
      projects: new Map([["workspace-1", new Map([
        ["hosting", { totalCostUsd: 9, aiCostUsd: 0 }],
      ])]]),
      workspaces: new Map([["workspace-1", {
        totalCostUsd: 9,
        memberAttributableUsd: 0,
        memberUnattributableUsd: 9,
      }]]),
    }),
    groups,
    membersByGroup: new Map([["a-group", ["creator"]]]),
    internalUserIds: new Set(),
    projectInfoByWorkspace: new Map(),
  });
  expect(result.isComplete).toBe(false);
  expect(result.pendingCount).toBe(1);
  expect(result.ungroupedByWorkspace.get("workspace-1")?.spendUsd).toBe(9);
});

test("caps observed attribution at workspace authority and reports reconciliation pending", () => {
  const result = computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: ["workspace-1"],
      members: new Map([["workspace-1", new Map([
        ["member", { totalCostUsd: 8, aiCostUsd: 8 }],
      ])]]),
      projects: new Map([["workspace-1", new Map([
        ["project", { totalCostUsd: 7, aiCostUsd: 0 }],
      ])]]),
      workspaces: new Map([["workspace-1", {
        totalCostUsd: 10,
        memberAttributableUsd: 10,
        memberUnattributableUsd: 0,
      }]]),
      accountTotalUsd: 10,
    }),
    groups: [groups[1]],
    membersByGroup: new Map([["a-group", ["member"]]]),
    internalUserIds: new Set(),
    projectInfoByWorkspace: new Map([["workspace-1", new Map([
      ["project", { creatorId: "member" }],
    ])]]),
  });
  expect(result.byGroup.get("a-group")?.spendUsd).toBe(10);
  expect(result.totalSpendUsd).toBe(10);
  expect(result.pendingCount).toBe(1);
  expect(result.isComplete).toBe(false);
});

test("counts missing account coverage in pending diagnostics", () => {
  const result = computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: [],
      status: "partial",
      coverage: {
        requestedDays: 1,
        requestedWorkspaceDays: 0,
        presentWorkspaceDays: 0,
        failedWorkspaceDays: [],
        missingWorkspaceDays: [],
        presentAccountDays: 0,
        missingAccountDays: ["2026-08-01"],
        ratio: 0,
      },
    }),
    groups: [],
    membersByGroup: new Map(),
    internalUserIds: new Set(),
    projectInfoByWorkspace: new Map(),
  });
  expect(result.pendingCount).toBe(1);
  expect(result.isComplete).toBe(false);
});

test("builds isolated daily snapshots for historical roster rollups", () => {
  const full = snapshot({
    includesDailyMembers: true,
    daily: new Map([["2026-08-01", {
      accountTotalUsd: 12,
      workspaceTotalUsd: 10,
    }]]),
    accountDays: new Set(["2026-08-01"]),
    dailyMembers: new Map([["2026-08-01", new Map([
      ["workspace-1", new Map([["u-1", { totalCostUsd: 6, aiCostUsd: 4 }]])],
    ])]]),
    dailyProjects: new Map([["2026-08-01", new Map([
      ["workspace-1", new Map([["p-1", { totalCostUsd: 6, aiCostUsd: 2 }]])],
    ])]]),
    dailyWorkspaces: new Map([["2026-08-01", new Map([
      ["workspace-1", {
        totalCostUsd: 10,
        memberAttributableUsd: 10,
        memberUnattributableUsd: 0,
      }],
    ])]]),
  });
  const day = usageSnapshotForDay(full, "2026-08-01");
  expect(day.accountTotalUsd).toBe(12);
  expect(day.members.get("workspace-1")?.get("u-1")?.aiCostUsd).toBe(4);
  expect(day.projects.get("workspace-1")?.get("p-1")?.totalCostUsd).toBe(6);
  expect(day.workspaces.get("workspace-1")?.totalCostUsd).toBe(10);
});

test("rolls completed historical days with their roster and uncovered days with live membership", () => {
  const full = snapshot({
    window: {
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-04T00:00:00.000Z",
    },
    workspaceIds: ["workspace-1"],
    includesDailyMembers: true,
    daily: new Map([
      ["2026-08-01", { accountTotalUsd: 10, workspaceTotalUsd: 10 }],
      ["2026-08-02", { accountTotalUsd: 20, workspaceTotalUsd: 20 }],
      ["2026-08-03", { accountTotalUsd: 30, workspaceTotalUsd: 30 }],
    ]),
    accountDays: new Set(["2026-08-01", "2026-08-02", "2026-08-03"]),
    dailyMembers: new Map([
      ["2026-08-01", new Map([["workspace-1", new Map([
        ["old-member", { totalCostUsd: 10, aiCostUsd: 10 }],
      ])]])],
      ["2026-08-02", new Map([["workspace-1", new Map([
        ["new-member", { totalCostUsd: 20, aiCostUsd: 20 }],
      ])]])],
      ["2026-08-03", new Map([["workspace-1", new Map([
        ["new-member", { totalCostUsd: 30, aiCostUsd: 30 }],
      ])]])],
    ]),
    dailyProjects: new Map([
      ["2026-08-01", new Map()],
      ["2026-08-02", new Map()],
      ["2026-08-03", new Map()],
    ]),
    dailyWorkspaces: new Map([
      ["2026-08-01", new Map([["workspace-1", {
        totalCostUsd: 10,
        memberAttributableUsd: 10,
        memberUnattributableUsd: 0,
      }]])],
      ["2026-08-02", new Map([["workspace-1", {
        totalCostUsd: 20,
        memberAttributableUsd: 20,
        memberUnattributableUsd: 0,
      }]])],
      ["2026-08-03", new Map([["workspace-1", {
        totalCostUsd: 30,
        memberAttributableUsd: 30,
        memberUnattributableUsd: 0,
      }]])],
    ]),
  });
  const result = computeHistoricalSnapshotUsageRollups({
    snapshot: full,
    groups: [groups[1]],
    currentUtcDay: "2026-08-03",
    currentMembersByGroup: new Map([["a-group", ["new-member"]]]),
    completedRosterDays: new Set(["2026-08-01"]),
    rosterMembersByDate: new Map([
      ["2026-08-01", new Map([["a-group", ["old-member"]]])],
    ]),
    internalUserIds: new Set(),
    projectInfoByWorkspace: new Map([["workspace-1", new Map()]]),
  });

  expect(result.get("2026-08-01")?.byGroup.get("a-group")?.spendUsd).toBe(10);
  expect(result.get("2026-08-02")?.byGroup.get("a-group")?.spendUsd).toBe(20);
  expect(result.get("2026-08-03")?.byGroup.get("a-group")?.spendUsd).toBe(30);
  expect(
    [...result.values()].reduce((sum, day) => sum + day.totalSpendUsd, 0),
  ).toBe(60);
});

test("daily slices preserve missing account and failed workspace coverage", () => {
  const full = snapshot({
    workspaceIds: ["workspace-1"],
    includesDailyMembers: true,
    status: "partial",
    daily: new Map([["2026-08-01", {
      accountTotalUsd: 0,
      workspaceTotalUsd: 0,
    }]]),
    accountDays: new Set(),
    dailyMembers: new Map([["2026-08-01", new Map()]]),
    dailyProjects: new Map([["2026-08-01", new Map()]]),
    dailyWorkspaces: new Map([["2026-08-01", new Map()]]),
    coverage: {
      requestedDays: 1,
      requestedWorkspaceDays: 1,
      presentWorkspaceDays: 0,
      failedWorkspaceDays: [{
        workspaceId: "workspace-1",
        usageDate: "2026-08-01",
      }],
      missingWorkspaceDays: [],
      presentAccountDays: 0,
      missingAccountDays: ["2026-08-01"],
      ratio: 0,
    },
  });
  const day = usageSnapshotForDay(full, "2026-08-01");
  expect(day.status).toBe("partial");
  expect(day.coverage.failedWorkspaceDays).toEqual([{
    workspaceId: "workspace-1",
    usageDate: "2026-08-01",
  }]);
  expect(day.coverage.missingAccountDays).toEqual(["2026-08-01"]);
  expect(day.coverage.presentAccountDays).toBe(0);
  expect(day.coverage.ratio).toBe(0);
});

test("over-allocation capping is deterministic across snapshot map order", () => {
  const make = (entries) => computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: ["workspace-1"],
      members: new Map([["workspace-1", new Map(entries)]]),
      workspaces: new Map([["workspace-1", {
        totalCostUsd: 6,
        memberAttributableUsd: 6,
        memberUnattributableUsd: 0,
      }]]),
      accountDays: new Set(["2026-08-01"]),
      accountTotalUsd: 6,
    }),
    groups,
    membersByGroup: new Map([
      ["a-group", ["a-user"]],
      ["z-group", ["z-user"]],
    ]),
    internalUserIds: new Set(),
    projectInfoByWorkspace: new Map(),
  });
  const entries = [
    ["z-user", { totalCostUsd: 5, aiCostUsd: 5 }],
    ["a-user", { totalCostUsd: 5, aiCostUsd: 5 }],
  ];
  const forward = make(entries);
  const reversed = make([...entries].reverse());
  expect(forward.byGroup).toEqual(reversed.byGroup);
  expect(forward.byGroup.get("a-group")?.spendUsd).toBe(5);
  expect(forward.byGroup.get("z-group")?.spendUsd).toBe(1);
});

test("excludes overlapping internal Agent and creator non-Agent spend exactly once", () => {
  const result = computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: ["workspace-1"],
      members: new Map([["workspace-1", new Map([
        ["internal", { totalCostUsd: 12, aiCostUsd: 10 }],
        ["external", { totalCostUsd: 5, aiCostUsd: 5 }],
      ])]]),
      projects: new Map([["workspace-1", new Map([
        ["internal-project", { totalCostUsd: 8, aiCostUsd: 2 }],
        ["external-project", { totalCostUsd: 4, aiCostUsd: 0 }],
      ])]]),
      workspaces: new Map([["workspace-1", {
        totalCostUsd: 25,
        memberAttributableUsd: 25,
        memberUnattributableUsd: 0,
      }]]),
      accountTotalUsd: 28,
    }),
    groups,
    membersByGroup: new Map([
      ["a-group", ["internal", "external"]],
      ["z-group", ["internal"]],
    ]),
    internalUserIds: new Set(["internal"]),
    projectInfoByWorkspace: new Map([["workspace-1", new Map([
      ["internal-project", { creatorId: "internal" }],
      ["external-project", { creatorId: "external" }],
    ])]]),
  });

  expect(result.grossSpendUsd).toBe(25);
  expect(result.excludedInternalSpendUsd).toBe(16);
  expect(result.eligibleSpendUsd).toBe(9);
  expect(result.totalSpendUsd).toBe(9);
  expect(result.byWorkspace.get("workspace-1")).toBe(9);
  expect(result.byGroup.get("a-group")?.spendUsd).toBe(9);
  expect(result.byGroup.get("z-group")?.spendUsd).toBe(0);
  expect(result.excludedInternalSpendByGroup.get("a-group")).toBe(16);
  expect(result.excludedInternalSpendByGroup.get("z-group")).toBe(0);
  expect(result.excludedInternalSpendByWorkspace.get("workspace-1")).toBe(16);
  expect(result.byUser.has("internal")).toBe(false);
  expect(result.accountReconciliationSpendUsd).toBe(3);
  expect(result.grossSpendUsd).toBe(
    result.excludedInternalSpendUsd + result.eligibleSpendUsd,
  );
  expect(result.isComplete).toBe(true);
});

test("reconciles snapshots with all internal or no internal usage", () => {
  const make = (internalUserIds) => computeSnapshotUsageRollup({
    snapshot: snapshot({
      workspaceIds: ["workspace-1"],
      members: new Map([["workspace-1", new Map([
        ["member", { totalCostUsd: 7, aiCostUsd: 7 }],
      ])]]),
      workspaces: new Map([["workspace-1", {
        totalCostUsd: 7,
        memberAttributableUsd: 7,
        memberUnattributableUsd: 0,
      }]]),
      accountTotalUsd: 7,
    }),
    groups: [groups[1]],
    membersByGroup: new Map([["a-group", ["member"]]]),
    internalUserIds,
    projectInfoByWorkspace: new Map(),
  });

  const allInternal = make(new Set(["member"]));
  expect(allInternal).toMatchObject({
    grossSpendUsd: 7,
    excludedInternalSpendUsd: 7,
    eligibleSpendUsd: 0,
    totalSpendUsd: 0,
    isComplete: true,
  });
  expect(allInternal.ungroupedByWorkspace.size).toBe(0);
  expect(allInternal.excludedInternalSpendByGroup.get("a-group")).toBe(7);

  const noInternal = make(new Set());
  expect(noInternal).toMatchObject({
    grossSpendUsd: 7,
    excludedInternalSpendUsd: 0,
    eligibleSpendUsd: 7,
    totalSpendUsd: 7,
    isComplete: true,
  });
});

test("applies internal exclusions to historical roster rollups", () => {
  const full = snapshot({
    workspaceIds: ["workspace-1"],
    includesDailyMembers: true,
    daily: new Map([["2026-08-01", {
      accountTotalUsd: 6,
      workspaceTotalUsd: 6,
    }]]),
    accountDays: new Set(["2026-08-01"]),
    dailyMembers: new Map([["2026-08-01", new Map([
      ["workspace-1", new Map([["internal", {
        totalCostUsd: 6,
        aiCostUsd: 6,
      }]])],
    ])]]),
    dailyProjects: new Map([["2026-08-01", new Map()]]),
    dailyWorkspaces: new Map([["2026-08-01", new Map([
      ["workspace-1", {
        totalCostUsd: 6,
        memberAttributableUsd: 6,
        memberUnattributableUsd: 0,
      }],
    ])]]),
  });
  const result = computeHistoricalSnapshotUsageRollups({
    snapshot: full,
    groups: [groups[1]],
    currentUtcDay: "2026-08-02",
    currentMembersByGroup: new Map(),
    completedRosterDays: new Set(["2026-08-01"]),
    rosterMembersByDate: new Map([
      ["2026-08-01", new Map([["a-group", ["internal"]]])],
    ]),
    internalUserIds: new Set(["internal"]),
    projectInfoByWorkspace: new Map([["workspace-1", new Map()]]),
  });

  expect(result.get("2026-08-01")).toMatchObject({
    grossSpendUsd: 6,
    excludedInternalSpendUsd: 6,
    eligibleSpendUsd: 0,
    isComplete: true,
  });
});