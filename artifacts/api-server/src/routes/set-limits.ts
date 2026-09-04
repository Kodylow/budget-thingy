import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  CommitLimitOperationBody,
  CommitLimitOperationParams,
  CommitLimitOperationResponse,
  GetLimitOperationParams,
  GetLimitOperationResponse,
  GetSetLimitsWorkspaceParams,
  GetSetLimitsWorkspaceResponse,
  PrepareLimitOperationBody,
  PrepareLimitOperationResponse,
  RetryLimitOperationTargetsBody,
  RetryLimitOperationTargetsParams,
  RetryLimitOperationTargetsResponse,
} from "@workspace/api-zod";
import {
  getLimitOperation,
  LimitOperationError,
  prepareLimitOperation,
  retryLimitTargets,
  commitLimitOperation,
} from "../lib/limit-operations";
import {
  getBillingPeriod,
  getCachedDirectory,
  hasSuccessfulLimitObservation,
} from "../lib/enterprise";
import { readUsageSnapshot } from "../lib/usage-store";
import { resolveUsageWindow } from "../lib/usage-window";
import { isReplitBudgetWriteConfigured } from "../lib/replit-budgets";

const router: IRouter = Router();

function sendError(req: Request, res: Response, error: unknown): void {
  const status = error instanceof LimitOperationError ? error.status : 500;
  if (status >= 500) req.log.error({ err: error }, "Set Limits request failed");
  res.status(status).json({
    error: error instanceof Error ? error.message : "Set Limits request failed",
  });
}

router.get("/limits/workspaces/:workspaceId", async (req, res): Promise<void> => {
  const params = GetSetLimitsWorkspaceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { workspaceId } = params.data;
  const canRead = req.authz!.capabilities.canWriteUserLimitsIn.includes(workspaceId) ||
    (req.authz!.isPreview === true && req.authz!.workspaceIds.includes(workspaceId));
  if (!canRead) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  try {
    const directory = await getCachedDirectory();
    const workspace = directory.workspaces.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const billing = getBillingPeriod();
    const window = resolveUsageWindow({
      rangeType: "custom",
      startDate: billing.start.slice(0, 10),
      endDate: billing.end.slice(0, 10),
    }).window;
    const usage = await readUsageSnapshot({ window, workspaceIds: [workspaceId] });
    const usageRows = usage.members.get(workspaceId);
    const usageComplete = usage.status === "complete" || usage.status === "stale";
    const knownLimits = hasSuccessfulLimitObservation(directory.budgets);
    const explicit = directory.budgets.userLimits.get(workspaceId) ?? new Map();
    const inherited = directory.budgets.workspaceDefaults.get(workspaceId);
    const groups = directory.groups.filter((group) => group.workspaceId === workspaceId);
    const groupIdsByUser = new Map<string, string[]>();
    for (const group of groups) {
      for (const userId of directory.groupMembers.get(group.id) ?? []) {
        const ids = groupIdsByUser.get(userId) ?? [];
        ids.push(group.id);
        groupIdsByUser.set(userId, ids);
      }
    }
    const members = [...directory.members.values()].flatMap((member) => {
      const membership = member.workspaces.get(workspaceId);
      if (!membership) return [];
      const explicitAmount = explicit.get(member.userId);
      const effective = explicitAmount ?? inherited ?? null;
      return [{
        userId: member.userId,
        username: member.username,
        name: member.name,
        email: member.email,
        role: membership.role,
        groupIds: groupIdsByUser.get(member.userId) ?? [],
        isInternal: member.isInternalReplitUser,
        isDisabled: membership.isDisabled,
        eligible: !membership.isDisabled && !member.isInternalReplitUser,
        usageUsd: usageComplete
          ? (usageRows?.get(member.userId)?.aiCostUsd ?? 0)
          : null,
        explicitLimitUsd: explicitAmount ?? null,
        effectiveLimitUsd: effective,
        limitState: !knownLimits
          ? "unavailable" as const
          : explicitAmount !== undefined
            ? "explicit" as const
            : inherited !== undefined
              ? "inherited" as const
              : "no_limit" as const,
      }];
    });
    const observation = directory.budgets.observation;
    res.json(GetSetLimitsWorkspaceResponse.parse({
      workspaceId,
      workspaceName: workspace.name,
      canWrite:
        !req.authz!.isPreview &&
        req.authz!.capabilities.canWriteUserLimitsIn.includes(workspaceId) &&
        isReplitBudgetWriteConfigured(),
      unavailableReason: !isReplitBudgetWriteConfigured()
        ? "Enterprise budget writes are not configured with write:budgets"
        : knownLimits
          ? null
          : observation.error ?? "No successful member-limit observation is available",
      billingPeriod: { start: billing.start, end: billing.end },
      limitObservation: {
        status: knownLimits
          ? "available"
          : observation.status === "failed" ? "failed" : "unavailable",
        observedAt: observation.lastSuccessfulAt == null
          ? null
          : new Date(observation.lastSuccessfulAt).toISOString(),
        error: observation.error,
      },
      groups: groups.map((group) => {
        const canonical = directory.account.roleGroupsById.get(group.id);
        return {
          groupId: group.id,
          name: group.name,
          familyName: canonical?.familyName ?? null,
          role: canonical?.role ?? null,
          eligibleUserIds: (directory.groupMembers.get(group.id) ?? []).filter((userId) => {
            const member = directory.members.get(userId);
            return !!member &&
              member.workspaces.get(workspaceId)?.isDisabled === false &&
              !member.isInternalReplitUser;
          }),
        };
      }),
      members,
    }));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post("/limits/operations/prepare", async (req, res): Promise<void> => {
  const parsed = PrepareLimitOperationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const actorName = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(" ") || null;
    const result = await prepareLimitOperation({
      authz: req.authz!,
      actor: { id: req.user!.id, email: req.user!.email, name: actorName },
      ...parsed.data,
    });
    res.json(PrepareLimitOperationResponse.parse(result));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post("/limits/operations/:operationId/commit", async (req, res): Promise<void> => {
  const params = CommitLimitOperationParams.safeParse(req.params);
  const body = CommitLimitOperationBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await commitLimitOperation({
      operationId: params.data.operationId,
      authz: req.authz!,
      ...body.data,
    });
    res.status(202).json(CommitLimitOperationResponse.parse(result));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.get("/limits/operations/:operationId", async (req, res): Promise<void> => {
  const params = GetLimitOperationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(GetLimitOperationResponse.parse(
      await getLimitOperation(params.data.operationId, req.authz!),
    ));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post("/limits/operations/:operationId/retry", async (req, res): Promise<void> => {
  const params = RetryLimitOperationTargetsParams.safeParse(req.params);
  const body = RetryLimitOperationTargetsBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await retryLimitTargets({
      operationId: params.data.operationId,
      authz: req.authz!,
      ...body.data,
    });
    res.status(202).json(RetryLimitOperationTargetsResponse.parse(result));
  } catch (error) {
    sendError(req, res, error);
  }
});

export default router;