import { describe, expect, test } from "vitest";
import {
  BoundedTaskScheduler,
  BoundedStaleCache,
  estimateRetainedBytes,
  TaskSchedulerBusyError,
} from "./bounded-stale-cache";

describe("BoundedStaleCache", () => {
  test("deduplicates cold misses and stays bounded", async () => {
    let loads = 0;
    const cache = new BoundedStaleCache<number>({
      maxEntries: 2, freshMs: 100, staleMs: 100,
    });
    const loader = async () => ++loads;
    const [first, second] = await Promise.all([
      cache.getOrLoad("a", loader),
      cache.getOrLoad("a", loader),
    ]);
    expect([first, second]).toEqual([1, 1]);
    expect(loads).toBe(1);
    await cache.getOrLoad("b", loader);
    await cache.getOrLoad("c", loader);
    expect(cache.size).toBe(2);
  });

  test("serves stale success while one refresh runs", async () => {
    let now = 0;
    let loads = 0;
    let release!: () => void;
    const cache = new BoundedStaleCache<number>({
      maxEntries: 2, freshMs: 10, staleMs: 100, now: () => now,
    });
    await cache.getOrLoad("a", async () => ++loads);
    now = 20;
    const loader = async () => {
      loads += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return loads;
    };
    expect(await cache.getOrLoad("a", loader)).toBe(1);
    expect(await cache.getOrLoad("a", loader)).toBe(1);
    expect(loads).toBe(2);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(await cache.getOrLoad("a", loader)).toBe(2);
  });

  test("can retain a same-key stale success during generation publication", async () => {
    let now = 0;
    let loads = 0;
    const cache = new BoundedStaleCache<number>({
      maxEntries: 2, freshMs: 10, staleMs: 100, now: () => now,
    });
    await cache.getOrLoad("a", async () => ++loads);
    now = 20;
    expect(await cache.getOrLoad(
      "a",
      async () => ++loads,
      { refreshStale: false },
    )).toBe(1);
    expect(loads).toBe(1);
  });

  test("can qualify a time-only stale success before background refresh completes", async () => {
    let now = 0;
    let release!: () => void;
    const cache = new BoundedStaleCache<{ stale: boolean }>({
      maxEntries: 2, freshMs: 10, staleMs: 100, now: () => now,
    });
    await cache.getOrLoad("a", async () => ({ stale: false }));
    now = 11;
    expect(await cache.getOrLoad(
      "a",
      async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { stale: false };
      },
      { onStale: (value) => ({ ...value, stale: true }) },
    )).toEqual({ stale: true });
    release();
  });

  test("a failed refresh preserves only the qualified same-key success and retries", async () => {
    let now = 0;
    let loads = 0;
    const cache = new BoundedStaleCache<{ status: string }>({
      maxEntries: 2, freshMs: 10, staleMs: 100, now: () => now,
    });
    const success = Object.freeze({ status: "known-success" });
    expect(await cache.getOrLoad("authorized:g1", async () => {
      loads += 1;
      return success;
    })).toBe(success);
    now = 11;
    expect(await cache.getOrLoad(
      "authorized:g1",
      async () => {
        loads += 1;
        throw new Error("refresh unavailable");
      },
      {
        onRefreshError: (stale) => Object.freeze({
          ...stale,
          status: "known-success-refresh-failed",
        }),
      },
    )).toBe(success);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.status("authorized:g1")).toBe("stale");
    expect(await cache.getOrLoad(
      "authorized:g1",
      async () => new Promise<{ status: string }>(() => {}),
      { refreshStale: false },
    )).toEqual({ status: "known-success-refresh-failed" });
    expect(await cache.getOrLoad("authorized:g2", async () => ({
      status: "different-generation",
    }))).not.toBe(success);
    expect(await cache.getOrLoad("authorized:g1", async () => {
      loads += 1;
      return { status: "refreshed-success" };
    })).toEqual({ status: "known-success-refresh-failed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(3);
    expect(await cache.getOrLoad(
      "authorized:g1",
      async () => ({ status: "wrong" }),
    )).toEqual({ status: "refreshed-success" });
  });

  test("never bridges identity or generation keys during an in-flight load", async () => {
    let release!: () => void;
    const cache = new BoundedStaleCache<string>({
      maxEntries: 4, freshMs: 100, staleMs: 100,
    });
    const oldLoad = cache.getOrLoad("identity-a:generation-1", async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "old-authorized-result";
    });
    const newLoad = cache.getOrLoad(
      "identity-a:generation-2",
      async () => "new-generation-result",
    );
    const otherIdentity = cache.getOrLoad(
      "identity-b:generation-2",
      async () => "other-authorized-result",
    );
    expect(await newLoad).toBe("new-generation-result");
    expect(await otherIdentity).toBe("other-authorized-result");
    release();
    expect(await oldLoad).toBe("old-authorized-result");
    expect(await cache.getOrLoad(
      "identity-a:generation-2",
      async () => "wrong",
    )).toBe("new-generation-result");
  });

  test("reports lookup state without exposing another key's value", async () => {
    let now = 0;
    let release!: () => void;
    const cache = new BoundedStaleCache<number>({
      maxEntries: 2, freshMs: 10, staleMs: 20, now: () => now,
    });
    expect(cache.status("identity-a")).toBe("miss");
    const loading = cache.getOrLoad("identity-a", async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 1;
    });
    expect(cache.status("identity-a")).toBe("in-flight");
    expect(cache.status("identity-b")).toBe("miss");
    release();
    await loading;
    expect(cache.status("identity-a")).toBe("hit");
    now = 15;
    expect(cache.status("identity-a")).toBe("stale");
    now = 31;
    expect(cache.status("identity-a")).toBe("miss");
  });

  test("evicts by retained weight rather than entry count", async () => {
    const cache = new BoundedStaleCache<{ bytes: number; actor: string }>({
      maxEntries: 100,
      maxWeight: 10,
      estimateWeight: (value) =>
        (value as { bytes: number }).bytes,
      freshMs: 100,
      staleMs: 100,
    });
    await cache.getOrLoad("actor-a:g1", async () => ({ bytes: 6, actor: "a" }));
    await cache.getOrLoad("actor-b:g1", async () => ({ bytes: 6, actor: "b" }));
    expect(cache.size).toBe(1);
    expect(cache.weight).toBe(6);
    expect(cache.status("actor-a:g1")).toBe("miss");
    expect(cache.status("actor-b:g1")).toBe("hit");
  });

  test("globally prunes expired generation keys on unrelated lookups", async () => {
    let now = 0;
    const cache = new BoundedStaleCache<number>({
      maxEntries: 100,
      maxWeight: 100,
      estimateWeight: () => 10,
      freshMs: 5,
      staleMs: 5,
      now: () => now,
    });
    await Promise.all(Array.from({ length: 6 }, (_, index) =>
      cache.getOrLoad(`actor-${index}:generation-1`, async () => index)));
    expect(cache.size).toBe(6);
    now = 11;
    expect(cache.status("new-actor:generation-2")).toBe("miss");
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
  });

  test("bounds realistic 111-day snapshots across six isolated actors", async () => {
    const snapshotFor = (actor: string) => ({
      actor,
      dailyMembers: new Map(Array.from({ length: 111 }, (_, day) => [
        `2026-05-${String(day + 1).padStart(3, "0")}`,
        new Map(Array.from({ length: 50 }, (__, member) => [
          `${actor}-member-${member}`,
          { totalCostUsd: day + member, aiCostUsd: member },
        ])),
      ])),
    });
    const sampleWeight = estimateRetainedBytes(snapshotFor("sample"));
    const cache = new BoundedStaleCache<ReturnType<typeof snapshotFor>>({
      maxEntries: 100,
      maxWeight: sampleWeight * 2.2,
      estimateWeight: estimateRetainedBytes,
      freshMs: 30_000,
      staleMs: 120_000,
    });
    const results = await Promise.all(Array.from({ length: 6 }, (_, actor) =>
      cache.getOrLoad(`actor-${actor}:generation-1`, async () =>
        snapshotFor(`actor-${actor}`))));
    expect(results.map((result) => result.actor)).toEqual(
      Array.from({ length: 6 }, (_, actor) => `actor-${actor}`),
    );
    expect(cache.size).toBeLessThanOrEqual(2);
    expect(cache.weight).toBeLessThanOrEqual(sampleWeight * 2.2);
    expect(cache.status("actor-0:generation-1")).toBe("miss");
    expect(cache.status("actor-5:generation-1")).toBe("hit");
  });

  test("bounds queued closures, preserves in-flight entries, and coalesces same keys", async () => {
    const scheduler = new BoundedTaskScheduler(2, 2);
    const cache = new BoundedStaleCache<string>({
      maxEntries: 1,
      freshMs: 100,
      staleMs: 100,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sameKeyStarts = 0;
    const sameKeyResults = Array.from({ length: 20 }, () =>
      cache.getOrLoad("same-actor:g1", () => scheduler.schedule(async () => {
        sameKeyStarts += 1;
        await gate;
        return "same";
      })));
    const distinct = Array.from({ length: 9 }, (_, index) =>
      cache.getOrLoad(`actor-${index}:g1`, () => scheduler.schedule(async () => {
        await gate;
        return `actor-${index}`;
      })));
    const distinctSettled = Promise.allSettled(distinct);
    await Promise.resolve();
    expect(sameKeyStarts).toBe(1);
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.queuedCount).toBe(2);
    expect(cache.status("same-actor:g1")).toBe("in-flight");
    expect(cache.size).toBeGreaterThanOrEqual(4);
    release();
    expect(await Promise.all(sameKeyResults)).toEqual(Array(20).fill("same"));
    const settled = await distinctSettled;
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(6);
    for (const item of settled) {
      if (item.status === "rejected") {
        expect(item.reason).toBeInstanceOf(TaskSchedulerBusyError);
      }
    }
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.queuedCount).toBe(0);
    expect(cache.size).toBeLessThanOrEqual(1);
  });
});