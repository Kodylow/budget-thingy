// @ts-nocheck
import { readFile } from "node:fs/promises";
import { afterEach, test, expect, vi } from "vitest";

import { pool } from "@workspace/db";
import * as enterprise from "./enterprise.ts";
import {
  getUsageSnapshotGeneration,
} from "./usage-store.ts";
import {
  saveIngestCursor,
  selectIngestSlice,
  unitKey,
} from "./ingest-selection.ts";

import {
  initializeUsageIngestScheduler,
  LocalUsageRateLimiter,
  nextReconciliationMismatchCount,
  reconciliationBounds,
  runBackgroundCycleOperations,
  runCycle,
  runQueue,
} from "./ingest.ts";
import { ENTERPRISE_USAGE_REQUESTS_PER_MINUTE } from "./enterprise-rate-limit.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

test("reconciliation requires consecutive mismatches beyond the one-dollar tolerance", () => {
  expect(nextReconciliationMismatchCount(0, 1)).toBe(0);
  expect(nextReconciliationMismatchCount(0, 1.01)).toBe(1);
  expect(nextReconciliationMismatchCount(1, 1.01)).toBe(2);
  expect(nextReconciliationMismatchCount(2, 0.5)).toBe(0);
});

test("local usage limiter never admits more than its cap in a rolling minute", async () => {
  let clock = 0;
  const admittedAt: number[] = [];
  const limiter = new LocalUsageRateLimiter(
    3,
    60_000,
    () => clock,
    async (delayMs) => {
      clock += delayMs;
    },
  );
  for (let index = 0; index < 7; index++) {
    await limiter.acquire();
    admittedAt.push(clock);
  }
  expect(admittedAt).toEqual([0, 0, 0, 60_000, 60_000, 60_000, 120_000]);
});

test("enterprise admission and ingest pacing share the 150 request usage cap", async () => {
  expect(ENTERPRISE_USAGE_REQUESTS_PER_MINUTE).toBe(150);

  let clock = 0;
  const limiter = new LocalUsageRateLimiter(
    undefined,
    60_000,
    () => clock,
    async (delayMs) => {
      clock += delayMs;
    },
  );
  for (let index = 0; index < ENTERPRISE_USAGE_REQUESTS_PER_MINUTE; index++) {
    await limiter.acquire();
  }
  expect(clock).toBe(0);
  await limiter.acquire();
  expect(clock).toBe(60_000);

  const enterpriseSource = await readFile(new URL("./enterprise.ts", import.meta.url), "utf8");
  expect(enterpriseSource).toContain(
    "this.localUsageUsed < ENTERPRISE_USAGE_REQUESTS_PER_MINUTE",
  );
  expect(enterpriseSource).not.toMatch(/\b170\b/);
});

test("current-month reconciliation includes only finalized days", () => {
  expect(reconciliationBounds("2026-09-01", "2026-09-04")).toEqual({
    effectiveStart: "2026-09-01",
    effectiveEnd: "2026-09-02",
  });
  expect(reconciliationBounds("2026-09-01", "2026-09-03")).toBeNull();
});

test("closed-month reconciliation bounds remain unchanged", () => {
  expect(reconciliationBounds("2026-08-01", "2026-09-04")).toEqual({
    effectiveStart: "2026-08-01",
    effectiveEnd: "2026-09-01",
  });
  expect(reconciliationBounds("2026-05-01", "2026-09-04")).toEqual({
    effectiveStart: "2026-05-20",
    effectiveEnd: "2026-06-01",
  });
});

test("post-ingest responsibilities run once in their required order", async () => {
  const order: string[] = [];
  await runBackgroundCycleOperations({
    evaluateThresholds: async () => { order.push("thresholds"); },
    refreshTeamLimitDrift: async () => { order.push("drift"); },
    syncAllocationAdjustments: async () => {
      order.push("adjustments");
      return { ok: true, error: null };
    },
    enforceMemberLimitPolicies: async () => { order.push("member-limits"); },
  });
  expect(order).toEqual(["thresholds", "drift", "adjustments", "member-limits"]);
});

