import { Router } from "express";
import { escapeCsvCell } from "./monitor.shared";
import { type IRouter, type Response, eq, desc, inArray, db, pool, groupBudgetsTable, teamLimitTargetsTable, teamBudgetsTable, adminEmailsTable, alertsTable, appAdminsTable, usersTable, apiProjectMetadataTable, apiProjectMetadataStateTable, usageLimitAuditsTable, ListGroupsResponse, GetSummaryResponse, ListBudgetsResponse, SetGroupBudgetBody, SetGroupBudgetResponse, DeleteGroupBudgetResponse, GetTeamsBudgetsResponse, ListAdminsResponse, AddAdminBody, AddAdminResponse, DeleteAdminResponse, ListWorkspaceAdminsResponse, ListAlertsQueryParams, ListAlertsResponse, RunAlertCheckResponse, SendTestAlertResponse, SendEmailTestExampleBody, SendEmailTestExampleResponse, GetStatusResponse, GetGroupDetailResponse, GetGroupProjectsResponse, GetCanonicalClusterHeadlineResponse, GetTrendsQueryParams, GetTrendsResponse, ListAppAdminsResponse, AddAppAdminBody, AddAppAdminResponse, DeleteAppAdminResponse, ListDirectoryGroupsResponse, GetTeamBudgetHistoryResponse, GetTeamAllocationAuditResponse, UpdateTeamAnnualAllocationParams, UpdateTeamAnnualAllocationBody, UpdateTeamAnnualAllocationResponse, UpdateTeamVisibilityParams, UpdateTeamVisibilityBody, UpdateTeamVisibilityResponse, GetTeamBudgetSyncStatusResponse, RetryTeamBudgetUpstreamSyncResponse, RefreshTeamBudgetsResponse, UpdateTeamBudgetLimitParams, UpdateTeamBudgetLimitBody, UpdateTeamBudgetLimitResponse, ApplyTeamBudgetLimitsBody, ApplyTeamBudgetLimitsResponse, GetTeamBudgetTargetsResponse, AssignTeamBudgetTargetBody, AssignTeamBudgetTargetResponse, UpdateTeamBudgetTargetParams, UpdateTeamBudgetTargetBody, UpdateTeamBudgetTargetResponse, ListVisibleWorkspacesResponse, ListVisibleWorkspaceMembersResponse, SetWorkspaceMemberBudgetBody, SetWorkspaceMemberBudgetResponse, ClearWorkspaceMemberBudgetResponse, BulkSetWorkspaceMemberBudgetsBody, BulkSetWorkspaceMemberBudgetsResponse, ListWorkspaceUsageLimitAuditsResponse, GetUserActivityResponse, GetAccountUsageObservationExportQueryParams, GetAccountUsageObservationExportResponse, GetEmailSettingsResponse, UpdateEmailSettingsBody, UpdateEmailSettingsResponse, isConfigured, getApiHealth, getDirectory, getDirectoryFreshness, getBillingPeriod, getBillingPeriodMetadata, buildCanonicalGroupMergePlan, buildCanonicalEffectiveTeams, type CanonicalAccountDirectory, resolveCanonicalMergedGroupBudget, type EnterpriseGroup, buildAlertEmail, isEmailConfigured, sendEmail, sendTestEmail, getEmailTestRecipient, resolveAlertRecipients, runCheck, getFiredThresholds, getFiredThresholdsBatch, getLastCheckAt, getCheckerState, requireAuth, requireRole, requireCapability, requireTrueAccountAdmin, requireUserLimitWorkspace, canSeeGroup, isAccountWide, isAdminRole, scopeGroups, type Authorization, scopeFor, getRosterHistory, projectEndOfPeriod, generateTrendBuckets, getEffectiveTeamBudgets, applyTeamBudgetLimits, assignTeamLimitTarget, getFreshEligibleTeamLimitGroup, getTeamLimitTargetConfiguration, getTeamBudgetUpstreamSyncRows, getVisibleEffectiveTeamBudgetMap, queueTeamBudgetUpstreamReconciliation, reconcileTeamBudgetsUpstream, refreshTeamBudgetSnapshot, updateTeamMonthlyLimit, updateTeamAnnualAllocation, updateTeamVisibility, getTeamAllocationAudits, updateTeamLimitTargetOverride, TEAM_BUDGET_REQUIRED_APPROVAL_STATUS, TEAM_BUDGET_SOURCE_TABLE, listReplitMemberBudgets, ReplitBudgetConnectorError, setReplitMemberBudget, resolveUsageWindow, USAGE_DATA_CUTOFF_ISO, type UsageWindowSelection, readUsageSnapshot, type UsageSnapshot, computeDedupedMemberCounts, computeHistoricalSnapshotUsageRollups, computeSnapshotUsageRollup, projectAttributionKey, type SnapshotUsageRollup, BACKGROUND_CYCLE_INTERVAL_MINUTES, runCycle, getNotificationSettings, updateNotificationSettings, visibleGroups, visibleGroupMembers, visibleRosterMembers, buildTeamAlertCanonicalScope, canSeeAlertEntity, targetTeamForGroup, groupTeamKey, buildGroupTeamMap, windowFromQuery, workspaceScope, readProjectMetadata, usageForRequest, usageHealth, dailyUsageRollups, effectiveGroupBudget, mergedGroupMemberIds, canonicalUserAttribution, alertToJson } from "./monitor.shared";

