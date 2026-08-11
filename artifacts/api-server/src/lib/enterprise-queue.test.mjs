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
let nextSpend = 10;
globalThis.fetch = async () => {
  fetchCount += 1;
  const spend = nextSpend;
  await new Promise((r) => setTimeout(r, 50));
  return {
    ok: true,
    status: 200,
    headers: { get: () => "10" },
    json: async () => ({
      data: {
        interval: {
          startTime: "2026-05-20T00:00:00Z",
          endTime: "2026-08-11T00:00:00Z",
        },
        totalCostUsd: spend,
      },
    }),
  };
};

const { queueGroupSpendFetch, getSpend } = await import("./enterprise.ts");

const group = {
  id: "test-queue-g1",
  workspaceId: "test-queue-w1",
  name: "Test Group",
  type: "custom",
};

test("duplicate-queued callbacks fan out with the fetched (not stale) value", async () => {
  // First fetch populates the cache with spend=10.
  nextSpend = 10;
  await new Promise((resolve) => {
    const r = queueGroupSpendFetch(group, 0, true, () => resolve());
    assert.equal(r, "queued");
  });
  assert.equal(getSpend(group.id)?.spendUsd, 10);
  assert.equal(fetchCount, 1);

  // Fresh cache: no fetch, no callback registration.
  assert.equal(queueGroupSpendFetch(group, 0, false), "fresh_cache");

  // Force a refresh (spend is now 20). While it is in flight/queued, a second
  // caller (e.g. the snapshot job racing /groups) attaches to the same fetch.
  nextSpend = 20;
  const results = [];
  const first = new Promise((resolve) => {
    const r = queueGroupSpendFetch(group, 0, true, (s) => {
      results.push(s.spendUsd);
      resolve();
    });
    assert.equal(r, "queued");
  });
  const second = new Promise((resolve) => {
    const r = queueGroupSpendFetch(group, 0, true, (s) => {
      results.push(s.spendUsd);
      resolve();
    });
    // Identical fetch already queued — callback must still be registered.
    assert.equal(r, "duplicate_queued");
  });

  await Promise.all([first, second]);

  // One fetch served both callers, and both saw the NEW value, never the
  // stale cached 10.
  assert.equal(fetchCount, 2);
  assert.deepEqual(results, [20, 20]);
  assert.equal(getSpend(group.id)?.spendUsd, 20);
});
