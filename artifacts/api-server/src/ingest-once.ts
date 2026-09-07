import { pool } from "@workspace/db";
import { runFullDataSync } from "./lib/full-sync";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "ingest:once [--full-data] [--max-minutes=N]\n" +
      "Data-only, resumable full sync. Default time budget: 60 minutes.\n" +
      "ingest:once --business-cycle\n" +
      "Explicit scheduler cycle: includes alerts, allocation import and limit policies.\n" +
      "Exit codes: 0 completed; 1 failed; 2 lock not acquired; 3 deferred.\n",
    );
  } else if (args.length === 1 && args[0] === "--business-cycle") {
    const { runCycle } = await import("./lib/ingest");
    const summary = await runCycle();
    process.stdout.write(`${JSON.stringify({ mode: "business-cycle", ...summary })}\n`);
    process.exitCode = !summary.acquired ? 2 : summary.unitsFailed > 0 ? 1 : 0;
  } else {
    if (args.some((arg) => arg !== "--full-data" && !/^--max-minutes=\d+(\.\d+)?$/.test(arg)) ||
        args.filter((arg) => arg.startsWith("--max-minutes=")).length > 1) {
      throw new Error("Unsupported arguments. Use --help; business operations require --business-cycle alone.");
    }
    const duration = args.find((arg) => arg.startsWith("--max-minutes="))?.split("=")[1];
    if (duration !== undefined && (!Number.isFinite(Number(duration)) || Number(duration) <= 0)) {
      throw new Error("--max-minutes must be a positive finite number");
    }
    const summary = await runFullDataSync({
      maxDurationMs: duration === undefined ? undefined : Number(duration) * 60_000,
      signal: controller.signal,
      onProgress: (progress) => process.stdout.write(`${JSON.stringify({
        event: "full_data_sync", ...progress,
      })}\n`),
    });
    process.exitCode = summary.outcome === "completed" ? 0
      : summary.outcome === "lock_not_acquired" ? 2
      : summary.outcome === "deferred" ? 3 : 1;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    outcome: "failed",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await pool.end();
}