import { describe, expect, test } from "vitest";
import type { Authorization } from "../lib/authz";
import type { SnapshotUsageRollup } from "../lib/usage-rollup";
import type {
  ProjectMetadata,
  ProjectMetadataSnapshot,
} from "../lib/project-metadata";
import { buildDashboardBuckets, utcBucketStart } from "./dashboard-buckets";
import {
  bucketRollupSpend,
  canExposeCanonicalAllocation,
  committedGenerationId,
  computeProjectMetadataRevision,
  qualifiedRollupTotals,
  qualifiedUserSpendByWorkspace,
  personalProjectCatalog,
  resolveAuthorizationForView,
  resolveCanonicalPoolAccess,
  scopedAccountingCacheKey,
  utcAccountingDay,
} from "./scoped-accounting";

test("personal catalog chooses freshest ownership and qualifies ambiguous duplicates", () => {
  const older = new Date("2026-09-07T00:00:00.000Z");
  const newer = new Date("2026-09-07T00:01:00.000Z");
  const metadata = (secondObservedAt: Date, secondOwner: string):
      ProjectMetadataSnapshot => ({
    byWorkspace: new Map<string, Map<string, ProjectMetadata>>([
      ["old", new Map([["same-project", {
        creatorId: "self", title: "old", hasDeployment: false,
        createdAt: null, updatedAt: null, deployments: [],
        deploymentsObservedAt: older.toISOString(), fetchedAt: older.toISOString(),
      }]])],
      ["new", new Map([["same-project", {
        creatorId: secondOwner, title: "new", hasDeployment: true,
        createdAt: null, updatedAt: null, deployments: [],
        deploymentsObservedAt: secondObservedAt.toISOString(),
        fetchedAt: secondObservedAt.toISOString(),
      }]])],
    ]),
    completeWorkspaceIds: new Set(["old", "new"]),
    observedWorkspaceIds: new Set(["old", "new"]),
    deploymentCompleteWorkspaceIds: new Set(["old", "new"]),
    deploymentObservedWorkspaceIds: new Set(["old", "new"]),
    freshnessByWorkspace: new Map([
      ["old", {
        status: "success", lastAttemptAt: older, lastSuccessfulAt: older,
      }],
      ["new", {
        status: "success",
        lastAttemptAt: secondObservedAt,
        lastSuccessfulAt: secondObservedAt,
      }],
    ]),
    revision: "test",
  });
  const self = auth({});

  expect(personalProjectCatalog(
    metadata(newer, "new-owner"), ["old", "new"], self,
  )).toMatchObject({ projectCount: 0, coverage: "complete" });
  expect(personalProjectCatalog(
    metadata(older, "new-owner"), ["old", "new"], self,
  )).toMatchObject({ projectCount: 0, coverage: "partial" });
  expect(personalProjectCatalog(
    metadata(older, "self"), ["old", "new"], self,
  )).toMatchObject({
    projectCount: 1,
    publishedProjectCount: 0,
    publicationUnknownProjectCount: 1,
    coverage: "partial",
  });
});

function auth(overrides: Partial<Authorization>): Authorization {
  return {
    role: "member",
    roles: ["member"],
    userId: "self",
    workspaceIds: [],
    teamNames: [],
    groupIds: [],
    userIds: ["self"],
    isTrueAccountAdmin: false,
    capabilities: {
      canViewAccountUsage: false,
      canManageAccess: false,
      canEditAllocations: false,
      canManageNotifications: false,
      canManageSystem: false,
      canPreviewRoles: false,
      canWriteGroupLimits: false,
      canRunChecks: false,
      canSendTestEmail: false,
      canWriteUserLimitsIn: [],
    },
    ...overrides,
  };
}

