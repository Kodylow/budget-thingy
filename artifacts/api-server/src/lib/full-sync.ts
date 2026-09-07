import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  getProjectMetadataProgress,
  isConfigured,
  refreshBillingPeriodMetadata,
  refreshProjectMetadataSlice,
  withEnterpriseIngestAccess,
} from "./enterprise";
import { beginRun, fetchTotal, finishRun, refreshMetadata, runQueue } from "./ingest";
import { remainingReconciliationCount, reconcileSlice } from "./ingest-reconcile";
import { saveIngestCursor, selectFullSyncSlice } from "./ingest-selection";
import { beginUsageGenerationUpdate } from "./usage-store";

export type FullSyncOutcome = "running" | "completed" | "lock_not_acquired" | "deferred" | "failed";
export interface FullSyncProgress {
  runId: string;
  outcome: FullSyncOutcome;
  stage: "starting" | "directory" | "billing" | "usage" | "reconciliation" | "metadata" | "done";
  startedAt: string;
  updatedAt: string;
  throughDate: string;
  acquired: boolean;
  slices: number;
  unitsAttempted: number;
  unitsSucceeded: number;
  unitsFailed: number;
  usageCalls: number;
  remainingLiveCount: number | null;
  remainingBackfillCount: number | null;
  remainingReconciliationCount: number | null;
  remainingMetadataCount: number | null;
  reason?: string;
}

/** Data only. Never calls runCycle or its allocation/alert/limit operations.
 * One advisory-lock owner; bounded atomic workers settle before it is released.
 * Facts, failure keys and cursors—not this process's counters—drive resumption.
 */
