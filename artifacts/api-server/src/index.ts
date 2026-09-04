import app from "./app";
import { logger } from "./lib/logger";
import { hydrateCheckerState } from "./lib/checker";
import { initCache } from "./lib/enterprise";
import { initializeUsageIngestScheduler } from "./lib/ingest";
import { applyAnnualTeamBudgetBackfill } from "@workspace/db/seed-teams";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // None of these tasks may delay the listening socket. In particular, cache
  // hydration is database-only and completes before Enterprise work is started.
  void initializeUsageIngestScheduler(Promise.all([
    initCache({ revalidateOnStartup: false }),
    applyAnnualTeamBudgetBackfill(),
    hydrateCheckerState(),
  ]));
});

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down gracefully");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  // Force-exit if draining takes too long (e.g. long-running SSE / checker)
  setTimeout(() => {
    logger.warn("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
