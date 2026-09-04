import { pool } from "@workspace/db";
import { runCycle } from "./lib/ingest";

try {
  const summary = await runCycle();
  process.stdout.write(`${JSON.stringify({
    unitsAttempted: summary.unitsAttempted,
    unitsSucceeded: summary.unitsSucceeded,
    unitsFailed: summary.unitsFailed,
    totalCalls: summary.totalCalls,
    durationMs: summary.durationMs,
    reconciliationDeltas: summary.reconciliations,
    remainingBackfillCount: summary.remainingBackfillCount,
    peakRequestsPerMinute: summary.peakRequestsPerMinute,
    lowestRateLimitRemaining: summary.lowestRateLimitRemaining,
  }, null, 2)}\n`);
  process.exitCode = summary.unitsFailed === 0 ? 0 : 1;
} finally {
  await pool.end();
}