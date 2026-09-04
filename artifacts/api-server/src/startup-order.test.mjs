import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the listening socket precedes cache hydration and Enterprise schedulers", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const listenAt = source.indexOf("app.listen(");
  const initAt = source.indexOf("initCache(", listenAt);
  const coordinatorAt = source.indexOf("startUsageIngestScheduler()", listenAt);

  assert.ok(listenAt >= 0);
  assert.ok(initAt > listenAt);
  assert.ok(coordinatorAt > initAt);
});

test("startup leaves both legacy Enterprise usage producers disabled", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /startDailyFactJob/);
  assert.doesNotMatch(source, /startUsageCoordinator/);
});

test("the scheduled checker has no Enterprise usage queue entry point", async () => {
  const source = await readFile(
    new URL("./lib/checker.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /queue(?:AccountUsage|GroupSpend|MemberUsage|ProjectUsage|WsSpend)Fetch/,
  );
  assert.match(source, /getStoredBudgetEvaluationSnapshot/);
});

test("application start does not push the database schema", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.scripts.prestart, undefined);
  assert.doesNotMatch(pkg.scripts.start, /drizzle|push/i);
});

test("startup cache initialization only names persisted metadata tables", async () => {
  const source = await readFile(
    new URL("./lib/enterprise.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function initCache(");
  const end = source.indexOf("\n}\n\nconst LEGACY_FULL_TERM_KEY", start);
  const initSource = source.slice(start, end);

  assert.doesNotMatch(initSource, /usageSyncChunksTable|usageDailyFactsTable/);
  assert.doesNotMatch(initSource, /apiSpendCacheTable|apiProjectMetadataTable/);
  assert.doesNotMatch(
    initSource,
    /canonicalMonthlyGroupUserRollupsTable|canonicalMonthlyRollupStateTable/,
  );
  assert.match(initSource, /apiDirectoryCacheTable/);
  assert.match(initSource, /apiBillingPeriodCacheTable/);
});