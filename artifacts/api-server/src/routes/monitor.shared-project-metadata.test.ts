import { describe, expect, test } from "vitest";
import {
  buildProjectMetadataSnapshot,
  PROJECT_METADATA_COMPLETE_MAX_AGE_MS,
} from "./monitor.shared";

const successAt = new Date("2026-09-05T12:00:00.000Z");

describe("project metadata snapshot qualification", () => {
  test("age-qualifies the last successful observation independently of latest failure", () => {
    const state = {
      workspaceId: "w1",
      status: "failed",
      completedAt: new Date("2026-09-05T12:05:00.000Z"),
      lastSuccessfulAt: successAt,
    };
    const fresh = buildProjectMetadataSnapshot([], [state], successAt.getTime() + 1);
    expect(fresh.completeWorkspaceIds.has("w1")).toBe(true);
    expect(fresh.freshnessByWorkspace.get("w1")?.status).toBe("failed");

    const expired = buildProjectMetadataSnapshot(
      [],
      [state],
      successAt.getTime() + PROJECT_METADATA_COMPLETE_MAX_AGE_MS,
    );
    expect(expired.completeWorkspaceIds.has("w1")).toBe(false);
  });

  test("preserves direct metadata edits within the consistent committed snapshot", () => {
    const snapshot = buildProjectMetadataSnapshot([
      {
        workspaceId: "w1",
        projectId: "committed",
        title: "Committed",
        creatorId: "u1",
        fetchedAt: successAt,
      },
      {
        workspaceId: "w1",
        projectId: "edited",
        title: "Direct edit",
        creatorId: "u2",
        fetchedAt: new Date(successAt.getTime() + 1),
      },
    ], [{
      workspaceId: "w1",
      status: "success",
      completedAt: successAt,
      lastSuccessfulAt: successAt,
    }], successAt.getTime());

    expect([...snapshot.byWorkspace.get("w1")!.keys()]).toEqual(["committed", "edited"]);
  });

  test("represents a successful empty listing as complete", () => {
    const snapshot = buildProjectMetadataSnapshot([], [{
      workspaceId: "w1",
      status: "success",
      completedAt: successAt,
      lastSuccessfulAt: successAt,
    }], successAt.getTime());
    expect(snapshot.completeWorkspaceIds.has("w1")).toBe(true);
    expect(snapshot.byWorkspace.get("w1")?.size).toBe(0);
  });
});