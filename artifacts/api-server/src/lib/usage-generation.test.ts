import { expect, test } from "vitest";
import {
  beginUsageGenerationUpdate,
  getUsageSnapshotGeneration,
  invalidateUsageSnapshotMemo,
} from "./usage-store";

test("publishes one usage generation after a batched ingestion cycle", () => {
  const before = getUsageSnapshotGeneration();
  const publish = beginUsageGenerationUpdate();
  invalidateUsageSnapshotMemo();
  invalidateUsageSnapshotMemo();
  expect(getUsageSnapshotGeneration()).toBe(before);
  publish();
  expect(getUsageSnapshotGeneration()).toBe(before + 1);
  publish();
  expect(getUsageSnapshotGeneration()).toBe(before + 1);
});