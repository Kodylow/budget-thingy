import { Router } from "express";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

import {
  canExposeCanonicalAllocation,
  qualifiedGroupSpendComponents,
  resolveStoredMemberLimit,
} from "../services/scoped-accounting";
import { hasSuccessfulLimitObservation } from "../lib/enterprise";

const router = Router();

function qualifiedGroupDataComplete(
  snapshot: Awaited<ReturnType<typeof usageForRequest>>["snapshot"],
): boolean {
  return snapshot.status !== "empty" &&
    snapshot.coverage.failedWorkspaceDays.length === 0 &&
    snapshot.coverage.missingWorkspaceDays.length === 0;
}

function qualifiedGroupUsageHealth(
  usage: Awaited<ReturnType<typeof usageForRequest>>,
) {
  return {
    ...usageHealth(usage.snapshot, usage.rollup, usage.authz),
    // Account/workspace reconciliation has no truthful group attribution.
    accountWorkspaceUnreconciledUsd: 0,
  };
}

router.get("/groups/:groupId", async (req, res): Promise<void> => {
  const startedAt = performance.now();
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    // Non-disclosing: out-of-scope groups are indistinguishable from missing.
    if (!group || !canSeeGroup(req.authz!, group)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const usage = await usageForRequest(
      req.authz!, dir, req.query as Record<string, unknown>, true);
    const billingWindow = windowFromQuery({ rangeType: "billing" }).window;
    const selectedIsBilling =
      usage.selection.window.start === billingWindow.start &&
      usage.selection.window.end === billingWindow.end;
    const cycleUsagePromise = selectedIsBilling
      ? Promise.resolve(usage)
      : usageForRequest(req.authz!, dir, { rangeType: "billing" }, true);
    const [cycleUsage, dailyRollups, budgets, groupTeamsRows] = await Promise.all([
      cycleUsagePromise,
      dailyUsageRollups(dir, usage),
      db.select().from(groupBudgetsTable),
      db.select().from(teamLimitTargetsTable),
    ]);
    const mergePlan = buildCanonicalGroupMergePlan(usage.groups, dir.workspaces);
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
    const sourceGroups = sourceIds.map((id) =>
      usage.groups.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is EnterpriseGroup => !!candidate);
    const requestedScopeIds = String(req.query["scopeGroupIds"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const requestedScopeGroups = requestedScopeIds.map((id) =>
      usage.groups.find((candidate) => candidate.id === id),
    );
    if (
      requestedScopeIds.length > 0 &&
      requestedScopeGroups.some((candidate) => !candidate)
    ) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const canonical = usage.rollup;
    const qualifiedDataComplete = qualifiedGroupDataComplete(usage.snapshot);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const rollupMemberCounts = computeDedupedMemberCounts(usage.groups, scopedMembers);
    const projectAttribution = canonical.projectAttribution;
    const projectSpendUsd = sourceIds.reduce((sum, id) =>
      sum + (projectAttribution.spendByGroup.get(id) ?? 0), 0);
    const projectSpendLoaded = projectAttribution.isComplete;

    const attributedComponents = qualifiedGroupSpendComponents(
      canonical, req.authz!, sourceGroups);
    const attributed = {
      spendUsd: attributedComponents.spendUsd,
      byUser: (() => {
        const result = new Map<string, number>();
        for (const id of sourceIds) {
          for (const [userId, spend] of canonical.byGroup.get(id)?.byUser ?? []) {
            result.set(userId, (result.get(userId) ?? 0) + spend);
          }
        }
        return result;
      })(),
    };

    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const fullMergePlan = buildCanonicalGroupMergePlan(dir.groups, dir.workspaces);
    const fullPrimaryId = fullMergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const fullSourceIds = fullMergePlan.mergeMap.get(fullPrimaryId) ?? [group.id];
    const fullSourceGroups = fullSourceIds.map((id) =>
      dir.groups.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is EnterpriseGroup => !!candidate);
    const allocationAuthorized = canExposeCanonicalAllocation(
      req.authz!, fullSourceGroups) && fullSourceGroups.every((source) => {
        if (req.authz!.roles.includes("account") ||
            req.authz!.workspaceIds.includes(source.workspaceId)) return true;
        const visible = new Set(scopedMembers.get(source.id) ?? []);
        return (dir.groupMembers.get(source.id) ?? [])
          .every((userId) => visible.has(userId));
      });
    const mergedBudget = allocationAuthorized
      ? resolveCanonicalMergedGroupBudget(fullPrimaryId, fullMergePlan, budgetMap)
      : null;
    const budget = effectiveGroupBudget(mergedBudget?.amountUsd);
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingPeriodStart = getBillingPeriod().start;
    const fired =
      billingPeriodStart && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingPeriodStart)
        : [];

    const detailHistoryArr = [...dailyRollups].map(([date, daily]) => ({
      date,
      spendUsd: qualifiedGroupSpendComponents(
        daily, req.authz!, sourceGroups).spendUsd,
    }));

    // Union of directory members across all source groups.
    const requestedUserIds = mergedGroupMemberIds(sourceIds, scopedMembers);
    const requestScope = scopeFor(req.authz!);
    const userIds = "kind" in requestScope
      ? requestedUserIds
      : requestedUserIds.filter((userId) => requestScope.userIds.has(userId));

    const members = userIds.map((userId) => {
      const m = dir.members.get(userId);
      // Use the primary group's workspace for role/isDisabled (the user's workspace membership).
      const ws = m?.workspaces.get(group.workspaceId) ??
        sourceIds.map((id) => {
          const srcGroup = dir.groups.find((g) => g.id === id);
          return srcGroup ? m?.workspaces.get(srcGroup.workspaceId) : undefined;
        }).find(Boolean);
      // Every per-user surface uses the same canonical all-metric total for the
      // caller's selected range and visible workspaces.
      const spendLoaded = qualifiedDataComplete;
      const totalSpendLoaded = qualifiedDataComplete;
      const aiSpendUsd = sourceIds.reduce((sum, id) =>
        sum + (canonical.aiSpendByGroup.get(id)?.get(userId) ?? 0), 0);
      const nonAiSpendUsd = sourceIds.reduce((sum, id) =>
        sum + (canonical.nonAiSpendByGroup.get(id)?.get(userId) ?? 0), 0);
      const totalSpendUsd = aiSpendUsd + nonAiSpendUsd;
      const limitWorkspaceId = m?.workspaces.has(group.workspaceId)
        ? group.workspaceId
        : sourceGroups.find((source) => m?.workspaces.has(source.workspaceId))
          ?.workspaceId ?? group.workspaceId;
      const limit = resolveStoredMemberLimit(dir, limitWorkspaceId, userId);
      const cycleAgentSpendUsd = sourceIds.reduce((sum, id) =>
        sum + (cycleUsage.rollup.aiSpendByGroup.get(id)?.get(userId) ?? 0), 0);
      return {
        userId,
        username: m?.username ?? null,
        email: m?.email ?? null,
        name: m?.name ?? null,
        role: ws?.role ?? null,
        isDisabled: ws?.isDisabled ?? null,
        isInternal: m?.isInternalReplitUser ?? false,
        allocatedBudgetUsd: limit.amount,
        budgetSource: limit.state === "explicit"
          ? "workspace_user_limit"
          : limit.state === "inherited"
            ? "workspace_default_user_limit"
            : null,
        limitState: limit.state,
        limitObservationStatus: dir.budgets.observation.status,
        spendLoaded,
        spendUsd: totalSpendUsd,
        aiSpendUsd,
        nonAiSpendUsd,
        remainingUsd: limit.amount === null
          ? null
          : limit.amount - cycleAgentSpendUsd,
        percentUsed: limit.amount !== null && limit.amount > 0
          ? (cycleAgentSpendUsd / limit.amount) * 100
          : null,
      };
    });

    // Reconciliation: members removed from the group since the last sync still count
    // toward group spend (they are captured in the rollup).  unattributedSpendUsd
    // surfaces that residual so the cluster page can show an accurate attributed total.
    const combinedSpend = attributed.spendUsd;
    const combinedLoaded = qualifiedDataComplete;
    const totalSpendLoaded = qualifiedDataComplete;
    let listedMembersSpend = 0;
    for (const userId of userIds) {
      listedMembersSpend += sourceIds.reduce(
        (sum, id) =>
          sum + (canonical.aiSpendByGroup.get(id)?.get(userId) ?? 0) +
          (canonical.nonAiSpendByGroup.get(id)?.get(userId) ?? 0),
        0,
      );
    }
    // Unattributed spend = spend from members removed from the group since the last sync
    // (still in the rollup total but no longer in the directory member list).
    // Must be computed from attributed.byUser (not raw member spend) so that members
    // whose spend is attributed elsewhere don't inflate this figure — raw spend can
    // exceed the attributed group total for users in multiple groups.
    // This includes both canonical accounting residuals and spend canonically
    // owned by this group for people who are no longer in its displayed member
    // roster. Deriving it from the authoritative total and the exact displayed
    // rows guarantees the response reconciles, including cross-workspace admin
    // and re-homing paths where the owner is not a current group member.
    const unattributed = Math.max(0, combinedSpend - listedMembersSpend);

    const mergedRollupMemberCount = sourceIds.reduce(
      (sum, id) => sum + (rollupMemberCounts.get(id) ?? 0),
      0,
    );
    const monthlyAgentLimitUsd = allocationAuthorized &&
      hasSuccessfulLimitObservation(dir.budgets)
      ? dir.budgets.groupLimits.get(group.workspaceId)?.get(group.id) ?? null
      : null;
    const cycleAgentSpendUsd = qualifiedGroupSpendComponents(
      cycleUsage.rollup, req.authz!, sourceGroups).agentSpendUsd;
    const hasAgentLimit = monthlyAgentLimitUsd != null && monthlyAgentLimitUsd > 0;

    res.setHeader("Server-Timing", `group;dur=${(performance.now() - startedAt).toFixed(1)}`);
    res.json(
      GetGroupDetailResponse.parse({
        group: {
          groupId: group.id,
          workspaceId: group.workspaceId,
          workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
          name: group.name,
          familyKey: dir.account.roleGroupsById.get(group.id)!.familyKey,
          familyName: dir.account.roleGroupsById.get(group.id)!.familyName,
          role: dir.account.roleGroupsById.get(group.id)!.role,
          isLegacy: dir.account.roleGroupsById.get(group.id)!.isLegacy,
          teamName: targetTeamForGroup(group, dir.account, groupTeamsRows) ?? null,
          type: group.type,
          memberCount: userIds.length,
          rollupMemberCount: mergedRollupMemberCount,
          spendLoaded: totalSpendLoaded,
          spendUsd: combinedSpend,
          paceSpendLoaded: false,
          paceSpendUsd: combinedSpend,
          projectSpendLoaded,
          projectSpendUsd,
          rollupSpendLoaded: qualifiedDataComplete,
          rollupSpendUsd: combinedSpend,
          spendUpdatedAt: usage.snapshot.dataAsOf,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd: combinedLoaded && hasBudget ? budget.amountUsd! - combinedSpend : null,
          percentUsed: combinedLoaded && hasBudget ? (combinedSpend / budget.amountUsd!) * 100 : null,
          monthlyAgentLimitUsd,
          cycleAgentSpendUsd,
          agentRemainingUsd: hasAgentLimit
            ? monthlyAgentLimitUsd! - cycleAgentSpendUsd
            : null,
          agentPercentUsed: hasAgentLimit
            ? (cycleAgentSpendUsd / monthlyAgentLimitUsd!) * 100
            : null,
          agentBlocked: hasAgentLimit && cycleAgentSpendUsd >= monthlyAgentLimitUsd!,
          thresholdsFired: fired,
          history: detailHistoryArr,
          projectedSpendUsd: combinedLoaded
            ? projectEndOfPeriod(combinedSpend, usage.selection.window.start, usage.selection.window.end)
            : null,
        },
        members,
        membersSpendUsd: listedMembersSpend,
        unattributedSpendUsd: unattributed,
        isComplete: combinedLoaded,
        usageHealth: qualifiedGroupUsageHealth(usage),
        rangeLabel: usage.selection.label,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getGroupDetail failed");
    res.status(503).json({ error: "Usage snapshot unavailable" });
  }
});

router.get("/groups/:groupId/projects", async (req, res): Promise<void> => {
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    // Non-disclosing: out-of-scope groups are indistinguishable from missing.
    if (!group || !canSeeGroup(req.authz!, group)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const usage = await usageForRequest(req.authz!, dir, req.query as Record<string, unknown>);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const mergePlan = buildCanonicalGroupMergePlan(usage.groups, dir.workspaces);
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
    const sourceGroups = sourceIds.map((id) =>
      usage.groups.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is EnterpriseGroup => !!candidate);
    const titlesComplete = sourceGroups.every((source) =>
      usage.projectMetadata.completeWorkspaceIds.has(source.workspaceId));
    const isComplete = qualifiedGroupDataComplete(usage.snapshot) && titlesComplete;
    const projects = sourceGroups.flatMap((source) =>
      Array.from(usage.snapshot.projects.get(source.workspaceId)?.entries() ?? [])
          .filter(([projectId]) => {
            const key = projectAttributionKey(source.workspaceId, projectId);
            const creatorId =
              usage.rollup.projectAttribution.creatorByProject.get(key) ?? null;
            return usage.rollup.projectAttribution.projectToGroup.get(key) === source.id &&
              creatorId !== null &&
              (scopedMembers.get(source.id) ?? []).includes(creatorId);
          })
          .map(([projectId, p]) => {
            const info = usage.projectMetadata.byWorkspace
              .get(source.workspaceId)?.get(projectId);
            const aiSpendUsd = p.aiCostUsd;
            const creatorId = info?.creatorId ?? null;
            return {
              projectId,
              title: info?.title ?? null,
              totalCostUsd: p.totalCostUsd,
              aiSpendUsd,
              nonAiSpendUsd: Math.max(0, p.totalCostUsd - aiSpendUsd),
              creatorId,
              creatorName: creatorId
                ? (dir.members.get(creatorId)?.name ?? dir.members.get(creatorId)?.username ?? null)
                : null,
              creatorIsCurrentMember:
                creatorId !== null &&
                (scopedMembers.get(source.id) ?? []).includes(creatorId),
              metrics: [],
              workspaceId: source.workspaceId,
              workspaceName: dir.workspaces.get(source.workspaceId)?.name ?? null,
            };
          }))
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    // Reconciliation: sum of project rows vs. group total.
    // Anchor to groupSpend.spendUsd (the same figure shown in the header stat card)
    // so the project table total always matches the group's reported spend.
    // Fall back to projectUsage.totalCostUsd only when the plain-group spend
    // hasn't loaded yet.
    const projectsSum = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
    const groupTotal = qualifiedGroupSpendComponents(
      usage.rollup, req.authz!, sourceGroups).spendUsd;
    const unattributedSpendUsd = Math.max(0, groupTotal - projectsSum);

    res.json(
      GetGroupProjectsResponse.parse({
        projects,
        unattributedSpendUsd,
        isComplete,
        titlesComplete,
        usageHealth: qualifiedGroupUsageHealth(usage),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getGroupProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/clusters/:clusterKey/headline", async (req, res): Promise<void> => {
  try {
    const groupIds = String(req.params["clusterKey"])
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (groupIds.length === 0) {
      res.status(400).json({ error: "No group IDs in cluster key" });
      return;
    }

    const dir = await getDirectory();
    const requested = groupIds.map((id) => dir.groups.find((group) => group.id === id));
    if (requested.some((group) => !group || !canSeeGroup(req.authz!, group))) {
      res.status(404).json({ error: "No matching groups found" });
      return;
    }
    const roleOrder = { admin: 0, member: 1, viewer: 2, guest: 3, unsuffixed: 4 };
    const requestedFamilies = requested.map(
      (group) => dir.account.roleGroupsById.get(group!.id)!,
    );
    const familyName = requestedFamilies[0]!.familyName;
    const roles = [...new Set(requestedFamilies.map((family) => family.role))]
      .sort((a, b) => roleOrder[a] - roleOrder[b]);
    const usage = await usageForRequest(req.authz!, dir, req.query as Record<string, unknown>);
    const visible = usage.groups;
    const accountMergePlan = buildCanonicalGroupMergePlan(visible, dir.workspaces);
    const relevantGroupIds = new Set(
      groupIds.flatMap((groupId) => {
        const primaryId = accountMergePlan.primaryByGroupId.get(groupId) ?? groupId;
        return accountMergePlan.mergeMap.get(primaryId) ?? [groupId];
      }),
    );
    const canonical = usage.rollup;
    const primaryIds = new Set(
      groupIds.map((groupId) => accountMergePlan.primaryByGroupId.get(groupId) ?? groupId),
    );
    const spendUsd = [...primaryIds].reduce(
      (sum, groupId) => sum + (accountMergePlan.mergeMap.get(groupId) ?? [groupId])
        .reduce((subtotal, id) => subtotal + (canonical.byGroup.get(id)?.spendUsd ?? 0), 0),
      0,
    );
    res.json(GetCanonicalClusterHeadlineResponse.parse({
      familyName,
      roles,
      spendUsd,
      isComplete: canonical.isComplete,
      pendingCount: canonical.pendingCount,
      usageHealth: usageHealth(usage.snapshot, usage.rollup, req.authz!),
    }));
  } catch (err) {
    req.log.error({ err }, "getClusterHeadline failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/clusters/:clusterKey/projects", async (req, res): Promise<void> => {
  try {
    const rawKey = String(req.params["clusterKey"]);
    const groupIds = rawKey.split(",").map((id) => id.trim()).filter(Boolean);
    if (groupIds.length === 0) {
      res.status(400).json({ error: "No group IDs in cluster key" });
      return;
    }

    const dir = await getDirectory();
    const requestedGroups = groupIds
      .map((id) => dir.groups.find((g) => g.id === id))
      .filter((g): g is EnterpriseGroup => g !== undefined);

    // Fail closed if any requested group is missing or outside the caller's
    // workspace scope. Returning the same 404 avoids disclosing its existence.
    if (
      requestedGroups.length !== groupIds.length ||
      requestedGroups.some((group) => !canSeeGroup(req.authz!, group))
    ) {
      res.status(404).json({ error: "No matching groups found" });
      return;
    }
    const groups = requestedGroups;
    const usageContext = await usageForRequest(
      req.authz!, dir, req.query as Record<string, unknown>);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const workspaceIds = new Set(groups.map((group) => group.workspaceId));

    // Member set — union of all members across constituent groups
    const memberSet = new Set<string>();
    for (const g of groups) {
      for (const userId of scopedMembers.get(g.id) ?? []) {
        memberSet.add(userId);
      }
    }

    // Collect unique projects across all sub-groups; de-dup by taking max totalCostUsd entry.
    // When the same project appears in multiple sub-group responses (because the creator is in
    // multiple sub-groups), we pick the entry with the highest reported total rather than summing,
    // which would inflate the figure.
    const projectMap = new Map<
      string,
      {
        entry: { projectId: string; totalCostUsd: number; aiCostUsd: number };
        workspaceId: string;
        groupId: string;
      }
    >();
    for (const g of groups) {
      for (const [projectId, totals] of usageContext.snapshot.projects.get(g.workspaceId) ?? []) {
        if (
          usageContext.rollup.projectAttribution.projectToGroup.get(
            projectAttributionKey(g.workspaceId, projectId),
          ) !== g.id
        ) continue;
        const entry = { projectId, ...totals };
        const projectKey = projectAttributionKey(g.workspaceId, projectId);
        const existing = projectMap.get(projectKey);
        if (
          !existing ||
          entry.totalCostUsd > existing.entry.totalCostUsd ||
          (
            entry.totalCostUsd === existing.entry.totalCostUsd &&
            g.id.localeCompare(existing.groupId) < 0
          )
        ) {
          projectMap.set(projectKey, {
            entry,
            workspaceId: g.workspaceId,
            groupId: g.id,
          });
        }
      }
    }

    // Project info (creatorId) availability — needed for exact attribution
    const projectInfoLoaded = Array.from(workspaceIds).every((wsId) =>
      usageContext.projectMetadata.completeWorkspaceIds.has(wsId));

    // Attribute projects by creator membership
    const attributed: {
      projectId: string;
      title: string | null;
      totalCostUsd: number;
      aiSpendUsd: number;
      nonAiSpendUsd: number;
      creatorId: string | null;
      creatorName: string | null;
      creatorIsCurrentMember: boolean;
      metrics: [];
      workspaceId: string | null;
      workspaceName: string | null;
    }[] = [];
    let unattributedSpendUsd = 0;

    for (const { entry, workspaceId } of projectMap.values()) {
      const info = usageContext.projectMetadata.byWorkspace
        .get(workspaceId)?.get(entry.projectId);
      const creatorId = info?.creatorId ?? null;
      const aiSpendUsd = entry.aiCostUsd;
      const nonAiSpendUsd = Math.max(0, entry.totalCostUsd - aiSpendUsd);
      const creatorIsCurrentMember = creatorId !== null && memberSet.has(creatorId);
      attributed.push({
        projectId: entry.projectId,
        title: info?.title ?? null,
        totalCostUsd: entry.totalCostUsd,
        aiSpendUsd,
        nonAiSpendUsd,
        creatorId,
        creatorName: creatorId
          ? (dir.members.get(creatorId)?.name ?? dir.members.get(creatorId)?.username ?? null)
          : null,
        creatorIsCurrentMember,
        metrics: [],
        workspaceId,
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
      });
      if (!creatorIsCurrentMember) {
        unattributedSpendUsd += nonAiSpendUsd;
      }
    }

    attributed.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    res.json(
      GetGroupProjectsResponse.parse({
        projects: attributed,
        unattributedSpendUsd,
        isComplete: usageContext.rollup.isComplete && projectInfoLoaded,
        titlesComplete: projectInfoLoaded,
        usageHealth: usageHealth(usageContext.snapshot, usageContext.rollup, req.authz!),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getClusterProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});


export default router;
