import express, {
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
  GetLimitsResponse,
  PrepareLimitChangesBody,
  PrepareLimitChangesResponse,
  PrepareClearAllLimitsBody,
  PrepareClearAllLimitsResponse,
  CommitLimitChangesParams,
  CommitLimitChangesBody,
  CommitLimitChangesResponse,
  GetLimitChangesParams,
  GetLimitChangesResponse,
  RetryLimitChangesParams,
  RetryLimitChangesBody,
  RetryLimitChangesResponse,
} from "@workspace/api-zod";
import {
  getLimitOperation,
  LimitOperationError,
  prepareLimitOperation,
  retryLimitTargets,
  commitLimitOperation,
  prepareLimitChanges,
  commitLimitChanges,
  retryLimitChanges,
  canWriteChange,
} from "../lib/limit-operations";
import {
  getBillingPeriodMetadata,
  getCachedDirectory,
  getFreshDirectoryForLimitValidation,
  hasSuccessfulLimitObservation,
} from "../lib/enterprise";
import {
  readUsageSnapshot,
  type MemberUsageTotal,
  type UsageSnapshot,
} from "../lib/usage-store";
import { resolveUsageWindow } from "../lib/usage-window";
import {
  isReplitBudgetWriteConfigured,
  listConfiguredWorkspaceLimits,
} from "../lib/replit-budgets";

const router: IRouter = Router();
export const limitsChangesJsonParser = express.json({ limit: "16mb" });

export function canReadLimitsWorkspaceScope(input: {
  accountWide: boolean;
  workspaceScoped: boolean;
  scopedGroupCount: number;
  selfIsMember: boolean;
}): boolean {
  return input.accountWide || input.workspaceScoped ||
    input.scopedGroupCount > 0 || input.selfIsMember;
}

export function canReadLimitMemberScope(input: {
  broadRead: boolean;
  authorizedUserIds: readonly string[];
  userId: string;
}): boolean {
  return input.broadRead || input.authorizedUserIds.includes(input.userId);
}

router.get("/limits", async (req, res): Promise<void> => {
  try {
    const directory = await getFreshDirectoryForLimitValidation();
    const inventory = await listConfiguredWorkspaceLimits();
    const accountWide = req.authz!.roles.includes("account");
    const limits = inventory.flatMap((limit) => {
      if (!accountWide && !req.authz!.workspaceIds.includes(limit.workspaceId)) return [];
      const targetId = limit.type === "workspace_group_limit" ? limit.groupId
        : limit.type === "workspace_user_limit" ? limit.userId : limit.workspaceId;
      if (
        limit.type === "workspace_group_limit" &&
        !accountWide &&
        !req.authz!.groupIds.includes(limit.groupId)
      ) return [];
      if (
        limit.type === "workspace_user_limit" &&
        !accountWide &&
        !req.authz!.capabilities.canWriteUserLimitsIn.includes(limit.workspaceId) &&
        !req.authz!.userIds.includes(limit.userId)
      ) return [];
      const canWrite = canWriteChange(req.authz!, {
        type: limit.type, workspaceId: limit.workspaceId, targetId, amountUsd: limit.amountUsd,
      });
      return [{
        workspaceId: limit.workspaceId,
        type: limit.type,
        targetId,
        amountUsd: limit.amountUsd,
        groupId: limit.type === "workspace_group_limit" ? limit.groupId : null,
        userId: limit.type === "workspace_user_limit" ? limit.userId : null,
        canWrite,
      }];
    });
    res.json(GetLimitsResponse.parse({
      canClearAll: !req.authz!.isPreview &&
        req.authz!.isTrueAccountAdmin &&
        req.authz!.capabilities.canWriteGroupLimits &&
        isReplitBudgetWriteConfigured(),
      writeConfigured: isReplitBudgetWriteConfigured(),
      observation: { status: "available", error: null },
      limits,
    }));
    void directory;
  } catch (error) {
    sendError(req, res, error);
  }
});

export function hasCompleteRequestedWorkspaceAgentUsage(
  usage: Pick<UsageSnapshot, "coverage">,
): boolean {
  return usage.coverage.requestedWorkspaceDays > 0 &&
    usage.coverage.presentWorkspaceDays === usage.coverage.requestedWorkspaceDays &&
    usage.coverage.missingWorkspaceDays.length === 0 &&
    usage.coverage.failedWorkspaceDays.length === 0;
}