test("post-ingest responsibilities all run before combined failure is reported", async () => {
  const order: string[] = [];
  await expect(runBackgroundCycleOperations({
    evaluateThresholds: async () => {
      order.push("thresholds");
      throw new Error("threshold failure");
    },
    refreshTeamLimitDrift: async () => { order.push("drift"); },
    syncAllocationAdjustments: async () => {
      order.push("adjustments");
      return { ok: false, error: "adjustment failure" };
    },
    enforceMemberLimitPolicies: async () => {
      order.push("member-limits");
      throw new Error("member limit failure");
    },
  })).rejects.toThrow("One or more background cycle operations failed");
  expect(order).toEqual(["thresholds", "drift", "adjustments", "member-limits"]);
});

test("an unavailable allocation source does not fail an otherwise healthy usage cycle", async () => {
  const order: string[] = [];
  await expect(runBackgroundCycleOperations({
    evaluateThresholds: async () => { order.push("thresholds"); },
    refreshTeamLimitDrift: async () => { order.push("drift"); },
    syncAllocationAdjustments: async () => {
      order.push("adjustments");
      return { ok: false, error: "Airtable source is not configured" };
    },
    enforceMemberLimitPolicies: async () => { order.push("member-limits"); },
  })).resolves.toBeUndefined();
  expect(order).toEqual(["thresholds", "drift", "adjustments", "member-limits"]);
});

test("application startup launches only the ingest scheduler", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const schedulerStarts = source.match(
    /\b(?:startChecker|startTeamBudgetSyncJob|initializeUsageIngestScheduler)\s*\(/g,
  ) ?? [];
  expect(schedulerStarts).toEqual(["initializeUsageIngestScheduler("]);
  expect(source).toContain("hydrateCheckerState()");
});

test("a failed startup initializer cannot suppress the sole scheduler", async () => {
  const startScheduler = vi.fn();
  await initializeUsageIngestScheduler(
    Promise.reject(new Error("transient initialization failure")),
    startScheduler,
  );
  expect(startScheduler).toHaveBeenCalledOnce();
});

test("a massive historical candidate set is selected in bounded rotating slices", async () => {
  const stage = `bounded-selection-${crypto.randomUUID()}`;
  const workspaceIds = Array.from({ length: 25 }, (_, index) => `bounded-${index}`);
  try {
    const first = await selectIngestSlice(
      workspaceIds,
      "2098-01-01",
      "2098-04-10",
      stage,
      7,
    );
    expect(first.units).toHaveLength(7);
    expect(first.remaining).toBe(2_600);

    await saveIngestCursor(stage, unitKey(first.units.at(-1)!));
    const second = await selectIngestSlice(
      workspaceIds,
      "2098-01-01",
      "2098-04-10",
      stage,
      7,
    );
    expect(second.units).toHaveLength(7);
    expect(second.remaining).toBe(2_600);
    expect(second.units.map(unitKey)).not.toEqual(first.units.map(unitKey));
    expect(new Set([
      ...first.units.map(unitKey),
      ...second.units.map(unitKey),
    ]).size).toBe(14);
  } finally {
    await pool.query("delete from ingest_cursor where stage=$1", [stage]);
  }
});

test("failed-unit selection rotates retries without admitting missing account days", async () => {
  const stage = `failed-selection-${crypto.randomUUID()}`;
  const workspaceId = `failed-selection-${crypto.randomUUID()}`;
  const dates = Array.from({ length: 6 }, (_, index) =>
    `2098-05-${String(index + 1).padStart(2, "0")}`);
  try {
    for (const usageDate of dates) {
      await pool.query(
        `insert into usage_workspace_day
           (workspace_id,usage_date,total_cost_usd,member_attributable_usd,
            member_unattributable_usd,metrics_json,fetched_at,status,error)
         values ($1,$2::date,0,0,0,'[]'::jsonb,now(),'failed','fixture')`,
        [workspaceId, usageDate],
      );
    }

    const first = await selectIngestSlice(
      [workspaceId],
      dates[0]!,
      dates.at(-1)!,
      stage,
      2,
      true,
    );
    expect(first.remaining).toBe(6);
    expect(first.units).toHaveLength(2);
    expect(first.units.every((unit) => unit.type === "workspace")).toBe(true);

    await saveIngestCursor(stage, unitKey(first.units.at(-1)!));
    const second = await selectIngestSlice(
      [workspaceId],
      dates[0]!,
      dates.at(-1)!,
      stage,
      2,
      true,
    );
    expect(second.units.map(unitKey)).not.toEqual(first.units.map(unitKey));
  } finally {
    await pool.query("delete from ingest_cursor where stage=$1", [stage]);
    await pool.query("delete from usage_workspace_day where workspace_id=$1", [workspaceId]);
  }
});

