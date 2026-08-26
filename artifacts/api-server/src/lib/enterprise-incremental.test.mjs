/**
 * Durable-mode regression coverage for member/workspace/project pagination,
 * closed historical reuse, and restart hydration.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";

const groupId = `incremental-group-${crypto.randomUUID()}`;
const workspaceId = `incremental-workspace-${crypto.randomUUID()}`;
const extraWorkspaceId = `incremental-extra-${crypto.randomUUID()}`;
let fetchCount = 0;
let failNextUsageFetch = false;
let failAtFetchCount = null;
let noCursorProjectMode = false;
let projectMetadataFetchCount = 0;
let failNextProjectMetadataFetch = false;
const usageRequestUrls = [];

globalThis.fetch = async (input) => {
  fetchCount += 1;
  const url = new URL(String(input));
  usageRequestUrls.push(url);
  if (url.pathname.endsWith("/projects")) {
    projectMetadataFetchCount += 1;
    if (failNextProjectMetadataFetch) {
      failNextProjectMetadataFetch = false;
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => "forced project metadata failure",
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "10" },
      json: async () => ({
        data: [
          { id: "persisted-project", title: "Persisted project", creatorId: "creator-1" },
        ],
        pagination: { cursor: null, hasMore: false },
      }),
    };
  }
  if (failNextUsageFetch || fetchCount === failAtFetchCount) {
    failNextUsageFetch = false;
    failAtFetchCount = null;
    return {
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => "forced rebuild failure",
    };
  }
  const groupBy = url.searchParams.get("groupBy");
  const cursor = url.searchParams.get("cursor");
  const isProject = groupBy === "project";
  const isGroupMember = groupBy === "member" && url.searchParams.has("groupId");
  const pagination = noCursorProjectMode && isProject
    ? { cursor: null, hasMore: true }
    : cursor
    ? { cursor: null, hasMore: false }
    : { cursor: "page-2", hasMore: true };

  let groups = [];
  let totalCostUsd = 0;
  if (isProject) {
    groups = cursor
      ? [{
          key: { projectId: "project-2" },
          totalCostUsd: 7,
          metrics: [{ id: "metric-2", name: "Storage", category: "infra", costUsd: 7 }],
        }]
      : [{
          key: { projectId: "project-1" },
          totalCostUsd: 5,
          metrics: [{ id: "metric-1", name: "Compute", category: "infra", costUsd: 5 }],
        }];
    totalCostUsd = 12;
  } else if (isGroupMember) {
    groups = cursor
      ? [{ key: { userId: "member-2" }, totalCostUsd: 6 }]
      : [{ key: { userId: "member-1" }, totalCostUsd: 4 }];
    totalCostUsd = 10;
  } else if (groupBy === "member") {
    groups = cursor
      ? [{ key: { userId: "member-2" }, totalCostUsd: 2 }]
      : [{ key: { userId: "member-1" }, totalCostUsd: 3 }];
    totalCostUsd = 5;
  } else if (!url.searchParams.has("workspaceId") && !url.searchParams.has("groupId")) {
    totalCostUsd = 25;
    pagination.hasMore = false;
    pagination.cursor = null;
  } else {
    totalCostUsd = 10;
    pagination.hasMore = false;
    pagination.cursor = null;
  }

  return {
    ok: true,
    status: 200,
    headers: { get: () => "10" },
    json: async () => ({
      data: {
        interval: url.searchParams.get("billingPeriod") === "current"
          ? {
              startTime: "2026-08-01T00:00:00.000Z",
              endTime: "2026-09-01T00:00:00.000Z",
            }
          : {
              startTime: url.searchParams.get("startTime"),
              endTime: url.searchParams.get("endTime"),
            },
        totalCostUsd,
        attributableTotalCostUsd: totalCostUsd === 25 ? 20 : totalCostUsd,
        unattributableTotalCostUsd: totalCostUsd === 25 ? 5 : 0,
        groups,
        pagination,
      },
    }),
  };
};

const enterprise = await import("./enterprise.ts");
const range = enterprise.resolveRange("custom", "2026-06-01", "2026-06-01");
const accountRange = {
  ...range,
  key: `custom:account-anchor-${crypto.randomUUID()}`,
};
const group = {
  id: groupId,
  workspaceId,
  name: "Incremental Test Group",
  type: "custom",
};

async function waitForQueue() {
  while (enterprise.pendingUsageCount() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("all usage modes paginate, persist, hydrate, and reuse closed ranges", async () => {
  enterprise.queueAccountUsageFetch(accountRange, 0);
  enterprise.queueGroupSpendFetch(group, 0, false, undefined, range);
  enterprise.queueMemberUsageFetch(group, range, 0);
  enterprise.queueWsSpendFetch(extraWorkspaceId, range, 0);
  enterprise.queueProjectUsageFetch(group, range, 0);
  await waitForQueue();

  assert.deepEqual(enterprise.getAccountUsage(accountRange.key), {
    fetchedAt: enterprise.getAccountUsage(accountRange.key).fetchedAt,
    totalCostUsd: 25,
    attributableTotalCostUsd: 20,
    unattributableTotalCostUsd: 5,
  });
  const accountRequest = usageRequestUrls.find(
    (url) =>
      url.pathname.endsWith("/usage") &&
      !url.searchParams.has("workspaceId") &&
      !url.searchParams.has("groupId"),
  );
  assert.ok(accountRequest, "account anchor must issue an unfiltered /usage request");
  assert.equal(accountRequest.searchParams.has("groupBy"), false);
  assert.equal(enterprise.getSpend(groupId, range.key)?.spendUsd, 10);
  assert.deepEqual(
    enterprise.getMemberUsage(groupId, range.key)?.byUser,
    new Map([["member-1", 4], ["member-2", 6]]),
  );
  assert.deepEqual(
    enterprise.getWsSpendByUser(extraWorkspaceId, range.key),
    new Map([["member-1", 3], ["member-2", 2]]),
  );
  const projects = enterprise.getProjectUsage(groupId, range.key);
  assert.equal(projects?.totalCostUsd, 12);
  assert.equal(projects?.byProject.get("project-1")?.metrics[0]?.costUsd, 5);
  assert.equal(projects?.byProject.get("project-2")?.metrics[0]?.costUsd, 7);

  const completedFetches = fetchCount;
  // Even force does not rewrite a successfully closed historical range.
  assert.equal(enterprise.queueAccountUsageFetch(accountRange, 0, true), false);
  assert.equal(enterprise.queueGroupSpendFetch(group, 0, true, undefined, range), "fresh_cache");
  assert.equal(enterprise.queueMemberUsageFetch(group, range, 0, true), false);
  assert.equal(enterprise.queueWsSpendFetch(extraWorkspaceId, range, 0, true), false);
  assert.equal(enterprise.queueProjectUsageFetch(group, range, 0, true), false);
  assert.equal(fetchCount, completedFetches);

  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache();
  assert.equal(enterprise.getAccountUsage(accountRange.key)?.totalCostUsd, 25);
  assert.equal(enterprise.getAccountUsage(accountRange.key)?.unattributableTotalCostUsd, 5);
  assert.equal(enterprise.getSpend(groupId, range.key)?.spendUsd, 10);
  assert.equal(enterprise.getMemberUsage(groupId, range.key)?.byUser.get("member-2"), 6);
  assert.equal(enterprise.getWsSpendByUser(extraWorkspaceId, range.key)?.get("member-1"), 3);
  assert.equal(
    enterprise.getProjectUsage(groupId, range.key)?.byProject.get("project-2")?.totalCostUsd,
    7,
  );
});

test("no-cursor pagination terminates as durable partial and retries only when forced", async () => {
  const partialRange = {
    key: `custom:no-cursor-${crypto.randomUUID()}`,
    label: "No cursor test",
    params: {
      startTime: "2026-06-01T00:00:00.000Z",
      endTime: "2026-06-01T02:00:00.000Z",
    },
  };
  noCursorProjectMode = true;
  assert.equal(enterprise.queueProjectUsageFetch(group, partialRange, 0), true);
  await waitForQueue();

  const partial = enterprise.getUsageSyncSummary(
    partialRange.key,
    [group],
    [],
    false,
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.pendingCount, 1, "missing member scope remains pending");
  assert.equal(partial.partialCount, 1);
  assert.equal(
    enterprise.isUsageSyncRetryable("group_project", partialRange.key, group.id),
    true,
  );
  assert.match(partial.error, /without a cursor/);
  const partialFetchCount = fetchCount;
  assert.equal(
    enterprise.queueProjectUsageFetch(group, partialRange, 0),
    false,
    "terminal partial state must not be requeued by polling",
  );
  assert.equal(fetchCount, partialFetchCount);

  noCursorProjectMode = false;
  assert.equal(enterprise.queueProjectUsageFetch(group, partialRange, 0, true), true);
  await waitForQueue();
  const retried = enterprise.getUsageSyncSummary(
    partialRange.key,
    [group],
    [],
    false,
  );
  assert.equal(retried.partialCount, 0);
  assert.equal(
    enterprise.isUsageSyncRetryable("group_project", partialRange.key, group.id),
    false,
  );
  assert.equal(retried.status, "syncing", "only the intentionally absent member scope remains");
});

test("failed usage scopes become terminal and do not remain pending", async () => {
  const failedRange = {
    key: `custom:failed-scope-${crypto.randomUUID()}`,
    label: "Failed scope test",
    params: {
      startTime: "2026-06-01T00:00:00.000Z",
      endTime: "2026-06-01T02:00:00.000Z",
    },
  };
  failNextUsageFetch = true;
  assert.equal(enterprise.queueProjectUsageFetch(group, failedRange, 0), true);
  await waitForQueue();
  const failed = enterprise.getUsageSyncSummary(failedRange.key, [group], [], false);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failedCount, 1);
  assert.equal(failed.pendingCount, 1, "only the absent member scope is pending");
  assert.equal(
    enterprise.queueProjectUsageFetch(group, failedRange, 0),
    false,
    "polling must not automatically loop a terminal failure",
  );
  assert.equal(
    enterprise.isUsageSyncRetryable("group_project", failedRange.key, group.id),
    true,
  );
});

test("project metadata persists and hydrates without an API refetch", async () => {
  const metadataWorkspace = `metadata-${crypto.randomUUID()}`;
  assert.equal(enterprise.queueProjectTitlesFetch(metadataWorkspace, 0), true);
  await waitForQueue();
  assert.deepEqual(enterprise.getProjectInfo(metadataWorkspace, "persisted-project"), {
    title: "Persisted project",
    creatorId: "creator-1",
  });
  const completedFetches = projectMetadataFetchCount;

  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache();
  assert.deepEqual(enterprise.getProjectInfo(metadataWorkspace, "persisted-project"), {
    title: "Persisted project",
    creatorId: "creator-1",
  });
  assert.equal(enterprise.queueProjectTitlesFetch(metadataWorkspace, 0), false);
  assert.equal(projectMetadataFetchCount, completedFetches);
});

test("failed project metadata is not hydrated as complete and remains retryable", async () => {
  const failedWorkspace = `metadata-failed-${crypto.randomUUID()}`;
  assert.equal(enterprise.queueProjectTitlesFetch(failedWorkspace, 0), true);
  await waitForQueue();
  assert.equal(enterprise.hasProjectInfo(failedWorkspace), true);

  failNextProjectMetadataFetch = true;
  assert.equal(enterprise.queueProjectTitlesFetch(failedWorkspace, 0, true), true);
  await waitForQueue();
  assert.equal(
    enterprise.hasProjectInfo(failedWorkspace),
    true,
    "the prior usable metadata stays available until restart",
  );

  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache();
  assert.equal(enterprise.hasProjectInfo(failedWorkspace), false);
  assert.equal(enterprise.queueProjectTitlesFetch(failedWorkspace, 0), true);
  await waitForQueue();
  assert.equal(enterprise.hasProjectInfo(failedWorkspace), true);
});

test("project attribution uses highest cross-group total and reports unattributed residual", () => {
  const attributionRange = `custom:project-attribution-${crypto.randomUUID()}`;
  const groups = [
    { id: "comcast-a", workspaceId: "1awqan", name: "Comcast A", type: "custom" },
    { id: "comcast-b", workspaceId: "1awqan", name: "Comcast B", type: "custom" },
    { id: "freewheel", workspaceId: "freewheel-ws", name: "Freewheel", type: "custom" },
  ];
  const usage = (totalCostUsd, projects) => ({
    fetchedAt: Date.now(),
    totalCostUsd,
    byProject: new Map(
      projects.map(([projectId, projectSpend]) => [
        projectId,
        { projectId, totalCostUsd: projectSpend, metrics: [] },
      ]),
    ),
  });

  enterprise.__setProjectUsageForTests(
    "comcast-a",
    attributionRange,
    usage(17, [["shared", 10], ["primary-only", 5]]),
  );
  enterprise.__setProjectUsageForTests(
    "comcast-b",
    attributionRange,
    usage(9, [["primary-only", 8], ["tie", 1]]),
  );
  enterprise.__setProjectUsageForTests(
    "freewheel",
    attributionRange,
    usage(4, [["shared", 3], ["tie", 1]]),
  );

  const result = enterprise.getProjectAttribution(
    attributionRange,
    groups,
    new Map(),
  );

  assert.equal(result.projectToGroup.get("shared"), "comcast-a");
  assert.equal(result.projectToGroup.get("primary-only"), "comcast-b");
  assert.equal(result.projectToGroup.get("tie"), "comcast-b");
  assert.equal(result.spendByGroup.get("comcast-a"), 10);
  assert.equal(result.spendByGroup.get("comcast-b"), 9);
  assert.equal(result.unattributedSpendUsd, 2);
  assert.equal(result.totalSpendUsd, 21);
  assert.equal(result.isComplete, true);
  assert.equal(result.pendingCount, 0);

  enterprise.__setProjectUsageForTests("freewheel", attributionRange, null);
  const incomplete = enterprise.getProjectAttribution(
    attributionRange,
    groups,
    new Map(),
  );
  assert.equal(incomplete.isComplete, false);
  assert.equal(incomplete.pendingCount, 1);

  for (const group of groups) {
    enterprise.__setProjectUsageForTests(group.id, attributionRange, null);
  }
});

test("creator non-AI attribution reconciles users plus true residual to authoritative total", () => {
  const rangeKey = `custom:creator-reconciliation-${crypto.randomUUID()}`;
  const workspaceId = `workspace-${crypto.randomUUID()}`;
  const group = { id: `group-${crypto.randomUUID()}`, workspaceId, name: "Creators", type: "custom" };
  const currentCreator = "current-creator";
  const formerCreator = "former-creator";

  enterprise.__setMemberUsageForTests(group.id, rangeKey, new Map([[currentCreator, 40]]));
  enterprise.__setWsSpendForTests(
    workspaceId,
    rangeKey,
    new Map([[currentCreator, 100]]),
    { totalCostUsd: 100, attributableTotalCostUsd: 100 },
  );
  enterprise.__setProjectUsageForTests(group.id, rangeKey, {
    fetchedAt: Date.now(),
    totalCostUsd: 60,
    byProject: new Map([
      ["owned", {
        projectId: "owned",
        workspaceId,
        totalCostUsd: 50,
        metrics: [{ id: "agent", name: "Agent", category: "ai", costUsd: 10 }],
      }],
      ["former", {
        projectId: "former",
        workspaceId,
        totalCostUsd: 10,
        metrics: [],
      }],
    ]),
  });
  enterprise.__setProjectInfoForTests(workspaceId, new Map([
    ["owned", { title: "Owned", creatorId: currentCreator }],
    ["former", { title: "Former", creatorId: formerCreator }],
  ]));

  const canonical = enterprise.getCanonicalUsage(
    [group],
    rangeKey,
    new Set([workspaceId]),
    new Map([[group.id, [currentCreator]]]),
    undefined,
    undefined,
    new Map([[workspaceId, { id: workspaceId, name: "Workspace" }]]),
  );

  assert.equal(canonical.aiSpendByUser.get(currentCreator), 40);
  assert.equal(canonical.nonAiSpendByUser.get(currentCreator), 40);
  assert.equal(canonical.byUser.get(currentCreator), 80);
  assert.equal(canonical.residualSpendByGroup.get(group.id), 20);
  assert.equal(canonical.totalSpendUsd, 100);
  assert.equal(
    [...canonical.byUser.values()].reduce((sum, value) => sum + value, 0) +
      canonical.residualSpendUsd,
    canonical.totalSpendUsd,
  );
  assert.equal(canonical.projectAttribution.unattributedSpendUsd, 10);
  assert.equal(canonical.isComplete, true);

  enterprise.__setMemberUsageForTests(group.id, rangeKey, null);
  enterprise.__setWsSpendForTests(workspaceId, rangeKey, null);
  enterprise.__setProjectUsageForTests(group.id, rangeKey, null);
  enterprise.__setProjectInfoForTests(workspaceId, null);
});

test("canonical readiness waives cold project inputs only for a proven AI-only total", () => {
  const rangeKey = `custom:project-readiness-${crypto.randomUUID()}`;
  const workspaceId = `workspace-${crypto.randomUUID()}`;
  const group = { id: `group-${crypto.randomUUID()}`, workspaceId, name: "AI Only", type: "custom" };
  const userId = "ai-user";
  const groupMembers = new Map([[group.id, [userId]]]);
  const workspaces = new Map([[workspaceId, { id: workspaceId, name: "Workspace" }]]);

  enterprise.__setMemberUsageForTests(group.id, rangeKey, new Map([[userId, 40]]));
  enterprise.__setWsSpendForTests(
    workspaceId,
    rangeKey,
    new Map([[userId, 40]]),
    { totalCostUsd: 40, attributableTotalCostUsd: 40 },
  );

  const aiOnly = enterprise.getCanonicalUsage(
    [group],
    rangeKey,
    new Set([workspaceId]),
    groupMembers,
    undefined,
    undefined,
    workspaces,
  );
  assert.equal(aiOnly.creatorAttributionRequired, false);
  assert.equal(aiOnly.isComplete, true);
  assert.equal(aiOnly.pendingCount, 0);

  enterprise.__setWsSpendForTests(
    workspaceId,
    rangeKey,
    new Map([[userId, 50]]),
    { totalCostUsd: 50, attributableTotalCostUsd: 50 },
  );
  const unexplainedNonAiGap = enterprise.getCanonicalUsage(
    [group],
    rangeKey,
    new Set([workspaceId]),
    groupMembers,
    undefined,
    undefined,
    workspaces,
  );
  assert.equal(unexplainedNonAiGap.creatorAttributionRequired, true);
  assert.equal(unexplainedNonAiGap.isComplete, false);
  assert.equal(unexplainedNonAiGap.pendingCount, 1);

  enterprise.__setMemberUsageForTests(group.id, rangeKey, null);
  enterprise.__setWsSpendForTests(workspaceId, rangeKey, null);
});

test("overlapping creator project winners use the stable owner and retain former or missing creators as winner residual", () => {
  const rangeKey = `custom:overlap-project-owner-${crypto.randomUUID()}`;
  const workspaceId = `workspace-${crypto.randomUUID()}`;
  const alpha = { id: `alpha-${crypto.randomUUID()}`, workspaceId, name: "Alpha", type: "custom" };
  const beta = { id: `beta-${crypto.randomUUID()}`, workspaceId, name: "Beta", type: "custom" };
  const creatorId = "overlapping-creator";
  const otherId = "beta-member";
  const formerCreatorId = "former-creator";
  const groupMembers = new Map([
    [alpha.id, [creatorId]],
    [beta.id, [creatorId, otherId]],
  ]);
  const workspaces = new Map([[workspaceId, { id: workspaceId, name: "Workspace" }]]);

  enterprise.__setMemberUsageForTests(alpha.id, rangeKey, new Map([[creatorId, 10]]));
  enterprise.__setMemberUsageForTests(beta.id, rangeKey, new Map([[creatorId, 10], [otherId, 0]]));
  enterprise.__setWsSpendForTests(
    workspaceId,
    rangeKey,
    new Map([[creatorId, 120], [otherId, 20]]),
    { totalCostUsd: 140, attributableTotalCostUsd: 140 },
  );
  enterprise.__setProjectUsageForTests(alpha.id, rangeKey, {
    fetchedAt: Date.now(),
    totalCostUsd: 80,
    byProject: new Map([["current", { projectId: "current", totalCostUsd: 80, metrics: [] }]]),
  });
  enterprise.__setProjectUsageForTests(beta.id, rangeKey, {
    fetchedAt: Date.now(),
    totalCostUsd: 110,
    byProject: new Map([
      ["current", { projectId: "current", totalCostUsd: 90, metrics: [] }],
      ["former", { projectId: "former", totalCostUsd: 10, metrics: [] }],
      ["missing", { projectId: "missing", totalCostUsd: 10, metrics: [] }],
    ]),
  });
  enterprise.__setProjectInfoForTests(workspaceId, new Map([
    ["current", { title: "Current", creatorId }],
    ["former", { title: "Former", creatorId: formerCreatorId }],
  ]));

  const canonical = enterprise.getCanonicalUsage(
    [alpha, beta],
    rangeKey,
    new Set([workspaceId]),
    groupMembers,
    undefined,
    undefined,
    workspaces,
  );
  assert.equal(canonical.byGroup.get(alpha.id)?.byUser.get(creatorId), 100);
  assert.equal(canonical.byGroup.get(beta.id)?.byUser.get(creatorId) ?? 0, 0);
  assert.equal(canonical.residualSpendByGroup.get(alpha.id), 20);
  assert.equal(canonical.residualSpendByGroup.get(beta.id), 20);
  assert.equal(canonical.projectAttribution.unattributedSpendUsd, 20);
  for (const group of [alpha, beta]) {
    const users = [...(canonical.byGroup.get(group.id)?.byUser.values() ?? [])]
      .reduce((sum, value) => sum + value, 0);
    assert.equal(
      users + (canonical.residualSpendByGroup.get(group.id) ?? 0),
      canonical.byGroup.get(group.id)?.spendUsd,
    );
  }
  assert.equal(
    [...canonical.byUser.values()].reduce((sum, value) => sum + value, 0) +
      canonical.residualSpendUsd,
    canonical.totalSpendUsd,
  );
  assert.equal(canonical.isComplete, true);

  for (const group of [alpha, beta]) {
    enterprise.__setMemberUsageForTests(group.id, rangeKey, null);
    enterprise.__setProjectUsageForTests(group.id, rangeKey, null);
  }
  enterprise.__setWsSpendForTests(workspaceId, rangeKey, null);
  enterprise.__setProjectInfoForTests(workspaceId, null);
});

test("project winner may exclude the creator while same-workspace stable ownership remains attributable", () => {
  const rangeKey = `custom:winner-excludes-creator-${crypto.randomUUID()}`;
  const workspaceId = `workspace-${crypto.randomUUID()}`;
  const alpha = { id: `alpha-${crypto.randomUUID()}`, workspaceId, name: "Alpha", type: "custom" };
  const beta = { id: `beta-${crypto.randomUUID()}`, workspaceId, name: "Beta", type: "custom" };
  const creatorId = "creator";
  const betaMemberId = "beta-member";
  const groupMembers = new Map([
    [alpha.id, [creatorId]],
    [beta.id, [betaMemberId]],
  ]);
  const workspaces = new Map([[workspaceId, { id: workspaceId, name: "Workspace" }]]);
  enterprise.__setMemberUsageForTests(alpha.id, rangeKey, new Map([[creatorId, 10]]));
  enterprise.__setMemberUsageForTests(beta.id, rangeKey, new Map([[betaMemberId, 0]]));
  enterprise.__setWsSpendForTests(
    workspaceId,
    rangeKey,
    new Map([[creatorId, 100], [betaMemberId, 20]]),
    { totalCostUsd: 120, attributableTotalCostUsd: 120 },
  );
  enterprise.__setProjectUsageForTests(alpha.id, rangeKey, {
    fetchedAt: Date.now(),
    totalCostUsd: 80,
    byProject: new Map([["project", { projectId: "project", totalCostUsd: 80, metrics: [] }]]),
  });
  enterprise.__setProjectUsageForTests(beta.id, rangeKey, {
    fetchedAt: Date.now(),
    totalCostUsd: 90,
    byProject: new Map([["project", { projectId: "project", totalCostUsd: 90, metrics: [] }]]),
  });
  enterprise.__setProjectInfoForTests(workspaceId, new Map([
    ["project", { title: "Project", creatorId }],
  ]));

  const canonical = enterprise.getCanonicalUsage(
    [alpha, beta],
    rangeKey,
    new Set([workspaceId]),
    groupMembers,
    undefined,
    undefined,
    workspaces,
  );
  assert.equal(canonical.projectAttribution.projectToGroup.get("project"), beta.id);
  assert.equal(canonical.projectAttribution.creatorNonAiSpendByGroup.get(alpha.id)?.get(creatorId), 90);
  assert.equal(canonical.byGroup.get(alpha.id)?.byUser.get(creatorId), 100);
  assert.equal(canonical.byGroup.get(beta.id)?.byUser.get(creatorId) ?? 0, 0);
  for (const group of [alpha, beta]) {
    const users = [...(canonical.byGroup.get(group.id)?.byUser.values() ?? [])]
      .reduce((sum, value) => sum + value, 0);
    assert.equal(users + (canonical.residualSpendByGroup.get(group.id) ?? 0), canonical.byGroup.get(group.id)?.spendUsd);
  }
  assert.equal(
    [...canonical.byUser.values()].reduce((sum, value) => sum + value, 0) + canonical.residualSpendUsd,
    canonical.totalSpendUsd,
  );

  for (const group of [alpha, beta]) {
    enterprise.__setMemberUsageForTests(group.id, rangeKey, null);
    enterprise.__setProjectUsageForTests(group.id, rangeKey, null);
  }
  enterprise.__setWsSpendForTests(workspaceId, rangeKey, null);
  enterprise.__setProjectInfoForTests(workspaceId, null);
});

test("billing period discovery exposes freshness, mismatch, fallback, and restart hydration", async () => {
  enterprise.__setBillingPeriodForTests(null);
  const fallback = enterprise.getBillingPeriodMetadata();
  assert.equal(fallback.isFallback, true);
  assert.equal(fallback.start, enterprise.SPEND_DATA_CUTOFF_ISO);

  await enterprise.refreshBillingPeriodMetadata(0);
  await waitForQueue();
  const discovered = enterprise.getBillingPeriodMetadata();
  assert.equal(discovered.start, "2026-08-01T00:00:00.000Z");
  assert.equal(discovered.end, "2026-09-01T00:00:00.000Z");
  assert.equal(discovered.isFallback, false);
  assert.equal(discovered.isFresh, true);
  assert.equal(discovered.differsFromReportingCutoff, true);

  enterprise.__setBillingPeriodForTests(null);
  await enterprise.initCache();
  assert.equal(enterprise.getBillingPeriodMetadata().start, discovered.start);
});

test("open ranges reconcile seven days and custom ranges close only after the grace window", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const openRange = {
    key: "mtd:2026-08-01",
    label: "Aug 2026 (MTD)",
    params: {
      startTime: "2026-08-01T00:00:00.000Z",
      endTime: "2026-08-20T12:00:00.000Z",
    },
  };
  const openPlan = enterprise.__planSyncChunksForTests(openRange, {
    syncedThrough: Date.parse("2026-08-20T12:00:00.000Z"),
    completedAt: 0,
    isClosed: false,
  }, now);
  assert.equal(openPlan.replacementStart, "2026-08-13T00:00:00.000Z");

  const graceRange = {
    key: "custom:2026-08-01:2026-08-19",
    label: "2026-08-01 to 2026-08-19",
    params: {
      startTime: "2026-08-01T00:00:00.000Z",
      endTime: "2026-08-20T00:00:00.000Z",
    },
  };
  assert.equal(
    enterprise.__planSyncChunksForTests(graceRange, undefined, now).isClosed,
    false,
  );
  assert.equal(
    enterprise.__planSyncChunksForTests(
      graceRange,
      undefined,
      Date.parse("2026-08-21T00:00:00.001Z"),
    ).isClosed,
    true,
  );
});

test("failed full rebuild preserves the previously committed account snapshot", async () => {
  const rollbackRange = {
    ...range,
    key: `custom:rollback-${crypto.randomUUID()}`,
  };
  const initial = await enterprise.__rebuildAccountUsageForTests(rollbackRange);
  assert.ok(initial.length > 0);
  failNextUsageFetch = true;
  await assert.rejects(
    enterprise.__rebuildAccountUsageForTests(rollbackRange),
    /forced rebuild failure/,
  );
  const afterFailure = await enterprise.__rebuildAccountUsageForTests(rollbackRange);
  assert.deepEqual(
    afterFailure.map((row) => row.payloadJson),
    initial.map((row) => row.payloadJson),
  );
});

test("failure after one staged scope rolls back the entire selected range", async () => {
  const atomicRange = {
    ...range,
    key: `custom:atomic-rollback-${crypto.randomUUID()}`,
  };
  await enterprise.__rebuildAccountAndWorkspaceUsageForTests(atomicRange, workspaceId);
  const before = await enterprise.__getDurableRangeRowsForTests(atomicRange.key);
  assert.ok(before.length >= 2);

  // Account scope stages first; fail on the first workspace request.
  failAtFetchCount = fetchCount + 2;
  await assert.rejects(
    enterprise.__rebuildAccountAndWorkspaceUsageForTests(atomicRange, workspaceId),
    /forced rebuild failure/,
  );
  const after = await enterprise.__getDurableRangeRowsForTests(atomicRange.key);
  assert.deepEqual(after, before);
});