import app from "./app";
import { logger } from "./lib/logger";
import { startChecker } from "./lib/checker";
import { initCache } from "./lib/enterprise";

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
  void initCache().then(() => startChecker());
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
