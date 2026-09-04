import { describe, expect, test } from "vitest";
import { BoundedStaleCache } from "./bounded-stale-cache";

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
});