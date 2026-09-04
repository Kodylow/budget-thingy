// @ts-nocheck
import { readFile } from "node:fs/promises";
import { test, expect, vi } from "vitest";

import {
  initializeUsageIngestScheduler,
  LocalUsageRateLimiter,
  nextReconciliationMismatchCount,
  reconciliationBounds,
  runBackgroundCycleOperations,
} from "./ingest.ts";
import { ENTERPRISE_USAGE_REQUESTS_PER_MINUTE } from "./enterprise-rate-limit.ts";

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