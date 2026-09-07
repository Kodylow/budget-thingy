import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default async function setup() {
  const postgresBin = await findPostgresBin();
  const clusterDir = await mkdtemp(path.join(os.tmpdir(), "api-vitest-pg-"));
  const dataDir = path.join(clusterDir, "data");
  const logFile = path.join(clusterDir, "postgres.log");
  const port = await availablePort();

  try {
    await execFileAsync(path.join(postgresBin, "initdb"), [
      "-D",
      dataDir,
      "-A",
      "trust",
      "-U",
      "postgres",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    await execFileAsync(path.join(postgresBin, "pg_ctl"), [
      "-D",
      dataDir,
      "-l",
      logFile,
      "-o",
      `-F -c listen_addresses=localhost -c unix_socket_directories=${clusterDir} -p ${port}`,
      "-w",
      "start",
    ]);
  } catch (error) {
    const postgresLog = await readFile(logFile, "utf8").catch(() => "");
    await stopPostgres(postgresBin, dataDir);
    await rm(clusterDir, { recursive: true, force: true });
    throw new Error(
      `Unable to start disposable PostgreSQL for API tests${
        postgresLog ? `:\n${postgresLog}` : ""
      }`,
      { cause: error },
    );
  }

  // Always replace any ambient connection. Tests must never migrate or drop
  // objects in a developer's/shared database.
  process.env.DATABASE_URL =
    `postgresql://postgres@127.0.0.1:${port}/postgres`;
  delete process.env.DATABASE_SCHEMA;

  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const schemaPrefix = `vitest_${runId}_`;
  process.env.VITEST_DATABASE_SCHEMA_PREFIX = schemaPrefix;

  return async () => {
    // Never remove a data directory while its postmaster could still be using
    // it. If stopping fails, preserve the directory for safe diagnosis.
    await stopPostgres(postgresBin, dataDir);
    await rm(clusterDir, { recursive: true, force: true });
  };
}

async function findPostgresBin(): Promise<string> {
  const { stdout } = await execFileAsync("sh", [
    "-c",
    "command -v initdb || find /usr/lib/postgresql /nix/store -path '*/bin/initdb' -type f -print -quit 2>/dev/null",
  ]);
  const initdb = stdout.trim().split("\n")[0];
  if (!initdb) {
    throw new Error("initdb is required to run the API integration tests");
  }
  return path.dirname(initdb);
}

async function stopPostgres(postgresBin: string, dataDir: string): Promise<void> {
  try {
    await execFileAsync(path.join(postgresBin, "pg_ctl"), [
      "-D",
      dataDir,
      "status",
    ]);
  } catch {
    return;
  }
  await execFileAsync(path.join(postgresBin, "pg_ctl"), [
    "-D",
    dataDir,
    "-m",
    "fast",
    "-w",
    "stop",
  ]);
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a PostgreSQL test port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  return address.port;
}