const router = Router();

router.get("/projects/export", async (req, res): Promise<void> => {
  let selection: UsageWindowSelection;
  try {
    selection = windowFromQuery(req.query as Record<string, unknown>);
  } catch {
    selection = windowFromQuery({});
  }

  try {
    const [dir, groupTeams] = await Promise.all([
      getDirectory(),
      db.select().from(teamLimitTargetsTable),
    ]);

    const groups = visibleGroups(req.authz!, dir.groups);
    const scopedMembers = visibleGroupMembers(req.authz!, dir.groupMembers);
    const groupTeamMap = buildGroupTeamMap(groups, dir.account, new Set(), groupTeams);
    const scopedWorkspaceIds = workspaceScope(req.authz!, dir, groups);
    const [snapshot, projectMetadata] = await Promise.all([
      readUsageSnapshot({
        window: selection.window,
        workspaceIds: scopedWorkspaceIds,
      }),
      readProjectMetadata(scopedWorkspaceIds),
    ]);
    const rollup = computeSnapshotUsageRollup({
      snapshot,
      groups,
      membersByGroup: scopedMembers,
      projectInfoByWorkspace: projectMetadata.byWorkspace,
    });

    const workspaceIds = new Set(groups.map((g) => g.workspaceId));

    // Aggregate across all groups: one row per projectId.
    // Dedup strategy: keep the entry with the highest reported spend to avoid
    // double-counting when a project appears in multiple groups because its
    // creator belongs to more than one group.  Track every group that
    // reported the project for informational columns.
    const projectMap = new Map<string, {
      entry: { projectId: string; totalCostUsd: number; aiCostUsd: number };
      workspaceId: string;
      winnerGroupId: string;
      groupNames: Set<string>;
      groupIds: Set<string>;
    }>();

    for (const g of groups) {
      for (const [projectId, totals] of snapshot.projects.get(g.workspaceId) ?? []) {
        if (
          rollup.projectAttribution.projectToGroup.get(
            projectAttributionKey(g.workspaceId, projectId),
          ) !== g.id
        ) continue;
        const entry = { projectId, ...totals };
        const projectKey = projectAttributionKey(g.workspaceId, projectId);
        const existing = projectMap.get(projectKey);
        if (!existing) {
          projectMap.set(projectKey, {
            entry,
            workspaceId: g.workspaceId,
            winnerGroupId: g.id,
            groupNames: new Set([g.name]),
            groupIds: new Set([g.id]),
          });
        } else {
          existing.groupNames.add(g.name);
          existing.groupIds.add(g.id);
          if (
            entry.totalCostUsd > existing.entry.totalCostUsd ||
            (
              entry.totalCostUsd === existing.entry.totalCostUsd &&
              g.id.localeCompare(existing.winnerGroupId) < 0
            )
          ) {
            existing.entry = entry;
            existing.workspaceId = g.workspaceId;
            existing.winnerGroupId = g.id;
          }
        }
      }
    }

    // Build output rows
    type ExportRow = {
      projectId: string;
      title: string;
      workspaceName: string;
      ownerName: string;
      ownerUsername: string;
      teams: string;
      groups: string;
      aiUsd: number;
      hostingUsd: number;
      storageUsd: number;
      otherUsd: number;
      creatorIsCurrentMember: boolean;
      attributedGroup: string;
      attributedNonAiUsd: number;
      unattributedNonAiUsd: number;
      totalUsd: number;
    };

    const rows: ExportRow[] = [];

    const orderedGroups = [...groups].sort(
      (a, b) =>
        a.workspaceId.localeCompare(b.workspaceId) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
    for (const { entry, workspaceId, groupNames, groupIds } of projectMap.values()) {
      const info = projectMetadata.byWorkspace.get(workspaceId)?.get(entry.projectId);
      const creatorId = info?.creatorId ?? null;
      const member = creatorId ? dir.members.get(creatorId) : undefined;

      const groupArr = Array.from(groupNames).sort();
      const teamSet = new Set<string>();
      for (const groupId of groupIds) {
        const group = groups.find((candidate) => candidate.id === groupId);
        const t = group && groupTeamMap.get(groupTeamKey(group));
        if (t) teamSet.add(t);
      }

      const aiUsd = entry.aiCostUsd;
      const hostingUsd = 0;
      const storageUsd = 0;
      // totalCostUsd is authoritative even when the API omits or introduces a
      // metric category, so the non-AI breakdown always reconciles to it.
      const otherUsd = Math.max(0, entry.totalCostUsd - aiUsd - hostingUsd - storageUsd);
      const nonAiUsd = Math.max(0, entry.totalCostUsd - aiUsd);
      const creatorOwner = creatorId
        ? orderedGroups.find(
          (group) =>
            group.workspaceId === workspaceId &&
            (scopedMembers.get(group.id) ?? []).includes(creatorId),
        )
        : undefined;
      const creatorIsCurrentMember = creatorOwner !== undefined;
      // This is the canonical stable member owner, not necessarily the
      // highest-total project observation's winning group.
      const attributedGroup = creatorOwner?.name ?? "";
      const attributedNonAiUsd = creatorOwner ? nonAiUsd : 0;
      const unattributedNonAiUsd = creatorOwner ? 0 : nonAiUsd;

      rows.push({
        projectId: entry.projectId,
        title: info?.title ?? "",
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? workspaceId,
        ownerName: member?.name ?? "",
        ownerUsername: member?.username ?? "",
        teams: Array.from(teamSet).sort().join("; "),
        groups: groupArr.join("; "),
        aiUsd,
        hostingUsd,
        storageUsd,
        otherUsd,
        creatorIsCurrentMember,
        attributedGroup,
        attributedNonAiUsd,
        unattributedNonAiUsd,
        totalUsd: entry.totalCostUsd,
      });
    }

    rows.sort((a, b) => b.totalUsd - a.totalUsd);

    // Emit CSV
    const fmt = (n: number) => n.toFixed(4);

    const header = [
      "Project Title",
      "Project ID",
      "Workspace",
      "Owner Name",
      "Owner Username",
      "Creator Is Current Member",
      "Attributed Group",
      "Team(s)",
      "Group(s)",
      "AI ($)",
      "Hosting ($)",
      "Storage ($)",
      "Other ($)",
      "Attributed Non-AI ($)",
      "Unattributed Non-AI Residual ($)",
      "Total ($)",
    ];

    const lines: string[] = [header.map(escapeCsvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          escapeCsvCell(r.title),
          escapeCsvCell(r.projectId),
          escapeCsvCell(r.workspaceName),
          escapeCsvCell(r.ownerName),
          escapeCsvCell(r.ownerUsername),
          escapeCsvCell(r.creatorIsCurrentMember ? "Yes" : "No"),
          escapeCsvCell(r.attributedGroup),
          escapeCsvCell(r.teams),
          escapeCsvCell(r.groups),
          fmt(r.aiUsd),
          fmt(r.hostingUsd),
          fmt(r.storageUsd),
          fmt(r.otherUsd),
          fmt(r.attributedNonAiUsd),
          fmt(r.unattributedNonAiUsd),
          fmt(r.totalUsd),
        ].join(","),
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const filename = `project-spend-${today}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(lines.join("\r\n"));
  } catch (err) {
    req.log.error({ err }, "projectsExport failed");
    res.status(503).json({ error: "Failed to generate export" });
  }
});

// Notification recipients are account-only data; workspace admins can neither
// view nor modify them.

export default router;
