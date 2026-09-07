import { Router, type IRouter, type Response } from "express";
import {
  GetWorkspaceProjectParams,
  GetWorkspaceProjectQueryParams,
  GetWorkspaceProjectResponse,
  ListUserOwnedProjectsParams,
  ListUserOwnedProjectsQueryParams,
  ListUserOwnedProjectsResponse,
} from "@workspace/api-zod";
import { prepareScopedAccounting } from "../services/scoped-accounting";
import { buildSpendTablePayload } from "./monitor.spend-tables";
import { windowFromQuery } from "./monitor.shared";

const router: IRouter = Router();

function invalidQuery(res: Response): void {
  res.status(400).json({ error: "Invalid project intelligence query" });
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