export function resolveLimitMemberAgentUsage(
  usage: MemberUsageTotal | undefined,
  workspaceUsageComplete: boolean,
): number | null {
  if (!workspaceUsageComplete) return null;
  if (!usage) return 0;
  return usage.agentMetricsComplete === true ? usage.aiCostUsd : null;
}

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
  try {
    const directory = await getCachedDirectory();
    const workspace = directory.workspaces.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const workspaceGroupIds = new Set(
      directory.groups.filter((group) => group.workspaceId === workspaceId)
        .map((group) => group.id),
    );
    const broadRead = req.authz!.roles.includes("account") ||
      req.authz!.workspaceIds.includes(workspaceId);
    const scopedGroupIds = new Set(
      req.authz!.groupIds.filter((groupId) => workspaceGroupIds.has(groupId)),
    );
    const selfIsMember = directory.members.get(req.authz!.userId)
      ?.workspaces.get(workspaceId)?.isDisabled === false;
    if (!canReadLimitsWorkspaceScope({
      accountWide: req.authz!.roles.includes("account"),
      workspaceScoped: req.authz!.workspaceIds.includes(workspaceId),
      scopedGroupCount: scopedGroupIds.size,
      selfIsMember,
    })) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    const billing = getBillingPeriodMetadata();
    const window = resolveUsageWindow({
      rangeType: "custom",
      startDate: billing.start.slice(0, 10),
      endDate: billing.end.slice(0, 10),
    }).window;
    const usage = await readUsageSnapshot({
      window,
      workspaceIds: [workspaceId],
      includeAccountAnchor: false,
    });
    const usageRows = usage.members.get(workspaceId);
    // This view only consumes this workspace's Agent facts. Account anchors and
    // unrelated workspace gaps must not suppress otherwise complete member data.
    const usageComplete = !billing.isFallback &&
      hasCompleteRequestedWorkspaceAgentUsage(usage);
    const knownLimits = hasSuccessfulLimitObservation(directory.budgets);
    const explicit = directory.budgets.userLimits.get(workspaceId) ?? new Map();
    const inherited = directory.budgets.workspaceDefaults.get(workspaceId);
    const groups = directory.groups.filter((group) =>
      group.workspaceId === workspaceId &&
      (broadRead || scopedGroupIds.has(group.id))
    );
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
      if (!canReadLimitMemberScope({
        broadRead,
        authorizedUserIds: req.authz!.userIds,
        userId: member.userId,
      })) return [];
      const explicitAmount = explicit.get(member.userId);
      const effective = knownLimits ? explicitAmount ?? inherited ?? null : null;
      const memberUsage = usageRows?.get(member.userId);
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
        usageUsd: resolveLimitMemberAgentUsage(memberUsage, usageComplete),
        explicitLimitUsd: knownLimits ? explicitAmount ?? null : null,
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

router.post("/limits/changes/prepare", async (req, res): Promise<void> => {
  const body = PrepareLimitChangesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const actorName = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(" ") || null;
    const result = await prepareLimitChanges({
      authz: req.authz!,
      actor: { id: req.user!.id, email: req.user!.email, name: actorName },
      idempotencyKey: body.data.idempotencyKey,
      changes: body.data.targets,
    });
    res.json(PrepareLimitChangesResponse.parse(result));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post("/limits/changes/clear-all/prepare", async (req, res): Promise<void> => {
  const body = PrepareClearAllLimitsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const actorName = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(" ") || null;
    const result = await prepareLimitChanges({
      authz: req.authz!,
      actor: { id: req.user!.id, email: req.user!.email, name: actorName },
      idempotencyKey: body.data.idempotencyKey,
      changes: [],
      clearAll: true,
    });
    res.json(PrepareClearAllLimitsResponse.parse(result));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post("/limits/changes/:operationId/commit", async (req, res): Promise<void> => {
  const params = CommitLimitChangesParams.safeParse(req.params);
  const body = CommitLimitChangesBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await commitLimitChanges({
      operationId: params.data.operationId,
      authz: req.authz!,
      reviewFingerprint: body.data.reviewFingerprint,
      changes: body.data.targets,
      confirmation: body.data.confirmation,
    });
    res.status(202).json(CommitLimitChangesResponse.parse(result));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.get("/limits/changes/:operationId", async (req, res): Promise<void> => {
  const params = GetLimitChangesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(GetLimitChangesResponse.parse(
      await getLimitOperation(params.data.operationId, req.authz!),
    ));
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post("/limits/changes/:operationId/retry", async (req, res): Promise<void> => {
  const params = RetryLimitChangesParams.safeParse(req.params);
  const body = RetryLimitChangesBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await retryLimitChanges({
      operationId: params.data.operationId,
      authz: req.authz!,
      idempotencyKey: body.data.idempotencyKey,
      targets: body.data.targets,
    });
    res.status(202).json(RetryLimitChangesResponse.parse(result));
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