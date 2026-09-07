// @ts-nocheck
import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@workspace/db");
  vi.doUnmock("./lib/full-sync");
  vi.doUnmock("./lib/ingest");
});

async function invoke(args: string[], outcome = "completed") {
  const end = vi.fn(async () => undefined);
  const runFullDataSync = vi.fn(async (options) => {
    options.onProgress?.({ outcome });
    return { outcome };
  });
  const runCycle = vi.fn(async () => ({
    acquired: true, unitsFailed: 0,
  }));
  const ingestImported = vi.fn();
  vi.doMock("@workspace/db", () => ({ pool: { end } }));
  vi.doMock("./lib/full-sync", () => ({ runFullDataSync }));
  vi.doMock("./lib/ingest", () => {
    ingestImported();
    return { runCycle };
  });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.argv = ["node", "ingest-once.ts", ...args];
  process.exitCode = undefined;
  await import("./ingest-once");
  return { end, runFullDataSync, runCycle, ingestImported, stdout, stderr };
}

test.each([
  ["completed", 0],
  ["failed", 1],
  ["lock_not_acquired", 2],
  ["deferred", 3],
])("full data outcome %s maps to exit %i", async (outcome, exitCode) => {
  const invoked = await invoke([], outcome);
  expect(invoked.runFullDataSync).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(exitCode);
  expect(invoked.end).toHaveBeenCalledOnce();
});

test("default mode is full data and does not directly import or run the business cycle", async () => {
  const invoked = await invoke([]);

  expect(invoked.runFullDataSync).toHaveBeenCalledOnce();
  expect(invoked.runCycle).not.toHaveBeenCalled();
  const source = await readFile(new URL("./ingest-once.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/^import\s+\{\s*runCycle\s*\}/m);
});

test("explicit --business-cycle alone dynamically imports and preserves runCycle", async () => {
  const invoked = await invoke(["--business-cycle"]);

  expect(invoked.ingestImported).toHaveBeenCalledOnce();
  expect(invoked.runCycle).toHaveBeenCalledOnce();
  expect(invoked.runFullDataSync).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

test.each([
  ["--unknown"],
  ["--business-cycle", "--full-data"],
  ["--max-minutes=0"],
  ["--max-minutes=-1"],
  ["--max-minutes=NaN"],
  ["--max-minutes=1", "--max-minutes=2"],
])("invalid flags fail closed: %j", async (...args) => {
  const invoked = await invoke(args);

  expect(invoked.runFullDataSync).not.toHaveBeenCalled();
  expect(invoked.runCycle).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(invoked.stderr).toHaveBeenCalled();
});

test("SIGINT is forwarded as an abort signal and produces deferred exit 3", async () => {
  const end = vi.fn(async () => undefined);
  const runFullDataSync = vi.fn(async ({ signal, onProgress }) => {
    process.emit("SIGINT");
    expect(signal.aborted).toBe(true);
    onProgress?.({ outcome: "deferred" });
    return { outcome: "deferred" };
  });
  vi.doMock("@workspace/db", () => ({ pool: { end } }));
  vi.doMock("./lib/full-sync", () => ({ runFullDataSync }));
  vi.doMock("./lib/ingest", () => ({ runCycle: vi.fn() }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.argv = ["node", "ingest-once.ts"];
  process.exitCode = undefined;

  await import("./ingest-once");

  expect(process.exitCode).toBe(3);
  expect(end).toHaveBeenCalledOnce();
});