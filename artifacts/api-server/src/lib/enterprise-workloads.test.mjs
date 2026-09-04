import { test } from "node:test";
import assert from "node:assert/strict";

process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";

const enterprise = await import("./enterprise.ts");

async function waitForQueue() {
  while (enterprise.pendingUsageCount() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("interactive work starts without waiting for an active backfill", async () => {
  enterprise.__resetEnterpriseSchedulerForTests();
  const events = [];
  let releaseBackfill;
  const blocked = new Promise((resolve) => {
    releaseBackfill = resolve;
  });

  enterprise.__enqueueEnterpriseTaskForTests("isolation-backfill", "backfill", async () => {
    events.push("backfill-start");
    await blocked;
    events.push("backfill-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  enterprise.__enqueueEnterpriseTaskForTests("isolation-interactive", "interactive", async () => {
    events.push("interactive");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(events, ["backfill-start", "interactive"]);
  releaseBackfill();
  await waitForQueue();
});

test("live headers update the shared conservative budget", () => {
  enterprise.__resetEnterpriseSchedulerForTests();
  enterprise.__observeEnterpriseRateLimitForTests({
    "X-RateLimit-Limit": "40",
    "X-RateLimit-Remaining": "17",
    "X-RateLimit-Reset": "30",
  });
  const budget = enterprise.__getEnterpriseBudgetForTests();
  assert.equal(budget.limit, 40);
  assert.equal(budget.remaining, 17);
  assert.equal(budget.observed, true);
  assert.ok(budget.resetAt > Date.now());
});

test("the single token bucket admits every workload class without reservations", async () => {
  enterprise.__resetEnterpriseSchedulerForTests({
    limit: 20,
    remaining: 5,
    resetAt: Date.now() + 25,
    observed: true,
  });

  await enterprise.__admitEnterpriseRequestForTests("interactive");
  assert.equal(enterprise.__getEnterpriseBudgetForTests().remaining, 4);

  let scheduledAdmitted = false;
  const scheduled = enterprise.__admitEnterpriseRequestForTests("scheduled").then(() => {
    scheduledAdmitted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scheduledAdmitted, true);
  await scheduled;
});

test("/usage admission stops at 170 requests in one fixed minute", async () => {
  enterprise.__resetEnterpriseSchedulerForTests({
    limit: 1_000,
    remaining: 1_000,
    resetAt: Date.now() + 60_000,
  });
  await Promise.all(Array.from(
    { length: 170 },
    () => enterprise.__admitEnterpriseRequestForTests("scheduled", true),
  ));

  let overflowAdmitted = false;
  const overflow = enterprise
    .__admitEnterpriseRequestForTests("scheduled", true)
    .then(() => {
      overflowAdmitted = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(overflowAdmitted, false);

  enterprise.__resetEnterpriseSchedulerForTests();
  await overflow;
  assert.equal(overflowAdmitted, true);
});

test("429 Retry-After blocks all classes until the stricter reset", async () => {
  enterprise.__resetEnterpriseSchedulerForTests({
    limit: 10,
    remaining: 10,
    resetAt: Date.now() + 10,
  });
  enterprise.__observeEnterpriseRateLimitForTests({ "Retry-After": "0.03" }, 429);
  let admitted = false;
  const request = enterprise.__admitEnterpriseRequestForTests("interactive").then(() => {
    admitted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(admitted, false);
  await request;
  assert.equal(admitted, true);
});

test("an older success cannot shorten a 429 embargo", async () => {
  enterprise.__resetEnterpriseSchedulerForTests({
    limit: 10,
    remaining: 10,
    resetAt: Date.now() + 10,
  });
  enterprise.__observeEnterpriseRateLimitForTests({ "Retry-After": "1" }, 429);
  const embargoReset = enterprise.__getEnterpriseBudgetForTests().resetAt;
  enterprise.__observeEnterpriseRateLimitForTests({
    "X-RateLimit-Limit": "10",
    "X-RateLimit-Remaining": "9",
    "X-RateLimit-Reset": "0.01",
  }, 200);
  assert.equal(enterprise.__getEnterpriseBudgetForTests().resetAt, embargoReset);

  let admitted = false;
  const request = enterprise.__admitEnterpriseRequestForTests("interactive").then(() => {
    admitted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(admitted, false);
  enterprise.__resetEnterpriseSchedulerForTests();
  await request;
});

test("a newer successful header replaces the prior successful reset window", () => {
  enterprise.__resetEnterpriseSchedulerForTests({
    limit: 10,
    remaining: 10,
    resetAt: Date.now() + 10,
    observed: true,
  });
  enterprise.__observeEnterpriseRateLimitForTests({
    "X-RateLimit-Limit": "10",
    "X-RateLimit-Remaining": "8",
    "X-RateLimit-Reset": "2",
  });
  const newerReset = enterprise.__getEnterpriseBudgetForTests().resetAt;
  enterprise.__observeEnterpriseRateLimitForTests({
    "X-RateLimit-Limit": "10",
    "X-RateLimit-Remaining": "9",
    "X-RateLimit-Reset": "0.01",
  });
  const merged = enterprise.__getEnterpriseBudgetForTests();
  assert.ok(merged.resetAt < newerReset);
  assert.equal(merged.remaining, 9);
});

test("paginated requests retry the same cursor after a 429", async () => {
  enterprise.__resetEnterpriseSchedulerForTests();
  const cursors = [];
  let calls = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      cursors.push(url.searchParams.get("cursor"));
      calls += 1;
      if (calls === 1) {
        return new Response("", {
          status: 429,
          headers: {
            "Retry-After": "0",
            "X-RateLimit-Limit": "10",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "0.01",
          },
        });
      }
      return Response.json({
        data: [{ id: "one" }],
        pagination: { hasMore: false, cursor: null },
      }, {
        headers: {
          "X-RateLimit-Limit": "10",
          "X-RateLimit-Remaining": "9",
          "X-RateLimit-Reset": "60",
        },
      });
    };

    const rows = await enterprise.__paginateEnterpriseForTests("/test");
    assert.deepEqual(rows, [{ id: "one" }]);
    assert.deepEqual(cursors, [null, null], "the failed page cursor is retried unchanged");
  } finally {
    globalThis.fetch = originalFetch;
    enterprise.__resetEnterpriseSchedulerForTests();
  }
});

test("scheduled and backfill class caps stay within the reported limit", async () => {
  enterprise.__resetEnterpriseSchedulerForTests({
    limit: 20,
    remaining: 20,
    resetAt: Date.now() + 30,
    observed: true,
  });
  await Promise.all([
    ...Array.from({ length: 5 }, () =>
      enterprise.__admitEnterpriseRequestForTests("backfill")),
    ...Array.from({ length: 11 }, () =>
      enterprise.__admitEnterpriseRequestForTests("scheduled")),
  ]);
  const budget = enterprise.__getEnterpriseBudgetForTests();
  assert.equal(budget.used.backfill, 5);
  assert.equal(budget.used.scheduled, 11);
  assert.ok(budget.used.backfill + budget.used.scheduled <= budget.limit);
});