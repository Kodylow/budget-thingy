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

globalThis.fetch = async (input) => {
  fetchCount += 1;
  const url = new URL(String(input));
  const groupBy = url.searchParams.get("groupBy");
  const cursor = url.searchParams.get("cursor");
  const isProject = groupBy === "project";
  const isGroupMember = groupBy === "member" && url.searchParams.has("groupId");
  const pagination = cursor
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
        interval: {
          startTime: url.searchParams.get("startTime"),
          endTime: url.searchParams.get("endTime"),
        },
        totalCostUsd,
        attributableTotalCostUsd: totalCostUsd,
        unattributableTotalCostUsd: 0,
        groups,
        pagination,
      },
    }),
  };
};

const enterprise = await import("./enterprise.ts");
const range = enterprise.resolveRange("custom", "2026-06-01", "2026-06-01");
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
  enterprise.queueGroupSpendFetch(group, 0, false, undefined, range);
  enterprise.queueMemberUsageFetch(group, range, 0);
  enterprise.queueWsSpendFetch(extraWorkspaceId, range, 0);
  enterprise.queueProjectUsageFetch(group, range, 0);
  await waitForQueue();

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
  assert.equal(enterprise.queueGroupSpendFetch(group, 0, true, undefined, range), "fresh_cache");
  assert.equal(enterprise.queueMemberUsageFetch(group, range, 0, true), false);
  assert.equal(enterprise.queueWsSpendFetch(extraWorkspaceId, range, 0, true), false);
  assert.equal(enterprise.queueProjectUsageFetch(group, range, 0, true), false);
  assert.equal(fetchCount, completedFetches);

  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache();
  assert.equal(enterprise.getSpend(groupId, range.key)?.spendUsd, 10);
  assert.equal(enterprise.getMemberUsage(groupId, range.key)?.byUser.get("member-2"), 6);
  assert.equal(enterprise.getWsSpendByUser(extraWorkspaceId, range.key)?.get("member-1"), 3);
  assert.equal(
    enterprise.getProjectUsage(groupId, range.key)?.byProject.get("project-2")?.totalCostUsd,
    7,
  );
});