import { describe, expect, test } from "vitest";
import {
  buildDashboardInsights,
  type DashboardInsightsUsage,
} from "./dashboard-insights";
import type { SnapshotUsageRollup } from "./usage-rollup";

function rollup(
  spend: number,
  users: Record<string, number>,
  projects: string[] = [],
): SnapshotUsageRollup {
  const byUser = new Map(Object.entries(users));
  return {
    eligibleSpendUsd: spend,
    excludedInternalSpendUsd: 0,
    residualSpendUsd: 0,
    accountReconciliationSpendUsd: 0,
    aiSpendByUser: byUser,
    aiSpendByGroup: new Map([["g1", byUser]]),
    nonAiSpendByGroup: new Map([["g1", new Map()]]),
    ungroupedByWorkspace: new Map(),
    projectAttribution: {
      aiSpendByProject: new Map(projects.map((id) => [`w1\u0000${id}`, 1])),
      nonAiSpendByProject: new Map(),
      projectToGroup: new Map(projects.map((id) => [`w1\u0000${id}`, "g1"])),
      creatorByProject: new Map(projects.map((id) => [
        `w1\u0000${id}`, id === "hidden-project" ? "hidden" : "self",
      ])),
      isComplete: true,
    },
  } as unknown as SnapshotUsageRollup;
}

function usage(
  authz: DashboardInsightsUsage["authz"],
  daily: Map<string, SnapshotUsageRollup>,
): DashboardInsightsUsage {
  return {
    authz,
    groups: [{ id: "g1", workspaceId: "w1" }],
    workspaceIds: new Set(["w1"]),
    snapshot: {
      includesAccountAnchor: authz.roles.includes("account"),
      coverage: {
        missingWorkspaceDays: [],
        failedWorkspaceDays: [],
        missingAccountDays: [],
      },
    } as unknown as DashboardInsightsUsage["snapshot"],
    rollup: [...daily.values()][0]!,
  };
}