test("durable run failures retry account gaps and stop after a newer success", async () => {
  const stage = `account-retry-${crypto.randomUUID()}`;
  const usageDate = "2098-06-01";
  let runId: string | undefined;
  try {
    const failedRun = await pool.query(
      `insert into ingest_run
         (kind,started_at,finished_at,units,calls,failures,error,remaining)
       values ('backfill','2098-06-02T00:00:00Z','2098-06-02T00:01:00Z',
               1,3,1,$1,1)
       returning id::text`,
      [`failed-units:${usageDate}|`],
    );
    runId = String(failedRun.rows[0]?.id);

    const pending = await selectIngestSlice([], usageDate, usageDate, stage, 2, true);
    expect(pending.units).toEqual([{ type: "account", usageDate }]);

    await pool.query(
      `insert into usage_account_day(usage_date,total_cost_usd,fetched_at)
       values ($1::date,0,'2098-06-02T00:02:00Z')`,
      [usageDate],
    );
    const recovered = await selectIngestSlice([], usageDate, usageDate, stage, 2, true);
    expect(recovered.units).toEqual([]);
  } finally {
    await pool.query("delete from usage_account_day where usage_date=$1::date", [usageDate]);
    await pool.query("delete from ingest_cursor where stage=$1", [stage]);
    if (runId) await pool.query("delete from ingest_run where id=$1", [runId]);
  }
});

