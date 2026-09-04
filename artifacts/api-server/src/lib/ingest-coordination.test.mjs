import assert from "node:assert/strict";
import test from "node:test";

import {
  reconciliationBounds,
  waitForLegacyMetadata,
} from "./ingest.ts";

test("current-month reconciliation includes only finalized days", () => {
  assert.deepEqual(
    reconciliationBounds("2026-09-01", "2026-09-04"),
    { effectiveStart: "2026-09-01", effectiveEnd: "2026-09-02" },
  );
  assert.equal(reconciliationBounds("2026-09-01", "2026-09-03"), null);
});

test("closed-month reconciliation bounds remain unchanged", () => {
  assert.deepEqual(
    reconciliationBounds("2026-08-01", "2026-09-04"),
    { effectiveStart: "2026-08-01", effectiveEnd: "2026-09-01" },
  );
  assert.deepEqual(
    reconciliationBounds("2026-05-01", "2026-09-04"),
    { effectiveStart: "2026-05-20", effectiveEnd: "2026-06-01" },
  );
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
  assert.deepEqual(result, {
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
  assert.deepEqual(result, {
    timedOut: false,
    pendingCount: 0,
    waitedMs: 50,
  });
});