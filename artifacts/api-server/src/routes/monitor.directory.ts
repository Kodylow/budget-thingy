import { Router } from "express";
import {
  GetWorkspaceLimitPoliciesResponse,
  SetGroupMemberLimitPolicyBody,
  SetGroupMemberLimitPolicyResponse,
  SetWorkspaceDefaultLimitPolicyBody,
  SetWorkspaceDefaultLimitPolicyResponse,
} from "@workspace/api-zod";
import {
  groupUserLimitPoliciesTable,
  memberLimitPolicyAssignmentsTable,
  workspaceDefaultLimitTargetsTable,
} from "@workspace/db";
import {
  getWorkspaceMemberLimitPolicyViews,
  markMemberLimitAsHandSet,
  setGroupMemberLimitPolicy,
  setWorkspaceDefaultMemberLimitPolicy,
  type MemberLimitPolicyOutcome,
} from "../lib/member-limit-policies";
import {
  getCachedDirectory,
  getDirectoryFreshness as getPersistedDirectoryFreshness,
  hasSuccessfulLimitObservation,
  isInternalReplitMember,
  reconcilePersistedLimitWrite,
} from "../lib/enterprise";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

router.get("/directory/workspaces", async (req, res): Promise<void> => {
  try {
    const dir = await getDirectory();
    const allowed = isAccountWide(req.authz)
      ? null
      : new Set(req.authz!.workspaceIds);
    const workspaces = [...dir.workspaces.values()]
      .filter((workspace) => !allowed || allowed.has(workspace.id))
      .map((workspace) => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        memberCount: [...dir.members.values()].filter((member) =>
          member.workspaces.has(workspace.id),
        ).length,
      }))
      .sort((a, b) =>
        a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: "base" }) ||
        a.workspaceId.localeCompare(b.workspaceId),
      );
    res.json(ListVisibleWorkspacesResponse.parse(workspaces));
  } catch (err) {
    req.log.error({ err }, "listVisibleWorkspaces failed");
    res.status(503).json({ error: "Directory unavailable" });
  }
});

