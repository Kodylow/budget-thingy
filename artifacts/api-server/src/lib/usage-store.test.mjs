import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";

const { pool } = await import("@workspace/db");
const {
  createUsageStore,
  invalidateUsageSnapshotMemo,
  readUsageSnapshot,
} = await import("./usage-store.ts");
const {
  resolveUsageWindow,
  UsageWindowError,
} = await import("./usage-window.ts");
const { ingestAccountDay } = await import("./ingest.ts");
const { ingestWorkspaceDay } = await import("./ingest.ts");
const enterprise = await import("./enterprise.ts");

const runId = crypto.randomUUID();
const workspaceA = `usage-store-a-${runId}`;
const workspaceB = `usage-store-b-${runId}`;
const dayOne = "2099-07-01";
const dayTwo = "2099-07-02";
const window = {
  start: `${dayOne}T00:00:00.000Z`,
  end: "2099-07-03T00:00:00.000Z",
};
const fetchedAt = new Date("2099-07-02T23:55:00.000Z");

async function cleanup() {
  for (const table of [
    "usage_member_day",
    "usage_project_day",
    "usage_workspace_day",
  ]) {
    await pool.query(
      `delete from ${table} where workspace_id = any($1::text[])`,
      [[workspaceA, workspaceB]],
    );
  }
  await pool.query(
    "delete from usage_account_day where usage_date >= $1::date and usage_date < $2::date",
    [dayOne, "2099-07-04"],
  );
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `insert into usage_workspace_day
       (workspace_id,usage_date,total_cost_usd,member_attributable_usd,
        member_unattributable_usd,metrics_json,fetched_at,status,error)
     values
       ($1,$3::date,10,8,2,'[]'::jsonb,$5,'complete',null),
       ($1,$4::date,20,15,5,'[]'::jsonb,$5,'complete',null),
       ($2,$3::date,30,25,5,'[]'::jsonb,$5,'complete',null),
       ($2,$4::date,0,0,0,'[]'::jsonb,$5,'failed','fixture failure')`,
    [workspaceA, workspaceB, dayOne, dayTwo, fetchedAt],
  );
  await pool.query(
    `insert into usage_member_day
       (workspace_id,usage_date,user_id,total_cost_usd,ai_cost_usd,metrics_json,fetched_at)
     values
       ($1,$3::date,'user-1',8,6,'[]'::jsonb,$5),
       ($1,$4::date,'user-1',15,10,'[]'::jsonb,$5),
       ($2,$3::date,'user-2',25,20,'[]'::jsonb,$5)`,
    [workspaceA, workspaceB, dayOne, dayTwo, fetchedAt],
  );
  await pool.query(
    `insert into usage_project_day
       (workspace_id,usage_date,project_id,total_cost_usd,metrics_json,fetched_at)
     values
       ($1,$3::date,'project-1',10,'[]'::jsonb,$5),
       ($1,$4::date,'project-1',20,'[]'::jsonb,$5),
       ($2,$3::date,'project-2',30,'[]'::jsonb,$5)`,
    [workspaceA, workspaceB, dayOne, dayTwo, fetchedAt],
  );
  await pool.query(
    `insert into usage_account_day (usage_date,total_cost_usd,fetched_at)
     values ($1::date,40,$3),($2::date,20,$3)`,
    [dayOne, dayTwo, fetchedAt],
  );
});

afterAll(async () => {
  enterprise.setEnterpriseFetchForTests(null);
  await cleanup();
});

test("store aggregates exclusive windows, scopes every workspace fact, and loads daily members on demand", async () => {
  const store = createUsageStore({
    now: () => Date.parse("2099-07-02T23:59:00.000Z"),
  });
  const snapshot = await store.read({
    window,
    workspaceIds: [workspaceA],
    includeDailyMembers: true,
  });

  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.accountTotalUsd, 60);
  assert.deepEqual(snapshot.workspaces.get(workspaceA), {
    totalCostUsd: 30,
    memberAttributableUsd: 23,
    memberUnattributableUsd: 7,
  });
  assert.deepEqual(snapshot.members.get(workspaceA)?.get("user-1"), {
    totalCostUsd: 23,
    aiCostUsd: 16,
  });
  assert.equal(snapshot.projects.get(workspaceA)?.get("project-1")?.totalCostUsd, 30);
  assert.equal(snapshot.daily.get(dayOne)?.workspaceTotalUsd, 10);
  assert.equal(
    snapshot.dailyMembers?.get(dayTwo)?.get(workspaceA)?.get("user-1")?.totalCostUsd,
    15,
  );
  assert.equal(snapshot.workspaces.has(workspaceB), false);
  assert.deepEqual(snapshot.coverage, {
    requestedDays: 2,
    requestedWorkspaceDays: 2,
    presentWorkspaceDays: 2,
    failedWorkspaceDays: [],
    missingWorkspaceDays: [],
    presentAccountDays: 2,
    missingAccountDays: [],
    ratio: 1,
  });
});

