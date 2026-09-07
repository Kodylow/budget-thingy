import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";

const { pool } = await import("@workspace/db");
const {
  createUsageStore,
  invalidateUsageSnapshotMemo,
  readUsageSnapshot,
} = await import("./usage-store.ts");
const {
  computeSnapshotUsageRollup,
  projectAttributionKey,
} = await import("./usage-rollup.ts");
const {
  resolveUsageWindow,
  UsageWindowError,
} = await import("./usage-window.ts");
const { ingestAccountDay } = await import("./ingest.ts");
const { ingestWorkspaceDay } = await import("./ingest.ts");
const enterprise = await import("./enterprise.ts");
const originalFetch = globalThis.fetch;

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
       ($1,$3::date,'user-1',8,2,'[]'::jsonb,$5),
       ($1,$4::date,'user-1',15,10,'[]'::jsonb,$5),
       ($2,$3::date,'user-2',25,20,'[]'::jsonb,$5)`,
    [workspaceA, workspaceB, dayOne, dayTwo, fetchedAt],
  );
  await pool.query(
    `insert into usage_project_day
       (workspace_id,usage_date,project_id,total_cost_usd,metrics_json,fetched_at)
     values
       ($1,$3::date,'project-1',10,
        '[{"id":"replit:v0:teams:ai_agent","name":"Agent","category":"ai","costUsd":2},
          {"id":"model-farm","name":"Model Farm","category":"ai","costUsd":3},
          {"id":"hosting","name":"Hosting","category":"compute","costUsd":5}]'::jsonb,$5),
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
  globalThis.fetch = originalFetch;
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
    aiCostUsd: 12,
    agentMetricsComplete: false,
  });
  assert.equal(snapshot.projects.get(workspaceA)?.get("project-1")?.totalCostUsd, 30);
  assert.equal(snapshot.projects.get(workspaceA)?.get("project-1")?.aiCostUsd, 2);
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