function rollup(): SnapshotUsageRollup {
  return {
    eligibleSpendUsd: 190,
    byWorkspace: new Map([["managed", 100], ["personal", 90]]),
    byGroup: new Map([
      ["managed-group", { spendUsd: 100, memberCount: 2, byUser: new Map([["managed-user", 100]]) }],
      ["self-group", { spendUsd: 7, memberCount: 1, byUser: new Map([["self", 7]]) }],
      ["hidden-group", { spendUsd: 83, memberCount: 3, byUser: new Map() }],
    ]),
    aiSpendByUser: new Map([["managed-user", 100], ["self", 7]]),
    aiSpendByGroup: new Map([
      ["managed-group", new Map([["managed-user", 100]])],
      ["self-group", new Map([["self", 7]])],
      ["hidden-group", new Map([["coworker", 83]])],
    ]),
    nonAiSpendByGroup: new Map(),
    excludedInternalSpendByWorkspace: new Map(),
    excludedInternalSpendByGroup: new Map(),
    excludedInternalSpendUsd: 0,
    ungroupedByWorkspace: new Map(),
    residualSpendUsd: 0,
    accountReconciliationSpendUsd: 0,
  } as unknown as SnapshotUsageRollup;
}

describe("compact dashboard accounting", () => {
  test("mixed grants add managed workspace and self-only external group without workspace leakage", () => {
    const value = bucketRollupSpend(
      rollup(),
      auth({
        role: "workspace_admin",
        roles: ["workspace_admin", "member"],
        workspaceIds: ["managed"],
        groupIds: ["managed-group", "self-group"],
        groupUserIds: {
          "managed-group": ["managed-user"],
          "self-group": ["self"],
        },
        userIds: ["self", "managed-user"],
      }),
      [
        { id: "managed-group", workspaceId: "managed" },
        { id: "self-group", workspaceId: "personal" },
      ],
    );
    expect(value).toBe(107);
  });

  test("view scopes preserve workspace-admin A and self-only B independently", () => {
    const mixed = auth({
      role: "workspace_admin",
      roles: ["workspace_admin", "member"],
      workspaceIds: ["managed"],
      groupIds: ["managed-group", "self-group"],
      managedGroupIds: ["managed-group"],
      groupUserIds: {
        "managed-group": ["managed-user"],
        "self-group": ["self"],
      },
      userIds: ["self", "managed-user"],
    });
    const memberships = new Map([
      ["managed-group", ["managed-user"]],
      ["self-group", ["self"]],
    ]);
    const groups = [
      { id: "managed-group", workspaceId: "managed" },
      { id: "self-group", workspaceId: "personal" },
    ];
    const managed = resolveAuthorizationForView(mixed, "managed", memberships);
    const self = resolveAuthorizationForView(mixed, "my", memberships);
    const all = resolveAuthorizationForView(mixed, "all_authorized", memberships);
    expect(bucketRollupSpend(rollup(), managed, groups.filter((group) =>
      managed.groupIds.includes(group.id)))).toBe(100);
    expect(bucketRollupSpend(rollup(), self, groups.filter((group) =>
      self.groupIds.includes(group.id)))).toBe(7);
    expect(bucketRollupSpend(rollup(), all, groups)).toBe(107);
  });

  test("family relationship never promotes coworker or residual workspace spend", () => {
    const family = auth({
      role: "team_admin",
      roles: ["team_admin"],
      groupIds: ["managed-group"],
      managedGroupIds: ["managed-group"],
      groupUserIds: { "managed-group": ["managed-user"] },
      userIds: ["managed-user"],
    });
    const adversarialRollup = rollup();
    adversarialRollup.aiSpendByGroup.set("managed-group", new Map([
      ["managed-user", 100],
      ["coworker-in-another-family", 83],
    ]));
    adversarialRollup.excludedInternalSpendByGroup.set("managed-group", 41);
    adversarialRollup.excludedInternalSpendByGroupUser = new Map([
      ["managed-group", new Map([["internal-coworker", 41]])],
    ]);
    const totals = qualifiedRollupTotals(
      adversarialRollup,
      family,
      [{ id: "managed-group", workspaceId: "managed" }],
    );
    expect(totals.eligibleSpendUsd).toBe(100);
    expect(totals.agentSpendUsd).toBe(100);
    expect(totals.internalExcludedUsd).toBe(0);
    expect(totals.eligibleSpendUsd + totals.internalExcludedUsd).toBe(100);
    expect(totals.unattributedUsd).toBe(0);
    const people = qualifiedUserSpendByWorkspace(
      new Map([["2026-09-01", adversarialRollup]]),
      family,
      [{ id: "managed-group", workspaceId: "managed" }],
    );
    expect([...people.get("managed")!]).toEqual([
      ["managed-user", { agent: 100, other: 0 }],
    ]);
  });

  test("canonical allocation requires every cross-workspace contributing portion", () => {
    const scoped = auth({
      role: "team_admin",
      roles: ["team_admin"],
      groupIds: ["same-name-w1"],
      managedGroupIds: ["same-name-w1"],
      groupUserIds: { "same-name-w1": ["managed-user"] },
    });
    const canonicalPool = [
      { id: "same-name-w1", workspaceId: "w1" },
      { id: "same-name-w2", workspaceId: "w2" },
    ];
    expect(canExposeCanonicalAllocation(scoped, canonicalPool)).toBe(false);
    expect(resolveCanonicalPoolAccess(
      scoped, canonicalPool, 1, 250,
    )).toEqual({
      sharedPool: true,
      allocationUsd: null,
    });
    expect(canExposeCanonicalAllocation(auth({
      role: "workspace_admin",
      roles: ["workspace_admin"],
      workspaceIds: ["w1", "w2"],
    }), canonicalPool)).toBe(true);
  });

  test("cards, trend buckets, and qualified table contributions share one identity", () => {
    const mixed = auth({
      role: "workspace_admin",
      roles: ["workspace_admin", "member"],
      workspaceIds: ["managed"],
      groupIds: ["managed-group", "self-group"],
      managedGroupIds: ["managed-group"],
      groupUserIds: {
        "managed-group": ["managed-user"],
        "self-group": ["self"],
      },
      userIds: ["managed-user", "self"],
    });
    const groups = [
      { id: "managed-group", workspaceId: "managed" },
      { id: "self-group", workspaceId: "personal" },
    ];
    const cardTotal = qualifiedRollupTotals(
      rollup(), mixed, groups).eligibleSpendUsd;
    const trend = buildDashboardBuckets([{
      day: "2026-09-01",
      spendUsd: bucketRollupSpend(rollup(), mixed, groups),
      complete: true,
    }], "day", "period");
    const tableContribution = groups.reduce((sum, group) =>
      sum + (rollup().byGroup.get(group.id)?.spendUsd ?? 0), 0);
    expect(cardTotal).toBe(107);
    expect(trend[0]?.spendUsd).toBe(cardTotal);
    expect(tableContribution).toBe(cardTotal);
  });

  test("account scope uses the canonical eligible total exactly once", () => {
    expect(bucketRollupSpend(
      rollup(),
      auth({ role: "account", roles: ["account"] }),
    )).toBe(190);
  });

  test("period and cumulative bucket sums have end-exclusive UTC semantics", () => {
    const daily = [
      { day: "2026-03-07", spendUsd: 2, complete: true },
      { day: "2026-03-08", spendUsd: 3, complete: true },
      { day: "2026-03-09", spendUsd: 5, complete: true },
    ];
    const period = buildDashboardBuckets(daily, "day", "period");
    const cumulative = buildDashboardBuckets(daily, "day", "cumulative");
    expect(period.reduce((sum, bucket) => sum + (bucket.spendUsd ?? 0), 0)).toBe(10);
    expect(cumulative.map((bucket) => bucket.valueUsd)).toEqual([2, 5, 10]);
    expect(period[1]?.endExclusive).toBe("2026-03-09T00:00:00.000Z");
  });

  test("partial coverage is a gap, never an observed zero", () => {
    const buckets = buildDashboardBuckets([
      { day: "2026-09-01", spendUsd: 4, complete: true },
      { day: "2026-09-02", spendUsd: 0, complete: false },
    ], "day", "period");
    expect(buckets[0]).toMatchObject({ spendUsd: 4, isMissing: false });
    expect(buckets[1]).toMatchObject({
      spendUsd: null,
      valueUsd: null,
      isPartial: true,
      isMissing: true,
    });
  });

  test("cumulative trend retains known spend across a coverage gap", () => {
    const buckets = buildDashboardBuckets([
      { day: "2026-09-01", spendUsd: 4, complete: true },
      { day: "2026-09-02", spendUsd: 3, complete: false },
      { day: "2026-09-03", spendUsd: 5, complete: true },
    ], "day", "cumulative");
    expect(buckets.map((bucket) => bucket.valueUsd)).toEqual([4, 7, 12]);
    expect(buckets.map((bucket) => bucket.spendUsd)).toEqual([4, null, 5]);
  });

  test("weekly buckets remain UTC across the Los Angeles DST boundary", () => {
    const original = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(utcBucketStart("2026-03-08", "week")).toBe("2026-03-02");
      expect(utcBucketStart("2026-03-09", "week")).toBe("2026-03-09");
    } finally {
      process.env.TZ = original;
    }
  });

  test("clamps regular bucket labels to the selected reporting period", () => {
    const buckets = buildDashboardBuckets([
      { day: "2026-05-20", spendUsd: 2, complete: true },
      { day: "2026-05-24", spendUsd: 3, complete: true },
      { day: "2026-05-25", spendUsd: 5, complete: true },
      { day: "2026-05-27", spendUsd: 7, complete: true },
    ], "week", "period", {
      start: "2026-05-20T00:00:00.000Z",
      endExclusive: "2026-05-28T00:00:00.000Z",
    });
    expect(buckets.map((bucket) => [bucket.start, bucket.endExclusive]))
      .toEqual([
        ["2026-05-20T00:00:00.000Z", "2026-05-25T00:00:00.000Z"],
        ["2026-05-25T00:00:00.000Z", "2026-05-28T00:00:00.000Z"],
      ]);
    expect(buckets.map((bucket) => bucket.spendUsd)).toEqual([5, 12]);
  });

  test("generation identity includes committed coverage and is shared deterministically", () => {
    const identity = {
      usageDataAsOf: "2026-09-04T12:00:00.000Z",
      directoryDataAsOf: "2026-09-04T11:00:00.000Z",
      usageStatus: "partial",
      coverage: { ratio: 0.5, missingWorkspaceDays: ["w1:2026-09-03"] },
      limitObservation: { status: "complete", observedAt: 1 },
      period: { start: "2026-09-01T00:00:00.000Z", end: "2026-09-05T00:00:00.000Z" },
      scope: { viewScope: "managed", workspaceIds: ["w1"] },
    };
    expect(committedGenerationId(identity)).toBe(committedGenerationId(identity));
    expect(committedGenerationId(identity)).not.toBe(committedGenerationId({
      ...identity,
      coverage: { ratio: 0.75, missingWorkspaceDays: [] },
    }));
    expect(committedGenerationId(identity)).not.toBe(committedGenerationId({
      ...identity,
      period: {
        start: "2026-10-01T00:00:00.000Z",
        end: "2026-11-01T00:00:00.000Z",
      },
    }));
  });

  test("common cache identity ignores presentation and splits only demand projections", () => {
    const identity = committedGenerationId({
      usageDataAsOf: "usage-generation-7",
      directoryDataAsOf: "directory-generation-3",
      usageStatus: "complete",
      coverage: { ratio: 1 },
      limitObservation: "limits-4",
      allocationRevision: "19",
      projectMetadataRevision: "projects-2",
      period: {
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-10-01T00:00:00.000Z",
      },
      scope: { userId: "u1", isPreview: false },
    });
    expect(scopedAccountingCacheKey(identity))
      .toBe(scopedAccountingCacheKey(identity, "groups"));
    expect(scopedAccountingCacheKey(identity, "pools"))
      .toBe(scopedAccountingCacheKey(identity));
    expect(scopedAccountingCacheKey(identity, "people"))
      .not.toBe(scopedAccountingCacheKey(identity));
    expect(scopedAccountingCacheKey(identity, "projects"))
      .not.toBe(scopedAccountingCacheKey(identity, "people"));
  });

  test("project metadata publication freshness changes with its committed observation", () => {
    const states = [{
      workspaceId: "w1",
      status: "success",
      completedAt: new Date("2026-09-01T00:00:00.000Z"),
    }];
    const initial = computeProjectMetadataRevision(states);
    expect(computeProjectMetadataRevision([{
      ...states[0]!,
      completedAt: new Date("2026-09-01T00:01:00.000Z"),
    }])).not.toBe(initial);
  });

  test("static custom accounting rolls over only at the UTC day boundary", () => {
    expect(utcAccountingDay(Date.parse("2026-03-08T23:59:59.999Z")))
      .toBe("2026-03-08");
    expect(utcAccountingDay(Date.parse("2026-03-09T00:00:00.000Z")))
      .toBe("2026-03-09");
  });
});