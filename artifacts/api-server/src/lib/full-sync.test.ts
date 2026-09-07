// @ts-nocheck
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    client,
    connect: vi.fn(async () => client),
    withAccess: vi.fn(async (work) => work()),
    configured: vi.fn(() => true),
    refreshMetadata: vi.fn(),
    refreshBilling: vi.fn(),
    metadataProgress: vi.fn(),
    refreshProjectMetadataSlice: vi.fn(),
    selectFullSyncSlice: vi.fn(),
    remainingReconciliationCount: vi.fn(),
    reconcileSlice: vi.fn(),
    beginRun: vi.fn(),
    finishRun: vi.fn(),
    runQueue: vi.fn(),
    fetchTotal: vi.fn(),
    saveIngestCursor: vi.fn(),
    commit: vi.fn(),
  };
});

vi.mock("@workspace/db", () => ({
  pool: { connect: mocks.connect },
}));
vi.mock("./enterprise", () => ({
  withEnterpriseIngestAccess: mocks.withAccess,
  isConfigured: mocks.configured,
  refreshBillingPeriodMetadata: mocks.refreshBilling,
  getProjectMetadataProgress: mocks.metadataProgress,
  refreshProjectMetadataSlice: mocks.refreshProjectMetadataSlice,
}));
vi.mock("./ingest", () => ({
  refreshMetadata: mocks.refreshMetadata,
  beginRun: mocks.beginRun,
  finishRun: mocks.finishRun,
  runQueue: mocks.runQueue,
  fetchTotal: mocks.fetchTotal,
}));
vi.mock("./ingest-selection", () => ({
  selectFullSyncSlice: mocks.selectFullSyncSlice,
  saveIngestCursor: mocks.saveIngestCursor,
}));
vi.mock("./ingest-reconcile", () => ({
  remainingReconciliationCount: mocks.remainingReconciliationCount,
  reconcileSlice: mocks.reconcileSlice,
}));
vi.mock("./usage-store", () => ({
  beginUsageGenerationUpdate: () => mocks.commit,
}));

import { runFullDataSync } from "./full-sync";

const directory = {
  workspaces: new Map([["workspace-1", { id: "workspace-1" }]]),
};
const queueUnit = (id: number) => ({
  type: "workspace",
  workspaceId: `workspace-${id}`,
  usageDate: "2026-05-20",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.query.mockImplementation(async (sql: string) => ({
    rows: [{ acquired: sql.includes("pg_try_advisory_lock") }],
  }));
  mocks.refreshMetadata.mockResolvedValue(directory);
  mocks.refreshBilling.mockResolvedValue(undefined);
  mocks.beginRun.mockResolvedValue("run-1");
  mocks.finishRun.mockResolvedValue(undefined);
  mocks.saveIngestCursor.mockResolvedValue(undefined);
  mocks.remainingReconciliationCount.mockResolvedValue(0);
  mocks.metadataProgress.mockResolvedValue({
    remaining: 0, fresh: 1, deferred: 0, failed: 0,
  });
  mocks.selectFullSyncSlice.mockResolvedValue({
    units: [], remaining: 0, remainingLiveCount: 0, remainingBackfillCount: 0,
  });
});

