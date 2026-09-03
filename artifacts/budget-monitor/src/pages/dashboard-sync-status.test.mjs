import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./dashboard.tsx", import.meta.url), "utf8");

test("dashboard reports headline and project synchronization independently", () => {
  assert.match(source, /Syncing headline usage · \{pendingCount\} remaining/);
  assert.match(source, /Updating project detail in background/);
  assert.doesNotMatch(source, /Syncing project spend.*pendingCount/);
  assert.match(source, /projectPendingCount > 0/);
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