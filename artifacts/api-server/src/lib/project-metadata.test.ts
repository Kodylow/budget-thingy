import { describe, expect, test } from "vitest";
import {
  buildProjectMetadataSnapshot,
  hasCompleteRequiredProjectMetadata,
} from "./project-metadata";

describe("required project metadata qualification", () => {
  test("requires fresh complete metadata for non-Agent project attribution", () => {
    const projects = new Map([["w1", new Map([["p1", {
      totalCostUsd: 10,
      aiCostUsd: 2,
    }]])]]);
    expect(hasCompleteRequiredProjectMetadata(
      { projects },
      { completeWorkspaceIds: new Set() },
    )).toBe(false);
    expect(hasCompleteRequiredProjectMetadata(
      { projects },
      { completeWorkspaceIds: new Set(["w1"]) },
    )).toBe(true);
  });

  test("does not block known member Agent totals for project Agent-only usage", () => {
    expect(hasCompleteRequiredProjectMetadata({
      projects: new Map([["w1", new Map([["p1", {
        totalCostUsd: 5,
        aiCostUsd: 5,
      }]])]]),
    }, { completeWorkspaceIds: new Set() })).toBe(true);
  });

  test("does not require optional titles", () => {
    expect(hasCompleteRequiredProjectMetadata({
      projects: new Map([["w1", new Map([["p1", {
        totalCostUsd: 5,
        aiCostUsd: 0,
      }]])]]),
    }, { completeWorkspaceIds: new Set(["w1"]) })).toBe(true);
  });

  test("new deployment coverage does not invalidate existing creator attribution", () => {
    const now = Date.now();
    const snapshot = buildProjectMetadataSnapshot([{
      workspaceId: "w1",
      projectId: "p1",
      creatorId: "creator",
      title: "Known",
      hasDeployment: null,
      fetchedAt: new Date(now - 1_000),
    }], [{
      workspaceId: "w1",
      status: "success",
      deploymentStatusObserved: false,
      completedAt: new Date(now - 1_000),
      lastSuccessfulAt: new Date(now - 1_000),
    }], now);

    expect(snapshot.completeWorkspaceIds).toEqual(new Set(["w1"]));
    expect(snapshot.deploymentCompleteWorkspaceIds).toEqual(new Set());
    expect(hasCompleteRequiredProjectMetadata({
      projects: new Map([["w1", new Map([["p1", {
        totalCostUsd: 5,
        aiCostUsd: 0,
      }]])]]),
    }, snapshot)).toBe(true);
  });

  test("retains a successful empty catalog observation after it becomes stale", () => {
    const now = Date.now();
    const observedAt = new Date(now - 16 * 60_000);
    const snapshot = buildProjectMetadataSnapshot([], [{
      workspaceId: "empty",
      status: "success",
      deploymentStatusObserved: true,
      completedAt: observedAt,
      lastSuccessfulAt: observedAt,
    }], now);

    expect(snapshot.observedWorkspaceIds).toEqual(new Set(["empty"]));
    expect(snapshot.byWorkspace.get("empty")).toEqual(new Map());
    expect(snapshot.completeWorkspaceIds).toEqual(new Set());
    expect(snapshot.deploymentObservedWorkspaceIds).toEqual(new Set(["empty"]));
    expect(snapshot.deploymentCompleteWorkspaceIds).toEqual(new Set());
  });

  test("keeps legacy enrichment unknown and projects current transferred ownership", () => {
    const observedAt = new Date("2026-09-07T12:00:00.000Z");
    const snapshot = buildProjectMetadataSnapshot([
      {
        workspaceId: "legacy",
        projectId: "old",
        creatorId: null,
        title: "Legacy",
        fetchedAt: observedAt,
      },
      {
        workspaceId: "current",
        projectId: "transferred",
        creatorId: "new-owner",
        title: "Transferred",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        hasDeployment: true,
        deployments: [
          {
            id: "deployment-1",
            url: "https://one.example/",
            privacy: "public",
            status: "success",
            createdAt: null,
            updatedAt: null,
          },
          {
            id: "deployment-2",
            url: null,
            privacy: null,
            status: null,
            createdAt: null,
            updatedAt: null,
          },
        ],
        deploymentsObservedAt: observedAt,
        fetchedAt: observedAt,
      },
    ], [
      {
        workspaceId: "legacy",
        status: "success",
        deploymentStatusObserved: false,
        completedAt: observedAt,
        lastSuccessfulAt: observedAt,
      },
      {
        workspaceId: "current",
        status: "success",
        deploymentStatusObserved: true,
        completedAt: observedAt,
        lastSuccessfulAt: observedAt,
      },
    ], observedAt.getTime() + 1_000);

    expect(snapshot.byWorkspace.get("legacy")?.get("old")).toMatchObject({
      creatorId: null,
      createdAt: null,
      updatedAt: null,
      hasDeployment: null,
      deployments: null,
      deploymentsObservedAt: null,
    });
    expect(snapshot.byWorkspace.get("current")?.get("transferred")).toMatchObject({
      creatorId: "new-owner",
      hasDeployment: true,
      deployments: [{ id: "deployment-1" }, { id: "deployment-2" }],
      deploymentsObservedAt: observedAt.toISOString(),
    });
  });
});