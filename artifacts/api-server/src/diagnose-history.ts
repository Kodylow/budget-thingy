import { pool } from "@workspace/db";
import { diagnoseHistoricalSpend } from "./lib/historical-spend-diagnostic";

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: diagnose:history [YYYY-MM-DD]");
  process.stdout.write(`${JSON.stringify(await diagnoseHistoricalSpend(args[0]), null, 2)}\n`);
} catch {
  // Database errors may contain connection details; never print them here.
  process.stderr.write("Historical diagnostic failed. Check date bounds and database/schema availability.\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}