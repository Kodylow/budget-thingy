import { afterEach, describe, expect, test } from "vitest";
import {
  apiProjectCreatorEvidenceTable,
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  db,
  pool,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  buildHistoricalProjectCreatorEvidence,
  buildProjectMetadataSnapshot,
  hasCompleteRequiredProjectMetadata,
  readProjectMetadata,
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

describe("historical project creator evidence", () => {
  const observed = (
    workspaceId: string,
    projectId: string,
    creatorId: string,
    first: string,
    last = first,
  ) => ({
    workspaceId,
    projectId,
    creatorId,
    provenance: "current_catalog_observation",
    firstObservedAt: new Date(first),
    lastObservedAt: new Date(last),
  });

  test("keeps observations workspace-qualified and does not borrow a transfer destination", () => {
    const evidence = buildHistoricalProjectCreatorEvidence([
      observed("source", "moved", "old-owner", "2026-09-01T00:00:00Z"),
      observed("destination", "moved", "new-owner", "2026-09-02T00:00:00Z"),
    ]);

    expect(evidence.get("source")?.get("moved")?.creatorId).toBe("old-owner");
    expect(evidence.get("destination")?.get("moved")?.creatorId).toBe("new-owner");
    expect(evidence.get("unobserved")?.get("moved")).toBeUndefined();
  });

  test("conflicting creator observations fail closed instead of reassigning past charges", () => {
    const evidence = buildHistoricalProjectCreatorEvidence([
      observed("workspace", "project", "old-owner", "2026-08-01T00:00:00Z"),
      observed("workspace", "project", "new-owner", "2026-09-01T00:00:00Z"),
    ]).get("workspace")?.get("project");

    expect(evidence).toMatchObject({
      creatorId: null,
      provenance: "current_catalog_observation",
      firstObservedAt: new Date("2026-08-01T00:00:00Z").getTime(),
      lastObservedAt: new Date("2026-09-01T00:00:00Z").getTime(),
      observedAt: new Date("2026-09-01T00:00:00Z").getTime(),
    });
  });

  test("snapshot retains removed current projects only in historical evidence", () => {
    const at = new Date("2026-09-01T00:00:00Z");
    const snapshot = buildProjectMetadataSnapshot([], [{
      workspaceId: "workspace",
      status: "success",
      completedAt: at,
      lastSuccessfulAt: at,
    }], at.getTime(), [
      observed("workspace", "removed", "owner", at.toISOString()),
    ]);

    expect(snapshot.byWorkspace.get("workspace")).toEqual(new Map());
    expect(snapshot.attributionByWorkspace
      .get("workspace")?.get("removed")?.creatorId).toBe("owner");
  });

  test("uses a successfully observed current-only creator as an honest candidate", () => {
    const at = new Date("2026-09-01T00:00:00Z");
    const snapshot = buildProjectMetadataSnapshot([{
      workspaceId: "workspace",
      projectId: "current-only",
      creatorId: "current-owner",
      title: "Current",
      fetchedAt: at,
    }], [{
      workspaceId: "workspace",
      status: "success",
      completedAt: at,
      lastSuccessfulAt: at,
    }], at.getTime());

    expect(snapshot.attributionByWorkspace.get("workspace")
      ?.get("current-only")).toEqual({
        creatorId: "current-owner",
        provenance: "current_catalog_observation",
        firstObservedAt: at.getTime(),
        lastObservedAt: at.getTime(),
        observedAt: at.getTime(),
      });
  });

  test("current creator disagreement with retained evidence fails closed", () => {
    const oldAt = new Date("2026-08-01T00:00:00Z");
    const newAt = new Date("2026-09-01T00:00:00Z");
    const snapshot = buildProjectMetadataSnapshot([{
      workspaceId: "workspace",
      projectId: "changed",
      creatorId: "new-owner",
      title: "Changed",
      fetchedAt: newAt,
    }], [{
      workspaceId: "workspace",
      status: "success",
      completedAt: newAt,
      lastSuccessfulAt: newAt,
    }], newAt.getTime(), [
      observed(
        "workspace",
        "changed",
        "old-owner",
        oldAt.toISOString(),
      ),
    ]);

    expect(snapshot.byWorkspace.get("workspace")
      ?.get("changed")?.creatorId).toBe("new-owner");
    expect(snapshot.attributionByWorkspace.get("workspace")
      ?.get("changed")).toMatchObject({
        creatorId: null,
        provenance: "current_catalog_observation",
        firstObservedAt: oldAt.getTime(),
        lastObservedAt: newAt.getTime(),
      });
  });

  test("preserves honest catalog-observation provenance", () => {
    const at = "2026-09-01T00:00:00Z";
    const evidence = buildHistoricalProjectCreatorEvidence([
      observed("workspace", "project", "owner", at),
    ]).get("workspace")?.get("project");

    expect(evidence).toEqual({
      creatorId: "owner",
      provenance: "current_catalog_observation",
      firstObservedAt: new Date(at).getTime(),
      lastObservedAt: new Date(at).getTime(),
      observedAt: new Date(at).getTime(),
    });
  });

  test("rejects unsupported provenance rather than upgrading it to historical proof", () => {
    expect(() => buildHistoricalProjectCreatorEvidence([{
      ...observed("workspace", "project", "owner", "2026-09-01T00:00:00Z"),
      provenance: "unverified-import",
    }])).toThrow("Unsupported project creator evidence provenance");
  });
});

describe("database-backed historical project creator evidence", () => {
  const workspaceIds = [
    "__project_evidence_allowed__",
    "__project_evidence_unauthorized__",
    "__project_evidence_committed__",
  ];

  afterEach(async () => {
    await db.delete(apiProjectMetadataTable)
      .where(inArray(apiProjectMetadataTable.workspaceId, workspaceIds));
    await db.delete(apiProjectCreatorEvidenceTable)
      .where(inArray(apiProjectCreatorEvidenceTable.workspaceId, workspaceIds));
    await db.delete(apiProjectMetadataStateTable)
      .where(inArray(apiProjectMetadataStateTable.workspaceId, workspaceIds));
  });

  test("excludes unrequested workspaces and keeps known evidence when current creator is unknown", async () => {
    const observedAt = new Date("2026-09-03T12:00:00.000Z");
    await db.insert(apiProjectMetadataStateTable).values(workspaceIds.slice(0, 2)
      .map((workspaceId) => ({
        workspaceId,
        status: "success",
        completedAt: observedAt,
        lastSuccessfulAt: observedAt,
      })));
    await db.insert(apiProjectMetadataTable).values([
      {
        workspaceId: workspaceIds[0]!,
        projectId: "known-then-unknown",
        creatorId: null,
        title: "Still current",
        fetchedAt: observedAt,
      },
      {
        workspaceId: workspaceIds[1]!,
        projectId: "secret-project",
        creatorId: "secret-owner",
        title: "Must remain scoped out",
        fetchedAt: observedAt,
      },
    ]);
    await db.insert(apiProjectCreatorEvidenceTable).values([
      {
        workspaceId: workspaceIds[0]!,
        projectId: "known-then-unknown",
        creatorId: "known-owner",
        firstObservedAt: new Date("2026-08-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        workspaceId: workspaceIds[1]!,
        projectId: "secret-project",
        creatorId: "secret-owner",
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
      },
    ]);

    const snapshot = await readProjectMetadata([workspaceIds[0]!], observedAt.getTime());

    expect(snapshot.byWorkspace.get(workspaceIds[0]!)
      ?.get("known-then-unknown")?.creatorId).toBeNull();
    expect(snapshot.attributionByWorkspace.get(workspaceIds[0]!)
      ?.get("known-then-unknown")?.creatorId).toBe("known-owner");
    expect(snapshot.byWorkspace.has(workspaceIds[1]!)).toBe(false);
    expect(snapshot.attributionByWorkspace.has(workspaceIds[1]!)).toBe(false);
    expect(snapshot.freshnessByWorkspace.has(workspaceIds[1]!)).toBe(false);
  });

  test("observes another client's commit and changes revision while conflicts fail closed", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(
        `INSERT INTO api_project_creator_evidence
          (workspace_id, project_id, creator_id, first_observed_at, last_observed_at)
         VALUES ($1, 'project', 'old-owner', '2026-08-01', '2026-08-01')`,
        [workspaceIds[2]!],
      );
      await first.query("COMMIT");

      const before = await readProjectMetadata([workspaceIds[2]!]);
      expect(before.attributionByWorkspace.get(workspaceIds[2]!)
        ?.get("project")?.creatorId).toBe("old-owner");

      await second.query("BEGIN");
      await second.query(
        `INSERT INTO api_project_creator_evidence
          (workspace_id, project_id, creator_id, first_observed_at, last_observed_at)
         VALUES ($1, 'project', 'new-owner', '2026-09-01', '2026-09-01')`,
        [workspaceIds[2]!],
      );
      await second.query("COMMIT");

      const after = await readProjectMetadata([workspaceIds[2]!]);
      expect(after.revision).not.toBe(before.revision);
      expect(after.attributionByWorkspace.get(workspaceIds[2]!)
        ?.get("project")).toMatchObject({
          creatorId: null,
          provenance: "current_catalog_observation",
          firstObservedAt: new Date("2026-08-01T00:00:00.000Z").getTime(),
          lastObservedAt: new Date("2026-09-01T00:00:00.000Z").getTime(),
          observedAt: new Date("2026-09-01T00:00:00.000Z").getTime(),
        });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });
});