export function runFullDataSync(options: {
  maxDurationMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: FullSyncProgress) => void;
} = {}): Promise<FullSyncProgress> {
  return withEnterpriseIngestAccess(async () => {
    const started = Date.now();
    const maxDurationMs = options.maxDurationMs ?? 60 * 60_000;
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
      throw new Error("Full sync duration must be a positive finite number");
    }
    const today = new Date(started).toISOString().slice(0, 10);
    // Freeze the target so live rows do not age back into the queue mid-run.
    const liveFreshAfter = new Date(started - 10 * 60_000);
    const progress: FullSyncProgress = {
      runId: randomUUID(), outcome: "running", stage: "starting",
      startedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(),
      throughDate: today, acquired: false, slices: 0,
      unitsAttempted: 0, unitsSucceeded: 0, unitsFailed: 0, usageCalls: 0,
      remainingLiveCount: null, remainingBackfillCount: null,
      remainingReconciliationCount: null, remainingMetadataCount: null,
    };
    const client = await pool.connect();
    let workspaceIds: string[] | undefined;
    const publish = async () => {
      progress.updatedAt = new Date().toISOString();
      if (progress.acquired) {
        await saveIngestCursor("full-sync-status", JSON.stringify(progress));
      }
      options.onProgress?.({ ...progress });
    };
    const scan = async () => {
      if (!workspaceIds) return;
      const [usage, reconciliation, metadata] = await Promise.all([
        selectFullSyncSlice(workspaceIds, today, liveFreshAfter, 1),
        remainingReconciliationCount(workspaceIds, today, true),
        getProjectMetadataProgress(workspaceIds),
      ]);
      progress.remainingLiveCount = usage.remainingLiveCount;
      progress.remainingBackfillCount = usage.remainingBackfillCount;
      progress.remainingReconciliationCount = reconciliation;
      progress.remainingMetadataCount = metadata.remaining;
    };
    const stopReason = () => options.signal?.aborted
      ? "Interrupted; admitted work settled and saved. Rerun to resume."
      : Date.now() - started >= maxDurationMs
        ? "Time budget reached; rerun to resume."
        : undefined;
    try {
      const lock = await client.query(
        "select pg_try_advisory_lock(hashtext('usage-ingest')) as acquired",
      );
      if (!lock.rows[0]?.acquired) {
        progress.outcome = "lock_not_acquired";
        progress.reason = "Another ingest owner is active; no work was performed and remaining counts are unknown.";
        await publish();
        return progress;
      }
      progress.acquired = true;
      await publish();
      const initialStop = stopReason();
      if (initialStop) {
        progress.outcome = "deferred";
        progress.reason = initialStop;
        await publish();
        return progress;
      }
      if (!isConfigured()) throw new Error("Enterprise API is not configured");
      progress.stage = "directory";
      workspaceIds = [...(await refreshMetadata(started, true, true)).workspaces.keys()].sort();
      await scan();
      await publish();
      progress.stage = "billing";
      await refreshBillingPeriodMetadata(true);
      let failureSlices = 0;
      let stalledSlices = 0;
      for (;;) {
        const reason = stopReason();
        if (reason) {
          progress.outcome = "deferred";
          progress.reason = reason;
          break;
        }
        let attempted = 0;
        let succeeded = 0;
        let failed = 0;
        if (progress.remainingLiveCount! + progress.remainingBackfillCount! > 0) {
          progress.stage = "usage";
          const selected = await selectFullSyncSlice(workspaceIds, today, liveFreshAfter, 12);
          const id = await beginRun("backfill");
          const result = await runQueue(selected.units,
            { units: 12, calls: 48, durationMs: 60_000 }, "full-sync");
          // Persist failure keys before reselecting: failed refreshes of existing
          // facts must remain pending even though the last-good rows survived.
          await finishRun(id, result);
          const pending = await selectFullSyncSlice(workspaceIds, today, liveFreshAfter, 1);
          await finishRun(id, { ...result, remaining: pending.remaining });
          ({ attempted, succeeded, failed } = result);
          progress.usageCalls += result.calls;
        } else if (progress.remainingReconciliationCount! > 0) {
          progress.stage = "reconciliation";
          const id = await beginRun("reconcile");
          const commit = beginUsageGenerationUpdate();
          try {
            const result = await reconcileSlice(workspaceIds, today, fetchTotal, true);
            await finishRun(id, result);
            attempted = result.attempted;
            failed = result.failed;
            succeeded = attempted - failed;
            progress.usageCalls += result.calls;
          } catch (error) {
            await finishRun(id, { attempted: 0, calls: 0, failed: 1 },
              "Full sync reconciliation failed; pending work remains retryable");
            throw error;
          } finally {
            commit();
          }
        } else if (progress.remainingMetadataCount! > 0) {
          progress.stage = "metadata";
          const result = await refreshProjectMetadataSlice(workspaceIds, { retryIncomplete: true });
          ({ attempted, succeeded, failed } = result);
        } else {
          // Recheck successful coverage immediately before declaring completion.
          await scan();
          if (progress.remainingLiveCount! + progress.remainingBackfillCount! +
              progress.remainingReconciliationCount! + progress.remainingMetadataCount! > 0) continue;
          progress.stage = "done";
          progress.outcome = "completed";
          break;
        }
        progress.slices++;
        progress.unitsAttempted += attempted;
        progress.unitsSucceeded += succeeded;
        progress.unitsFailed += failed;
        failureSlices = failed > 0 ? failureSlices + 1 : 0;
        stalledSlices = succeeded === 0 ? stalledSlices + 1 : 0;
        await scan();
        await publish();
        if (failureSlices >= 3 || stalledSlices >= 3) {
          progress.outcome = failed > 0 || failureSlices > 0 ? "failed" : "deferred";
          progress.reason = progress.outcome === "failed"
            ? "Provider work failed repeatedly; stopped safely. Resolve the failure and rerun."
            : "No successful progress for three slices; unfinished work remains resumable.";
          break;
        }
      }
      if (progress.outcome !== "completed") await scan();
      await publish();
      return progress;
    } catch (error) {
      progress.outcome = "failed";
      progress.reason = error instanceof Error ? error.message : String(error);
      // Retain the last known counts if storage itself is unavailable.
      await scan().catch(() => undefined);
      await publish();
      return progress;
    } finally {
      try {
        if (progress.acquired) {
          await client.query("select pg_advisory_unlock(hashtext('usage-ingest'))");
        }
      } finally {
        client.release();
      }
    }
  });
}