describe("dashboard insights", () => {
  test("derives scoped selected metrics and equal-window comparison", () => {
    const authz = {
      userId: "admin",
      roles: ["account"],
      workspaceIds: [],
      groupUserIds: {},
    } as unknown as DashboardInsightsUsage["authz"];
    const selectedDaily = new Map([
      ["2026-06-10", rollup(12, { a: 5, b: 7 })],
      ["2026-06-11", rollup(18, { a: 8, b: 10 })],
    ]);
    const expandedDaily = new Map([
      ["2026-06-08", rollup(10, { a: 10 })],
      ["2026-06-09", rollup(10, { b: 10 })],
      ...selectedDaily,
    ]);
    const insights = buildDashboardInsights({
      selected: usage(authz, selectedDaily),
      selectedDaily,
      expanded: usage(authz, expandedDaily),
      expandedDaily,
      directory: { members: new Map([
        ["a", { name: "A" }],
        ["b", { name: "B" }],
      ]) },
      period: {
        start: "2026-06-10T00:00:00.000Z",
        endExclusive: "2026-06-12T00:00:00.000Z",
      },
      now: new Date("2026-06-11T12:00:00.000Z"),
      cutoff: "2026-05-20T00:00:00.000Z",
      projectAttributionComplete: true,
    });
    expect(insights.activeUsers).toBe(2);
    expect(insights.avgSpendPerActiveUserUsd).toBe(15);
    expect(insights.activeDays).toBe(2);
    expect(insights.busiestDay).toEqual({ date: "2026-06-11", spendUsd: 18 });
    expect(insights.previousPeriodSpendUsd).toBe(20);
    expect(insights.changePercent).toBe(50);
    expect(insights.monthly).toHaveLength(6);
    expect(insights.monthly.at(-1)).toMatchObject({
      start: "2026-06-01T00:00:00.000Z",
      endExclusive: "2026-07-01T00:00:00.000Z",
      activeUsers: 2,
      isPartial: true,
    });
  });

  test("monthly active users distinguish missing and zero and dedupe scoped users", () => {
    const authz = {
      userId: "admin",
      roles: ["account"],
      workspaceIds: [],
      groupUserIds: {},
    } as unknown as DashboardInsightsUsage["authz"];
    const february = rollup(0, {});
    const june = rollup(10, {});
    june.aiSpendByGroup = new Map([
      ["g1", new Map([["shared", 2]])],
      ["g2", new Map([["shared", 3], ["second", 1]])],
      ["out-of-scope", new Map([["hidden", 4]])],
    ]);
    june.nonAiSpendByGroup = new Map([
      ["g1", new Map([["shared", 1]])],
      ["g2", new Map([["second", 3]])],
      ["out-of-scope", new Map()],
    ]);
    const daily = new Map([
      ["2026-02-10", february],
      ["2026-06-10", june],
    ]);
    const expanded = usage(authz, daily);
    expanded.groups = [
      { id: "g1", workspaceId: "w1" },
      { id: "g2", workspaceId: "w2" },
    ];
    expanded.workspaceIds = new Set(["w1", "w2"]);

    const insights = buildDashboardInsights({
      selected: expanded,
      selectedDaily: daily,
      expanded,
      expandedDaily: daily,
      directory: { members: new Map() },
      period: {
        start: "2026-06-10T00:00:00.000Z",
        endExclusive: "2026-06-11T00:00:00.000Z",
      },
      now: new Date("2026-06-10T12:00:00.000Z"),
      cutoff: "2026-01-01T00:00:00.000Z",
      projectAttributionComplete: true,
    });

    expect(insights.monthly[0]).toMatchObject({
      activeUsers: null,
      isMissing: true,
    });
    expect(insights.monthly[1]).toMatchObject({
      activeUsers: 0,
      isMissing: true,
    });
    expect(insights.monthly.at(-1)).toMatchObject({
      activeUsers: 2,
      isPartial: true,
    });
  });

  test("personal scope excludes other users and their projects", () => {
    const authz = {
      userId: "self",
      roles: ["member"],
      workspaceIds: [],
      groupUserIds: { g1: ["self"] },
    } as unknown as DashboardInsightsUsage["authz"];
    const daily = new Map([
      ["2026-06-10", rollup(
        109, { self: 9, hidden: 100 }, ["my-project", "hidden-project"])],
    ]);
    const insights = buildDashboardInsights({
      selected: usage(authz, daily),
      selectedDaily: daily,
      expanded: usage(authz, daily),
      expandedDaily: daily,
      directory: { members: new Map([
        ["self", { name: "Me" }],
        ["hidden", { name: "Global leader" }],
      ]) },
      period: {
        start: "2026-06-10T00:00:00.000Z",
        endExclusive: "2026-06-11T00:00:00.000Z",
      },
      now: new Date("2026-06-10T12:00:00.000Z"),
      cutoff: "2026-05-20T00:00:00.000Z",
      projectAttributionComplete: true,
    });
    expect(insights.topSpenders).toEqual([
      { id: "self", name: "Me", spendUsd: 9 },
    ]);
    expect(insights.activeUsers).toBe(1);
    expect(insights.monthly.at(-1)?.activeUsers).toBe(1);
    expect(insights.projectCount).toBe(1);
  });

  test("personal internal usage is reported while peers stay excluded", () => {
    const authz = {
      userId: "self",
      roles: ["member"],
      userIds: ["self"],
      workspaceIds: [],
      groupUserIds: {},
    } as unknown as DashboardInsightsUsage["authz"];
    const day = rollup(0, {}, ["my-project", "hidden-project"]);
    day.projectAttribution.projectToGroup = new Map();
    day.excludedInternalSpendUsd = 110;
    day.excludedInternalAgentSpendByWorkspaceUser = new Map([
      ["w1", new Map([["self", 10], ["hidden", 100]])],
    ]);
    day.excludedInternalOtherSpendByWorkspaceUser = new Map();
    day.agentSpendByWorkspaceUser = new Map([
      ["w1", new Map([["self", 10], ["hidden", 100]])],
    ]);
    day.otherSpendByWorkspaceUser = new Map();
    const daily = new Map([["2026-06-10", day]]);
    const insights = buildDashboardInsights({
      selected: usage(authz, daily),
      selectedDaily: daily,
      expanded: usage(authz, daily),
      expandedDaily: daily,
      directory: { members: new Map([
        ["self", { name: "Me" }],
        ["hidden", { name: "Peer" }],
      ]) },
      period: {
        start: "2026-06-10T00:00:00.000Z",
        endExclusive: "2026-06-11T00:00:00.000Z",
      },
      now: new Date("2026-06-10T12:00:00.000Z"),
      cutoff: "2026-05-20T00:00:00.000Z",
      projectAttributionComplete: true,
    });

    expect(insights.topSpenders).toEqual([
      { id: "self", name: "Me", spendUsd: 10 },
    ]);
    expect(insights.busiestDay).toEqual({
      date: "2026-06-10",
      spendUsd: 10,
    });
    expect(insights.projectCount).toBe(1);
  });
});