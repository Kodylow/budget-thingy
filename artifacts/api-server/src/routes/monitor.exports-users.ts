import { Router } from "express";
import { escapeCsvCell } from "./monitor.shared";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

router.get("/export/users.csv", async (req, res): Promise<void> => {
  let selection: UsageWindowSelection;
  try {
    selection = windowFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  let dir: Awaited<ReturnType<typeof getDirectory>>;
  try {
    dir = await getDirectory();
  } catch (err) {
    req.log.error({ err }, "export directory fetch failed");
    res.status(503).json({ error: "Directory unavailable" });
    return;
  }

  const requestedIds = String(req.query["groupIds"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (requestedIds.length === 0) {
    res.status(400).json({ error: "At least one group ID is required" });
    return;
  }
  const uniqueRequestedIds = [...new Set(requestedIds)];
  const requestedGroups = uniqueRequestedIds.map((id) =>
    dir.groups.find((group) => group.id === id),
  );
  // Fail closed without revealing whether an unknown or inaccessible group exists.
  if (
    requestedGroups.some((group) => !group) ||
    requestedGroups.some((group) => group && !canSeeGroup(req.authz!, group))
  ) {
    res.status(404).json({ error: "No matching groups found" });
    return;
  }

  const visible = visibleGroups(req.authz!, dir.groups);
  const groupTeams = await db.select().from(teamLimitTargetsTable);
  const teamNameMap = buildGroupTeamMap(visible, dir.account, new Set(), groupTeams);
  const mergePlan = buildCanonicalGroupMergePlan(
    visible,
    dir.workspaces,
    teamNameMap,
  );
  const primaryIds = uniqueRequestedIds.map(
    (id) => mergePlan.primaryByGroupId.get(id) ?? id,
  );
  const exportGroupIds = [...new Set(
    primaryIds.flatMap((id) => mergePlan.mergeMap.get(id) ?? [id]),
  )];
  const exportGroupIdSet = new Set(exportGroupIds);
  const exportGroups = visible.filter((group) => exportGroupIdSet.has(group.id));

  const scopedWorkspaceIds = workspaceScope(req.authz!, dir, visible);
  const [snapshot, projectMetadata] = await Promise.all([
    readUsageSnapshot({
      window: selection.window,
      workspaceIds: scopedWorkspaceIds,
    }),
    readProjectMetadata(scopedWorkspaceIds),
  ]);
  const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
  const canonical = computeSnapshotUsageRollup({
    snapshot, groups: visible, membersByGroup: scopedMembers,
    internalUserIds: dir.internalUserIds,
    projectInfoByWorkspace: projectMetadata.byWorkspace,
  });

  const sortedGroupsForCsv = [...exportGroups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const requestedMemberIds = new Set(
    sortedGroupsForCsv.flatMap((group) => scopedMembers.get(group.id) ?? []),
  );
  const userGroupAttr = canonicalUserAttribution(
    canonical,
    sortedGroupsForCsv,
    scopedMembers,
    teamNameMap,
  );
  const rows: { email: string; name: string; username: string; isInternal: boolean; group: string; team: string; workspaces: string; aiSpendUsd: number; nonAiSpendUsd: number; spendUsd: number }[] = [];
  for (const userId of requestedMemberIds) {
    const member = dir.members.get(userId);
    if (!member) continue;
    const attr = userGroupAttr.get(userId);
    const memberGroups = sortedGroupsForCsv.filter((group) =>
      (scopedMembers.get(group.id) ?? []).includes(userId),
    );
    const workspaceNames = [...new Set(
      memberGroups.map((group) => dir.workspaces.get(group.workspaceId)?.name ?? group.workspaceId),
    )];
    const sumForUser = (byGroup: ReadonlyMap<string, ReadonlyMap<string, number>>) =>
      exportGroupIds.reduce((sum, id) => sum + (byGroup.get(id)?.get(userId) ?? 0), 0);
    rows.push({
      email: member.email,
      name: member.name ?? "",
      username: member.username,
      isInternal: member.isInternalReplitUser,
      group: attr?.groupName ?? "",
      team: attr?.teamName ?? "",
      workspaces: workspaceNames.join("; "),
      aiSpendUsd: sumForUser(canonical.aiSpendByGroup),
      nonAiSpendUsd: sumForUser(canonical.nonAiSpendByGroup),
      spendUsd: exportGroupIds.reduce(
        (sum, id) => sum + (canonical.byGroup.get(id)?.byUser.get(userId) ?? 0), 0),
    });
  }

  // Sort by spend descending
  rows.sort((a, b) => b.spendUsd - a.spendUsd);

  // Build CSV
  const header = ["Email", "Name", "Username", "Internal Replit User", "Workspace(s)", "Group", "Team", "Eligible AI Spend (USD)", "Eligible Hosting / Non-AI Spend (USD)", "Eligible Spend (USD)"].map(escapeCsvCell).join(",");
  const lines = rows.map((r) =>
    [r.email, r.name, r.username, r.isInternal ? "Yes" : "No", r.workspaces, r.group, r.team, r.aiSpendUsd.toFixed(2), r.nonAiSpendUsd.toFixed(2), r.spendUsd.toFixed(2)].map(escapeCsvCell).join(","),
  );

  const isComplete = canonical.isComplete;
  const csv = [header, ...lines].join("\r\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${primaryIds.length === 1 ? "group-users" : "group-cluster-users"}-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.setHeader("X-Groups-Loaded", String(canonical.isComplete ? exportGroups.length : 0));
  res.setHeader("X-Groups-Total", String(exportGroups.length));
  res.setHeader("X-Export-Complete", String(isComplete));
  res.setHeader("X-Usage-Window", `${selection.window.start}/${selection.window.end}`);
  res.send(csv);
});

// ── GET /users/activity ───────────────────────────────────────────────────────
// Returns workspace members with canonical all-metric spend for the selected range.
// Each user-workspace pair is counted once and distinct workspaces are summed.
// The displayed group/team is the user's highest-spend group (primary cost center).
// NOTE: these per-user totals can exceed the deduped budget totals in /groups
// and /summary, which attribute shared users to a single group to avoid
// double-counting group budgets — different accounting views by design.
// Scoped to the caller's visible groups: account admins see all members;
// workspace admins see only members in their visible groups. Responds
// immediately with cached data; isComplete=false while usage is still loading.
router.get("/users/activity", async (req, res): Promise<void> => {
  let selection: UsageWindowSelection;
  try {
    selection = windowFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  let dir: Awaited<ReturnType<typeof getDirectory>>;
  try {
    dir = await getDirectory();
  } catch (err) {
    req.log.error({ err }, "users/activity directory fetch failed");
    res.status(503).json({ error: "Directory unavailable" });
    return;
  }

  // Scope groups to what the caller can see, then apply deterministic ordering
  // (matches the orderGroups() logic in usage-rollup.ts)
  const scopedGroups = visibleGroups(req.authz!, dir.groups);
  const orderedGroups = [...scopedGroups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );

  const groupTeams = await db.select().from(teamLimitTargetsTable);
  const teamNameMap = buildGroupTeamMap(orderedGroups, dir.account, new Set(), groupTeams);

  const callerIsAccountAdmin = isAccountWide(req.authz);
  const groupedWorkspaceIds = orderedGroups.map((group) => group.workspaceId);
  const scopedWorkspaceIds = callerIsAccountAdmin
    ? new Set([...dir.workspaces.keys(), ...groupedWorkspaceIds])
    : new Set([...req.authz!.workspaceIds, ...groupedWorkspaceIds]);
  const activityScope = scopeFor(req.authz!);
  const visibleUserIds = "kind" in activityScope
    ? new Set(dir.members.keys())
    : activityScope.userIds;

  const [snapshot, projectMetadata] = await Promise.all([
    readUsageSnapshot({
      window: selection.window,
      workspaceIds: scopedWorkspaceIds,
    }),
    readProjectMetadata(scopedWorkspaceIds),
  ]);
  const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
  const canonical = computeSnapshotUsageRollup({
    snapshot,
    groups: orderedGroups,
    membersByGroup: scopedMembers,
    internalUserIds: dir.internalUserIds,
    projectInfoByWorkspace: projectMetadata.byWorkspace,
  });
  const userGroupAttr = canonicalUserAttribution(
    canonical,
    orderedGroups,
    scopedMembers,
    teamNameMap,
  );

  // Pass 2: emit one entry per relevant member.
  // Workspace admins see only members in their visible groups.
  const users: {
    userId: string;
    username: string;
    email: string;
    teamName: string;
    groupName: string;
    spendUsd: number;
    aiSpendUsd: number;
    nonAiSpendUsd: number;
    workspaceRole: string;
    isInternal: boolean;
  }[] = [];

  for (const [userId, m] of dir.members) {
    if (!callerIsAccountAdmin && !visibleUserIds.has(userId)) continue;

    const attr = userGroupAttr.get(userId);
    let workspaceRole = "member";
    if (m.isAccountAdmin) {
      workspaceRole = "account_admin";
    } else if (attr) {
      const ws = m.workspaces.get(attr.workspaceId);
      if (ws) workspaceRole = ws.role;
    } else {
      const first = m.workspaces.values().next().value;
      if (first) workspaceRole = (first as { role: string }).role;
    }

    users.push({
      userId,
      username: m.username,
      email: m.email,
      isInternal: m.isInternalReplitUser,
      teamName: attr?.teamName ?? "",
      groupName: attr?.groupName ?? "",
      spendUsd: canonical.byUser.get(userId) ?? 0,
      aiSpendUsd: canonical.aiSpendByUser.get(userId) ?? 0,
      nonAiSpendUsd: canonical.nonAiSpendByUser.get(userId) ?? 0,
      workspaceRole,
    });
  }

  // Sort spend descending
  users.sort((a, b) => b.spendUsd - a.spendUsd);

  const totalCount = scopedWorkspaceIds.size;
  const fullyVisibleWorkspaceIds = new Set(req.authz!.workspaceIds);
  const additionallyVisibleGroups = orderedGroups.filter(
    (group) => !fullyVisibleWorkspaceIds.has(group.workspaceId),
  );
  const eligibleSpendUsd = callerIsAccountAdmin
    ? canonical.eligibleSpendUsd
    : [...fullyVisibleWorkspaceIds].reduce(
        (sum, workspaceId) =>
          sum + (canonical.byWorkspace.get(workspaceId) ?? 0),
        0,
      ) +
      additionallyVisibleGroups.reduce(
        (sum, group) => sum + (canonical.byGroup.get(group.id)?.spendUsd ?? 0),
        0,
      );
  const excludedInternalSpendUsd = callerIsAccountAdmin
    ? canonical.excludedInternalSpendUsd
    : [...fullyVisibleWorkspaceIds].reduce(
        (sum, workspaceId) =>
          sum +
          (canonical.excludedInternalSpendByWorkspace.get(workspaceId) ?? 0),
        0,
      ) +
      additionallyVisibleGroups.reduce(
        (sum, group) =>
          sum + (canonical.excludedInternalSpendByGroup.get(group.id) ?? 0),
        0,
      );
  res.json(GetUserActivityResponse.parse({
    usageHealth: usageHealth(snapshot, canonical, req.authz!),
    grossSpendUsd: eligibleSpendUsd + excludedInternalSpendUsd,
    excludedInternalSpendUsd,
    eligibleSpendUsd,
    isComplete: canonical.isComplete,
    loadedCount: Math.max(0, totalCount - canonical.pendingCount),
    totalCount,
    users,
  }));
});

// ---------- Directory members ----------


export default router;