test("lock contention exits before provider access or background side effects", async () => {
  process.env["REPLIT_ENTERPRISE_API_KEY"] = "isolated-test-key";
  const lockClient = await pool.connect();
  const provider = vi.fn(async () => {
    throw new Error("provider must not be called");
  });
  globalThis.fetch = provider;
  const operations = {
    evaluateThresholds: vi.fn(async () => undefined),
    refreshTeamLimitDrift: vi.fn(async () => undefined),
    syncAllocationAdjustments: vi.fn(async () => ({ ok: true, error: null })),
    enforceMemberLimitPolicies: vi.fn(async () => undefined),
  };
  try {
    await lockClient.query("select pg_advisory_lock(hashtext('usage-ingest'))");
    await expect(runCycle(new Date("2026-05-19T00:30:00.000Z"), operations))
      .resolves.toMatchObject({ acquired: false, unitsAttempted: 0, totalCalls: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(Object.values(operations).every((operation) => operation.mock.calls.length === 0))
      .toBe(true);
  } finally {
    await lockClient.query("select pg_advisory_unlock(hashtext('usage-ingest'))");
    lockClient.release();
  }
});

test("large live directories stay bounded and rotate the complete three-day window", async () => {
  process.env["REPLIT_ENTERPRISE_API_KEY"] = "isolated-test-key";
  const runId = crypto.randomUUID();
  const workspaceIds = Array.from({ length: 200 }, (_, index) =>
    `live-bound-${String(index).padStart(3, "0")}-${runId}`);
  const directory = {
    fetchedAt: Date.parse("2026-05-19T00:00:00.000Z"),
    workspaces: new Map(workspaceIds.map((id) => [id, { id, name: id }])),
    groups: [],
    allGroups: [],
    groupMembers: new Map(),
    members: new Map(),
    internalUserIds: new Set(),
    budgets: {},
    account: {},
  };
  vi.spyOn(enterprise, "getDirectoryFreshness").mockReturnValue({
    dataAsOf: null,
    isStale: true,
    isRefreshing: false,
  });
  vi.spyOn(enterprise, "refreshDirectoryForIngest").mockResolvedValue(directory);
  vi.spyOn(enterprise, "assertCompleteRosterDirectory").mockImplementation(() => undefined);
  vi.spyOn(enterprise, "refreshBillingPeriodMetadata").mockResolvedValue(undefined);
  const enrichment = vi.spyOn(enterprise, "refreshProjectMetadataSlice").mockResolvedValue({
    attempted: 0, succeeded: 0, failed: 0, deferred: 0,
  });
  vi.spyOn(LocalUsageRateLimiter.prototype, "acquire").mockResolvedValue(undefined);
  let virtualNow = Date.now() + 120_000;
  vi.spyOn(Date, "now").mockImplementation(() => virtualNow);

  let cycleNumber = 0;
  let providerCallCount = 0;
  const requested = [new Set<string>(), new Set<string>()];
  globalThis.fetch = vi.fn(async (input) => {
    providerCallCount++;
    if (providerCallCount % 100 === 0) virtualNow += 60_000;
    const url = new URL(String(input));
    const usageDate = url.searchParams.get("startTime")!.slice(0, 10);
    const workspaceId = url.searchParams.get("workspaceId") ?? "";
    requested[cycleNumber - 1]!.add(`${usageDate}|${workspaceId}`);
    const groupBy = url.searchParams.get("groupBy");
    return Response.json({
      data: {
        interval: {
          startTime: url.searchParams.get("startTime"),
          endTime: url.searchParams.get("endTime"),
        },
        totalCostUsd: 1,
        attributableTotalCostUsd: 1,
        unattributableTotalCostUsd: 0,
        metrics: [],
        groups: groupBy === "member"
          ? [{ key: { userId: "user" }, totalCostUsd: 1, metrics: [] }]
          : groupBy === "project"
          ? [{ key: { projectId: "project" }, totalCostUsd: 1, metrics: [] }]
          : [],
        pagination: { hasMore: false },
      },
    });
  });
  const operations = {
    evaluateThresholds: vi.fn(async () => undefined),
    refreshTeamLimitDrift: vi.fn(async () => undefined),
    syncAllocationAdjustments: vi.fn(async () => ({ ok: true, error: null })),
    enforceMemberLimitPolicies: vi.fn(async () => undefined),
  };
  const liveRuns: Array<{ remaining: number; units: number; calls: number }> = [];
  const cursors: string[] = [];

  try {
    for (cycleNumber = 1; cycleNumber <= 2; cycleNumber++) {
      const summary = await runCycle(
        new Date("2026-05-19T00:30:00.000Z"),
        operations,
      );
      expect(summary.unitsAttempted).toBeLessThanOrEqual(96);
      expect(summary.totalCalls).toBeLessThanOrEqual(154);
      expect(requested[cycleNumber - 1]!.size).toBeGreaterThan(0);

      const run = await pool.query(
        `select units,calls,remaining from ingest_run
         where kind='live' order by id desc limit 1`,
      );
      liveRuns.push(run.rows[0]);
      expect(run.rows[0]).toMatchObject({
        units: summary.unitsAttempted,
        calls: summary.totalCalls,
      });
      expect(run.rows[0].remaining).toBe(603 - summary.unitsAttempted);
      expect(run.rows[0].remaining).toBeGreaterThan(0);
      const cursor = await pool.query(
        "select cursor from ingest_cursor where stage='live'",
      );
      cursors.push(String(cursor.rows[0]?.cursor));
    }

    expect(cursors[1]).not.toBe(cursors[0]);
    expect([...requested[0]!].some((key) => requested[1]!.has(key))).toBe(false);
    expect(liveRuns.every((run) => run.units <= 96 && run.calls <= 154)).toBe(true);
    expect(Object.values(operations).every((operation) => operation.mock.calls.length === 2))
      .toBe(true);
    expect(enrichment).toHaveBeenCalledTimes(2);
  } finally {
    for (const table of ["usage_member_day", "usage_project_day", "usage_workspace_day"]) {
      await pool.query(`delete from ${table} where workspace_id=any($1::text[])`, [workspaceIds]);
    }
    await pool.query(
      "delete from usage_account_day where usage_date between '2026-05-17'::date and '2026-05-19'::date",
    );
    await pool.query("delete from ingest_cursor where stage='live'");
    await pool.query("delete from ingest_run");
    await pool.query("delete from group_roster_snapshot_days where snapshot_date='2026-05-19'");
  }
}, 30_000);

test.each([
  ["unit", { units: 0, calls: 10, durationMs: 10_000 }],
  ["call", { units: 10, calls: 0, durationMs: 10_000 }],
  ["time", { units: 10, calls: 10, durationMs: 0 }],
])("a zero %s budget admits no queue work", async (_name, budget) => {
  const provider = vi.fn(async () => Response.json({ data: { totalCostUsd: 1 } }));
  globalThis.fetch = provider;
  const result = await runQueue(
    [{ type: "account", usageDate: "2097-01-01" }],
    budget,
    `zero-${_name}`,
  );
  expect(result).toEqual({
    attempted: 0,
    succeeded: 0,
    failed: 0,
    calls: 0,
    deferred: 1,
    failureKeys: [],
  });
  expect(provider).not.toHaveBeenCalled();
});

test("slow admitted work has worker-bounded call overshoot and publishes on settlement", async () => {
  process.env["REPLIT_ENTERPRISE_API_KEY"] = "isolated-test-key";
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const provider = vi.fn(async () => {
    await providerGate;
    return Response.json({ data: { totalCostUsd: 1 } });
  });
  globalThis.fetch = provider;
  const units = Array.from({ length: 10 }, (_, index) => ({
    type: "account" as const,
    usageDate: `2097-02-${String(index + 1).padStart(2, "0")}`,
  }));
  const before = getUsageSnapshotGeneration();
  const queued = runQueue(
    units,
    { units: 10, calls: 1, durationMs: 10_000 },
    `slow-budget-${crypto.randomUUID()}`,
  );
  try {
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(3));
    expect(getUsageSnapshotGeneration()).toBe(before);
    releaseProvider();
    const result = await queued;
    expect(result).toMatchObject({
      attempted: 3,
      succeeded: 3,
      calls: 3,
      deferred: 7,
    });
    expect(result.calls).toBeLessThanOrEqual(3);
    expect(getUsageSnapshotGeneration()).toBe(before + 1);
  } finally {
    releaseProvider();
    await queued.catch(() => undefined);
    await pool.query(
      "delete from usage_account_day where usage_date between '2097-02-01'::date and '2097-02-10'::date",
    );
  }
});

test("atomic pagination and retries settle after the soft call target within the reserved ceiling", async () => {
  process.env["REPLIT_ENTERPRISE_API_KEY"] = "isolated-test-key";
  const runId = crypto.randomUUID();
  const workspaceIds = Array.from({ length: 5 }, (_, index) =>
    `atomic-budget-${index}-${runId}`);
  const providerCalls = new Map<string, number>();
  globalThis.fetch = vi.fn(async (input) => {
    const url = new URL(String(input));
    const workspaceId = url.searchParams.get("workspaceId")!;
    providerCalls.set(workspaceId, (providerCalls.get(workspaceId) ?? 0) + 1);
    const groupBy = url.searchParams.get("groupBy");
    const cursor = url.searchParams.get("cursor");
    if (workspaceId === workspaceIds[0] && groupBy === "project") {
      throw new Error("simulated terminal project failure");
    }
    const failingMember = workspaceId === workspaceIds[0] && groupBy === "member";
    const secondPage = cursor !== null;
    return Response.json({
      data: {
        interval: {
          startTime: url.searchParams.get("startTime"),
          endTime: url.searchParams.get("endTime"),
        },
        totalCostUsd: 1,
        attributableTotalCostUsd: 1,
        unattributableTotalCostUsd: 0,
        metrics: [],
        groups: groupBy === "member"
          ? [{ key: { userId: secondPage ? "user-2" : "user-1" }, totalCostUsd: 1, metrics: [] }]
          : [{ key: { projectId: secondPage ? "project-2" : "project-1" }, totalCostUsd: 1, metrics: [] }],
        pagination: failingMember || secondPage
          ? { hasMore: false }
          : { hasMore: true, nextCursor: "page-2" },
      },
    });
  });
  const before = getUsageSnapshotGeneration();
  try {
    const result = await runQueue(
      workspaceIds.map((workspaceId) => ({
        type: "workspace",
        workspaceId,
        usageDate: "2097-03-01",
      })),
      { units: 5, calls: 4, durationMs: 10_000 },
      `atomic-budget-${runId}`,
    );
    expect(result).toMatchObject({
      attempted: 3,
      succeeded: 2,
      failed: 1,
      calls: 14,
      deferred: 2,
    });
    expect(providerCalls.get(workspaceIds[0]!)).toBe(6);
    expect(result.calls).toBeGreaterThan(4);
    expect(result.calls).toBeLessThanOrEqual(4 + 3 * 1_200);
    expect(getUsageSnapshotGeneration()).toBe(before + 1);
  } finally {
    for (const table of ["usage_member_day", "usage_project_day", "usage_workspace_day"]) {
      await pool.query(`delete from ${table} where workspace_id=any($1::text[])`, [workspaceIds]);
    }
  }
});

test("live usage publishes before slow metadata enrichment and background stages", async () => {
  process.env["REPLIT_ENTERPRISE_API_KEY"] = "isolated-test-key";
  const order: string[] = [];
  let releaseEnrichment!: () => void;
  const enrichmentGate = new Promise<void>((resolve) => {
    releaseEnrichment = resolve;
  });
  const directory = {
    fetchedAt: Date.parse("2026-05-19T00:00:00.000Z"),
    workspaces: new Map(),
    groups: [],
    allGroups: [],
    groupMembers: new Map(),
    members: new Map(),
    internalUserIds: new Set(),
    budgets: {},
    account: {},
  };
  vi.spyOn(enterprise, "getDirectoryFreshness").mockReturnValue({
    dataAsOf: null,
    isStale: true,
    isRefreshing: false,
  });
  vi.spyOn(enterprise, "refreshDirectoryForIngest").mockResolvedValue(directory);
  vi.spyOn(enterprise, "assertCompleteRosterDirectory").mockImplementation(() => undefined);
  vi.spyOn(enterprise, "refreshBillingPeriodMetadata").mockImplementation(async () => {
    order.push("billing");
  });
  vi.spyOn(enterprise, "refreshProjectMetadataSlice").mockImplementation(async () => {
    order.push("enrichment-start");
    await enrichmentGate;
    order.push("enrichment-end");
    return { attempted: 0, succeeded: 0, failed: 0, deferred: 0 };
  });
  globalThis.fetch = vi.fn(async () => {
    order.push("usage");
    return Response.json({ data: { totalCostUsd: 1 } });
  });
  const operations = {
    evaluateThresholds: vi.fn(async () => { order.push("thresholds"); }),
    refreshTeamLimitDrift: vi.fn(async () => { order.push("drift"); }),
    syncAllocationAdjustments: vi.fn(async () => {
      order.push("adjustments");
      return { ok: true, error: null };
    }),
    enforceMemberLimitPolicies: vi.fn(async () => { order.push("member-limits"); }),
  };
  const before = getUsageSnapshotGeneration();
  const publishedAtPostOperations: number[] = [];
  const publishedAtEnrichment: number[] = [];
  operations.evaluateThresholds.mockImplementation(async () => {
    publishedAtPostOperations.push(getUsageSnapshotGeneration());
    order.push("thresholds");
  });
  vi.mocked(enterprise.refreshProjectMetadataSlice).mockImplementation(async () => {
    publishedAtEnrichment.push(getUsageSnapshotGeneration());
    order.push("enrichment-start");
    await enrichmentGate;
    order.push("enrichment-end");
    return { attempted: 0, succeeded: 0, failed: 0, deferred: 0 };
  });
  let cycle: ReturnType<typeof runCycle> | undefined;
  try {
    cycle = runCycle(new Date("2026-05-19T00:30:00.000Z"), operations);
    await vi.waitFor(() => expect(order).toContain("enrichment-start"));
    expect(order.indexOf("usage")).toBeLessThan(order.indexOf("enrichment-start"));
    expect(getUsageSnapshotGeneration()).toBeGreaterThan(before);
    expect(order).not.toContain("enrichment-end");
    expect(publishedAtPostOperations[0]).toBeGreaterThan(before);
    expect(publishedAtEnrichment[0]).toBeGreaterThan(before);

    releaseEnrichment();
    await expect(cycle).resolves.toMatchObject({
      acquired: true,
      unitsAttempted: 3,
      unitsSucceeded: 3,
      totalCalls: 3,
    });
    expect(order).toEqual([
      "usage", "usage", "usage",
      "billing", "thresholds", "drift", "adjustments", "member-limits",
      "enrichment-start", "enrichment-end",
    ]);
  } finally {
    releaseEnrichment();
    await cycle?.catch(() => undefined);
    await pool.query(
      "delete from usage_account_day where usage_date between '2026-05-17'::date and '2026-05-19'::date",
    );
    await pool.query("delete from ingest_run");
  }
});
