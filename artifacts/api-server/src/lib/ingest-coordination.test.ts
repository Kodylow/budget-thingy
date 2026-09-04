// @ts-nocheck
import { readFile } from "node:fs/promises";
import { test, expect, vi } from "vitest";

import {
  initializeUsageIngestScheduler,
  LocalUsageRateLimiter,
  nextReconciliationMismatchCount,
  reconciliationBounds,
  runBackgroundCycleOperations,
  waitForLegacyMetadata,
} from "./ingest.ts";

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

test("legacy metadata coordination stops at its deadline", async () => {
  let clock = 0;
  const result = await waitForLegacyMetadata({
    timeoutMs: 60_000,
    pollMs: 25,
    pending: () => 7,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
  });
  expect(result).toEqual({
    timedOut: true,
    pendingCount: 7,
    waitedMs: 60_000,
  });
});

test("legacy metadata coordination returns as soon as the queue drains", async () => {
  let clock = 0;
  let pendingCount = 2;
  const result = await waitForLegacyMetadata({
    timeoutMs: 60_000,
    pollMs: 25,
    pending: () => pendingCount,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
      pendingCount--;
    },
  });
  expect(result).toEqual({
    timedOut: false,
    pendingCount: 0,
    waitedMs: 50,
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
  });
  expect(order).toEqual(["thresholds", "drift", "adjustments"]);
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
  })).rejects.toThrow("One or more background cycle operations failed");
  expect(order).toEqual(["thresholds", "drift", "adjustments"]);
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