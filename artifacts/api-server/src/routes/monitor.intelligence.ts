import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetWorkspaceProjectParams,
  GetWorkspaceProjectQueryParams,
  GetWorkspaceProjectResponse,
  ListUserOwnedProjectsParams,
  ListUserOwnedProjectsQueryParams,
  ListUserOwnedProjectsResponse,
} from "@workspace/api-zod";
import {
  buildProjectIntelligenceFromResult,
  buildScopedAccounting,
  buildScopedDetailProjectionForGroups,
  prepareScopedAccounting,
} from "../services/scoped-accounting";
import {
  authorizeSpendView,
  buildSpendTablePayload,
} from "./monitor.spend-tables";
import { buildAuthorization } from "../lib/authz";
import { visibleGroupMembers, windowFromQuery } from "./monitor.shared";

const router: IRouter = Router();

function invalidQuery(res: Response): void {
  res.status(400).json({ error: "Invalid project intelligence query" });
}

async function canonicalTeamProjectScope(
  req: Request,
  query: Record<string, unknown>,
  poolId: string,
) {
  if (!authorizeSpendView(req.authz!, "pools")) {
    return { error: 403 as const, message: "The pools view is outside your authorized scope" };
  }
  const prepared = await prepareScopedAccounting(
    req.authz!, query, undefined, req.configurationSnapshot);
  const base = await buildScopedAccounting(
    req.authz!, query, undefined, prepared);
  const teamRow = base.poolRows.find((row) =>
    row.kind === "pool" &&
    row.id.startsWith("pool:team:") &&
    row.id === poolId);
  if (!teamRow) {
    return { error: 404 as const, message: "Budget team report not found" };
  }
  const sourceIds = new Set(teamRow.sourceGroupIds ?? []);
  const groups = base.dir.groups.filter((group) => sourceIds.has(group.id));
  const scopedMembers = visibleGroupMembers(
    prepared.effectiveAuth,
    base.dir.groupMembers,
  );
  const groupUserIds = new Map(groups.map((group) => [
    group.id,
    scopedMembers.get(group.id) ?? [],
  ]));
  const projectionAuthz = buildAuthorization({
    userId: req.authz!.userId,
    roles: ["team_admin"],
    teamNames: [teamRow.name],
    groupIds: groups.map((group) => group.id),
    managedGroupIds: groups.map((group) => group.id),
    userIds: new Set([
      req.authz!.userId,
      ...groups.flatMap((group) => scopedMembers.get(group.id) ?? []),
    ]),
    groupUserIds,
  });
  const workspaceIds = new Set(groups.map((group) => group.workspaceId));
  const selected = await buildScopedDetailProjectionForGroups(
    {
      ...base,
      authz: projectionAuthz,
      usage: {
        ...base.usage,
        authz: projectionAuthz,
        groups,
        workspaceIds,
      },
      scope: {
        ...base.scope,
        workspaceIds: [...workspaceIds].sort(),
        groupIds: groups.map((group) => group.id).sort(),
      },
      accounting: {
        ...base.accounting,
        eligibleSpendUsd: teamRow.spendUsd,
        grossSpendUsd: teamRow.spendUsd,
        internalExcludedUsd: 0,
        unbudgetedUsd: 0,
        unattributedUsd: 0,
        reconciliationUsd: 0,
        agentSpendUsd: teamRow.agentSpendUsd,
        otherServicesUsd: teamRow.otherServicesUsd,
      },
      metadata: {
        ...base.metadata,
        qualifications: base.metadata.qualifications.filter((qualification) =>
          !/Internal Replit usage|reconciliation|unbudgeted|Shared canonical allocation/i
            .test(qualification)),
        coverage: {
          ...base.metadata.coverage,
          missingDays: [...new Set([
            ...base.usage.snapshot.coverage.missingWorkspaceDays
              .filter((item) => workspaceIds.has(item.workspaceId))
              .map((item) => item.usageDate),
            ...base.usage.snapshot.coverage.failedWorkspaceDays
              .filter((item) => workspaceIds.has(item.workspaceId))
              .map((item) => item.usageDate),
          ])].sort(),
          failedWorkspaceDays:
            base.usage.snapshot.coverage.failedWorkspaceDays
              .filter((item) => workspaceIds.has(item.workspaceId))
              .map((item) => `${item.workspaceId}:${item.usageDate}`),
        },
      },
    },
    "projects",
    groups,
  );
  const intelligence = await buildProjectIntelligenceFromResult(
    selected,
    prepared,
    new Date(),
    typeof query["workspaceId"] === "string"
      ? String(query["workspaceId"])
      : undefined,
  );
  const attributedProjectKeys = new Set<string>();
  for (const rollup of base.daily.values()) {
    for (const [key, groupId] of rollup.projectAttribution.projectToGroup) {
      if (sourceIds.has(groupId)) attributedProjectKeys.add(key);
    }
  }
  intelligence.result.projectRows = intelligence.result.projectRows.filter(
    (row) =>
      row.workspaceId !== null &&
      row.projectId !== undefined &&
      attributedProjectKeys.has(`${row.workspaceId}\u0000${row.projectId}`),
  );
  return { projectionAuthz, prepared, intelligence, workspaceIds };
}