test("failed workspace-days produce partial coverage once while stale live data is classified separately", async () => {
  const partialStore = createUsageStore({
    now: () => Date.parse("2099-07-02T23:59:00.000Z"),
  });
  const partial = await partialStore.read({
    window,
    workspaceIds: [workspaceB],
  });
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.coverage.failedWorkspaceDays, [{
    workspaceId: workspaceB,
    usageDate: dayTwo,
  }]);
  assert.deepEqual(partial.coverage.missingWorkspaceDays, []);
  assert.equal(partial.coverage.ratio, 3 / 4);

  const staleStore = createUsageStore({
    now: () => Date.parse("2099-07-02T23:59:00.000Z"),
    staleAfterMs: 60_000,
  });
  const stale = await staleStore.read({ window, workspaceIds: [workspaceA] });
  assert.equal(stale.status, "stale");
  assert.equal(stale.dataAsOf, fetchedAt.toISOString());
});

test("empty scopes are empty and equivalent requests share one memo", async () => {
  let queryCount = 0;
  const queryable = {
    async query() {
      queryCount++;
      return { rows: [] };
    },
  };
  const store = createUsageStore({ queryable, now: () => Date.parse("2099-07-02T12:00:00Z") });
  const first = store.read({ window, workspaceIds: [] });
  const second = store.read({ window, workspaceIds: [] });
  assert.strictEqual(first, second);
  assert.equal((await first).status, "empty");
  assert.equal((await first).accountTotalUsd, 0);
  assert.equal(queryCount, 0);
  store.invalidate();
  await store.read({ window, workspaceIds: [] });
  assert.equal(queryCount, 0);
});

test("a warm live memo becomes stale as time advances without repeating database reads", async () => {
  let currentTime = Date.parse("2099-07-02T23:55:30.000Z");
  let queryCount = 0;
  const rows = {
    member: [],
    project: [],
    workspace: [{
      workspace_id: workspaceA,
      usage_date: dayTwo,
      total_cost_usd: 20,
      member_attributable_usd: 15,
      member_unattributable_usd: 5,
      fetched_at: fetchedAt,
      status: "complete",
    }],
    account: [{
      usage_date: dayTwo,
      total_cost_usd: 20,
      fetched_at: fetchedAt,
    }],
  };
  const queryable = {
    async query(text) {
      queryCount++;
      if (text.includes("usage_member_day")) return { rows: rows.member };
      if (text.includes("usage_project_day")) return { rows: rows.project };
      if (text.includes("usage_workspace_day")) return { rows: rows.workspace };
      return { rows: rows.account };
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => currentTime,
    staleAfterMs: 60_000,
  });
  const oneDayWindow = {
    start: `${dayTwo}T00:00:00.000Z`,
    end: window.end,
  };
  assert.equal(
    (await store.read({ window: oneDayWindow, workspaceIds: [workspaceA] })).status,
    "complete",
  );
  currentTime = Date.parse("2099-07-02T23:57:00.000Z");
  assert.equal(
    (await store.read({ window: oneDayWindow, workspaceIds: [workspaceA] })).status,
    "stale",
  );
  assert.equal(queryCount, 4);
});

test("successful account ingest invalidates the default memo", async () => {
  invalidateUsageSnapshotMemo();
  await readUsageSnapshot({ window, workspaceIds: [workspaceA] });
  const before = await readUsageSnapshot({ window, workspaceIds: [workspaceA] });

  enterprise.setEnterpriseFetchForTests(async () =>
    Response.json({ data: { totalCostUsd: 99 } }));
  const result = await enterprise.withEnterpriseIngestAccess(
    () => ingestAccountDay("2099-07-03"),
  );
  assert.equal(result.ok, true);
  const after = await readUsageSnapshot({ window, workspaceIds: [workspaceA] });
  assert.notStrictEqual(after, before);
});

