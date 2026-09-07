import { afterEach, describe, expect, test, vi } from "vitest";
import { apiProjectMetadataStateTable, db } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  getProjectMetadataProgress,
  refreshProjectMetadataSlice,
  validateProviderPage,
} from "./enterprise";

describe("Enterprise provider publication validation", () => {
  test("requires explicit pagination completeness even for an empty page", () => {
    expect(() => validateProviderPage("/workspaces", { data: [] }))
      .toThrow("pagination completeness");
    expect(validateProviderPage("/workspaces", {
      data: [],
      pagination: { hasMore: false },
    }).data).toEqual([]);
  });

  test("validates every row before a page can be published", () => {
    expect(() => validateProviderPage<{ id?: string }>(
      "/projects",
      { data: [{ id: "ok" }, {}], pagination: { hasMore: false } },
      (row) => {
        if (!row.id) throw new Error("missing project id");
      },
    )).toThrow("missing project id");
  });
});

describe("project metadata durable progress", () => {
  const ids = [
    "__metadata_progress_empty__",
    "__metadata_progress_stale__",
    "__metadata_progress_missing__",
    "__metadata_progress_timeout__",
    "__metadata_progress_failed_last_good__",
    "__metadata_progress_deferred__",
  ];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env["REPLIT_ENTERPRISE_API_KEY"];

  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env["REPLIT_ENTERPRISE_API_KEY"];
    else process.env["REPLIT_ENTERPRISE_API_KEY"] = originalKey;
    await db.delete(apiProjectMetadataStateTable)
      .where(inArray(apiProjectMetadataStateTable.workspaceId, ids));
  });

  test("counts successful empty workspaces, stale state, and missing expected workspaces", async () => {
    const now = Date.now();
    await db.insert(apiProjectMetadataStateTable).values([
      {
        workspaceId: ids[0]!,
        status: "success",
         deploymentStatusObserved: true,
        completedAt: new Date(now - 1_000),
        lastSuccessfulAt: new Date(now - 1_000),
      },
      {
        workspaceId: ids[1]!,
        status: "success",
         deploymentStatusObserved: true,
        completedAt: new Date(now - 16 * 60_000),
        lastSuccessfulAt: new Date(now - 16 * 60_000),
      },
      {
        workspaceId: ids[4]!,
        status: "failed",
        completedAt: new Date(now - 500),
        lastSuccessfulAt: new Date(now - 1_000),
      },
      {
        workspaceId: ids[5]!,
        status: "unavailable",
        completedAt: new Date(now - 500),
      },
    ]);

    await expect(getProjectMetadataProgress(
      [ids[0]!, ids[1]!, ids[2]!, ids[2]!, ids[4]!, ids[5]!],
      now,
    )).resolves.toEqual({
      remaining: 4,
      fresh: 1,
      deferred: 1,
      failed: 1,
    });
  });

  test("repeated post-timeout cooldown returns attempted zero but remains incomplete", async () => {
    const now = Date.now();
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    await db.insert(apiProjectMetadataStateTable).values({
      workspaceId: ids[3]!,
      status: "unavailable",
      errorMessage: "Project metadata refresh deferred by slice deadline",
      startedAt: new Date(now - 1_000),
      completedAt: new Date(now - 1_000),
    });
    globalThis.fetch = vi.fn();

    const first = await refreshProjectMetadataSlice([ids[3]!]);
    const second = await refreshProjectMetadataSlice([ids[3]!]);

    expect(first).toMatchObject({ attempted: 0, remaining: 1 });
    expect(second).toMatchObject({ attempted: 0, remaining: 1 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("retryIncomplete bypasses failure cooldown and records real successful coverage", async () => {
    const now = Date.now();
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    await db.insert(apiProjectMetadataStateTable).values({
      workspaceId: ids[3]!,
      status: "failed",
      errorMessage: "timed out",
      startedAt: new Date(now - 1_000),
      completedAt: new Date(now - 1_000),
    });
    globalThis.fetch = async () => Response.json({
      data: [],
      pagination: { hasMore: false },
    });

    await expect(refreshProjectMetadataSlice(
      [ids[3]!],
      { retryIncomplete: true },
    )).resolves.toMatchObject({
      attempted: 1,
      succeeded: 1,
      remaining: 0,
    });
  });
});