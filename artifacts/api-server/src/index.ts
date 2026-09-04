import app from "./app";
import { logger } from "./lib/logger";
import { hydrateCheckerState } from "./lib/checker";
import { initCache } from "./lib/enterprise";
import { initializeUsageIngestScheduler } from "./lib/ingest";
import { resumeDurableLimitOperations } from "./lib/limit-operations";
import type { Server } from "node:http";

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

let server: Server | null = null;

async function start(): Promise<void> {
  // Authorization-dependent traffic must not race persisted directory hydration.
  await initCache({ revalidateOnStartup: false });
  await resumeDurableLimitOperations();
  server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening after directory hydration");
    void initializeUsageIngestScheduler(hydrateCheckerState());
  });
}

void start().catch((err) => {
  logger.error({ err }, "API startup failed");
  process.exit(1);
});

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down gracefully");
  if (!server) {
    process.exit(0);
  }
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