router.get(
  "/directory/workspaces/:workspaceId/members",
  async (req, res): Promise<void> => {
    try {
      const workspaceId = String(req.params["workspaceId"]);
      const dir = await getCachedDirectory();
      const workspace = dir.workspaces.get(workspaceId);
      const authzScope = scopeFor(req.authz!);
      const hasScopedGroupInWorkspace =
        !("kind" in authzScope) &&
        dir.groups.some(
          (group) =>
            group.workspaceId === workspaceId &&
            authzScope.groupIds.has(group.id),
        );
      if (
        !workspace ||
        (!("kind" in authzScope) &&
          !authzScope.workspaceIds.has(workspaceId) &&
          !hasScopedGroupInWorkspace)
      ) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      const observation = dir.budgets.observation;
      const hasKnownLimits = hasSuccessfulLimitObservation(dir.budgets);
      const explicitLimits = dir.budgets.userLimits.get(workspaceId) ?? new Map();
      const policyViews = await getWorkspaceMemberLimitPolicyViews(
        workspaceId,
        explicitLimits,
        dir,
      );
      const selection = windowFromQuery({ rangeType: "billing" });
      const usage = await readUsageSnapshot({
        window: selection.window,
        workspaceIds: [workspaceId],
      });
      const workspaceUsage = usage.members.get(workspaceId);
      const workspaceUsageComplete = usage.status === "complete" || usage.status === "stale";
      const seen = new Set<string>();
      const members = [...dir.members.values()]
        .flatMap((member) => {
          const membership = member.workspaces.get(workspaceId);
          if (
            !membership ||
            seen.has(member.userId) ||
            (!("kind" in authzScope) &&
              !authzScope.userIds.has(member.userId))
          ) return [];
          seen.add(member.userId);
          const explicitLimit = explicitLimits.get(member.userId);
          const inheritedLimit = dir.budgets.workspaceDefaults.get(workspaceId);
          const budgetUsd = explicitLimit ?? null;
          const effectiveLimitUsd = explicitLimit ?? inheritedLimit ?? null;
          const limitState = !hasKnownLimits
            ? "unavailable"
            : explicitLimit !== undefined
              ? "explicit"
              : inheritedLimit !== undefined
                ? "inherited"
                : "no_limit";
          const isInternal = member.isInternalReplitUser;
          const usageUsd = !workspaceUsage || !workspaceUsageComplete
            ? null
            : isInternal || !workspaceUsage.has(member.userId)
              ? 0
              : (workspaceUsage.get(member.userId)?.aiCostUsd ?? null);
          const policyView = isInternal ? undefined : policyViews.get(member.userId);
          const percentUsed =
            effectiveLimitUsd == null || effectiveLimitUsd <= 0 || usageUsd == null
              ? null
              : (usageUsd / effectiveLimitUsd) * 100;
          return [{
            userId: member.userId,
            username: member.username,
            name: member.name,
            email: member.email,
            isInternal,
            role: membership.role,
            isDisabled: membership.isDisabled,
            budgetUsd,
            effectiveLimitUsd,
            limitState,
            usageUsd,
            remainingUsd:
              effectiveLimitUsd == null || usageUsd == null
                ? null
                : effectiveLimitUsd - usageUsd,
            percentUsed,
            blocked: !isInternal && effectiveLimitUsd != null &&
              usageUsd != null && usageUsd >= effectiveLimitUsd,
            effectiveBaselineUsd: policyView?.effectiveBaseline?.amountUsd ?? null,
            baselineSourceType: policyView?.effectiveBaseline?.sourceType ?? null,
            baselineSourceId: policyView?.effectiveBaseline?.sourceId ?? null,
            isHandSetOverride: policyView?.isHandSetOverride ?? false,
          }];
        })
        .sort((a, b) =>
          a.username.localeCompare(b.username, undefined, { sensitivity: "base" }) ||
          a.userId.localeCompare(b.userId),
        );
      res.json(ListVisibleWorkspaceMembersResponse.parse({
        workspaceId,
        workspaceName: workspace.name,
        billingPeriod: "current",
        connector: {
          status: observation.status === "failed"
            ? "error"
            : hasKnownLimits ? "available" : "unavailable",
          canWrite:
            req.authz!.capabilities.canWriteUserLimitsIn.includes(workspaceId) &&
            !req.authz!.isPreview,
          error: observation.error,
        },
        limitObservation: observation,
        directoryFreshness: getPersistedDirectoryFreshness(),
        members,
      }));
    } catch (err) {
      req.log.error({ err }, "listVisibleWorkspaceMembers failed");
      res.status(503).json({ error: "Directory unavailable" });
    }
  },
);

async function validateWorkspaceMembers(
  workspaceId: string,
  userIds: readonly string[],
): Promise<"valid" | "not_found" | "internal"> {
  const dir = await getDirectory();
  if (
    !dir.workspaces.has(workspaceId) ||
    !userIds.every((userId) =>
      dir.members.get(userId)?.workspaces.has(workspaceId) === true
    )
  ) return "not_found";
  return userIds.some((userId) => isInternalReplitMember(dir.members.get(userId)))
    ? "internal"
    : "valid";
}

async function rejectInvalidLimitTargets(
  workspaceId: string,
  userIds: readonly string[],
  res: Response,
): Promise<boolean> {
  const validation = await validateWorkspaceMembers(workspaceId, userIds);
  if (validation === "not_found") {
    res.status(404).json({ error: "Workspace member not found" });
    return true;
  }
  if (validation === "internal") {
    res.status(403).json({
      error: "Internal Replit members cannot be targeted by usage limits",
    });
    return true;
  }
  return false;
}
async function recordUsageLimitAudit(
  req: Parameters<typeof requireAuth>[0],
  workspaceId: string,
  userId: string,
  action: "set" | "clear",
  operation: "individual" | "bulk",
  requestedAmountUsd: number | null,
  outcome: "success" | "failed",
): Promise<void> {
  const dir = await getDirectory();
  const workspace = dir.workspaces.get(workspaceId);
  const member = dir.members.get(userId);
  const operatorName = [req.user!.firstName, req.user!.lastName].filter(Boolean).join(" ") || null;
  await db.insert(usageLimitAuditsTable).values({
    operatorUserId: req.user!.id,
    operatorEmail: req.user!.email,
    operatorName,
    workspaceId,
    workspaceName: workspace?.name ?? null,
    memberUserId: userId,
    memberEmail: member?.email ?? null,
    memberName: member?.name ?? member?.username ?? null,
    action,
    operation,
    requestedAmountUsd,
    outcome,
  });
}

