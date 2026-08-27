/**
 * Focused test for the /usage queue callback semantics used by the daily
 * snapshot job: a duplicate-queued request must still get the freshly fetched
 * value (never a stale cached one), via callback fan-out.
 *
 * Run via `pnpm --filter @workspace/api-server test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";

// Mock the Enterprise API before importing the module under test.
let fetchCount = 0;
let pendingSpend = 10;
let failAtFetch = null;
const requestedStarts = [];
globalThis.fetch = async (input) => {
  fetchCount += 1;
  if (fetchCount === failAtFetch) throw new Error("simulated incremental failure");
  // Incremental synchronization splits the initial history into one stable
  // chunk plus recent UTC-day chunks. Attribute this fixture's change to only
  // one chunk so the aggregate remains deterministic.
  const spend = pendingSpend ?? 0;
  pendingSpend = null;
  await new Promise((r) => setTimeout(r, 50));
  const url = new URL(String(input));
  requestedStarts.push(url.searchParams.get("startTime"));
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
        totalCostUsd: spend,
      },
    }),
  };
};

const {
  queueGroupSpendFetch,
  getSpend,
  pendingUsageCount,
  initCache,
  resolveRange,
  __setBillingPeriodForTests,
  __resetDurableUsageCachesForTests,
} = await import("./enterprise.ts");

const group = {
  id: `test-queue-${crypto.randomUUID()}`,
  workspaceId: "test-queue-w1",
  name: "Test Group",
  type: "custom",
};
const queueRange = {
  key: `custom:queue-${crypto.randomUUID()}`,
  label: "Queue callback test",
  params: {
    startTime: "2026-05-20T00:00:00.000Z",
    endTime: new Date().toISOString(),
  },
};

test("duplicate-queued callbacks fan out with the fetched (not stale) value", async () => {
  // First fetch populates the cache with spend=10.
  pendingSpend = 10;
  await new Promise((resolve) => {
    const r = queueGroupSpendFetch(group, 0, true, () => resolve(), queueRange);
    assert.equal(r, "queued");
  });
  assert.equal(getSpend(group.id, queueRange.key)?.spendUsd, 10);
  const bootstrapFetchCount = fetchCount;
  assert.ok(bootstrapFetchCount >= 1);
  assert.equal(requestedStarts[0], "2026-05-20T00:00:00.000Z");

  // Simulate a server restart: in-memory state disappears, then initCache
  // immediately reconstructs the same complete aggregate from PostgreSQL.
  __resetDurableUsageCachesForTests();
  assert.equal(getSpend(group.id, queueRange.key), undefined);
  await initCache();
  assert.equal(getSpend(group.id, queueRange.key)?.spendUsd, 10);

  // Fresh cache: no fetch, no callback registration.
  assert.equal(queueGroupSpendFetch(group, 0, false, undefined, queueRange), "fresh_cache");

  // A failure after one incremental chunk must not publish that partial chunk
  // or advance the durable watermark.
  pendingSpend = 20;
  failAtFetch = fetchCount + 2;
  queueGroupSpendFetch(group, 0, true, undefined, queueRange);
  while (pendingUsageCount() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  failAtFetch = null;
  assert.equal(getSpend(group.id, queueRange.key)?.spendUsd, 10);

  // Force a successful refresh. While it is in flight/queued, a second
  // caller (e.g. the snapshot job racing /groups) attaches to the same fetch.
  pendingSpend = 20;
  const results = [];
  const first = new Promise((resolve) => {
    const r = queueGroupSpendFetch(group, 0, true, (s) => {
      results.push(s.spendUsd);
      resolve();
    }, queueRange);
    assert.equal(r, "queued");
  });
  const second = new Promise((resolve) => {
    const r = queueGroupSpendFetch(group, 0, true, (s) => {
      results.push(s.spendUsd);
      resolve();
    }, queueRange);
    // Identical fetch already queued — callback must still be registered.
    assert.equal(r, "duplicate_queued");
  });

  await Promise.all([first, second]);

  // One incremental synchronization served both callers, and both saw the
  // newly committed aggregate, never the stale cached 10.
  assert.ok(fetchCount > bootstrapFetchCount);
  const incrementalStarts = requestedStarts.slice(bootstrapFetchCount);
  assert.ok(
    incrementalStarts.every((start) => start !== "2026-05-20T00:00:00.000Z"),
    "refreshes must reconcile only recent chunks, not restart at the cutoff",
  );
  assert.deepEqual(results, [30, 30]);
  assert.equal(getSpend(group.id, queueRange.key)?.spendUsd, 30);
});

test("daily snapshot lookup uses the same active billing key as its prewarmed fetch", async () => {
  __setBillingPeriodForTests({
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-09-01T00:00:00.000Z",
    fetchedAt: Date.now(),
  });
  const billingRange = resolveRange("billing");
  const snapshotGroup = {
    ...group,
    id: `test-snapshot-${crypto.randomUUID()}`,
  };
  pendingSpend = 7;
  await new Promise((resolve) => {
    const result = queueGroupSpendFetch(
      snapshotGroup,
      1,
      true,
      () => resolve(),
      billingRange,
    );
    assert.equal(result, "queued");
  });
  assert.equal(getSpend(snapshotGroup.id, "billing:from-cutoff"), undefined);
  assert.equal(getSpend(snapshotGroup.id, billingRange.key)?.spendUsd, 7);
  __setBillingPeriodForTests(null);
});
