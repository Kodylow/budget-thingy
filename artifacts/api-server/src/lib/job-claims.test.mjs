import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, recurringJobClaimsTable } from "@workspace/db";
import {
  acquireJobClaim,
  releaseJobClaim,
  withJobClaim,
} from "./job-claims.ts";
import { selectRoundRobinUsageItems } from "./enterprise.ts";

test("concurrent replicas elect exactly one recurring job owner", async () => {
  const key = `test:claim:${crypto.randomUUID()}`;
  const attempts = await Promise.all(
    Array.from({ length: 24 }, () => acquireJobClaim(key, 60_000, 10_000)),
  );
  const winners = attempts.filter(Boolean);
  assert.equal(winners.length, 1);
  await releaseJobClaim(winners[0]);
});

test("a live lease cannot overlap and an expired owner is recoverable", async () => {
  const key = `test:recovery:${crypto.randomUUID()}`;
  const first = await acquireJobClaim(key, 60_000, 10_000);
  assert.ok(first);
  assert.equal(await acquireJobClaim(key, 60_000, 10_000), null);

  // Simulate a crashed process whose heartbeat stopped.
  await db.update(recurringJobClaimsTable).set({
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(recurringJobClaimsTable.jobKey, key));
  const recovered = await acquireJobClaim(key, 60_000, 10_000);
  assert.ok(recovered);
  assert.notEqual(recovered.ownerToken, first.ownerToken);
  await releaseJobClaim(recovered);
  assert.equal(
    await acquireJobClaim(key, 60_000, 10_000),
    null,
    "recovery starts a fresh cadence rather than becoming immediately claimable",
  );
});

test("a worker observes ownership loss when another owner recovers its lease", async () => {
  const key = `test:lease-loss:${crypto.randomUUID()}`;
  let activeClaim;
  let observedAbort = false;
  const worker = withJobClaim(key, 60_000, 5_000, async (claim) => {
    activeClaim = claim;
    await new Promise((resolve) => {
      claim.signal.addEventListener("abort", resolve, { once: true });
    });
    observedAbort = claim.signal.aborted;
    claim.signal.throwIfAborted();
  });
  while (!activeClaim) await new Promise((resolve) => setTimeout(resolve, 5));
  await db.update(recurringJobClaimsTable).set({
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(recurringJobClaimsTable.jobKey, key));
  const recovered = await acquireJobClaim(key, 60_000, 10_000);
  assert.ok(recovered);
  await assert.rejects(worker, /Lost recurring job claim/);
  assert.equal(observedAbort, true);
  await releaseJobClaim(recovered);
});

test("persistable round-robin cursor rotates every scope fairly", () => {
  const items = ["d", "b", "a", "c"].map((key) => ({
    key,
    kind: "group_member",
  }));
  const first = selectRoundRobinUsageItems(items, null, 2);
  assert.deepEqual(first.selected.map((item) => item.key), ["a", "b"]);
  const second = selectRoundRobinUsageItems(items, first.cursor, 2);
  assert.deepEqual(second.selected.map((item) => item.key), ["c", "d"]);
  const third = selectRoundRobinUsageItems(items, second.cursor, 2);
  assert.deepEqual(third.selected.map((item) => item.key), ["a", "b"]);
});

test("replica count and ordinary GET traffic cannot multiply scheduling", async () => {
  const key = `test:volume:${crypto.randomUUID()}`;
  let upstreamPasses = 0;
  const replicas = await Promise.all(
    Array.from({ length: 40 }, async () => {
      const claim = await acquireJobClaim(key, 60_000, 10_000);
      if (!claim) return;
      upstreamPasses++;
      await releaseJobClaim(claim);
    }),
  );
  assert.equal(replicas.length, 40);
  assert.equal(upstreamPasses, 1);

  const source = await readFile(
    new URL("../routes/monitor.ts", import.meta.url),
    "utf8",
  );
  let routeMethod = "";
  for (const line of source.split("\n")) {
    const route = line.match(/router\.(get|post|put|delete)\(/);
    if (route) routeMethod = route[1];
    if (routeMethod === "get") {
      assert.doesNotMatch(
        line,
        /\b(queue(?:Account|Member|Project|AllWorkspaces|WsSpend|GroupSpend|ProjectTitles)Fetch|refreshAllGroupSpends)\s*\(/,
        "ordinary GET handlers must remain read-only with respect to ingestion",
      );
    }
  }
});