function sendBudgetConnectorError(
  error: unknown,
  res: Response,
): void {
  if (error instanceof ReplitBudgetConnectorError) {
    const status =
      error.upstreamStatus === 401 || error.upstreamStatus === 403
        ? error.upstreamStatus
        : error.kind === "unavailable" ? 503 : 502;
    res.status(status).json({ error: error.message });
    return;
  }
  res.status(502).json({
    error: error instanceof Error ? error.message : "Replit budgets API request failed",
  });
}

router.put(
  "/directory/workspaces/:workspaceId/members/budget",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const parsed = BulkSetWorkspaceMemberBudgetsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const workspaceId = String(req.params["workspaceId"]);
    const userIds = [...new Set(parsed.data.userIds)];
    try {
      if (await rejectInvalidLimitTargets(workspaceId, userIds, res)) return;
      const outcomes = [];
      for (const userId of userIds) {
        let outcome;
        try {
          await setReplitMemberBudget(workspaceId, userId, parsed.data.amountUsd);
          await reconcilePersistedLimitWrite({
            type: "workspace_user_limit",
            workspaceId,
            userId,
            amountUsd: parsed.data.amountUsd,
          });
          await markMemberLimitAsHandSet(workspaceId, userId);
        } catch (error) {
          await recordUsageLimitAudit(
            req,
            workspaceId,
            userId,
            "set",
            "bulk",
            parsed.data.amountUsd,
            "failed",
          );
          outcome = {
            userId,
            success: false,
            budgetUsd: null,
            error: error instanceof Error
              ? error.message
              : "Replit budgets API request failed",
          };
          outcomes.push(outcome);
          continue;
        }
        await recordUsageLimitAudit(
          req,
          workspaceId,
          userId,
          "set",
          "bulk",
          parsed.data.amountUsd,
          "success",
        );
        outcome = {
          userId,
          success: true,
          budgetUsd: parsed.data.amountUsd,
          error: null,
        };
        outcomes.push(outcome);
      }
      if (
        outcomes.every((outcome) => !outcome.success) &&
        outcomes.some((outcome) => /write:budgets|connector/i.test(outcome.error ?? ""))
      ) {
        res.status(503).json({ error: outcomes[0]?.error ?? "Budget editing unavailable" });
        return;
      }
      res.json(BulkSetWorkspaceMemberBudgetsResponse.parse({
        workspaceId,
        amountUsd: parsed.data.amountUsd,
        outcomes,
      }));
    } catch (error) {
      sendBudgetConnectorError(error, res);
    }
  },
);

router.put(
  "/directory/workspaces/:workspaceId/members/:userId/budget",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const parsed = SetWorkspaceMemberBudgetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const workspaceId = String(req.params["workspaceId"]);
    const userId = String(req.params["userId"]);
    try {
      if (await rejectInvalidLimitTargets(workspaceId, [userId], res)) return;
      try {
        await setReplitMemberBudget(workspaceId, userId, parsed.data.amountUsd);
        await reconcilePersistedLimitWrite({
          type: "workspace_user_limit",
          workspaceId,
          userId,
          amountUsd: parsed.data.amountUsd,
        });
        await markMemberLimitAsHandSet(workspaceId, userId);
      } catch (error) {
        await recordUsageLimitAudit(
          req,
          workspaceId,
          userId,
          "set",
          "individual",
          parsed.data.amountUsd,
          "failed",
        );
        sendBudgetConnectorError(error, res);
        return;
      }
      await recordUsageLimitAudit(
        req,
        workspaceId,
        userId,
        "set",
        "individual",
        parsed.data.amountUsd,
        "success",
      );
      res.json(SetWorkspaceMemberBudgetResponse.parse({
        workspaceId,
        userId,
        budgetUsd: parsed.data.amountUsd,
      }));
    } catch (error) {
      req.log.error({ err: error }, "set usage limit failed");
      res.status(500).json({ error: "Usage limit audit could not be recorded" });
    }
  },
);

