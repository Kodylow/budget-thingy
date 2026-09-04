import { Router } from "express";
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
      const dir = await getDirectory();
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
      const snapshot = await listReplitMemberBudgets(workspaceId);
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
          // Defensive identity deduplication protects against replayed/duplicate
          // memberships in upstream directory snapshots.
          if (
            !membership ||
            seen.has(member.userId) ||
            (!("kind" in authzScope) &&
              !authzScope.userIds.has(member.userId))
          ) return [];
          seen.add(member.userId);
          const budget = snapshot.budgets.get(member.userId);
          const budgetUsd = budget?.budgetUsd ?? null;
          // One workspace_member observation avoids role-subgroup duplicates.
          // Only its Agent metric is used, always for the current billing range.
          const usageUsd = !workspaceUsage || !workspaceUsageComplete
            ? null
            : !workspaceUsage.has(member.userId)
              ? 0
              : (workspaceUsage.get(member.userId)?.aiCostUsd ?? null);
          return [{
            userId: member.userId,
            username: member.username,
            name: member.name,
            email: member.email,
            role: membership.role,
            isDisabled: membership.isDisabled,
            budgetUsd,
            usageUsd,
            // Do not clamp: a negative value is meaningful overspend.
            remainingUsd:
              budgetUsd == null || usageUsd == null ? null : budgetUsd - usageUsd,
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
          status: snapshot.status,
          canWrite: snapshot.canWrite,
          error: snapshot.error,
        },
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
): Promise<boolean> {
  const dir = await getDirectory();
  return dir.workspaces.has(workspaceId) &&
    userIds.every((userId) =>
      dir.members.get(userId)?.workspaces.has(workspaceId) === true
    );
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
    res.status(error.kind === "unavailable" ? 503 : 502).json({ error: error.message });
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
      if (!(await validateWorkspaceMembers(workspaceId, userIds))) {
        res.status(404).json({ error: "Workspace member not found" });
        return;
      }
      const outcomes = await Promise.all(userIds.map(async (userId) => {
        try {
          await setReplitMemberBudget(workspaceId, userId, parsed.data.amountUsd);
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
          return {
            userId,
            success: false,
            budgetUsd: null,
            error: error instanceof Error
              ? error.message
              : "Replit budgets API request failed",
          };
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
        return {
          userId,
          success: true,
          budgetUsd: parsed.data.amountUsd,
          error: null,
        };
      }));
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
      if (!(await validateWorkspaceMembers(workspaceId, [userId]))) {
        res.status(404).json({ error: "Workspace member not found" });
        return;
      }
      try {
        await setReplitMemberBudget(workspaceId, userId, parsed.data.amountUsd);
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
      if (!(await validateWorkspaceMembers(workspaceId, [userId]))) {
        res.status(404).json({ error: "Workspace member not found" });
        return;
      }
      try {
        await setReplitMemberBudget(workspaceId, userId, null);
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

router.get(
  "/directory/workspaces/:workspaceId/usage-limit-audits",
  requireCapability("canWriteGroupLimits"),
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

router.get("/directory/groups", requireRole("account"), async (req, res): Promise<void> => {
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
    groups.sort(
      (a, b) =>
        a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: "base" }) ||
        a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" }) ||
        a.groupId.localeCompare(b.groupId),
    );

    res.json(ListDirectoryGroupsResponse.parse(groups));
  } catch (err) {
    req.log.error({ err }, "listDirectoryGroups failed");
    res.status(503).json({ error: "Directory unavailable" });
  }
});

router.get("/directory/members", requireRole("account"), async (req, res): Promise<void> => {
  try {
    const dir = await getDirectory();
    if (!dir) {
      res.status(503).json({ error: "Directory not yet available" });
      return;
    }

    const usage = await readUsageSnapshot({
      window: windowFromQuery(req.query as Record<string, unknown>).window,
      workspaceIds: dir.workspaces.keys(),
    });
    const members = [...dir.members.values()].map((m) => {
      return {
        userId: m.userId,
        username: m.username,
        name: m.name,
        email: m.email,
        isAccountAdmin: m.isAccountAdmin,
        workspaces: [...m.workspaces.entries()].map(([workspaceId, ws]) => {
          return {
            workspaceId,
            workspaceName: dir.workspaces.get(workspaceId)?.name ?? workspaceId,
            role: ws.role,
            isDisabled: ws.isDisabled,
            spendUsd: usage.members.get(workspaceId)?.get(m.userId)?.totalCostUsd ?? 0,
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
