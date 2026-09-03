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
let noCursorWorkspaceMode = false;
let projectMetadataFetchCount = 0;
let failNextProjectMetadataFetch = false;
let accountTotalUsd = 25;
let heldUsageFetch = null;
const usageRequestUrls = [];
const testNow = new Date();
const testBillingStart = new Date(Date.UTC(
  testNow.getUTCFullYear(),
  testNow.getUTCMonth(),
  1,
)).toISOString();
const testBillingEnd = new Date(Date.UTC(
  testNow.getUTCFullYear(),
  testNow.getUTCMonth() + 1,
  1,
)).toISOString();

const originalFetch = globalThis.fetch;
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
      headers: { get: () => null },
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
  let heldAccountTotalUsd = null;
  if (heldUsageFetch && url.pathname.endsWith("/usage")) {
    const held = heldUsageFetch;
    heldUsageFetch = null;
    heldAccountTotalUsd = accountTotalUsd;
    held.started();
    await held.release;
  }
  const groupBy = url.searchParams.get("groupBy");
  const cursor = url.searchParams.get("cursor");
  const isProject = groupBy === "project";
  const isGroupMember = groupBy === "member" && url.searchParams.has("groupId");
  const isWorkspaceMember = groupBy === "member" && url.searchParams.has("workspaceId") &&
    !url.searchParams.has("groupId");
  const pagination = (noCursorProjectMode && isProject) ||
      (noCursorWorkspaceMode && isWorkspaceMember)
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
    totalCostUsd = heldAccountTotalUsd ?? accountTotalUsd;
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
    headers: { get: () => null },
    json: async () => ({
      data: {
        interval: url.searchParams.get("billingPeriod") === "current"
          ? {
              startTime: testBillingStart,
              endTime: testBillingEnd,
            }
          : {
              startTime: url.searchParams.get("startTime"),
              endTime: url.searchParams.get("endTime"),
            },
        totalCostUsd,
        attributableTotalCostUsd: totalCostUsd === accountTotalUsd ? totalCostUsd - 5 : totalCostUsd,
        unattributableTotalCostUsd: totalCostUsd === accountTotalUsd ? 5 : 0,
        groups,
        pagination,
      },
    }),
  };
};

const enterprise = await import("./enterprise.ts");
const { pool } = await import("@workspace/db");
enterprise.__setDailyFactReadsForTests(false);
test.beforeEach(() => {
  enterprise.__resetEnterpriseSchedulerForTests({
    limit: 1_000_000,
    remaining: 1_000_000,
    resetAt: Date.now() + 60_000,
  });
});
test.afterEach(() => {
  enterprise.__resetEnterpriseSchedulerForTests();
});
test.after(() => {
  globalThis.fetch = originalFetch;
});
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

test("daily fact day identities are normalized to UTC", () => {
  assert.deepEqual(
    enterprise.__dateRangeDaysForTests(
      "2026-08-31T23:30:00.000Z",
      "2026-09-02T00:00:00.000Z",
    ),
    ["2026-08-31", "2026-09-01"],
  );
});

test("fact-backed UTC ranges hydrate without queueing an upstream request", () => {
  enterprise.__setDailyFactReadsForTests(true);
  enterprise.__resetDurableUsageCachesForTests();
  enterprise.__setDailyFactsForTests([{
    mode: "account_total",
    scopeKey: "enterprise",
    usageDate: "2026-06-01",
    payloadJson: {
      totalCostUsd: 12.5,
      attributableTotalCostUsd: 10,
      unattributableTotalCostUsd: 2.5,
      groups: [],
    },
    source: "test",
    fetchedAt: new Date(),
  }]);
  const factRange = enterprise.resolveRange("custom", "2026-06-01", "2026-06-01");
  assert.equal(enterprise.getAccountUsage(factRange.key).totalCostUsd, 12.5);
  assert.equal(enterprise.queueAccountUsageFetch(factRange, 0), false);

  enterprise.__resetDurableUsageCachesForTests();
  enterprise.__setDailyFactReadsForTests(false);
});

test("fact reads fail closed for a non-midnight range start", () => {
  enterprise.__setDailyFactReadsForTests(true);
  enterprise.__resetDurableUsageCachesForTests();
  enterprise.__setDailyFactsForTests([{
    mode: "account_total",
    scopeKey: "enterprise",
    usageDate: "2026-06-01",
    payloadJson: {
      totalCostUsd: 12.5,
      attributableTotalCostUsd: 10,
      unattributableTotalCostUsd: 2.5,
      groups: [],
    },
    source: "test",
    fetchedAt: new Date(),
  }]);
  const partialRange = {
    key: "partial-start",
    label: "partial",
    params: {
      startTime: "2026-06-01T12:00:00.000Z",
      endTime: "2026-06-02T00:00:00.000Z",
    },
  };
  assert.equal(enterprise.prepareUsageRangeFromDailyFacts(partialRange), false);
  assert.equal(enterprise.getAccountUsage(partialRange.key), undefined);

  enterprise.__resetDurableUsageCachesForTests();
  enterprise.__setDailyFactReadsForTests(false);
});