router.delete(
  "/directory/workspaces/:workspaceId/members/:userId/budget",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const workspaceId = String(req.params["workspaceId"]);
    const userId = String(req.params["userId"]);
    try {
      if (await rejectInvalidLimitTargets(workspaceId, [userId], res)) return;
      try {
        await setReplitMemberBudget(workspaceId, userId, null);
        await reconcilePersistedLimitWrite({
          type: "workspace_user_limit",
          workspaceId,
          userId,
          amountUsd: null,
        });
        await markMemberLimitAsHandSet(workspaceId, userId);
      } catch (error) {
        await recordUsageLimitAudit(
          req,
          workspaceId,
          userId,
          "clear",
          "individual",
          null,
          "failed",
        );
        sendBudgetConnectorError(error, res);
        return;
      }
      await recordUsageLimitAudit(
        req,
        workspaceId,
        userId,
        "clear",
        "individual",
        null,
        "success",
      );
      res.json(ClearWorkspaceMemberBudgetResponse.parse({
        workspaceId,
        userId,
        budgetUsd: null,
      }));
    } catch (error) {
      req.log.error({ err: error }, "clear usage limit failed");
      res.status(500).json({ error: "Usage limit audit could not be recorded" });
    }
  },
);

function policyOutcomeJson(outcome: MemberLimitPolicyOutcome) {
  return {
    workspaceId: outcome.workspaceId,
    userId: outcome.userId,
    desiredAmountUsd: outcome.desired?.amountUsd ?? null,
    sourceType: outcome.desired?.sourceType ?? null,
    sourceId: outcome.desired?.sourceId ?? null,
    previousAmountUsd: outcome.previousAmountUsd,
    state: outcome.state,
    status: outcome.status,
    error: outcome.error,
  };
}

router.get(
  "/directory/workspaces/:workspaceId/limit-policies",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const workspaceId = String(req.params["workspaceId"]);
    const dir = await getDirectory();
    const workspace = dir.workspaces.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const [groupPolicies, defaults, assignments, snapshot] = await Promise.all([
      db.select().from(groupUserLimitPoliciesTable)
        .where(eq(groupUserLimitPoliciesTable.workspaceId, workspaceId)),
      db.select().from(workspaceDefaultLimitTargetsTable)
        .where(eq(workspaceDefaultLimitTargetsTable.workspaceId, workspaceId)),
      db.select().from(memberLimitPolicyAssignmentsTable)
        .where(eq(memberLimitPolicyAssignmentsTable.workspaceId, workspaceId)),
      listReplitMemberBudgets(workspaceId),
    ]);
    const assignmentByUser = new Map(assignments.map((row) => [row.userId, row]));
    const overrides = [...snapshot.budgets.values()].flatMap((budget) => {
      if (
        budget.budgetUsd == null ||
        assignmentByUser.get(budget.userId)?.lastAmountUsd === budget.budgetUsd
      ) return [];
      const member = dir.members.get(budget.userId);
      return [{
        userId: budget.userId,
        name: member?.name ?? member?.username ?? null,
        amountUsd: budget.budgetUsd,
      }];
    });
    const policyByGroup = new Map(groupPolicies.map((row) => [row.groupId, row]));
    res.json(GetWorkspaceLimitPoliciesResponse.parse({
      workspaceId,
      workspaceName: workspace.name,
      defaultAmountUsd:
        defaults[0]?.isEnabled ? defaults[0].monthlyLimitUsd : null,
      groups: dir.groups
        .filter((group) => group.workspaceId === workspaceId)
        .map((group) => ({
          groupId: group.id,
          groupName: group.name,
          amountUsd: policyByGroup.get(group.id)?.amountUsd ?? null,
          isEnabled: policyByGroup.get(group.id)?.isEnabled ?? false,
        })),
      overrides,
    }));
  },
);

