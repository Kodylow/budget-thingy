import { afterEach, expect, test, vi } from "vitest";
import {
  beginUsageGenerationUpdate,
  getUsageSnapshotGeneration,
  invalidateUsageSnapshotMemo,
} from "./usage-store";

afterEach(() => {
  vi.useRealTimers();
});

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

test("expires a process generation so independently committed facts are reloaded", () => {
  const before = getUsageSnapshotGeneration();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 31_000);

  expect(getUsageSnapshotGeneration()).toBe(before + 1);
  expect(getUsageSnapshotGeneration()).toBe(before + 1);
});

test("does not publish a time expiry through an active ingestion generation", () => {
  // Reset the deadline after the preceding fake-clock test.
  invalidateUsageSnapshotMemo();
  const before = getUsageSnapshotGeneration();
  const publish = beginUsageGenerationUpdate();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 31_000);

  expect(getUsageSnapshotGeneration()).toBe(before);
  publish();
  expect(getUsageSnapshotGeneration()).toBe(before + 1);
});