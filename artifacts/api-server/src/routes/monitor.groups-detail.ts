import { Router } from "express";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

router.get("/groups/:groupId", async (req, res): Promise<void> => {
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
    const dailyRollups = await dailyUsageRollups(dir, usage);
    const mergePlan = buildCanonicalGroupMergePlan(usage.groups, dir.workspaces);
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
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
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const rollupMemberCounts = computeDedupedMemberCounts(usage.groups, scopedMembers);
    const projectAttribution = canonical.projectAttribution;
    const projectSpendUsd = sourceIds.reduce(
      (sum, id) => sum + (projectAttribution.spendByGroup.get(id) ?? 0),
      0,
    );
    const projectSpendLoaded = projectAttribution.isComplete;

    const attributed = {
      spendUsd: sourceIds.reduce((sum, id) => sum + (canonical.byGroup.get(id)?.spendUsd ?? 0), 0),
      byUser: (() => {
        const m = new Map<string, number>();
        for (const id of sourceIds) {
          for (const [uid, s] of canonical.byGroup.get(id)?.byUser ?? []) {
            m.set(uid, (m.get(uid) ?? 0) + s);
          }
        }
        return m;
      })(),
    };

    const [budgets, groupTeamsRows] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(teamLimitTargetsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const mergedBudget = resolveCanonicalMergedGroupBudget(group.id, mergePlan, budgetMap);
    const budget = effectiveGroupBudget(mergedBudget?.amountUsd);
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingPeriodStart = getBillingPeriod().start;
    const fired =
      billingPeriodStart && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingPeriodStart)
        : [];

    const detailHistoryArr = [...dailyRollups].map(([date, daily]) => ({
      date,
      spendUsd: sourceIds.reduce(
        (sum, id) => sum + (daily.byGroup.get(id)?.spendUsd ?? 0), 0),
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
      const spendLoaded = canonical.isComplete;
      const totalSpendLoaded = canonical.isComplete;
      const totalSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (canonical.byGroup.get(id)?.byUser.get(userId) ?? 0), 0);
      const aiSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (canonical.aiSpendByGroup.get(id)?.get(userId) ?? 0),
        0,
      );
      const nonAiSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (canonical.nonAiSpendByGroup.get(id)?.get(userId) ?? 0),
        0,
      );
      return {
        userId,
        username: m?.username ?? null,
        email: m?.email ?? null,
        name: m?.name ?? null,
        role: ws?.role ?? null,
        isDisabled: ws?.isDisabled ?? null,
        allocatedBudgetUsd: null,
        budgetSource: null,
        spendLoaded,
        spendUsd: totalSpendUsd,
        aiSpendUsd,
        nonAiSpendUsd,
        remainingUsd: null,
        percentUsed: null,
      };
    });

    // Reconciliation: members removed from the group since the last sync still count
    // toward group spend (they are captured in the rollup).  unattributedSpendUsd
    // surfaces that residual so the cluster page can show an accurate attributed total.
    const combinedSpend = attributed.spendUsd;
    const combinedLoaded = canonical.isComplete;
    const totalSpendLoaded = canonical.isComplete;
    let listedMembersSpend = 0;
    if (totalSpendLoaded) {
      for (const userId of userIds) {
        listedMembersSpend += sourceIds.reduce(
          (sum, id) => sum + (canonical.byGroup.get(id)?.byUser.get(userId) ?? 0),
          0,
        );
      }
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
    const unattributed = totalSpendLoaded
      ? Math.max(0, combinedSpend - listedMembersSpend)
      : 0;

    const mergedRollupMemberCount = sourceIds.reduce(
      (sum, id) => sum + (rollupMemberCounts.get(id) ?? 0),
      0,
    );

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
          rollupSpendLoaded: canonical.isComplete,
          rollupSpendUsd: combinedSpend,
          spendUpdatedAt: usage.snapshot.dataAsOf,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd: combinedLoaded && hasBudget ? budget.amountUsd! - combinedSpend : null,
          percentUsed: combinedLoaded && hasBudget ? (combinedSpend / budget.amountUsd!) * 100 : null,
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
        usageHealth: usageHealth(usage.snapshot, usage.rollup, req.authz!),
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
    const workspaceProjects = usage.snapshot.projects.get(group.workspaceId) ?? new Map();
    const projectMetadata = usage.projectMetadata.byWorkspace.get(group.workspaceId) ?? new Map();
    const titlesComplete = usage.projectMetadata.completeWorkspaceIds.has(group.workspaceId);
    const isComplete = usage.rollup.isComplete && titlesComplete;
    const projects = Array.from(workspaceProjects.entries())
          .filter(([projectId]) =>
            usage.rollup.projectAttribution.projectToGroup.get(
              projectAttributionKey(group.workspaceId, projectId),
            ) === group.id)
          .map(([projectId, p]) => {
            const info = projectMetadata.get(projectId);
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
                (scopedMembers.get(group.id) ?? []).includes(creatorId),
              metrics: [],
              workspaceId: group.workspaceId,
              workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
            };
          })
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    // Reconciliation: sum of project rows vs. group total.
    // Anchor to groupSpend.spendUsd (the same figure shown in the header stat card)
    // so the project table total always matches the group's reported spend.
    // Fall back to projectUsage.totalCostUsd only when the plain-group spend
    // hasn't loaded yet.
    const projectsSum = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
    const groupTotal = usage.rollup.byGroup.get(group.id)?.spendUsd ?? 0;
    const unattributedSpendUsd = Math.max(0, groupTotal - projectsSum);

    res.json(
      GetGroupProjectsResponse.parse({
        projects,
        unattributedSpendUsd,
        isComplete,
        titlesComplete,
        usageHealth: usageHealth(usage.snapshot, usage.rollup, req.authz!),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getGroupProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/clusters/:clusterKey/headline", async (req, res): Promise<void> => {
  try {
    const groupIds = String(req.params["clusterKey"]).split(",").map((id) => id.trim()).filter(Boolean);
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
