import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  db,
} from "@workspace/db";
import type { UsageSnapshot } from "./usage-store";

export const PROJECT_METADATA_COMPLETE_MAX_AGE_MS = 15 * 60_000;

export interface ProjectMetadataSnapshot {
  byWorkspace: Map<
    string,
    Map<string, {
      creatorId: string | null;
      title: string | null;
      hasDeployment: boolean | null;
    }>
  >;
  /** Workspaces with a complete catalog observation, including stale/empty ones. */
  observedWorkspaceIds: Set<string>;
  completeWorkspaceIds: Set<string>;
  /** Workspaces with a complete deployment observation, including stale ones. */
  deploymentObservedWorkspaceIds: Set<string>;
  deploymentCompleteWorkspaceIds: Set<string>;
  freshnessByWorkspace: Map<string, {
    status: string;
    lastAttemptAt: Date;
    lastSuccessfulAt: Date | null;
  }>;
  revision: string;
}

interface ProjectMetadataRow {
  workspaceId: string;
  projectId: string;
  creatorId: string | null;
  title: string | null;
  hasDeployment?: boolean | null;
  fetchedAt: Date;
}

interface ProjectMetadataState {
  workspaceId: string;
  status: string;
  deploymentStatusObserved?: boolean;
  completedAt: Date;
  lastSuccessfulAt: Date | null;
}

export function buildProjectMetadataSnapshot(
  rows: readonly ProjectMetadataRow[],
  states: readonly ProjectMetadataState[],
  now = Date.now(),
): ProjectMetadataSnapshot {
  const successfullyObservedWorkspaces = new Set(states.flatMap((state) =>
    state.lastSuccessfulAt ? [state.workspaceId] : []));
  const byWorkspace = new Map<
    string,
    Map<string, {
      creatorId: string | null;
      title: string | null;
      hasDeployment: boolean | null;
    }>
  >();
  for (const row of rows) {
    if (!successfullyObservedWorkspaces.has(row.workspaceId)) continue;
    const projects = byWorkspace.get(row.workspaceId) ?? new Map();
    projects.set(row.projectId, {
      creatorId: row.creatorId,
      title: row.title,
      hasDeployment: row.hasDeployment ?? null,
    });
    byWorkspace.set(row.workspaceId, projects);
  }
  // A successful empty listing is data, not a missing workspace. Materialize
  // it even after it becomes stale so readers can distinguish empty from
  // never observed while separately consulting freshness.
  for (const workspaceId of successfullyObservedWorkspaces) {
    if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, new Map());
  }
  const completeWorkspaceIds = new Set(states.flatMap((state) => {
    const successfulAt = state.lastSuccessfulAt?.getTime();
    return successfulAt !== undefined &&
        now - successfulAt >= 0 &&
        now - successfulAt < PROJECT_METADATA_COMPLETE_MAX_AGE_MS
      ? [state.workspaceId]
      : [];
  }));
  const deploymentCompleteWorkspaceIds = new Set(states.flatMap((state) =>
    state.deploymentStatusObserved === true &&
        completeWorkspaceIds.has(state.workspaceId)
      ? [state.workspaceId]
      : []));
  const deploymentObservedWorkspaceIds = new Set(states.flatMap((state) =>
    state.deploymentStatusObserved === true && state.lastSuccessfulAt
      ? [state.workspaceId]
      : []));
  return {
    byWorkspace,
    observedWorkspaceIds: successfullyObservedWorkspaces,
    completeWorkspaceIds,
    deploymentObservedWorkspaceIds,
    deploymentCompleteWorkspaceIds,
    freshnessByWorkspace: new Map(states.map((state) => [
      state.workspaceId,
      {
        status: state.status,
        lastAttemptAt: state.completedAt,
        lastSuccessfulAt: state.lastSuccessfulAt,
      },
    ])),
    revision: createHash("sha256").update(JSON.stringify({
      states: states.map((state) => [
        state.workspaceId,
        state.status,
        state.deploymentStatusObserved ?? false,
        state.completedAt.toISOString(),
        state.lastSuccessfulAt?.toISOString() ?? null,
        completeWorkspaceIds.has(state.workspaceId),
      ] as const).sort(([a], [b]) => a.localeCompare(b)),
      rows: rows.map((row) => [
        row.workspaceId,
        row.projectId,
        row.creatorId,
        row.title,
        row.hasDeployment ?? null,
        row.fetchedAt.toISOString(),
      ] as const).sort(([aWorkspace, aProject], [bWorkspace, bProject]) =>
        aWorkspace.localeCompare(bWorkspace) || aProject.localeCompare(bProject)),
    })).digest("hex").slice(0, 24),
  };
}

export async function readProjectMetadata(
  workspaceIds: Iterable<string>,
  now = Date.now(),
): Promise<ProjectMetadataSnapshot> {
  const ids = [...new Set(workspaceIds)].sort();
  if (ids.length === 0) {
    return {
      byWorkspace: new Map(),
      observedWorkspaceIds: new Set(),
      completeWorkspaceIds: new Set(),
      deploymentObservedWorkspaceIds: new Set(),
      deploymentCompleteWorkspaceIds: new Set(),
      freshnessByWorkspace: new Map(),
      revision: "empty",
    };
  }
  const { rows, states } = await db.transaction(async (tx) => ({
    rows: await tx.select().from(apiProjectMetadataTable)
      .where(inArray(apiProjectMetadataTable.workspaceId, ids)),
    states: await tx.select().from(apiProjectMetadataStateTable)
      .where(inArray(apiProjectMetadataStateTable.workspaceId, ids)),
  }), { isolationLevel: "repeatable read", accessMode: "read only" });
  return buildProjectMetadataSnapshot(rows, states, now);
}

export function hasCompleteRequiredProjectMetadata(
  snapshot: Pick<UsageSnapshot, "projects">,
  metadata: Pick<ProjectMetadataSnapshot, "completeWorkspaceIds">,
): boolean {
  for (const [workspaceId, projects] of snapshot.projects) {
    const hasNonAgentProjectSpend = [...projects.values()].some((project) =>
      project.totalCostUsd - project.aiCostUsd > 1e-9);
    if (
      hasNonAgentProjectSpend &&
      !metadata.completeWorkspaceIds.has(workspaceId)
    ) return false;
  }
  return true;
}