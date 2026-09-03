import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./dashboard.tsx", import.meta.url), "utf8");

test("dashboard hides healthy synchronization implementation status", () => {
  assert.doesNotMatch(source, /Syncing headline usage/);
  assert.doesNotMatch(source, /Updating project detail in background/);
  assert.doesNotMatch(source, /badge-loading-status/);
  assert.doesNotMatch(source, /badge-project-sync-background/);
  assert.match(source, /badge-project-sync-error/);
});

test("groups and summary request failures retain stale data and offer retry", () => {
  assert.match(source, /placeholderData: \(previousData\) => previousData/g);
  assert.match(source, /dashboard-request-error/);
  assert.match(source, /Showing the last available data/);
  assert.match(source, /Retry requests/);
});

test("usage retry failures are visible instead of becoming unhandled rejections", () => {
  assert.match(source, /setRetrySyncError/);
  assert.match(source, /dashboard-retry-error/);
  assert.match(source, /Could not retry usage synchronization/);
});

test("dashboard renders settled placeholders and provisional totals without loading UI", () => {
  assert.doesNotMatch(source, /Loading\.\.\./);
  assert.doesNotMatch(source, /animate-pulse-glow/);
  assert.doesNotMatch(source, /<LoadingCell/);
  assert.doesNotMatch(source, /stat\.loading/);
  assert.match(source, /groups\.reduce\(\(s, g\) => s \+ g\.rollupMemberCount, 0\)/);
  assert.match(source, /summary\?\.totalSpendUsd \?\? tableTotals\.totalSpendUsd/);
  assert.match(source, /tableTotals\.totalRemainingUsd\.toFixed\(2\)/);
});

test("dashboard uses bounded polling for cold and non-converging responses", () => {
  assert.match(source, /dashboardPollInterval/g);
  assert.match(source, /placeholderData: \(previousData\) => previousData/g);
});