router.put(
  "/directory/workspaces/:workspaceId/default-limit-policy",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const parsed = SetWorkspaceDefaultLimitPolicyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const workspaceId = String(req.params["workspaceId"]);
    const dir = await getDirectory();
    const workspace = dir.workspaces.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    try {
      const outcomes = await setWorkspaceDefaultMemberLimitPolicy({
        workspaceId,
        displayName: workspace.name,
        amountUsd: parsed.data.amountUsd,
      });
      res.json(SetWorkspaceDefaultLimitPolicyResponse.parse({
        workspaceId,
        sourceType: "workspace_default",
        sourceId: workspaceId,
        amountUsd: parsed.data.amountUsd,
        outcomes: outcomes.map(policyOutcomeJson),
      }));
    } catch (error) {
      sendBudgetConnectorError(error, res);
    }
  },
);

router.put(
  "/directory/workspaces/:workspaceId/groups/:groupId/limit-policy",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const parsed = SetGroupMemberLimitPolicyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const workspaceId = String(req.params["workspaceId"]);
    const groupId = String(req.params["groupId"]);
    try {
      const outcomes = await setGroupMemberLimitPolicy({
        workspaceId,
        groupId,
        amountUsd: parsed.data.amountUsd,
      });
      res.json(SetGroupMemberLimitPolicyResponse.parse({
        workspaceId,
        sourceType: "group",
        sourceId: groupId,
        amountUsd: parsed.data.amountUsd,
        outcomes: outcomes.map(policyOutcomeJson),
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "Group not found in workspace") {
        res.status(404).json({ error: error.message });
        return;
      }
      sendBudgetConnectorError(error, res);
    }
  },
);

router.get(
  "/directory/workspaces/:workspaceId/usage-limit-audits",
  requireUserLimitWorkspace,
  async (req, res): Promise<void> => {
    const workspaceId = String(req.params["workspaceId"]);
    const dir = await getDirectory();
    if (!dir.workspaces.has(workspaceId)) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const rows = await db
      .select()
      .from(usageLimitAuditsTable)
      .where(eq(usageLimitAuditsTable.workspaceId, workspaceId))
      .orderBy(desc(usageLimitAuditsTable.createdAt), desc(usageLimitAuditsTable.id))
      .limit(200);
    res.json(ListWorkspaceUsageLimitAuditsResponse.parse(rows));
  },
);

router.get("/directory/groups", requireCapability("canManageAccess"), async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  try {
    const dir = await getDirectory();
    if (!dir) {
      res.status(503).json({ error: "Directory not yet available" });
      return;
    }

    const groups = dir.groups.map((group) => {
      const canonical = dir.account.roleGroupsById.get(group.id)!;
      return {
        groupId: group.id,
        groupName: group.name,
        workspaceId: group.workspaceId,
        workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? group.workspaceId,
        familyKey: canonical.familyKey,
        familyName: canonical.familyName,
        role: canonical.role,
        isLegacy: canonical.isLegacy,
        teamName: canonical.teamName,
      };
    });
    const roleOrder = { admin: 0, member: 1, viewer: 2, guest: 3, unsuffixed: 4 };
    type DirectoryGroup = (typeof groups)[number];
    type FamilyNode = {
      familyKey: string;
      familyName: string;
      isLegacy: boolean;
      groups: DirectoryGroup[];
    };
    type TeamNode = { teamName: string | null; families: FamilyNode[] };
    type WorkspaceNode = {
      workspaceId: string;
      workspaceName: string;
      teams: TeamNode[];
    };
    const workspaceNodes = new Map<string, WorkspaceNode>();
    for (const group of groups) {
      const workspace = workspaceNodes.get(group.workspaceId) ?? {
        workspaceId: group.workspaceId,
        workspaceName: group.workspaceName,
        teams: [],
      };
      if (!workspaceNodes.has(group.workspaceId)) {
        workspaceNodes.set(group.workspaceId, workspace);
      }
      let team = workspace.teams.find((item) => item.teamName === group.teamName);
      if (!team) {
        team = { teamName: group.teamName, families: [] };
        workspace.teams.push(team);
      }
      let family = team.families.find((item) => item.familyKey === group.familyKey);
      if (!family) {
        family = {
          familyKey: group.familyKey,
          familyName: group.familyName,
          isLegacy: group.isLegacy,
          groups: [],
        };
        team.families.push(family);
      }
      family.groups.push(group);
    }
    const workspaces = [...workspaceNodes.values()]
      .map((workspace) => ({
        ...workspace,
        teams: workspace.teams
          .map((team) => ({
            ...team,
            families: team.families
              .map((family) => ({
                ...family,
                groups: family.groups.sort(
                  (a, b) =>
                    roleOrder[a.role] - roleOrder[b.role] ||
                    a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" }),
                ),
              }))
              .sort(
                (a, b) =>
                  a.familyName.localeCompare(b.familyName, undefined, { sensitivity: "base" }) ||
                  a.familyKey.localeCompare(b.familyKey),
              ),
          }))
          .sort((a, b) =>
            (a.teamName ?? "Unassigned").localeCompare(
              b.teamName ?? "Unassigned",
              undefined,
              { sensitivity: "base" },
            )),
      }))
      .sort(
        (a, b) =>
          a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: "base" }) ||
          a.workspaceId.localeCompare(b.workspaceId),
      );

    res.json(ListDirectoryGroupsResponse.parse({ workspaces }));
  } catch (err) {
    req.log.error({ err }, "listDirectoryGroups failed");
    res.status(503).json({ error: "Directory unavailable" });
  }
});