describe("full data sync orchestration", () => {
  test("drains multiple usage, reconciliation, and metadata slices and persists actual remaining counts", async () => {
    let usage = 25;
    let reconciliation = 2;
    let metadata = 3;
    let queueCall = 0;
    mocks.selectFullSyncSlice.mockImplementation(async (_ids, _today, _fresh, limit) => ({
      units: Array.from({ length: Math.min(limit, usage) }, (_, i) => queueUnit(i)),
      remaining: usage,
      remainingLiveCount: Math.min(2, usage),
      remainingBackfillCount: Math.max(0, usage - 2),
    }));
    mocks.runQueue.mockImplementation(async (units) => {
      queueCall++;
      const failed = queueCall === 1 ? 1 : 0;
      const succeeded = units.length - failed;
      usage -= succeeded;
      return {
        attempted: units.length, succeeded, failed, calls: units.length * 3,
        deferred: 0, failureKeys: failed ? ["2026-05-20|workspace-1"] : [],
      };
    });
    mocks.remainingReconciliationCount.mockImplementation(async () => reconciliation);
    mocks.reconcileSlice.mockImplementation(async () => {
      const attempted = reconciliation;
      reconciliation = 0;
      return { attempted, failed: 0, calls: attempted, deferred: 0 };
    });
    mocks.metadataProgress.mockImplementation(async () => ({
      remaining: metadata, fresh: 3 - metadata, deferred: 0, failed: 0,
    }));
    mocks.refreshProjectMetadataSlice.mockImplementation(async (_ids, options) => {
      expect(options).toEqual({ retryIncomplete: true });
      const attempted = Math.min(2, metadata);
      metadata -= attempted;
      return { attempted, succeeded: attempted, failed: 0, deferred: 0 };
    });

    const result = await runFullDataSync();

    expect(result).toMatchObject({
      outcome: "completed",
      stage: "done",
      remainingLiveCount: 0,
      remainingBackfillCount: 0,
      remainingReconciliationCount: 0,
      remainingMetadataCount: 0,
      unitsFailed: 1,
    });
    expect(mocks.runQueue).toHaveBeenCalledTimes(3);
    expect(mocks.reconcileSlice).toHaveBeenCalledOnce();
    expect(mocks.refreshProjectMetadataSlice).toHaveBeenCalledTimes(2);
    const persisted = mocks.saveIngestCursor.mock.calls
      .filter(([stage]) => stage === "full-sync-status")
      .map(([, value]) => JSON.parse(value));
    expect(persisted.at(-1)).toMatchObject({
      outcome: "completed",
      remainingLiveCount: 0,
      remainingBackfillCount: 0,
      remainingReconciliationCount: 0,
      remainingMetadataCount: 0,
    });
    expect(mocks.remainingReconciliationCount).toHaveBeenCalledWith(
      ["workspace-1"], expect.any(String), true,
    );
  });

  test("lock contention performs no directory, provider, selection, or business work", async () => {
    mocks.client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });

    const result = await runFullDataSync();

    expect(result).toMatchObject({
      outcome: "lock_not_acquired", acquired: false, unitsAttempted: 0,
    });
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.refreshMetadata).not.toHaveBeenCalled();
    expect(mocks.refreshBilling).not.toHaveBeenCalled();
    expect(mocks.selectFullSyncSlice).not.toHaveBeenCalled();
    expect(mocks.runQueue).not.toHaveBeenCalled();
    expect(mocks.reconcileSlice).not.toHaveBeenCalled();
    expect(mocks.refreshProjectMetadataSlice).not.toHaveBeenCalled();
    expect(mocks.saveIngestCursor).not.toHaveBeenCalled();
  });

  test("stops after repeated persistent failures while preserving the real pending count", async () => {
    mocks.selectFullSyncSlice.mockResolvedValue({
      units: [queueUnit(1)], remaining: 1,
      remainingLiveCount: 1, remainingBackfillCount: 0,
    });
    mocks.runQueue.mockResolvedValue({
      attempted: 1, succeeded: 0, failed: 1, calls: 3,
      deferred: 0, failureKeys: ["2026-05-20|workspace-1"],
    });

    const result = await runFullDataSync();

    expect(result).toMatchObject({
      outcome: "failed", slices: 3, unitsSucceeded: 0, unitsFailed: 3,
      remainingLiveCount: 1,
    });
    expect(mocks.runQueue).toHaveBeenCalledTimes(3);
  });

  test("metadata deferred with attempted zero never reports complete", async () => {
    mocks.metadataProgress.mockResolvedValue({
      remaining: 1, fresh: 0, deferred: 1, failed: 0,
    });
    mocks.refreshProjectMetadataSlice.mockResolvedValue({
      attempted: 0, succeeded: 0, failed: 0, deferred: 1,
    });

    const result = await runFullDataSync();

    expect(result).toMatchObject({
      outcome: "deferred", stage: "metadata", slices: 3,
      remainingMetadataCount: 1,
    });
    expect(mocks.refreshProjectMetadataSlice).toHaveBeenCalledTimes(3);
  });

  test("a rerun resumes from durable selection rather than process counters", async () => {
    let remaining = 2;
    let admitted: string[] = [];
    mocks.selectFullSyncSlice.mockImplementation(async (_ids, _today, _fresh, limit) => ({
      units: limit === 1 || remaining === 0
        ? (remaining ? [queueUnit(3 - remaining)] : [])
        : [queueUnit(3 - remaining)],
      remaining,
      remainingLiveCount: remaining,
      remainingBackfillCount: 0,
    }));
    const firstAbort = new AbortController();
    mocks.runQueue.mockImplementation(async (units) => {
      admitted.push(units[0].workspaceId);
      remaining--;
      firstAbort.abort();
      return {
        attempted: 1, succeeded: 1, failed: 0, calls: 3,
        deferred: 0, failureKeys: [],
      };
    });
    const first = await runFullDataSync({ signal: firstAbort.signal });
    expect(first).toMatchObject({ outcome: "deferred", remainingLiveCount: 1 });

    mocks.runQueue.mockImplementation(async (units) => {
      admitted.push(units[0].workspaceId);
      remaining--;
      return {
        attempted: 1, succeeded: 1, failed: 0, calls: 3,
        deferred: 0, failureKeys: [],
      };
    });
    const second = await runFullDataSync();

    expect(second.outcome).toBe("completed");
    expect(admitted).toEqual(["workspace-1", "workspace-2"]);
  });

  test("time budget defers before admitting a slice", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10;
      return now;
    });
    mocks.selectFullSyncSlice.mockResolvedValue({
      units: [queueUnit(1)], remaining: 1,
      remainingLiveCount: 1, remainingBackfillCount: 0,
    });
    try {
      const result = await runFullDataSync({ maxDurationMs: 5 });
      expect(result).toMatchObject({ outcome: "deferred", slices: 0 });
      expect(mocks.runQueue).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("all admitted workers settle and progress is saved before unlock", async () => {
    const events: string[] = [];
    let remaining = 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_try")) return { rows: [{ acquired: true }] };
      events.push("unlock");
      return { rows: [] };
    });
    mocks.selectFullSyncSlice.mockImplementation(async (_ids, _today, _fresh, limit) => ({
      units: remaining && limit > 1 ? [queueUnit(1)] : [],
      remaining,
      remainingLiveCount: remaining,
      remainingBackfillCount: 0,
    }));
    mocks.runQueue.mockImplementation(async () => {
      events.push("worker-start");
      await gate;
      events.push("worker-settled");
      remaining = 0;
      return {
        attempted: 1, succeeded: 1, failed: 0, calls: 3,
        deferred: 0, failureKeys: [],
      };
    });
    mocks.saveIngestCursor.mockImplementation(async () => { events.push("saved"); });

    const running = runFullDataSync();
    await vi.waitFor(() => expect(events).toContain("worker-start"));
    expect(events).not.toContain("unlock");
    release();
    await running;

    expect(events.indexOf("worker-settled")).toBeLessThan(events.indexOf("unlock"));
    expect(events.lastIndexOf("saved")).toBeLessThan(events.indexOf("unlock"));
  });
});