router.get(
  "/workspaces/:workspaceId/projects/:projectId",
  async (req, res): Promise<void> => {
    const params = GetWorkspaceProjectParams.safeParse(req.params);
    const query = GetWorkspaceProjectQueryParams.safeParse(req.query);
    if (!params.success || !query.success) {
      invalidQuery(res);
      return;
    }
    try {
      windowFromQuery(query.data);
    } catch {
      res.status(400).json({ error: "Invalid reporting date range" });
      return;
    }
    try {
      const scopedQuery = {
        ...query.data,
        workspaceId: params.data.workspaceId,
      };
      const poolId = (query.data as { poolId?: string }).poolId;
      if (poolId) {
        const team = await canonicalTeamProjectScope(req, scopedQuery, poolId);
        if ("error" in team) {
          res.status(team.error!).json({ error: team.message });
          return;
        }
        if (!team.workspaceIds.has(params.data.workspaceId)) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        const payload = await buildSpendTablePayload(
          team.projectionAuthz,
          "projects",
          { ...scopedQuery, page: 1, pageSize: 100 },
          team.prepared,
          undefined,
          team.intelligence,
        );
        const project = payload.filteredAllRows.find((row) =>
          row.workspaceId === params.data.workspaceId &&
          row.projectId === params.data.projectId);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json(GetWorkspaceProjectResponse.parse({
          scope: payload.scope,
          period: payload.period,
          project,
          metadata: payload.metadata,
          staleEvaluation: payload.staleEvaluation,
        }));
        return;
      }
      const prepared = await prepareScopedAccounting(
        req.authz!, scopedQuery, "projects", req.configurationSnapshot);
      const payload = await buildSpendTablePayload(
        req.authz!,
        "projects",
        { ...scopedQuery, page: 1, pageSize: 100 },
        prepared,
      );
      const project = payload.filteredAllRows.find((row) =>
        row.workspaceId === params.data.workspaceId &&
        row.projectId === params.data.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json(GetWorkspaceProjectResponse.parse({
        scope: payload.scope,
        period: payload.period,
        project,
        metadata: payload.metadata,
        staleEvaluation: payload.staleEvaluation,
      }));
    } catch (error) {
      req.log.error({ err: error }, "project intelligence detail failed");
      res.status(503).json({ error: "Project details unavailable" });
    }
  },
);

router.get("/users/:userId/projects", async (req, res): Promise<void> => {
  const params = ListUserOwnedProjectsParams.safeParse(req.params);
  const query = ListUserOwnedProjectsQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    invalidQuery(res);
    return;
  }
  try {
    windowFromQuery(query.data);
  } catch {
    res.status(400).json({ error: "Invalid reporting date range" });
    return;
  }
  try {
    const poolId = (query.data as { poolId?: string }).poolId;
    if (poolId) {
      const team = await canonicalTeamProjectScope(req, query.data, poolId);
      if ("error" in team) {
        res.status(team.error!).json({ error: team.message });
        return;
      }
      const member = team.intelligence.result.dir.members.get(params.data.userId);
      const visibleIdentity = member !== undefined &&
        team.projectionAuthz.userIds.includes(params.data.userId);
      if (!visibleIdentity || !member) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const projects = await buildSpendTablePayload(
        team.projectionAuthz,
        "projects",
        query.data,
        team.prepared,
        params.data.userId,
        team.intelligence,
      );
      res.json(ListUserOwnedProjectsResponse.parse({
        user: {
          userId: member.userId,
          username: member.username ?? null,
          name: member.name,
          email: member.email ?? null,
        },
        projects,
      }));
      return;
    }
    const prepared = await prepareScopedAccounting(
      req.authz!, query.data, "projects", req.configurationSnapshot);
    const member = prepared.dir.members.get(params.data.userId);
    const visibleWorkspaceIds = new Set([
      ...prepared.effectiveAuth.workspaceIds,
      ...prepared.dir.allGroups
        .filter((group) => prepared.effectiveAuth.groupIds.includes(group.id))
        .map((group) => group.workspaceId),
    ]);
    const identityWorkspaceIds = query.data.workspaceId
      ? new Set(visibleWorkspaceIds.has(query.data.workspaceId)
        ? [query.data.workspaceId] : [])
      : visibleWorkspaceIds;
    const belongsToSelectedWorkspace = !query.data.workspaceId ||
      member?.workspaces.has(query.data.workspaceId) === true;
    const visibleIdentity = belongsToSelectedWorkspace && (
      prepared.effectiveAuth.roles.includes("account") ||
      params.data.userId === prepared.effectiveAuth.userId ||
      (
        prepared.effectiveAuth.userIds.includes(params.data.userId) &&
        member !== undefined &&
        [...member.workspaces.keys()].some((id) => identityWorkspaceIds.has(id))
      )
    );
    if (!visibleIdentity || !member) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const projects = await buildSpendTablePayload(
      req.authz!, "projects", query.data, prepared, params.data.userId);
    res.json(ListUserOwnedProjectsResponse.parse({
      user: {
        userId: member.userId,
        username: member.username ?? null,
        name: member.name,
        email: member.email ?? null,
      },
      projects,
    }));
  } catch (error) {
    req.log.error({ err: error }, "owned project intelligence failed");
    res.status(503).json({ error: "Owned projects unavailable" });
  }
});

export default router;