router.get("/directory/members", requireCapability("canManageAccess"), async (req, res): Promise<void> => {
  try {
    const dir = await getDirectory();
    if (!dir) {
      res.status(503).json({ error: "Directory not yet available" });
      return;
    }

    const workspaceIds = [...dir.workspaces.keys()];
    const [usage, projectMetadata] = await Promise.all([
      readUsageSnapshot({
        window: windowFromQuery(req.query as Record<string, unknown>).window,
        workspaceIds,
      }),
      readProjectMetadata(workspaceIds),
    ]);
    const canonical = computeSnapshotUsageRollup({
      snapshot: usage,
      groups: dir.groups,
      membersByGroup: dir.groupMembers,
      internalUserIds: dir.internalUserIds,
      projectInfoByWorkspace: projectMetadata.byWorkspace,
    });
    const spendLoaded = canonical.isComplete;
    const members = [...dir.members.values()].map((m) => {
      return {
        userId: m.userId,
        username: m.username,
        name: m.name,
        email: m.email,
        isAccountAdmin: m.isAccountAdmin,
        isInternal: m.isInternalReplitUser,
        workspaces: [...m.workspaces.entries()].map(([workspaceId, ws]) => {
          return {
            workspaceId,
            workspaceName: dir.workspaces.get(workspaceId)?.name ?? workspaceId,
            role: ws.role,
            isDisabled: ws.isDisabled,
            spendLoaded,
            spendUsd: m.isInternalReplitUser
              ? 0
              : dir.groups
                  .filter((group) => group.workspaceId === workspaceId)
                  .reduce(
                    (sum, group) =>
                      sum +
                      (canonical.aiSpendByGroup.get(group.id)?.get(m.userId) ?? 0) +
                      (canonical.nonAiSpendByGroup.get(group.id)?.get(m.userId) ?? 0),
                    canonical.ungroupedByWorkspace
                      .get(workspaceId)?.byUser.get(m.userId) ?? 0,
                  ),
          };
        }),
      };
    });

    members.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));

    res.json(members);
  } catch (err) {
    req.log.error({ err }, "listDirectoryMembers failed");
    res.status(503).json({ error: "Directory unavailable" });
  }
});

export default router;
