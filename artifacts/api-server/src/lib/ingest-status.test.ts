import { describe, expect, test } from "vitest";
import { presentUsageIngestRun } from "./ingest-status";

const row = {
  id: 1,
  kind: "backfill",
  started_at: "2026-09-05T00:00:00.000Z",
  finished_at: "2026-09-05T00:01:00.000Z",
  units: 3,
  calls: 8,
  failures: 1,
  error: "failed-units:2026-08-20|workspace-1",
  remaining: 4,
};

describe("operator ingest run presentation", () => {
  test("classifies a mixed run as partial rather than failed", () => {
    expect(presentUsageIngestRun(row)).toMatchObject({
      status: "partial",
      failures: 1,
      remaining: 4,
      error: "failed-units:2026-08-20|workspace-1",
    });
  });

  test("classifies an all-failed run as failed", () => {
    expect(presentUsageIngestRun({ ...row, units: 1 })).toMatchObject({ status: "failed" });
  });

  test("keeps backlog-only and running states distinct", () => {
    expect(presentUsageIngestRun({ ...row, failures: 0, error: null }))
      .toMatchObject({ status: "partial" });
    expect(presentUsageIngestRun({ ...row, finished_at: null }))
      .toMatchObject({ status: "running", finishedAt: null });
  });

  test("a retired failed-unit ledger no longer labels the old run failed", () => {
    expect(presentUsageIngestRun({ ...row, error: null, remaining: 0 }))
      .toMatchObject({ status: "succeeded" });
  });
});