test("mixed AI project metrics send only Agent spend through member attribution", async () => {
  const store = createUsageStore({
    now: () => Date.parse("2099-07-01T23:59:00.000Z"),
  });
  const loaded = await store.read({
    window: {
      start: `${dayOne}T00:00:00.000Z`,
      end: `${dayTwo}T00:00:00.000Z`,
    },
    workspaceIds: [workspaceA],
  });
  const result = computeSnapshotUsageRollup({
    snapshot: loaded,
    groups: [{ id: "group", workspaceId: workspaceA, name: "Group" }],
    membersByGroup: new Map([["group", ["user-1"]]]),
    projectInfoByWorkspace: new Map([
      [workspaceA, new Map([["project-1", { creatorId: "user-1" }]])],
    ]),
  });

  assert.equal(result.aiSpendByUser.get("user-1"), 2);
  assert.equal(result.nonAiSpendByUser.get("user-1"), 8);
  assert.equal(result.byGroup.get("group")?.spendUsd, 10);
  const projectKey = projectAttributionKey(workspaceA, "project-1");
  assert.equal(result.projectAttribution.aiSpendByProject.get(projectKey), 2);
  assert.equal(result.projectAttribution.nonAiSpendByProject.get(projectKey), 8);
  assert.equal(result.ungroupedByWorkspace.size, 0);
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

test("one read uses one repeatable-read snapshot across a concurrent commit", async () => {
  let committedVersion = 1;
  let released = false;
  const transactionStatements = [];
  const queryable = {
    async connect() {
      let transactionVersion = null;
      return {
        async query(text) {
          if (text.startsWith("begin")) {
            transactionVersion = committedVersion;
            transactionStatements.push("begin");
            return { rows: [] };
          }
          if (text === "commit" || text === "rollback") {
            transactionStatements.push(text);
            return { rows: [] };
          }
          const version = transactionVersion;
          if (text.includes("usage_member_day")) {
            // This models another database client committing after the first
            // table read. Later reads must retain the transaction's version.
            committedVersion = 2;
            return {
              rows: [{
                workspace_id: workspaceA,
                user_id: "concurrent-user",
                total_cost_usd: version * 10,
                ai_cost_usd: version,
                agent_metrics_complete: true,
              }],
            };
          }
          if (text.includes("usage_project_day")) return { rows: [] };
          if (text.includes("usage_workspace_day")) {
            return {
              rows: [{
                workspace_id: workspaceA,
                usage_date: dayOne,
                total_cost_usd: version * 10,
                member_attributable_usd: version * 10,
                member_unattributable_usd: 0,
                fetched_at: fetchedAt,
                status: "complete",
              }],
            };
          }
          return {
            rows: [{
              usage_date: dayOne,
              total_cost_usd: version * 10,
              fetched_at: fetchedAt,
            }],
          };
        },
        release() {
          released = true;
        },
      };
    },
    async query() {
      throw new Error("pool query must not be used outside the transaction");
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => Date.parse("2099-07-01T23:59:00.000Z"),
  });
  const snapshot = await store.read({
    window: { start: window.start, end: `${dayTwo}T00:00:00.000Z` },
    workspaceIds: [workspaceA],
  });

  assert.equal(committedVersion, 2);
  assert.equal(snapshot.members.get(workspaceA)?.get("concurrent-user")?.totalCostUsd, 10);
  assert.equal(snapshot.workspaces.get(workspaceA)?.totalCostUsd, 10);
  assert.equal(snapshot.accountTotalUsd, 10);
  assert.deepEqual(transactionStatements, ["begin", "commit"]);
  assert.equal(released, true);
});

test("a warmed snapshot reloads after its bounded cache lifetime", async () => {
  let currentTime = Date.parse("2099-07-01T12:00:00.000Z");
  let committedTotal = 10;
  let queryCount = 0;
  const queryable = {
    async query(text) {
      queryCount++;
      if (text.includes("usage_member_day") || text.includes("usage_project_day")) {
        return { rows: [] };
      }
      if (text.includes("usage_workspace_day")) {
        return {
          rows: [{
            workspace_id: workspaceA,
            usage_date: dayOne,
            total_cost_usd: committedTotal,
            member_attributable_usd: committedTotal,
            member_unattributable_usd: 0,
            fetched_at: fetchedAt,
            status: "complete",
          }],
        };
      }
      return {
        rows: [{
          usage_date: dayOne,
          total_cost_usd: committedTotal,
          fetched_at: fetchedAt,
        }],
      };
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => currentTime,
    cacheMaxAgeMs: 1_000,
  });
  const request = {
    window: { start: window.start, end: `${dayTwo}T00:00:00.000Z` },
    workspaceIds: [workspaceA],
  };
  const first = await store.read(request);
  committedTotal = 25;
  currentTime += 999;
  assert.strictEqual(await store.read(request), first);
  assert.equal(queryCount, 5);

  currentTime += 1;
  const reloaded = await store.read(request);
  assert.notStrictEqual(reloaded, first);
  assert.equal(reloaded.workspaces.get(workspaceA)?.totalCostUsd, 25);
  assert.equal(queryCount, 10);
});

test("snapshot memo evicts least-recently-used scopes at its entry bound", async () => {
  let queryCount = 0;
  const queryable = {
    async query() {
      queryCount++;
      return { rows: [] };
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => Date.parse("2099-07-01T12:00:00.000Z"),
    cacheMaxEntries: 2,
  });
  const requestFor = (workspaceId) => ({
    window: { start: window.start, end: `${dayTwo}T00:00:00.000Z` },
    workspaceIds: [workspaceId],
  });
  await store.read(requestFor("scope-1"));
  await store.read(requestFor("scope-2"));
  // Touch scope-1, making scope-2 the eviction candidate.
  await store.read(requestFor("scope-1"));
  await store.read(requestFor("scope-3"));
  assert.equal(store.memoSize(), 2);
  await store.read(requestFor("scope-2"));
  assert.equal(queryCount, 20);
});

test("workspace-only readiness neither depends on nor reads the account anchor", async () => {
  let accountQueries = 0;
  const queryable = {
    async query(text) {
      if (text.includes("usage_member_day") || text.includes("usage_project_day")) {
        return { rows: [] };
      }
      if (text.includes("usage_workspace_day")) {
        return {
          rows: [{
            workspace_id: workspaceA,
            usage_date: dayOne,
            total_cost_usd: 10,
            member_attributable_usd: 8,
            member_unattributable_usd: 2,
            fetched_at: fetchedAt,
            status: "complete",
          }],
        };
      }
      if (text.includes("ingest_run")) return { rows: [] };
      accountQueries++;
      return { rows: [{ usage_date: dayOne, total_cost_usd: 999, fetched_at: fetchedAt }] };
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => Date.parse("2099-07-01T23:59:00.000Z"),
  });
  const snapshot = await store.read({
    window: { start: window.start, end: `${dayTwo}T00:00:00.000Z` },
    workspaceIds: [workspaceA],
    includeAccountAnchor: false,
  });

  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.workspaceStatus, "complete");
  assert.equal(snapshot.includesAccountAnchor, false);
  assert.equal(snapshot.accountTotalUsd, 0);
  assert.equal(snapshot.accountDays.size, 0);
  assert.deepEqual(snapshot.coverage.missingAccountDays, []);
  assert.equal(accountQueries, 0);
});

test("a success-preserving failed attempt qualifies scoped last-good facts", async () => {
  const failedAt = new Date("2099-07-02T23:56:00.000Z");
  const queryable = {
    async query(text) {
      if (text.includes("usage_member_day") || text.includes("usage_project_day")) {
        return { rows: [] };
      }
      if (text.includes("usage_workspace_day")) {
        return {
          rows: [{
            workspace_id: workspaceA,
            usage_date: dayTwo,
            total_cost_usd: 20,
            member_attributable_usd: 15,
            member_unattributable_usd: 5,
            fetched_at: fetchedAt,
            status: "complete",
          }],
        };
      }
      if (text.includes("ingest_run")) {
        return {
          rows: [{
            attempted_at: failedAt,
            usage_date: dayTwo,
            workspace_id: workspaceA,
          }],
        };
      }
      throw new Error("workspace-only read must not query account facts");
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => Date.parse("2099-07-02T23:59:00.000Z"),
  });
  const snapshot = await store.read({
    window: { start: `${dayTwo}T00:00:00.000Z`, end: window.end },
    workspaceIds: [workspaceA],
    includeAccountAnchor: false,
  });

  assert.equal(snapshot.status, "stale");
  assert.equal(snapshot.workspaceStatus, "stale");
  assert.deepEqual(snapshot.latestFailedAttempts, [{
    workspaceId: workspaceA,
    usageDate: dayTwo,
    attemptedAt: failedAt.toISOString(),
  }]);
  assert.equal(snapshot.workspaces.get(workspaceA)?.totalCostUsd, 20);
});

test("a scoped failed unit remains visible behind more than 100 newer global runs", async () => {
  const marker = `failure-ledger-${runId}`;
  try {
    await pool.query(
      `insert into ingest_run
         (kind,started_at,finished_at,units,calls,failures,error,remaining)
       values
         ('live',$1::timestamptz - interval '1 second',$1::timestamptz,
          1,1,1,$2,0)`,
      [
        "2099-07-02T23:56:00.000Z",
        `failed-units:${dayTwo}|${workspaceA}\n${dayOne}|${marker}`,
      ],
    );
    await pool.query(
      `insert into ingest_run
         (kind,started_at,finished_at,units,calls,failures,error,remaining)
       select 'live',
              $1::timestamptz + n * interval '1 second',
              $1::timestamptz + n * interval '1 second',
              1,1,1,
              'failed-units:${dayTwo}|${workspaceB}\n${dayOne}|${marker}',
              0
       from generate_series(1,101) n`,
      ["2099-07-02T23:57:00.000Z"],
    );
    const store = createUsageStore({
      now: () => Date.parse("2099-07-02T23:59:00.000Z"),
    });
    const snapshot = await store.read({
      window: { start: `${dayTwo}T00:00:00.000Z`, end: window.end },
      workspaceIds: [workspaceA],
      includeAccountAnchor: false,
    });
    assert.deepEqual(snapshot.latestFailedAttempts, [{
      workspaceId: workspaceA,
      usageDate: dayTwo,
      attemptedAt: "2099-07-02T23:56:00.000Z",
    }]);
  } finally {
    await pool.query("delete from ingest_run where error like $1", [`%${marker}%`]);
  }
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
    cacheMaxAgeMs: 10 * 60_000,
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
  assert.equal(queryCount, 5);
});

test("time-derived stale memo becomes complete after its live window closes", async () => {
  let currentTime = Date.parse("2099-07-02T23:57:00.000Z");
  const queryable = {
    async query(text) {
      if (text.includes("usage_member_day") || text.includes("usage_project_day")) {
        return { rows: [] };
      }
      if (text.includes("usage_workspace_day")) {
        return {
          rows: [{
            workspace_id: workspaceA,
            usage_date: dayTwo,
            total_cost_usd: 20,
            member_attributable_usd: 15,
            member_unattributable_usd: 5,
            fetched_at: fetchedAt,
            status: "complete",
          }],
        };
      }
      return {
        rows: [{
          usage_date: dayTwo,
          total_cost_usd: 20,
          fetched_at: fetchedAt,
        }],
      };
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
    "stale",
  );
  currentTime = Date.parse("2099-07-05T00:00:00.000Z");
  assert.equal(
    (await store.read({ window: oneDayWindow, workspaceIds: [workspaceA] })).status,
    "complete",
  );
});

test("live-day freshness ignores old closed-day backfill timestamps", async () => {
  const oldFetch = new Date("2099-06-01T00:00:00.000Z");
  const liveFetch = new Date("2099-07-02T23:58:30.000Z");
  const mixedWindow = {
    start: "2099-06-29T00:00:00.000Z",
    end: "2099-07-03T00:00:00.000Z",
  };
  const mixedDays = ["2099-06-29", "2099-06-30", dayOne, dayTwo];
  const queryable = {
    async query(text) {
      if (text.includes("usage_member_day") || text.includes("usage_project_day")) {
        return { rows: [] };
      }
      if (text.includes("usage_workspace_day")) {
        return {
          rows: mixedDays.map((usageDate, index) => ({
              workspace_id: workspaceA,
              usage_date: usageDate,
              total_cost_usd: 10 + index,
              member_attributable_usd: 15,
              member_unattributable_usd: 5,
              fetched_at: index === 0 ? oldFetch : liveFetch,
              status: "complete",
          })),
        };
      }
      return {
        rows: mixedDays.map((usageDate, index) => ({
          usage_date: usageDate,
          total_cost_usd: 10 + index,
          fetched_at: index === 0 ? oldFetch : liveFetch,
        })),
      };
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => Date.parse("2099-07-02T23:59:00.000Z"),
    staleAfterMs: 60_000,
  });
  const snapshot = await store.read({
    window: mixedWindow,
    workspaceIds: [workspaceA],
  });
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.dataAsOf, liveFetch.toISOString());
});

test("workspace and account full-term totals accept a tie-out within one dollar", async () => {
  const store = createUsageStore({
    now: () => Date.parse("2099-07-02T23:59:00.000Z"),
  });
  const loaded = await store.read({ window, workspaceIds: [workspaceA] });
  const rollup = computeSnapshotUsageRollup({
    snapshot: { ...loaded, accountTotalUsd: 30.75 },
    groups: [{ id: "group", workspaceId: workspaceA, name: "Group" }],
    membersByGroup: new Map([["group", ["user-1"]]]),
    projectInfoByWorkspace: new Map([
      [workspaceA, new Map([["project-1", { creatorId: "user-1" }]])],
    ]),
  });
  assert.ok(Math.abs(rollup.accountReconciliationSpendUsd) <= 1);
});

test("stale and failed workspace rows keep their stored daily totals", async () => {
  const queryable = {
    async query(text) {
      if (text.includes("usage_member_day") || text.includes("usage_project_day")) {
        return { rows: [] };
      }
      if (text.includes("usage_workspace_day")) {
        return {
          rows: [
            {
              workspace_id: workspaceA,
              usage_date: dayOne,
              total_cost_usd: 10,
              member_attributable_usd: 8,
              member_unattributable_usd: 2,
              fetched_at: fetchedAt,
              status: "stale",
            },
            {
              workspace_id: workspaceA,
              usage_date: dayTwo,
              total_cost_usd: 20,
              member_attributable_usd: 15,
              member_unattributable_usd: 5,
              fetched_at: fetchedAt,
              status: "failed",
            },
          ],
        };
      }
      return {
        rows: [
          { usage_date: dayOne, total_cost_usd: 10, fetched_at: fetchedAt },
          { usage_date: dayTwo, total_cost_usd: 20, fetched_at: fetchedAt },
        ],
      };
    },
  };
  const store = createUsageStore({
    queryable,
    now: () => Date.parse("2099-07-02T23:59:00.000Z"),
  });
  const snapshot = await store.read({
    window,
    workspaceIds: [workspaceA],
    includeDailyMembers: true,
  });
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.workspaces.get(workspaceA)?.totalCostUsd, 30);
  assert.equal(snapshot.daily.get(dayOne)?.workspaceTotalUsd, 10);
  assert.equal(snapshot.daily.get(dayTwo)?.workspaceTotalUsd, 20);
  assert.equal(snapshot.dailyWorkspaces?.get(dayOne)?.get(workspaceA)?.totalCostUsd, 10);
  assert.equal(snapshot.dailyWorkspaces?.get(dayTwo)?.get(workspaceA)?.totalCostUsd, 20);
});