test("fact reads fail closed for a non-midnight range end", () => {
  enterprise.__setDailyFactReadsForTests(true);
  enterprise.__resetDurableUsageCachesForTests();
  enterprise.__setDailyFactsForTests([{
    mode: "account_total",
    scopeKey: "enterprise",
    usageDate: "2026-06-01",
    payloadJson: {
      totalCostUsd: 12.5,
      attributableTotalCostUsd: 10,
      unattributableTotalCostUsd: 2.5,
      groups: [],
    },
    source: "test",
    fetchedAt: new Date(),
  }]);
  const partialRange = {
    key: "partial-end",
    label: "partial",
    params: {
      startTime: "2026-06-01T00:00:00.000Z",
      endTime: "2026-06-01T12:00:00.000Z",
    },
  };
  assert.equal(enterprise.prepareUsageRangeFromDailyFacts(partialRange), false);
  assert.equal(enterprise.getAccountUsage(partialRange.key), undefined);

  enterprise.__resetDurableUsageCachesForTests();
  enterprise.__setDailyFactReadsForTests(false);
});

test("cold usage ranges read daily storage on demand and keep the hot cache bounded", async () => {
  enterprise.__setDailyFactReadsForTests(true);
  enterprise.__resetDurableUsageCachesForTests();
  // Keep account-scope fixtures outside any real reporting interval because
  // this suite shares the development database with the preview.
  const firstDay = new Date("2099-01-01T00:00:00.000Z");
  const dates = Array.from(
    { length: enterprise.DAILY_FACT_RANGE_CACHE_MAX + 2 },
    (_, index) => new Date(firstDay.getTime() + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
  const source = `startup-lru-${crypto.randomUUID()}`;
  await pool.query(
    `insert into usage_daily_facts
       (mode, scope_key, usage_date, payload_json, source, fetched_at)
     select 'account_total', 'enterprise', day::date,
       '{"totalCostUsd":1,"attributableTotalCostUsd":1,"unattributableTotalCostUsd":0,"groups":[]}'::jsonb,
       $1, now()
     from unnest($2::text[]) as day
     on conflict (mode, scope_key, usage_date) do update
       set payload_json = excluded.payload_json,
           source = excluded.source,
           fetched_at = excluded.fetched_at`,
    [source, dates],
  );
  await pool.query(
    `insert into usage_daily_facts
       (mode, scope_key, usage_date, payload_json, source, fetched_at)
     select 'group_total', 'unrelated-' || series::text, $2::date,
       '{"totalCostUsd":999,"attributableTotalCostUsd":999,"unattributableTotalCostUsd":0,"groups":[]}'::jsonb,
       $1, now()
     from generate_series(1, 100) as series
     on conflict (mode, scope_key, usage_date) do update
       set payload_json = excluded.payload_json,
           source = excluded.source,
           fetched_at = excluded.fetched_at`,
    [source, dates[0]],
  );
  const requestsBefore = usageRequestUrls.length;
  try {
    for (const day of dates) {
      const factRange = enterprise.resolveRange("custom", day, day);
      assert.equal(enterprise.queueAccountUsageFetch(factRange, 0), true);
      await waitForQueue();
      assert.equal(enterprise.getAccountUsage(factRange.key)?.totalCostUsd, 1);
    }
    assert.equal(usageRequestUrls.length, requestsBefore);
    assert.equal(
      enterprise.__getDailyFactRangeCacheSizeForTests(),
      enterprise.DAILY_FACT_RANGE_CACHE_MAX,
    );
    assert.ok(
      enterprise.__getDailyFactHotRowCountForTests() <=
        enterprise.DAILY_FACT_RANGE_CACHE_MAX,
      "unrelated scopes and evicted ranges must not remain in the hot cache",
    );
  } finally {
    await pool.query("delete from usage_daily_facts where source = $1", [source]);
    enterprise.__resetDurableUsageCachesForTests();
    enterprise.__setDailyFactReadsForTests(false);
  }
});

test("a hot account anchor does not skip a stored group scope for the same range", async () => {
  enterprise.__setDailyFactReadsForTests(true);
  enterprise.__resetDurableUsageCachesForTests();
  const source = `scope-aware-lru-${crypto.randomUUID()}`;
  const scopeGroup = {
    id: `stored-group-${crypto.randomUUID()}`,
    workspaceId,
    name: "Stored group",
    type: "custom",
  };
  const day = "2099-03-01";
  const factRange = enterprise.resolveRange("custom", day, day);
  await pool.query(
    `insert into usage_daily_facts
       (mode, scope_key, usage_date, payload_json, source, fetched_at)
     values
       ('account_total', 'enterprise', $2::date,
        '{"totalCostUsd":7,"attributableTotalCostUsd":7,"unattributableTotalCostUsd":0,"groups":[]}'::jsonb,
        $1, now()),
       ('group_total', $3, $2::date,
        '{"totalCostUsd":7,"attributableTotalCostUsd":7,"unattributableTotalCostUsd":0,"groups":[]}'::jsonb,
        $1, now())
     on conflict (mode, scope_key, usage_date) do update
       set payload_json = excluded.payload_json,
           source = excluded.source,
           fetched_at = excluded.fetched_at`,
    [source, day, scopeGroup.id],
  );
  const requestsBefore = usageRequestUrls.length;
  try {
    assert.equal(enterprise.queueAccountUsageFetch(factRange, 0), true);
    await waitForQueue();
    assert.equal(
      enterprise.queueGroupSpendFetch(
        scopeGroup,
        0,
        false,
        undefined,
        factRange,
      ),
      "queued",
    );
    await waitForQueue();
    assert.equal(enterprise.getSpend(scopeGroup.id, factRange.key)?.spendUsd, 7);
    assert.equal(usageRequestUrls.length, requestsBefore);
  } finally {
    await pool.query("delete from usage_daily_facts where source = $1", [source]);
    enterprise.__resetDurableUsageCachesForTests();
    enterprise.__setDailyFactReadsForTests(false);
  }
});

test("materialized monthly rollups aggregate aligned months and fail closed on gaps or attribution changes", () => {
  enterprise.__resetDurableUsageCachesForTests();
  const materializedGroup = {
    id: `materialized-${crypto.randomUUID()}`,
    workspaceId: `materialized-ws-${crypto.randomUUID()}`,
    name: "Materialized",
    type: "custom",
  };
  const directory = {
    workspaces: new Map([[materializedGroup.workspaceId, {
      id: materializedGroup.workspaceId,
      name: "Materialized Workspace",
      slug: "materialized",
      memberCount: 1,
    }]]),
    groups: [materializedGroup],
    groupMembers: new Map([[materializedGroup.id, ["member"]]]),
    members: new Map([["member", {
      userId: "member",
      username: "member",
      email: "member@example.com",
      name: "Member",
      isAccountAdmin: true,
      workspaces: new Map([[materializedGroup.workspaceId, {
        role: "member",
        isDisabled: false,
      }]]),
    }]]),
  };
  enterprise.__setDirectoryCacheForTests(directory);
  const fingerprintBefore = enterprise.__canonicalInputFingerprintForTests("2026-06-01");
  enterprise.__setDirectoryCacheForTests(directory);
  assert.equal(
    enterprise.__canonicalInputFingerprintForTests("2026-06-01"),
    fingerprintBefore,
    "a no-op directory refresh must not invalidate a historical rollup",
  );
  const row = (monthStart, aiSpendUsd, residualSpendUsd) => ({
    monthStart,
    groupId: materializedGroup.id,
    workspaceId: materializedGroup.workspaceId,
    userKey: "member",
    aiSpendUsd,
    nonAiSpendUsd: 0,
    residualSpendUsd: 0,
    authoritativeSpendUsd: aiSpendUsd,
    updatedAt: new Date(),
  });
  const residual = (monthStart, residualSpendUsd) => ({
    ...row(monthStart, 0, 0),
    userKey: "\u0001canonical-residual",
    residualSpendUsd,
    authoritativeSpendUsd: 0,
  });
  const authoritativeOnly = (monthStart, authoritativeSpendUsd) => ({
    ...row(monthStart, 0, 0),
    userKey: "residual-member",
    authoritativeSpendUsd,
  });
  enterprise.__setCanonicalMonthlyRollupsForTests([
    {
      monthStart: "2026-06-01",
      startTime: "2026-06-01T00:00:00.000Z",
      endTime: "2026-07-01T00:00:00.000Z",
      rows: [
        row("2026-06-01", 10, 0),
        authoritativeOnly("2026-06-01", 4),
        residual("2026-06-01", 2),
      ],
    },
    {
      monthStart: "2026-07-01",
      startTime: "2026-07-01T00:00:00.000Z",
      endTime: "2026-08-01T00:00:00.000Z",
      rows: [
        row("2026-07-01", 20, 0),
        authoritativeOnly("2026-07-01", 3),
        residual("2026-07-01", 3),
      ],
    },
  ]);
  const aligned = enterprise.resolveRange("custom", "2026-06-01", "2026-07-31");
  const canonical = enterprise.getCanonicalUsage(
    [materializedGroup],
    aligned.key,
    new Set([materializedGroup.workspaceId]),
    directory.groupMembers,
    directory.members,
    undefined,
    directory.workspaces,
  );
  assert.equal(canonical.isComplete, true);
  assert.equal(canonical.byUser.get("member"), 30);
  assert.equal(canonical.byGroup.get(materializedGroup.id)?.spendUsd, 35);
  assert.equal(canonical.aiSpendByGroup.get(materializedGroup.id)?.get("member"), 30);
  assert.equal(canonical.authoritativeSpendByGroup.get(materializedGroup.id)?.get("member"), 30);
  assert.equal(
    canonical.authoritativeSpendByGroup.get(materializedGroup.id)?.get("residual-member"),
    7,
  );
  assert.equal(canonical.byGroup.get(materializedGroup.id)?.byUser.get("residual-member"), 0);
  assert.equal(canonical.residualSpendByGroup.get(materializedGroup.id), 5);

  const unsafe = enterprise.resolveRange("custom", "2026-06-01", "2026-08-31");
  assert.equal(
    enterprise.getCanonicalUsage(
      [materializedGroup], unsafe.key, new Set([materializedGroup.workspaceId]),
      directory.groupMembers, directory.members, undefined, directory.workspaces,
    ).isComplete,
    false,
    "a missing monthly segment must use the normal incomplete fallback",
  );
  const changedDirectory = {
    ...directory,
    groupMembers: new Map([[materializedGroup.id, ["member", "new-member"]]]),
  };
  enterprise.__setDirectoryCacheForTests(changedDirectory);
  assert.notEqual(enterprise.__canonicalInputFingerprintForTests("2026-06-01"), fingerprintBefore);
  assert.equal(
    enterprise.getCanonicalUsage(
      [materializedGroup], aligned.key, new Set([materializedGroup.workspaceId]),
      changedDirectory.groupMembers, changedDirectory.members, undefined, changedDirectory.workspaces,
    ).isComplete,
    false,
    "stale materialized attribution must not be served after membership changes",
  );
  enterprise.__setDirectoryCacheForTests(null);
});

test("a month cannot close when a persisted daily fact is missing", async () => {
  await assert.rejects(
    enterprise.__finalizeMissingFactMonthForTests(
      "2026-06-01",
      `missing-fact-${crypto.randomUUID()}`,
      new Date("2026-09-03T12:00:00.000Z"),
    ),
    /is incomplete/,
  );
});

async function waitForQueue() {
  while (enterprise.pendingUsageCount() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("all usage modes paginate and persist without startup hydration", async () => {
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
  await enterprise.initCache({ revalidateOnStartup: false });
  assert.equal(enterprise.getAccountUsage(accountRange.key), undefined);
  assert.equal(enterprise.getSpend(groupId, range.key), undefined);
  assert.equal(enterprise.getMemberUsage(groupId, range.key), undefined);
  assert.equal(enterprise.getWsSpendByUser(extraWorkspaceId, range.key), undefined);
  assert.equal(enterprise.getProjectUsage(groupId, range.key), undefined);
});

test("an incremental refresh keeps the successful Postgres snapshot complete", async () => {
  const refreshRange = {
    key: `custom:background-refresh-${crypto.randomUUID()}`,
    label: "Background refresh test",
    params: {
      startTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };

  assert.equal(enterprise.queueAccountUsageFetch(refreshRange, 0), true);
  await waitForQueue();
  assert.equal(
    enterprise.getUsageSyncSummary(refreshRange.key, [], [], true).status,
    "complete",
  );

  assert.equal(enterprise.queueAccountUsageFetch(refreshRange, 1, true), true);
  assert.equal(
    enterprise.getUsageSyncSummary(refreshRange.key, [], [], true).status,
    "complete",
    "usable stored data must remain complete while its incremental refresh runs",
  );
  await waitForQueue();
});

test("no-cursor pagination terminates as durable partial and retries only when forced", async () => {
  const partialRange = {
    key: `custom:no-cursor-${crypto.randomUUID()}`,
    label: "No cursor test",
    params: {
      startTime: "2026-06-01T00:00:00.000Z",
      endTime: "2026-08-01T00:00:00.000Z",
    },
  };
  const fetchesBeforePartial = fetchCount;
  noCursorProjectMode = true;
  assert.equal(enterprise.queueProjectUsageFetch(group, partialRange, 0), true);
  await waitForQueue();
  assert.ok(
    fetchCount - fetchesBeforePartial <= 31,
    "cursorless recovery must be bounded for multi-month ranges",
  );

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

test("cursorless workspace refresh retains the last usable snapshot across retry and restart", async () => {
  const retainedWorkspaceId = `retained-workspace-${crypto.randomUUID()}`;
  const retainedRange = {
    key: `full-term:retained-${crypto.randomUUID()}`,
    label: "Retained workspace snapshot",
    params: {
      startTime: "2026-09-03T00:00:00.000Z",
      endTime: "2026-09-03T02:00:00.000Z",
    },
  };
  assert.equal(enterprise.queueWsSpendFetch(retainedWorkspaceId, retainedRange, 0), true);
  await waitForQueue();
  assert.equal(
    enterprise.getWsSpendByUser(retainedWorkspaceId, retainedRange.key)?.get("member-2"),
    2,
  );

  const beforeMalformed = fetchCount;
  noCursorWorkspaceMode = true;
  assert.equal(enterprise.queueWsSpendFetch(retainedWorkspaceId, retainedRange, 0, true), true);
  await waitForQueue();
  assert.ok(
    fetchCount - beforeMalformed <= 3,
    "workspace cursorless recovery must stop after the first bounded failed chunk",
  );
  assert.equal(
    enterprise.getWsSpendByUser(retainedWorkspaceId, retainedRange.key)?.get("member-2"),
    2,
    "a partial first page must not replace the complete prior workspace snapshot",
  );
  assert.equal(
    enterprise.isWorkspaceMemberUsageComplete(retainedWorkspaceId, retainedRange.key),
    false,
  );
  const partial = enterprise.getUsageSyncSummary(
    retainedRange.key,
    [],
    [retainedWorkspaceId],
  );
  assert.equal(partial.status, "partial");
  assert.match(partial.error, new RegExp(retainedWorkspaceId));
  assert.match(partial.error, /without a cursor/);

  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache({ revalidateOnStartup: false });
  noCursorWorkspaceMode = false;
  assert.equal(
    enterprise.getWsSpendByUser(retainedWorkspaceId, retainedRange.key),
    undefined,
    "startup must not hydrate historical workspace usage",
  );
  assert.equal(
    enterprise.isWorkspaceMemberUsageComplete(retainedWorkspaceId, retainedRange.key),
    false,
  );

  assert.equal(enterprise.queueWsSpendFetch(retainedWorkspaceId, retainedRange, 0, true), true);
  await waitForQueue();
  assert.equal(
    enterprise.isWorkspaceMemberUsageComplete(retainedWorkspaceId, retainedRange.key),
    true,
  );
  assert.equal(
    enterprise.getWsSpendByUser(retainedWorkspaceId, retainedRange.key)?.get("member-2"),
    2,
  );
});

test("stable full-term range reuses same-day data and advances only the trailing reconciliation window", () => {
  const firstDay = enterprise.resolveRange(
    "full-term",
    undefined,
    undefined,
    new Date("2026-09-03T23:59:59.000Z"),
  );
  const nextDay = enterprise.resolveRange(
    "full-term",
    undefined,
    undefined,
    new Date("2026-09-04T00:00:01.000Z"),
  );
  assert.equal(firstDay.key, enterprise.FULL_TERM_RANGE_KEY);
  assert.equal(nextDay.key, firstDay.key);
  assert.equal(firstDay.params.startTime, enterprise.SPEND_DATA_CUTOFF_ISO);
  assert.equal(firstDay.params.endTime, "2026-09-04T00:00:00.000Z");
  assert.equal(nextDay.params.endTime, "2026-09-05T00:00:00.000Z");

  const sameDayPlan = enterprise.__planSyncChunksForTests(firstDay, {
    syncedThrough: Date.parse(firstDay.params.endTime),
    completedAt: Date.parse("2026-09-03T23:59:58.000Z"),
    isClosed: false,
    status: "success",
    error: null,
  }, Date.parse("2026-09-03T23:59:59.000Z"));
  assert.equal(sameDayPlan.chunks.length, 0);

  const rolloverPlan = enterprise.__planSyncChunksForTests(nextDay, {
    syncedThrough: Date.parse(firstDay.params.endTime),
    completedAt: 0,
    isClosed: false,
    status: "success",
    error: null,
  }, Date.parse("2026-09-04T00:00:01.000Z"));
  assert.equal(rolloverPlan.replacementStart, "2026-08-28T00:00:00.000Z");
  assert.equal(rolloverPlan.chunks.at(-1)?.end, nextDay.params.endTime);
  assert.ok(rolloverPlan.chunks.length <= 8, "rollover must not replay full-term history");
  assert.equal(rolloverPlan.isClosed, false);

  const closedRange = {
    key: `custom:closed-tail-${crypto.randomUUID()}`,
    label: "Closed tail",
    params: {
      startTime: "2026-05-20T00:00:00.000Z",
      endTime: "2026-08-01T00:00:00.000Z",
    },
  };
  const closedPlan = enterprise.__planSyncChunksForTests(closedRange, {
    syncedThrough: Date.parse(closedRange.params.endTime),
    completedAt: 0,
    isClosed: false,
    status: "success",
    error: null,
  }, Date.parse("2026-08-03T00:00:01.000Z"));
  assert.equal(closedPlan.isClosed, true);
  assert.notEqual(
    closedPlan.replacementStart,
    closedRange.params.startTime,
    "closing a durable range must preserve immutable history",
  );
  assert.ok(
    closedPlan.chunks.length <= 8,
    "final closure must synchronize only the reconciliation tail",
  );
});

test("startup does not scan or adopt legacy usage snapshots", async () => {
  const legacyScope = `legacy-full-term-${crypto.randomUUID()}`;
  const legacyKey = "custom:2026-05-20:2026-09-02";
  const completedAt = new Date("2026-09-03T00:05:00.000Z");
  await pool.query(
    `insert into usage_sync_chunks
      (mode, range_key, scope_key, chunk_start, chunk_end, payload_json, completed_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      "group_project",
      legacyKey,
      legacyScope,
      enterprise.SPEND_DATA_CUTOFF_ISO,
      "2026-09-03T00:00:00.000Z",
      JSON.stringify({
        totalCostUsd: 9,
        attributableTotalCostUsd: 9,
        unattributableTotalCostUsd: 0,
        groups: [{
          key: { projectId: "legacy-project" },
          totalCostUsd: 9,
          metrics: [],
        }],
      }),
      completedAt,
    ],
  );
  await pool.query(
    `insert into usage_sync_state
      (mode, range_key, scope_key, range_start, synced_through, is_closed, status,
       error_message, started_at, completed_at)
     values ($1, $2, $3, $4, $5, true, 'success', null, $6, $6)`,
    [
      "group_project",
      legacyKey,
      legacyScope,
      enterprise.SPEND_DATA_CUTOFF_ISO,
      "2026-09-03T00:00:00.000Z",
      completedAt,
    ],
  );

  const requestsBeforeRestart = usageRequestUrls.length;
  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache({ revalidateOnStartup: false });
  assert.equal(enterprise.getProjectUsage(legacyScope, enterprise.FULL_TERM_RANGE_KEY), undefined);
  assert.equal(usageRequestUrls.length, requestsBeforeRestart);
  const adoptedRows = await enterprise.__getDurableRangeRowsForTests(
    enterprise.FULL_TERM_RANGE_KEY,
  );
  assert.equal(adoptedRows.some((row) =>
    row.mode === "group_project" && row.scopeKey === legacyScope
  ), false);
  await pool.query(
    `delete from usage_sync_chunks
     where mode = 'group_project' and scope_key = $1
       and range_key in ($2, $3)`,
    [legacyScope, legacyKey, enterprise.FULL_TERM_RANGE_KEY],
  );
  await pool.query(
    `delete from usage_sync_state
     where mode = 'group_project' and scope_key = $1
       and range_key in ($2, $3)`,
    [legacyScope, legacyKey, enterprise.FULL_TERM_RANGE_KEY],
  );
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
  const diagnostics = enterprise.getUsageOperationalDiagnostics();
  assert.ok(
    diagnostics.scopes.some((scope) =>
      scope.mode === "group_project" &&
      scope.rangeKey === failedRange.key &&
      scope.scopeKey === group.id &&
      scope.status === "failed"
    ),
    "account diagnostics must identify the exact failed scope",
  );

  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache({ revalidateOnStartup: false });
  assert.equal(
    enterprise.isUsageSyncRetryable("group_project", failedRange.key, group.id),
    false,
    "startup must not hydrate historical synchronization state",
  );
});

test("queue diagnostics expose active work, backlog age, and recent progress", async () => {
  const diagnosticRange = {
    key: `custom:queue-diagnostics-${crypto.randomUUID()}`,
    label: "Queue diagnostics",
    params: {
      startTime: "2026-09-01T00:00:00.000Z",
      endTime: "2026-09-01T02:00:00.000Z",
    },
  };
  const secondGroup = {
    ...group,
    id: `diagnostic-group-${crypto.randomUUID()}`,
  };
  assert.equal(enterprise.queueMemberUsageFetch(group, diagnosticRange, 1), true);
  assert.equal(enterprise.queueProjectUsageFetch(secondGroup, diagnosticRange, 1), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const active = enterprise.getUsageOperationalDiagnostics();
  assert.ok(active.queueDepth >= 1);
  assert.ok(active.active || active.queuedCount > 0);
  assert.ok(active.lastProgressAt);
  assert.ok(active.oldestQueuedAgeMs === null || active.oldestQueuedAgeMs >= 0);
  await waitForQueue();
  const complete = enterprise.getUsageOperationalDiagnostics();
  assert.equal(complete.queueDepth, 0);
  assert.equal(complete.active, null);
});

test("project metadata persists without startup hydration", async () => {
  const metadataWorkspace = `metadata-${crypto.randomUUID()}`;
  assert.equal(enterprise.queueProjectTitlesFetch(metadataWorkspace, 0), true);
  await waitForQueue();
  assert.deepEqual(enterprise.getProjectInfo(metadataWorkspace, "persisted-project"), {
    title: "Persisted project",
    creatorId: "creator-1",
  });
  const completedFetches = projectMetadataFetchCount;

  enterprise.__resetDurableUsageCachesForTests();
  await enterprise.initCache({ revalidateOnStartup: false });
  assert.equal(enterprise.getProjectInfo(metadataWorkspace, "persisted-project"), undefined);
  assert.equal(enterprise.queueProjectTitlesFetch(metadataWorkspace, 0), true);
  await waitForQueue();
  assert.ok(projectMetadataFetchCount > completedFetches);
});

test("failed project metadata refresh preserves the stored snapshot across restart", async () => {
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
  await enterprise.initCache({ revalidateOnStartup: false });
  assert.equal(
    enterprise.hasProjectInfo(failedWorkspace),
    false,
    "startup must not hydrate project metadata",
  );
  assert.equal(enterprise.queueProjectTitlesFetch(failedWorkspace, 0), true);
  await waitForQueue();
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
  const fallbackRange = enterprise.resolveRange("billing");
  assert.equal(fallbackRange.key, "billing:from-cutoff");
  assert.equal(fallbackRange.params.startTime, enterprise.SPEND_DATA_CUTOFF_ISO);
  assert.match(fallbackRange.label, /May 20, 2026/);

  await enterprise.refreshBillingPeriodMetadata(0, false, false);
  await waitForQueue();
  assert.equal(enterprise.getBillingPeriodMetadata().isFallback, true);
  await enterprise.refreshBillingPeriodMetadata(0, false, false);
  await waitForQueue();
  const discovered = enterprise.getBillingPeriodMetadata();
  assert.equal(discovered.start, testBillingStart);
  assert.equal(discovered.end, testBillingEnd);
  assert.equal(discovered.isFallback, false);
  assert.equal(discovered.isFresh, true);
  assert.equal(discovered.differsFromReportingCutoff, true);
  const resolved = enterprise.resolveRange("billing");
  assert.ok(resolved.key.includes(testBillingStart));
  assert.ok(resolved.key.includes(testBillingEnd));
  assert.equal(resolved.params.startTime, discovered.start);
  assert.ok(new Date(resolved.params.endTime) <= new Date(discovered.end));
  assert.equal(
    resolved.label,
    `${new Date(resolved.params.startTime).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    })} – ${new Date(resolved.params.endTime).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    })}`,
  );

  enterprise.__setBillingPeriodForTests(null);
});

test("billing rollover adopts only the second identical persisted observation after restart", async () => {
  const persistenceId = `billing-observation-${crypto.randomUUID()}`;
  const period = {
    start: "2099-01-01T00:00:00.000Z",
    end: "2099-02-01T00:00:00.000Z",
    fetchedAt: Date.now(),
  };
  try {
    enterprise.__resetDurableUsageCachesForTests();
    assert.equal(
      await enterprise.__observeBillingPeriodForTests(period, persistenceId),
      null,
    );
    enterprise.__resetDurableUsageCachesForTests();
    await enterprise.__hydrateBillingPeriodStateForTests(persistenceId);
    const adopted = await enterprise.__observeBillingPeriodForTests(
      { ...period, fetchedAt: period.fetchedAt + 1_000 },
      persistenceId,
    );
    assert.equal(adopted?.start, period.start);
    assert.equal(adopted?.end, period.end);
  } finally {
    await pool.query(
      "delete from api_billing_period_observation where id = $1",
      [persistenceId],
    );
    await pool.query(
      "delete from api_billing_period_cache where id = $1",
      [persistenceId],
    );
    enterprise.__resetDurableUsageCachesForTests();
  }
});

test("expired metadata falls back and pre-cutoff billing does not trigger a window banner", () => {
  enterprise.__setBillingPeriodForTests({
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
    fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
  });
  const expiredMetadata = enterprise.getBillingPeriodMetadata();
  const expiredRange = enterprise.resolveRange("billing");
  assert.equal(expiredMetadata.isFallback, true);
  assert.equal(expiredMetadata.differsFromReportingCutoff, false);
  assert.equal(expiredRange.key, "billing:from-cutoff");
  assert.equal(expiredRange.params.startTime, enterprise.SPEND_DATA_CUTOFF_ISO);

  enterprise.__setBillingPeriodForTests({
    start: "2026-05-01T00:00:00.000Z",
    end: "2026-09-01T00:00:00.000Z",
    fetchedAt: Date.now(),
  });
  const clamped = enterprise.getBillingPeriodMetadata();
  const clampedRange = enterprise.resolveRange("billing");
  assert.equal(clamped.differsFromReportingCutoff, false);
  assert.equal(clampedRange.params.startTime, enterprise.SPEND_DATA_CUTOFF_ISO);
  enterprise.__setBillingPeriodForTests(null);
});

test("account-total verification records no-op, heals drift, and preserves cache on failure", async () => {
  const verificationRange = {
    key: `custom:verification-${crypto.randomUUID()}`,
    label: "Verification",
    params: {
      startTime: "2026-08-01T00:00:00.000Z",
      endTime: "2026-08-02T00:00:00.000Z",
    },
  };
  accountTotalUsd = 25;
  await enterprise.__rebuildAccountUsageForTests(verificationRange);
  await enterprise.__verifyAccountTotalForTests(verificationRange);
  assert.equal(enterprise.getAccountTotalVerificationState()?.outcome, "success");
  assert.equal(enterprise.getAccountUsage(verificationRange.key)?.totalCostUsd, undefined);

  accountTotalUsd = 30;
  await enterprise.__verifyAccountTotalForTests(verificationRange);
  assert.equal(enterprise.getAccountTotalVerificationState()?.outcome, "healed");
  assert.equal(enterprise.getAccountUsage(verificationRange.key)?.totalCostUsd, 30);
  const beforeFailure = enterprise.getAccountUsage(verificationRange.key);

  failNextUsageFetch = true;
  await enterprise.__verifyAccountTotalForTests(verificationRange);
  assert.equal(enterprise.getAccountTotalVerificationState()?.outcome, "failed");
  assert.deepEqual(enterprise.getAccountUsage(verificationRange.key), beforeFailure);
  accountTotalUsd = 25;
});

test("account verification acquires the cross-replica lock before its upstream fetch", async () => {
  const lockedRange = {
    key: `custom:verification-lock-${crypto.randomUUID()}`,
    label: "Verification lock",
    params: {
      startTime: "2026-08-01T00:00:00.000Z",
      endTime: "2026-08-01T02:00:00.000Z",
    },
  };
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `account_total|${lockedRange.key}|enterprise`,
    ]);
    const requestsBefore = usageRequestUrls.length;
    const verification = enterprise.__verifyAccountTotalForTests(lockedRange);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      usageRequestUrls.length,
      requestsBefore,
      "verification must not fetch while another replica holds the account lock",
    );
    await client.query("rollback");
    await verification;
    assert.equal(usageRequestUrls.length, requestsBefore + 1);
  } finally {
    client.release();
  }
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

test("failed full rebuild staging preserves the previously committed account snapshot", async () => {
  const rollbackRange = {
    ...range,
    key: `custom:rollback-${crypto.randomUUID()}`,
  };
  await enterprise.__rebuildAccountUsageForTests(rollbackRange);
  const initial = await enterprise.__getDurableRangeRowsForTests(rollbackRange.key);
  assert.ok(initial.length > 0);
  failNextUsageFetch = true;
  await assert.rejects(
    enterprise.__rebuildAccountUsageForTests(rollbackRange),
    /forced rebuild failure/,
  );
  const afterFailure = await enterprise.__getDurableRangeRowsForTests(rollbackRange.key);
  assert.deepEqual(afterFailure, initial);
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

test("failed full rebuild commit preserves the previously committed snapshot", async () => {
  const commitRange = {
    ...range,
    key: `custom:commit-rollback-${crypto.randomUUID()}`,
  };
  await enterprise.__rebuildAccountAndWorkspaceUsageForTests(commitRange, workspaceId);
  const before = await enterprise.__getDurableRangeRowsForTests(commitRange.key);
  assert.ok(before.length >= 2);

  const triggerSuffix = crypto.randomUUID().replaceAll("-", "_");
  const functionName = `fail_usage_rebuild_${triggerSuffix}`;
  const triggerName = `fail_usage_rebuild_${triggerSuffix}`;
  await pool.query(`
    create function ${functionName}() returns trigger
    language plpgsql as $$
    begin
      if new.range_key = '${commitRange.key}' then
        raise exception 'forced rebuild commit failure';
      end if;
      return new;
    end;
    $$;
    create trigger ${triggerName}
      before insert on usage_sync_chunks
      for each row execute function ${functionName}();
  `);

  try {
    await assert.rejects(
      enterprise.__rebuildAccountAndWorkspaceUsageForTests(commitRange, workspaceId),
      (error) => error?.cause?.message === "forced rebuild commit failure",
    );
  } finally {
    await pool.query(`drop trigger ${triggerName} on usage_sync_chunks`);
    await pool.query(`drop function ${functionName}()`);
  }

  const after = await enterprise.__getDurableRangeRowsForTests(commitRange.key);
  assert.deepEqual(after, before);
});

test("an older staged rebuild cannot replace a newer committed snapshot", async () => {
  const fencedRange = {
    ...range,
    key: `custom:concurrent-rebuild-${crypto.randomUUID()}`,
  };
  await enterprise.__rebuildAccountUsageForTests(fencedRange);

  let signalStarted;
  let releaseFetch;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  heldUsageFetch = { started: signalStarted, release };

  try {
    accountTotalUsd = 40;
    const olderRebuild = enterprise.__rebuildAccountUsageForTests(fencedRange);
    await started;

    accountTotalUsd = 50;
    await enterprise.__rebuildAccountUsageForTests(fencedRange);
    releaseFetch();
    await assert.rejects(
      olderRebuild,
      /Usage range changed while the rebuild was staged/,
    );

    const durable = await enterprise.__getDurableRangeRowsForTests(fencedRange.key);
    assert.equal(durable.length, 1);
    assert.equal(durable[0].payloadJson.totalCostUsd, 50);
  } finally {
    releaseFetch?.();
    heldUsageFetch = null;
    accountTotalUsd = 25;
  }
});