test("successful workspace ingest invalidates the default memo after commit", async () => {
  const ingestWorkspace = `usage-store-ingest-${runId}`;
  const ingestDay = "2099-07-04";
  const ingestWindow = {
    start: `${ingestDay}T00:00:00.000Z`,
    end: "2099-07-05T00:00:00.000Z",
  };
  try {
    invalidateUsageSnapshotMemo();
    const before = await readUsageSnapshot({
      window: ingestWindow,
      workspaceIds: [ingestWorkspace],
    });
    enterprise.setEnterpriseFetchForTests(async (input) => {
      const groupBy = new URL(String(input)).searchParams.get("groupBy");
      return Response.json({
        data: {
          totalCostUsd: 12,
          attributableTotalCostUsd: 9,
          unattributableTotalCostUsd: 3,
          metrics: [],
          groups: groupBy === "member"
            ? [{ key: { userId: "ingested-user" }, totalCostUsd: 9, metrics: [] }]
            : [{ key: { projectId: "ingested-project" }, totalCostUsd: 12, metrics: [] }],
          pagination: { hasMore: false, nextCursor: null },
        },
      });
    });
    const result = await enterprise.withEnterpriseIngestAccess(
      () => ingestWorkspaceDay(ingestWorkspace, ingestDay),
    );
    assert.equal(result.ok, true);
    const after = await readUsageSnapshot({
      window: ingestWindow,
      workspaceIds: [ingestWorkspace],
    });
    assert.notStrictEqual(after, before);
    assert.equal(after.workspaces.get(ingestWorkspace)?.totalCostUsd, 12);

    enterprise.setEnterpriseFetchForTests(async () =>
      new Response("forced refresh failure", { status: 503 }));
    const failed = await enterprise.withEnterpriseIngestAccess(
      () => ingestWorkspaceDay(ingestWorkspace, ingestDay),
    );
    assert.equal(failed.ok, false);
    const afterFailure = await readUsageSnapshot({
      window: ingestWindow,
      workspaceIds: [ingestWorkspace],
    });
    assert.notStrictEqual(afterFailure, after);
    assert.equal(afterFailure.status, "partial");
    assert.equal(afterFailure.workspaces.get(ingestWorkspace)?.totalCostUsd, 12);
  } finally {
    for (const table of [
      "usage_member_day",
      "usage_project_day",
      "usage_workspace_day",
    ]) {
      await pool.query(`delete from ${table} where workspace_id=$1`, [ingestWorkspace]);
    }
  }
});

test("pure UTC window resolution has no range key and honors cutoff, billing anchors, and inclusive custom dates", () => {
  const now = new Date("2026-09-04T23:30:00-07:00");
  const billing = resolveUsageWindow({
    rangeType: "billing",
    now,
    billingPeriod: {
      start: "2026-08-17T00:00:00.000Z",
      end: "2026-09-17T00:00:00.000Z",
    },
  });
  assert.deepEqual(billing.window, {
    start: "2026-08-17T00:00:00.000Z",
    end: "2026-09-06T00:00:00.000Z",
  });
  assert.equal("key" in billing, false);

  const custom = resolveUsageWindow({
    rangeType: "custom",
    startDate: "2026-05-01",
    endDate: "2026-05-20",
    now,
  });
  assert.deepEqual(custom.window, {
    start: "2026-05-20T00:00:00.000Z",
    end: "2026-05-21T00:00:00.000Z",
  });

  const expired = resolveUsageWindow({
    rangeType: "billing",
    now,
    billingPeriod: {
      start: "2026-07-17T00:00:00.000Z",
      end: "2026-08-17T00:00:00.000Z",
    },
  });
  assert.equal(expired.window.start, "2026-05-20T00:00:00.000Z");
  const nonMidnight = resolveUsageWindow({
    rangeType: "billing",
    now,
    billingPeriod: {
      start: "2026-08-17T12:30:00.000Z",
      end: "2026-09-17T12:30:00.000Z",
    },
  });
  assert.deepEqual(nonMidnight.window, {
    start: "2026-08-18T00:00:00.000Z",
    end: "2026-09-06T00:00:00.000Z",
  });
  assert.throws(
    () => resolveUsageWindow({
      rangeType: "custom",
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      now,
    }),
    UsageWindowError,
  );
});