test("successful account ingest invalidates the default memo", async () => {
  invalidateUsageSnapshotMemo();
  await readUsageSnapshot({ window, workspaceIds: [workspaceA] });
  const before = await readUsageSnapshot({ window, workspaceIds: [workspaceA] });

  globalThis.fetch = async () =>
    Response.json({ data: { totalCostUsd: 99 } });
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
    globalThis.fetch = async (input) => {
      const requestUrl = new URL(String(input));
      const groupBy = requestUrl.searchParams.get("groupBy");
      return Response.json({
        data: {
          interval: {
            startTime: requestUrl.searchParams.get("startTime"),
            endTime: requestUrl.searchParams.get("endTime"),
          },
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
    };
    const result = await enterprise.withEnterpriseIngestAccess(
      () => ingestWorkspaceDay(ingestWorkspace, ingestDay),
    );
    assert.equal(result.ok, true, result.error);
    const after = await readUsageSnapshot({
      window: ingestWindow,
      workspaceIds: [ingestWorkspace],
    });
    assert.notStrictEqual(after, before);
    assert.equal(after.workspaces.get(ingestWorkspace)?.totalCostUsd, 12);

    globalThis.fetch = async () =>
      new Response("forced refresh failure", { status: 503 });
    const failed = await enterprise.withEnterpriseIngestAccess(
      () => ingestWorkspaceDay(ingestWorkspace, ingestDay),
    );
    assert.equal(failed.ok, false);
    const afterFailure = await readUsageSnapshot({
      window: ingestWindow,
      workspaceIds: [ingestWorkspace],
    });
    // A failed refresh preserves the last successful facts and does not
    // publish a replacement generation when no durable fact changed.
    assert.strictEqual(afterFailure, after);
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