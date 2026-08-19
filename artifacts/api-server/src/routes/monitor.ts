import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  groupBudgetsTable,
  groupTeamsTable,
  teamBudgetsTable,
  adminEmailsTable,
  alertsTable,
  editorAllowlistTable,
  editorBootstrapStateTable,
  usersTable,
} from "@workspace/db";
import {
  ListGroupsResponse,
  RefreshGroupUsageResponse,
  GetSummaryResponse,
  ListBudgetsResponse,
  SetGroupBudgetBody,
  SetGroupBudgetResponse,
  DeleteGroupBudgetResponse,
  GetTeamsBudgetsResponse,
  SetTeamBudgetBody,
  SetTeamBudgetResponse,
  ListAdminsResponse,
  AddAdminBody,
  AddAdminResponse,
  DeleteAdminResponse,
  ListAlertsQueryParams,
  ListAlertsResponse,
  RunAlertCheckResponse,
  SendTestAlertResponse,
  GetStatusResponse,
  GetGroupDetailResponse,
  GetGroupProjectsResponse,
  GetTrendsQueryParams,
  GetTrendsResponse,
  ListEditorsResponse,
  AddEditorBody,
  AddEditorResponse,
  DeleteEditorResponse,
} from "@workspace/api-zod";
import {
  isConfigured,
  getApiHealth,
  getDirectory,
  getSpend,
  getBillingPeriod,
  queueGroupSpendFetch,
  refreshAllGroupSpends,
  queueMemberUsageFetch,
  getMemberUsage,
  queueExtraWorkspacesFetch,
  getExtraWorkspaceSpend,
  queueAllWorkspacesFetch,
  getWsSpendByUser,
  queueProjectUsageFetch,
  getProjectUsage,
  queueProjectTitlesFetch,
  getProjectTitles,
  getProjectInfo,
  hasProjectInfo,
  getDedupedUsageRollup,
  getDedupedMemberCounts,
  resolveRange,
  isBadRangeError,
  SPEND_DATA_CUTOFF_ISO,
  type UsageRange,
  type EnterpriseGroup,
  type ProjectUsageMetric,
} from "../lib/enterprise";
import { buildAlertEmail, isEmailConfigured, sendEmail } from "../lib/email";
import { resolveAlertRecipients } from "../lib/alert-recipients";
import {
  runCheck,
  getFiredThresholds,
  getLastCheckAt,
  CHECK_INTERVAL_MINUTES,
} from "../lib/checker";
import {
  requireAuth,
  requireAccountAdmin,
  requireAccountOperator,
} from "../middlewares/requireAuth";
import {
  canSeeGroup,
  isApplicationAdmin,
  isAccountWide,
  scopeGroups,
  type Authorization,
} from "../lib/authz";
import { getHistoryForGroups, projectEndOfPeriod } from "../lib/history";

const router: IRouter = Router();

// Every monitor endpoint requires an authenticated, authorized user.
// Health and auth entry points live on separate routers and stay public.
router.use(requireAuth);

/**
 * Reduce a directory's group list to the set visible to the current request's
 * authorization. Account admins see every custom group; workspace admins see
 * only groups whose workspace they administer.
 */
function visibleGroups(authz: Authorization, groups: EnterpriseGroup[]): EnterpriseGroup[] {
  return scopeGroups(authz, groups);
}

function rangeFromQuery(query: Record<string, unknown>): UsageRange {
  return resolveRange(
    typeof query["rangeType"] === "string" ? query["rangeType"] : undefined,
    typeof query["startDate"] === "string" ? query["startDate"] : undefined,
    typeof query["endDate"] === "string" ? query["endDate"] : undefined,
  );
}

interface EffectiveBudget {
  amountUsd: number | null;
  source: "app" | null;
}

function effectiveGroupBudget(appBudget: number | undefined): EffectiveBudget {
  if (appBudget != null) return { amountUsd: appBudget, source: "app" };
  return { amountUsd: null, source: null };
}

/**
 * When the same group name exists in multiple workspaces (e.g. after a workspace
 * migration where "AZ-Replit – Comcast Advertising" was created in the Comcast
 * Advertising workspace while the old copy in the Comcast workspace still carries
 * the billing data), the dashboard would show two rows for the same logical group.
 *
 * This function detects those duplicates and builds a merge plan:
 *   • `mergeMap`      — primaryGroupId → [primaryId, ...aliasIds]
 *   • `hiddenGroupIds` — set of non-primary IDs to exclude from responses
 *
 * Primary selection: prefer the workspace whose name equals the group's suffix
 * (the part after "AZ-Replit – "). For "AZ-Replit – Comcast Advertising" the
 * Comcast Advertising workspace wins. Falls back to alphabetical workspace name.
 *
 * Spend from ALL same-name source groups is summed on the primary so that no
 * spend is lost during the transition period when billing data has not yet
 * migrated to the new workspace.
 */
interface GroupMergePlan {
  /** primary group ID → all source IDs (primary + aliases) */
  mergeMap: Map<string, string[]>;
  /** non-primary group IDs to hide from dashboard/detail responses */
  hiddenGroupIds: Set<string>;
}

function buildGroupMergePlan(
  groups: EnterpriseGroup[],
  workspaces: ReadonlyMap<string, { name: string }>,
): GroupMergePlan {
  const byName = new Map<string, EnterpriseGroup[]>();
  for (const g of groups) {
    const key = g.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(g);
  }

  const mergeMap = new Map<string, string[]>();
  const hiddenGroupIds = new Set<string>();

  for (const [, nameGroups] of byName) {
    if (nameGroups.length <= 1) continue;

    // Extract the body of the group name after "az-replit -" (handles both " - " and " – ").
    // e.g. "AZ-Replit - NBCU - Viewer" → "nbcu - viewer"
    //      "AZ-Replit - Finance - Member" → "finance - member"
    //      "AZ-Replit - PrepProd-Admins" → "prepprod-admins"
    const body = nameGroups[0].name
      .replace(/^az-replit\s*[-–]\s*/i, "")
      .toLowerCase()
      .trim();

    // Try to find the workspace whose name "owns" this group:
    // Match the first dash/space-delimited token of the workspace name against the
    // start of the body.  "NBCU" → token "nbcu", matches body "nbcu - viewer".
    // "Finance-Community" → token "finance", matches body "finance - member".
    // "Global Product" → token "global", does NOT match body "gpo connected living".
    const matchedGroup = nameGroups.find((g) => {
      const wsName = (workspaces.get(g.workspaceId)?.name ?? "").trim().toLowerCase();
      const firstToken = wsName.split(/[-\s]+/)[0] ?? "";
      return firstToken.length >= 2 && body.startsWith(firstToken);
    });

    const primary =
      matchedGroup ??
      // No workspace-name prefix match (e.g. cross-workspace groups like "preprod-admins"):
      // fall back to alphabetical workspace name so the result is deterministic.
      // "Comcast" (the main account workspace) sorts early and naturally becomes the
      // primary for these shared/cross-workspace groups.
      nameGroups.slice().sort((a, b) => {
        const aN = workspaces.get(a.workspaceId)?.name ?? "";
        const bN = workspaces.get(b.workspaceId)?.name ?? "";
        return aN.localeCompare(bN);
      })[0];

    mergeMap.set(primary.id, nameGroups.map((g) => g.id));
    for (const g of nameGroups) {
      if (g.id !== primary.id) hiddenGroupIds.add(g.id);
    }
  }

  return { mergeMap, hiddenGroupIds };
}

/**
 * Given a set of source group IDs (a merged group's aliases), return the union of
 * their directory members (deduped) in stable insertion order.
 */
function mergedGroupMemberIds(
  sourceIds: string[],
  groupMembers: ReadonlyMap<string, readonly string[]>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of sourceIds) {
    for (const uid of groupMembers.get(id) ?? []) {
      if (!seen.has(uid)) { seen.add(uid); result.push(uid); }
    }
  }
  return result;
}

function alertToJson(a: typeof alertsTable.$inferSelect) {
  return {
    id: a.id,
    entityType: a.entityType,
    entityId: a.entityId || a.groupId,
    entityName: a.entityName || a.groupName,
    workspaceIds: a.workspaceIds,
    threshold: a.threshold,
    spendUsd: a.spendUsd,
    budgetUsd: a.budgetUsd,
    recipients: a.recipients,
    sentAt: a.sentAt.toISOString(),
    status: a.status,
    errorMessage: a.errorMessage,
  };
}

router.get("/groups", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const dir = await getDirectory();
    // Scope every fetch, rollup, and computation to the groups this user may
    // see, so workspace admins never receive records or totals from other
    // workspaces (dedup/rollup are recomputed over the visible scope).
    const scoped = visibleGroups(req.authz!, dir.groups);

    // Detect same-name groups across workspaces (e.g. after a workspace migration)
    // so only the preferred workspace version shows as a single merged row.
    const mergePlan = buildGroupMergePlan(scoped, dir.workspaces);
    const displayGroups = scoped.filter((g) => !mergePlan.hiddenGroupIds.has(g.id));

    // Member-level usage is the dashboard's critical path: the deduped rollup
    // cannot render until every visible group has it. Queue it interactively so
    // it preempts checker/snapshot group-total work already waiting at startup.
    // Once synchronized, these entries are durable and hydrate before listen.
    for (const group of scoped) queueMemberUsageFetch(group, range, 0);
    const isAccountAdmin = isAccountWide(req.authz);
    if (isAccountAdmin) {
      queueExtraWorkspacesFetch(dir, range, 0);
      // Also fetch workspace_member data for grouped workspaces: the group_member API
      // only returns AI-agent spend; workspace_member captures compute + all other types.
      queueAllWorkspacesFetch(dir, range, 0);
    }
    // Raw group totals support alerting/history metadata but are not required to
    // construct the member-deduped dashboard, so keep them in the background.
    void refreshAllGroupSpends(1, undefined, range).catch(() => undefined);

    const [budgets, groupTeams] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(groupTeamsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const groupTeamMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));
    const billing = getBillingPeriod();
    const extraSpend = isAccountAdmin
      ? getExtraWorkspaceSpend(dir, range.key)
      : { byUser: new Map<string, number>(), isComplete: true, loadedCount: 0, totalCount: 0 };
    // Pass ALL scoped groups (including aliases) so the dedup rollup correctly
    // attributes shared users across both the old and new workspace versions.
    const rollup = getDedupedUsageRollup(scoped, range.key, extraSpend.byUser, dir.groupMembers);
    const rollupMemberCounts = getDedupedMemberCounts(scoped, dir.groupMembers);

    // Include source group IDs (alias groups) in the history query so merged
    // primaries can show the complete spend history across both workspace versions.
    const allHistoryGroupIds = [
      ...new Set(scoped.flatMap((g) => mergePlan.mergeMap.get(g.id) ?? [g.id])),
    ];
    const historyMap = billing.start
      ? await getHistoryForGroups(allHistoryGroupIds, billing.start)
      : new Map<string, { date: string; spendUsd: number }[]>();

    const groups = await Promise.all(
      displayGroups.map(async (g) => {
        // Source group IDs: the primary itself plus any same-name aliases.
        const sourceIds = mergePlan.mergeMap.get(g.id) ?? [g.id];

        // ALL source groups must have member usage loaded for spend to be reliable.
        const memberUsageLoaded = sourceIds.every((id) => !!getMemberUsage(id, range.key));

        // Spend is only "loaded" when this group's member usage, the full rollup, AND
        // all extra-workspace fetches are complete. Until all groups' member usage loads,
        // shared users can be temporarily attributed to the wrong group.
        const fullyLoaded = memberUsageLoaded && rollup.isComplete && extraSpend.isComplete;

        // Sum spend across all same-name source groups. The rollup already deduplicates
        // users so summing byGroup values produces the correct combined total without
        // double-counting: each user's spend appears in exactly one source group.
        const combinedSpend = sourceIds.reduce(
          (sum, id) => sum + (rollup.byGroup.get(id)?.spendUsd ?? 0),
          0,
        );

        // Keep raw spend for the primary (for period timestamps / projection).
        const spend = getSpend(g.id, range.key);

        // Merged member count: union of directory members across all source groups.
        const memberIds = mergedGroupMemberIds(sourceIds, dir.groupMembers);
        const rawMemberCount = memberIds.length;
        // Rollup member count: sum of deduped counts across all source groups.
        const mergedRollupMemberCount = sourceIds.reduce(
          (sum, id) => sum + (rollupMemberCounts.get(id) ?? 0),
          0,
        );

        // Raw member spend = sum of each current member's workspace spend across
        // sourceIds, plus unattributable (ex-member) spend per source group.
        // We use MAX(group_member, workspace_member) per user because the group_member
        // API only returns AI-agent spend; workspace_member captures all spend types.
        let rawMemberSpend = 0;
        if (memberUsageLoaded) {
          const wsData = getWsSpendByUser(g.workspaceId, range.key);
          for (const userId of memberIds) {
            let groupMemberSpend = 0;
            for (const srcId of sourceIds) {
              groupMemberSpend += getMemberUsage(srcId, range.key)?.byUser.get(userId) ?? 0;
            }
            rawMemberSpend += Math.max(groupMemberSpend, wsData?.get(userId) ?? 0);
          }
          for (const srcId of sourceIds) {
            rawMemberSpend += getMemberUsage(srcId, range.key)?.unattributableTotalCostUsd ?? 0;
          }
        }

        const budget = effectiveGroupBudget(budgetMap.get(g.id));
        // Threshold state is always tracked against the cutoff-anchored billing period.
        const billingSpend = getSpend(g.id, "billing:from-cutoff");
        const fired =
          billingSpend && budget.amountUsd != null
            ? await getFiredThresholds(g.id, billingSpend.periodStart)
            : [];
        const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;

        // Merge history entries from all source groups by date (sum same-date spend).
        const histByDate = new Map<string, number>();
        for (const id of sourceIds) {
          for (const entry of historyMap.get(id) ?? []) {
            histByDate.set(entry.date, (histByDate.get(entry.date) ?? 0) + entry.spendUsd);
          }
        }
        const mergedHistory = [...histByDate.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, spendUsd]) => ({ date, spendUsd }));

        return {
          groupId: g.id,
          workspaceId: g.workspaceId,
          workspaceName: dir.workspaces.get(g.workspaceId)?.name ?? null,
          name: g.name,
          teamName: groupTeamMap.get(g.name) ?? null,
          type: g.type,
          memberCount: rawMemberCount || (dir.groupMembers.get(g.id)?.length ?? null),
          rollupMemberCount: mergedRollupMemberCount,
          spendLoaded: fullyLoaded,
          spendUsd: fullyLoaded ? combinedSpend : null,
          rollupSpendLoaded: rollup.isComplete && extraSpend.isComplete,
          rollupSpendUsd: combinedSpend,
          rawMemberSpendUsd: memberUsageLoaded ? rawMemberSpend : null,
          rawMemberSpendLoaded: memberUsageLoaded,
          spendUpdatedAt: spend ? new Date(spend.fetchedAt).toISOString() : null,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd: fullyLoaded && hasBudget ? budget.amountUsd! - combinedSpend : null,
          percentUsed:
            fullyLoaded && hasBudget ? (combinedSpend / budget.amountUsd!) * 100 : null,
          thresholdsFired: fired,
          history: mergedHistory,
          projectedSpendUsd:
            fullyLoaded && spend
              ? projectEndOfPeriod(combinedSpend, spend.periodStart, spend.periodEnd)
              : null,
        };
      }),
    );

    // Per-team raw member spend with within-team seenUserIds dedup.
    // Mirrors cluster-detail's totalMembersSpend + totalUnattributedSpend:
    // each member counted once within the team, at their raw workspace spend
    // (not the global-attribution rollup, so members attributed to other groups
    // still contribute their spend here).
    const teamRawSpend: Record<string, { spendUsd: number; spendLoaded: boolean }> = {};
    const teamGroupsByName = new Map<string, typeof displayGroups>();
    for (const g of displayGroups) {
      const teamName = groupTeamMap.get(g.name);
      if (!teamName) continue;
      const existing = teamGroupsByName.get(teamName) ?? [];
      existing.push(g);
      teamGroupsByName.set(teamName, existing);
    }
    for (const [teamName, tGroups] of teamGroupsByName) {
      const seenUsers = new Set<string>();
      let teamRaw = 0;
      let teamLoaded = true;
      for (const g of tGroups) {
        const srcIds = mergePlan.mergeMap.get(g.id) ?? [g.id];
        const loaded = srcIds.every((id) => !!getMemberUsage(id, range.key));
        if (!loaded) teamLoaded = false;
        const gMemberIds = mergedGroupMemberIds(srcIds, dir.groupMembers);
        // Union directory members with users returned by the API who may not yet
        // be reflected in the directory snapshot (mirrors getDedupedUsageRollup).
        const apiUserIds = new Set<string>();
        for (const srcId of srcIds) {
          for (const userId of (getMemberUsage(srcId, range.key)?.byUser.keys() ?? [])) {
            apiUserIds.add(userId);
          }
        }
        // wsData is used below only as a spend lookup — do NOT expand allMemberIds
        // with wsData.keys(). workspace_member covers the whole workspace, not just
        // this group's members; adding its keys here would count every workspace user
        // under every group that shares the workspace, causing massive double-counting.
        const wsData = getWsSpendByUser(g.workspaceId, range.key);
        const allMemberIds = new Set([...gMemberIds, ...apiUserIds]);
        for (const userId of allMemberIds) {
          if (seenUsers.has(userId)) continue;
          seenUsers.add(userId);
          // Sum group_member spend across source groups, then take the higher of that
          // and workspace_member spend (which captures compute + non-agent metrics).
          let groupMemberSpend = 0;
          for (const srcId of srcIds) {
            groupMemberSpend += getMemberUsage(srcId, range.key)?.byUser.get(userId) ?? 0;
          }
          teamRaw += Math.max(groupMemberSpend, wsData?.get(userId) ?? 0);
        }
        // Include ex-member (unattributable) spend from each source group.
        for (const srcId of srcIds) {
          teamRaw += getMemberUsage(srcId, range.key)?.unattributableTotalCostUsd ?? 0;
        }
      }
      teamRawSpend[teamName] = { spendUsd: teamRaw, spendLoaded: teamLoaded };
    }

    res.json(
      ListGroupsResponse.parse({
        groups,
        isComplete: rollup.isComplete && extraSpend.isComplete,
        // rollup.pendingCount already counts every missing source group. Adding
        // missing display rows counted the same work twice (e.g. 126 became 252).
        pendingCount:
          rollup.pendingCount + (extraSpend.totalCount - extraSpend.loadedCount),
        billingPeriodLabel: range.key === "billing:from-cutoff" ? billing.label : range.label,
        teamRawSpend,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "listGroups failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/groups/:groupId", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    // Non-disclosing: out-of-scope groups are indistinguishable from missing.
    if (!group || !canSeeGroup(req.authz!, group)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const scoped = visibleGroups(req.authz!, dir.groups);

    // Build merge plan so alias (hidden) groups redirect and primaries aggregate
    // member usage and spend from all same-name workspace variants.
    const mergePlan = buildGroupMergePlan(scoped, dir.workspaces);

    // If this group is a hidden alias, treat it as not found (the primary carries
    // all the data; direct navigation to an alias would show misleading $0 spend).
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    // Source group IDs: this primary plus any same-name aliases.
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];

    // Queue the selected group's data at high priority (priority 0) so it loads first.
    // Also queue member usage for ALL source groups and all other visible groups at lower
    // priority so the deduped rollup can complete.
    for (const srcId of sourceIds) {
      const srcGroup = dir.groups.find((g) => g.id === srcId);
      if (srcGroup) {
        queueGroupSpendFetch(srcGroup, 0, false, undefined, range);
        queueMemberUsageFetch(srcGroup, range, 0);
        queueProjectUsageFetch(srcGroup, range, 0);
        queueProjectTitlesFetch(srcGroup.workspaceId, 0);
      }
    }
    for (const g of scoped) {
      if (!sourceIds.includes(g.id)) queueMemberUsageFetch(g, range, 1);
    }

    const spend = getSpend(group.id, range.key);

    // Aggregate member usage across all source groups (primary + aliases).
    // This ensures the detail view shows the full combined spend even when
    // billing data has not yet migrated to the new workspace's group.
    const aggregatedMemberUsage = (() => {
      const byUser = new Map<string, number>();
      let totalCostUsd = 0;
      let anyLoaded = false;
      for (const id of sourceIds) {
        const usage = getMemberUsage(id, range.key);
        if (!usage) continue;
        anyLoaded = true;
        for (const [uid, s] of usage.byUser) {
          byUser.set(uid, (byUser.get(uid) ?? 0) + s);
          totalCostUsd += s;
        }
      }
      return anyLoaded ? { byUser, totalCostUsd } : undefined;
    })();
    const memberUsage = aggregatedMemberUsage;
    // All source groups must be loaded for spend to be considered complete.
    const allSourcesLoaded = sourceIds.every((id) => !!getMemberUsage(id, range.key));

    const isAccountAdmin = isAccountWide(req.authz);
    if (isAccountAdmin) {
      queueExtraWorkspacesFetch(dir, range, 0);
      queueAllWorkspacesFetch(dir, range, 0);
    }
    const extraSpend = isAccountAdmin
      ? getExtraWorkspaceSpend(dir, range.key)
      : { byUser: new Map<string, number>(), isComplete: true, loadedCount: 0, totalCount: 0 };
    const rollup = getDedupedUsageRollup(scoped, range.key, extraSpend.byUser, dir.groupMembers);
    const rollupMemberCounts = getDedupedMemberCounts(scoped, dir.groupMembers);

    // Aggregate attributed spend across all source groups (mirrors dashboard logic).
    const attributed = {
      spendUsd: sourceIds.reduce((sum, id) => sum + (rollup.byGroup.get(id)?.spendUsd ?? 0), 0),
      byUser: (() => {
        const m = new Map<string, number>();
        for (const id of sourceIds) {
          for (const [uid, s] of rollup.byGroup.get(id)?.byUser ?? []) {
            m.set(uid, (m.get(uid) ?? 0) + s);
          }
        }
        return m;
      })(),
    };

    const [budgets, groupTeamsRows] = await Promise.all([
      db.select().from(groupBudgetsTable),
      db.select().from(groupTeamsTable),
    ]);
    const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));
    const groupTeamMap = new Map(groupTeamsRows.map((gt) => [gt.groupName, gt.teamName]));
    const budget = effectiveGroupBudget(budgetMap.get(group.id));
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingSpend = getSpend(group.id, "billing:from-cutoff");
    const fired =
      billingSpend && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingSpend.periodStart)
        : [];

    // Merge history from all source groups by date.
    const detailHistoryArr: { date: string; spendUsd: number }[] = [];
    if (billingSpend) {
      const histResult = await getHistoryForGroups(
        [...new Set(sourceIds)],
        billingSpend.periodStart,
      );
      const byDate = new Map<string, number>();
      for (const id of sourceIds) {
        for (const entry of histResult.get(id) ?? []) {
          byDate.set(entry.date, (byDate.get(entry.date) ?? 0) + entry.spendUsd);
        }
      }
      for (const [date, spendUsd] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        detailHistoryArr.push({ date, spendUsd });
      }
    }

    // Union of directory members across all source groups.
    const userIds = mergedGroupMemberIds(sourceIds, dir.groupMembers);

    const members = userIds.map((userId) => {
      const m = dir.members.get(userId);
      // Use the primary group's workspace for role/isDisabled (the user's workspace membership).
      const ws = m?.workspaces.get(group.workspaceId) ??
        sourceIds.map((id) => {
          const srcGroup = dir.groups.find((g) => g.id === id);
          return srcGroup ? m?.workspaces.get(srcGroup.workspaceId) : undefined;
        }).find(Boolean);
      // Member spend shows the user's actual workspace-level spend for this group
      // (from the Replit usage API), so admins see real usage figures for every member.
      // This is intentionally different from the deduped budget attribution used for
      // the group total — a user in multiple groups will show their real spend here
      // even if their budget attribution is assigned to a different group.
      // Member spend is available as soon as this group's own usage cache loads;
      // it does not need the full cross-group rollup to complete.
      const memberSpendLoaded = allSourcesLoaded;
      const rawSpend = memberUsage?.byUser.get(userId);
      const spendUsd = !memberSpendLoaded ? null : (rawSpend ?? 0);
      const spendLoaded = memberSpendLoaded;
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
        spendUsd,
        remainingUsd: null,
        percentUsed: null,
      };
    });

    // Reconciliation: members removed from the group since the last sync still count
    // toward group spend (they are captured in the rollup).  unattributedSpendUsd
    // surfaces that residual so the cluster page can show an accurate attributed total.
    // Note: member rows show raw workspace spend (listedMembersSpend), which can exceed
    // combinedSpend for members whose spend is attributed elsewhere; the cluster total
    // is therefore derived from group.spendUsd (= combinedSpend), not member-row sums.
    const combinedSpend = attributed.spendUsd;
    const combinedLoaded = allSourcesLoaded && rollup.isComplete && extraSpend.isComplete;
    let listedMembersSpend = 0;
    if (memberUsage) {
      for (const userId of userIds) {
        listedMembersSpend += memberUsage.byUser.get(userId) ?? 0;
      }
    }
    // Unattributed spend = spend from members removed from the group since the last sync
    // (still in the rollup total but no longer in the directory member list).
    // Must be computed from attributed.byUser (not raw member spend) so that members
    // whose spend is attributed elsewhere don't inflate this figure — raw spend can
    // exceed the attributed group total for users in multiple groups.
    let attributedCurrentMembersSpend = 0;
    for (const userId of userIds) {
      attributedCurrentMembersSpend += attributed.byUser.get(userId) ?? 0;
    }
    const unattributed = combinedLoaded
      ? Math.max(0, combinedSpend - attributedCurrentMembersSpend)
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
          teamName: groupTeamMap.get(group.name) ?? null,
          type: group.type,
          memberCount: userIds.length,
          rollupMemberCount: mergedRollupMemberCount,
          spendLoaded: combinedLoaded,
          spendUsd: combinedLoaded ? combinedSpend : null,
          rollupSpendLoaded: rollup.isComplete && extraSpend.isComplete,
          rollupSpendUsd: combinedSpend,
          spendUpdatedAt: spend ? new Date(spend.fetchedAt).toISOString() : null,
          budgetUsd: budget.amountUsd,
          budgetSource: budget.source,
          remainingUsd: combinedLoaded && hasBudget ? budget.amountUsd! - combinedSpend : null,
          percentUsed: combinedLoaded && hasBudget ? (combinedSpend / budget.amountUsd!) * 100 : null,
          thresholdsFired: fired,
          history: detailHistoryArr,
          projectedSpendUsd: combinedLoaded && billingSpend
            ? projectEndOfPeriod(combinedSpend, billingSpend.periodStart, billingSpend.periodEnd)
            : null,
        },
        members,
        membersSpendUsd: listedMembersSpend,
        unattributedSpendUsd: unattributed,
        isComplete: combinedLoaded && extraSpend.isComplete,
        rangeLabel: range.label,
      }),
    );
  } catch (err) {
    if (isBadRangeError(err)) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, "getGroupDetail failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/groups/:groupId/projects", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const groupId = String(req.params["groupId"]);
    const dir = await getDirectory();
    const group = dir.groups.find((g) => g.id === groupId);
    // Non-disclosing: out-of-scope groups are indistinguishable from missing.
    if (!group || !canSeeGroup(req.authz!, group)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    // Kick off fetches (high priority); serve from cache if available.
    queueProjectUsageFetch(group, range, 0);
    queueProjectTitlesFetch(group.workspaceId, 0);

    const projectUsage = getProjectUsage(group.id, range.key);
    const titleMap = getProjectTitles(group.workspaceId);
    const groupSpend = getSpend(group.id, range.key);

    const isComplete = !!projectUsage;

    const projects = projectUsage
      ? Array.from(projectUsage.byProject.values())
          .map((p) => ({
            projectId: p.projectId,
            title: titleMap.get(p.projectId) ?? null,
            totalCostUsd: p.totalCostUsd,
            metrics: p.metrics,
          }))
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      : [];

    // Reconciliation: sum of project rows vs. group total.
    // Anchor to groupSpend.spendUsd (the same figure shown in the header stat card)
    // so the project table total always matches the group's reported spend.
    // Fall back to projectUsage.totalCostUsd only when the plain-group spend
    // hasn't loaded yet.
    const projectsSum = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
    const groupTotal = groupSpend?.spendUsd ?? projectUsage?.totalCostUsd ?? 0;
    const unattributedSpendUsd = Math.max(0, groupTotal - projectsSum);

    res.json(
      GetGroupProjectsResponse.parse({
        projects,
        unattributedSpendUsd,
        isComplete,
      }),
    );
  } catch (err) {
    if (isBadRangeError(err)) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, "getGroupProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.get("/clusters/:clusterKey/projects", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
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

    // Queue fetches (high priority)
    const workspaceIds = new Set(groups.map((g) => g.workspaceId));
    for (const g of groups) queueProjectUsageFetch(g, range, 0);
    for (const wsId of workspaceIds) queueProjectTitlesFetch(wsId, 0);

    // Member set — union of all members across constituent groups
    const memberSet = new Set<string>();
    for (const g of groups) {
      for (const userId of dir.groupMembers.get(g.id) ?? []) {
        memberSet.add(userId);
      }
    }

    // Collect unique projects across all sub-groups; de-dup by taking max totalCostUsd entry.
    // When the same project appears in multiple sub-group responses (because the creator is in
    // multiple sub-groups), we pick the entry with the highest reported total rather than summing,
    // which would inflate the figure.
    const projectMap = new Map<
      string,
      { entry: { projectId: string; totalCostUsd: number; metrics: ProjectUsageMetric[] }; workspaceId: string }
    >();
    let allGroupsLoaded = true;

    for (const g of groups) {
      const usage = getProjectUsage(g.id, range.key);
      if (!usage) {
        allGroupsLoaded = false;
        continue;
      }
      for (const entry of usage.byProject.values()) {
        const existing = projectMap.get(entry.projectId);
        if (!existing || entry.totalCostUsd > existing.entry.totalCostUsd) {
          projectMap.set(entry.projectId, { entry, workspaceId: g.workspaceId });
        }
      }
    }

    // Project info (creatorId) availability — needed for exact attribution
    const projectInfoLoaded = Array.from(workspaceIds).every((wsId) => hasProjectInfo(wsId));

    // Attribute projects by creator membership
    const attributed: {
      projectId: string;
      title: string | null;
      totalCostUsd: number;
      metrics: ProjectUsageMetric[];
    }[] = [];
    let unattributedSpendUsd = 0;

    for (const { entry, workspaceId } of projectMap.values()) {
      const info = getProjectInfo(workspaceId, entry.projectId);
      const creatorId = info?.creatorId ?? null;
      if (creatorId !== null && memberSet.has(creatorId)) {
        attributed.push({
          projectId: entry.projectId,
          title: info?.title ?? null,
          totalCostUsd: entry.totalCostUsd,
          metrics: entry.metrics,
        });
      } else {
        unattributedSpendUsd += entry.totalCostUsd;
      }
    }

    attributed.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    res.json(
      GetGroupProjectsResponse.parse({
        projects: attributed,
        unattributedSpendUsd,
        isComplete: allGroupsLoaded && projectInfoLoaded,
      }),
    );
  } catch (err) {
    if (isBadRangeError(err)) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, "getClusterProjects failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

router.post("/groups/:groupId/refresh", requireAccountOperator, async (req, res): Promise<void> => {
  const groupId = String(req.params["groupId"]);
  const dir = await getDirectory();
  const group = dir.groups.find((g) => g.id === groupId);
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  queueGroupSpendFetch(group, 0, true);
  res.status(202).json(RefreshGroupUsageResponse.parse({ ok: true }));
});

router.get("/summary", async (req, res): Promise<void> => {
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const authz = req.authz!;
  const isAccount = isAccountWide(authz);
  const [budgets, teamBudgets] = await Promise.all([
    db.select().from(groupBudgetsTable),
    db.select().from(teamBudgetsTable),
  ]);
  const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));

  let totalGroups = 0;
  let totalSpendUsd = 0;
  let totalRemainingUsd = 0;
  let totalBudgetUsd = 0;
  let budgetedGroups = 0;
  let pending = 0;
  let summaryExtraComplete = true; // tracks extra-workspace load state for isComplete
  let over50 = 0;
  let over75 = 0;
  let over90 = 0;
  let over100 = 0;

  // Set of visible groups, used both to scope spend and to filter alerts.
  let visibleGroupIds = new Set<string>();

  if (isConfigured()) {
    try {
      const dir = await getDirectory();
      const scoped = visibleGroups(authz, dir.groups);
      visibleGroupIds = new Set(scoped.map((g) => g.id));
      totalGroups = scoped.length;
      for (const g of scoped) {
        const budget = effectiveGroupBudget(budgetMap.get(g.id));
        if (budget.amountUsd != null && budget.amountUsd > 0) {
          budgetedGroups += 1;
        }
      }
      // Use deduped, cross-workspace rollup for total spend so the summary
      // matches the group rows (which also show combined spend).
      //
      // Extra-workspace spend only applies to account admins; workspace admins
      // are scoped to their own workspace's groups and must not see spend from others.
      //
      // Queue per-group member usage so /summary can independently populate
      // the rollup from a cold cache (not depending on /groups being visited first).
      for (const group of scoped) queueMemberUsageFetch(group, range, 1);
      if (isAccount) {
        queueExtraWorkspacesFetch(dir, range, 1);
        queueAllWorkspacesFetch(dir, range, 1);
      }
      const summaryExtraSpend = isAccount
        ? getExtraWorkspaceSpend(dir, range.key)
        : { byUser: new Map<string, number>(), isComplete: true, loadedCount: 0, totalCount: 0 };
      const summaryRollup = getDedupedUsageRollup(scoped, range.key, summaryExtraSpend.byUser, dir.groupMembers);
      // Also sum extra-workspace spend for enterprise members not in ANY custom group.
      // These users are excluded from the per-group rollup (no group to attribute to)
      // but ARE counted in the CSV — including them here keeps the two totals consistent.
      let ungroupedExtraSpend = 0;
      if (isAccount && summaryExtraSpend.isComplete) {
        const allGroupedIds = new Set<string>();
        for (const g of scoped) {
          for (const uid of dir.groupMembers.get(g.id) ?? []) allGroupedIds.add(uid);
        }
        for (const [uid, spend] of summaryExtraSpend.byUser) {
          if (!allGroupedIds.has(uid)) ungroupedExtraSpend += spend;
        }
      }
      totalSpendUsd = summaryRollup.totalSpendUsd + ungroupedExtraSpend;
      pending = summaryRollup.pendingCount;
      summaryExtraComplete = summaryExtraSpend.isComplete;
    } catch (err) {
      req.log.error({ err }, "summary directory fetch failed");
    }
  }

  // Team budgets are account-wide configuration and are not workspace-scoped,
  // so they are exposed only to account admins. Workspace admins get a total
  // recomputed from the group budgets of the groups they can actually see.
  if (isAccount) {
    totalBudgetUsd = teamBudgets.reduce((sum, tb) => sum + tb.amountUsd, 0);
  } else {
    for (const b of budgets) {
      if (visibleGroupIds.has(b.groupId)) totalBudgetUsd += b.amountUsd;
    }
  }

  // Remaining is the (scoped) budget total minus loaded spend.
  totalRemainingUsd = totalBudgetUsd - totalSpendUsd;

  const billing = getBillingPeriod();
  const allAlerts = await db.select().from(alertsTable);
  const periodStart = billing.start ? new Date(billing.start) : null;
  const alertsSentThisPeriod = allAlerts.filter(
    (a) =>
      a.status === "sent" &&
      (isAccount ||
        (a.entityType === "team"
          ? a.workspaceIds.length > 0 &&
            a.workspaceIds.every((workspaceId) => authz.workspaceIds.includes(workspaceId))
          : visibleGroupIds.has(a.entityId || a.groupId))) &&
      (!periodStart || a.sentAt >= periodStart),
  ).length;

  res.json(
    GetSummaryResponse.parse({
      totalGroups,
      budgetedGroups,
      totalSpendUsd,
      totalBudgetUsd,
      totalRemainingUsd,
      groupsOver50: over50,
      groupsOver75: over75,
      groupsOver90: over90,
      groupsOver100: over100,
      alertsSentThisPeriod,
      billingPeriodLabel: range.key === "billing:from-cutoff" ? billing.label : range.label,
      isComplete: pending === 0 && summaryExtraComplete,
    }),
  );
});

// Account-wide roles see every team pool. Workspace admins get read-only pool
// values only for teams containing a group in one of their administered workspaces.
router.get("/teams/budgets", async (req, res): Promise<void> => {
  const budgets = await db.select().from(teamBudgetsTable);
  const [dir, assignments] = await Promise.all([
    getDirectory(),
    db.select().from(groupTeamsTable),
  ]);
  const scopedGroups = visibleGroups(req.authz!, dir.groups);
  const visibleGroupNames = new Set(scopedGroups.map((group) => group.name));
  const visibleTeams = new Set(
    assignments
      .filter((assignment) => visibleGroupNames.has(assignment.groupName))
      .map((assignment) => assignment.teamName),
  );
  const allWorkspaceIdsByTeam = new Map<string, Set<string>>();
  for (const group of dir.groups) {
    const teamName = assignments.find((assignment) => assignment.groupName === group.name)?.teamName;
    if (!teamName) continue;
    const ids = allWorkspaceIdsByTeam.get(teamName) ?? new Set<string>();
    ids.add(group.workspaceId);
    allWorkspaceIdsByTeam.set(teamName, ids);
  }
  const workspaceIdsByTeam = new Map<string, Set<string>>();
  for (const group of scopedGroups) {
    const teamName = assignments.find((assignment) => assignment.groupName === group.name)?.teamName;
    if (!teamName) continue;
    const ids = workspaceIdsByTeam.get(teamName) ?? new Set<string>();
    ids.add(group.workspaceId);
    workspaceIdsByTeam.set(teamName, ids);
  }
  const visibleBudgets = isAccountWide(req.authz)
    ? budgets
    : budgets.filter((budget) => visibleTeams.has(budget.teamName));
  res.json(
    GetTeamsBudgetsResponse.parse({
      budgets: visibleBudgets.map((b) => ({
        teamName: b.teamName,
        amountUsd: b.amountUsd,
        workspaceIds: [
          ...(isAccountWide(req.authz)
            ? allWorkspaceIdsByTeam.get(b.teamName) ?? []
            : workspaceIdsByTeam.get(b.teamName) ?? []),
        ].sort(),
      })),
    }),
  );
});

router.put("/teams/:teamName/budget", requireAccountOperator, async (req, res): Promise<void> => {
  const teamName = decodeURIComponent(String(req.params["teamName"]));
  const parsed = SetTeamBudgetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(teamBudgetsTable)
    .values({ teamName, amountUsd: parsed.data.amountUsd })
    .onConflictDoUpdate({
      target: teamBudgetsTable.teamName,
      set: { amountUsd: parsed.data.amountUsd, updatedAt: new Date() },
    })
    .returning();
  if (!row) {
    res.status(400).json({ error: "Failed to save team budget" });
    return;
  }
  res.json(
    SetTeamBudgetResponse.parse({
      teamName: row.teamName,
      amountUsd: row.amountUsd,
      workspaceIds: [],
    }),
  );
});

router.delete("/teams/:teamName/budget", requireAccountOperator, async (req, res): Promise<void> => {
  const teamName = decodeURIComponent(String(req.params["teamName"]));
  await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, teamName));
  res.status(204).send();
});

router.get("/budgets", async (req, res): Promise<void> => {
  const authz = req.authz!;
  const budgets = await db.select().from(groupBudgetsTable);
  let visible = budgets;
  if (!isAccountWide(authz)) {
    // Scope budgets to the groups this workspace admin can see.
    try {
      const dir = await getDirectory();
      const allowedIds = new Set(visibleGroups(authz, dir.groups).map((g) => g.id));
      visible = budgets.filter((b) => allowedIds.has(b.groupId));
    } catch {
      // Fail closed: if scope can't be resolved, expose nothing.
      visible = [];
    }
  }
  res.json(
    ListBudgetsResponse.parse(
      visible.map((b) => ({
        groupId: b.groupId,
        amountUsd: b.amountUsd,
        updatedAt: b.updatedAt.toISOString(),
      })),
    ),
  );
});

router.put("/groups/:groupId/budget", requireAccountOperator, async (req, res): Promise<void> => {
  const groupId = String(req.params["groupId"]);
  const parsed = SetGroupBudgetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(groupBudgetsTable)
    .values({ groupId, amountUsd: parsed.data.amountUsd })
    .onConflictDoUpdate({
      target: groupBudgetsTable.groupId,
      set: { amountUsd: parsed.data.amountUsd, updatedAt: new Date() },
    })
    .returning();
  if (!row) {
    res.status(400).json({ error: "Failed to save budget" });
    return;
  }
  res.json(
    SetGroupBudgetResponse.parse({
      groupId: row.groupId,
      amountUsd: row.amountUsd,
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

router.delete("/groups/:groupId/budget", requireAccountOperator, async (req, res): Promise<void> => {
  const groupId = String(req.params["groupId"]);
  const deleted = await db
    .delete(groupBudgetsTable)
    .where(eq(groupBudgetsTable.groupId, groupId))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "No budget configured for this group" });
    return;
  }
  res.json(DeleteGroupBudgetResponse.parse({ ok: true }));
});

// Notification recipients are account-only data; workspace admins can neither
// view nor modify them.
router.get("/admins", requireAccountAdmin, async (_req, res): Promise<void> => {
  const admins = await db.select().from(adminEmailsTable).orderBy(adminEmailsTable.id);
  res.json(
    ListAdminsResponse.parse(
      admins.map((a) => ({
        id: a.id,
        email: a.email,
        createdAt: a.createdAt.toISOString(),
      })),
    ),
  );
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/admins", requireAccountAdmin, async (req, res): Promise<void> => {
  const parsed = AddAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  const existing = await db
    .select()
    .from(adminEmailsTable)
    .where(eq(adminEmailsTable.email, email));
  if (existing.length > 0) {
    res.status(400).json({ error: "This email is already on the list" });
    return;
  }
  const [row] = await db.insert(adminEmailsTable).values({ email }).returning();
  if (!row) {
    res.status(400).json({ error: "Failed to add email" });
    return;
  }
  res.status(201).json(
    AddAdminResponse.parse({
      id: row.id,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

router.delete("/admins/:adminId", requireAccountAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params["adminId"])
    ? req.params["adminId"][0]
    : req.params["adminId"];
  const id = parseInt(String(raw), 10);
  if (Number.isNaN(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const deleted = await db
    .delete(adminEmailsTable)
    .where(eq(adminEmailsTable.id, id))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(DeleteAdminResponse.parse({ ok: true }));
});

router.get("/editors", requireAccountAdmin, async (_req, res): Promise<void> => {
  const editors = await db
    .select()
    .from(editorAllowlistTable)
    .orderBy(editorAllowlistTable.createdAt);
  res.json(
    ListEditorsResponse.parse(
      editors.map((editor) => ({
        userId: editor.userId,
        email: editor.email,
        createdBy: editor.createdBy,
        createdAt: editor.createdAt.toISOString(),
      })),
    ),
  );
});

router.post("/editors", requireAccountAdmin, async (req, res): Promise<void> => {
  const parsed = AddEditorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = parsed.data.userId.trim();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "This Replit user has not signed in to the app" });
    return;
  }
  const [row] = await db
    .insert(editorAllowlistTable)
    .values({
      userId,
      email: user.email ?? "",
      createdBy: req.user!.id,
    })
    .onConflictDoNothing({ target: editorAllowlistTable.userId })
    .returning();
  if (!row) {
    res.status(400).json({ error: "This user is already an editor" });
    return;
  }
  res.status(201).json(
    AddEditorResponse.parse({
      userId: row.userId,
      email: row.email,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

router.delete("/editors/:userId", requireAccountAdmin, async (req, res): Promise<void> => {
  const userId = decodeURIComponent(String(req.params["userId"]));
  const deleted = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(editorAllowlistTable)
      .where(eq(editorAllowlistTable.userId, userId))
      .returning();
    const row = removed[0];
    if (row) {
      await tx
        .insert(editorBootstrapStateTable)
        .values({
          userId: row.userId,
          email: row.email,
          completedBy: req.user!.id,
          revokedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: editorBootstrapStateTable.userId,
          set: {
            revokedAt: new Date(),
          },
        });
    }
    return removed;
  });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(DeleteEditorResponse.parse({ ok: true }));
});

router.get("/alerts", async (req, res): Promise<void> => {
  const authz = req.authz!;
  const accountWide = isAccountWide(authz);
  const canSeeRecipients = isApplicationAdmin(authz);
  const parsed = ListAlertsQueryParams.safeParse(req.query);
  const limit = parsed.success && parsed.data.limit ? parsed.data.limit : 100;

  if (accountWide) {
    const alerts = await db
      .select()
      .from(alertsTable)
      .orderBy(desc(alertsTable.sentAt))
      .limit(limit);
    const visible = alerts.map(alertToJson).map((alert) =>
      canSeeRecipients ? alert : { ...alert, recipients: [] },
    );
    res.json(ListAlertsResponse.parse(visible));
    return;
  }

  // Workspace admins: scope alert history to visible groups, and strip the
  // account-only recipient list from each returned alert.
  let allowedIds = new Set<string>();
  try {
    const dir = await getDirectory();
    allowedIds = new Set(visibleGroups(authz, dir.groups).map((g) => g.id));
  } catch {
    // Fail closed: expose no alert history if scope can't be resolved.
    res.json(ListAlertsResponse.parse([]));
    return;
  }
  const allAlerts = await db
    .select()
    .from(alertsTable)
    .orderBy(desc(alertsTable.sentAt));
  const allowedWorkspaceIds = new Set(authz.workspaceIds);
  const scoped = allAlerts
    .filter((a) =>
      a.entityType === "team"
        ? a.workspaceIds.length > 0 &&
          a.workspaceIds.every((workspaceId) => allowedWorkspaceIds.has(workspaceId))
        : allowedIds.has(a.entityId || a.groupId),
    )
    .slice(0, limit)
    .map((a) => ({ ...alertToJson(a), recipients: [] }));
  res.json(ListAlertsResponse.parse(scoped));
});

router.post("/alerts/check", requireAccountOperator, async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }
  try {
    const result = await runCheck(true);
    res.json(
      RunAlertCheckResponse.parse({
        checkedGroups: result.checkedGroups,
        checkedTeams: result.checkedTeams,
        alertsSent: result.alerts.filter((a) => a.status === "sent").length,
        alerts: result.alerts.map(alertToJson),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "manual check failed");
    res.status(503).json({ error: getApiHealth().error ?? "Check failed" });
  }
});

router.post(
  "/alerts/:alertId/test",
  requireAccountAdmin,
  async (req, res): Promise<void> => {
    const alertId = Number(req.params["alertId"]);
    if (!Number.isInteger(alertId) || alertId <= 0) {
      res.status(404).json({ error: "Email activity not found" });
      return;
    }
    const [source] = await db
      .select()
      .from(alertsTable)
      .where(eq(alertsTable.id, alertId))
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "Email activity not found" });
      return;
    }

    const recipients = await resolveAlertRecipients(source.workspaceIds);
    const { subject, html } = buildAlertEmail({
      entityType: source.entityType === "team" ? "team" : "group",
      entityName: source.entityName || source.groupName,
      groupName: source.groupName,
      workspaceName: null,
      threshold: source.threshold,
      spendUsd: source.spendUsd,
      budgetUsd: source.budgetUsd,
      billingPeriodLabel: getBillingPeriod().label,
    });
    const result = await sendEmail(
      recipients,
      `[TEST] ${subject}`,
      `<div style="padding: 12px; margin-bottom: 16px; background: #ecfeff; border: 1px solid #06b6d4;"><strong>Test delivery:</strong> This message does not affect budget threshold state.</div>${html}`,
    );
    const [activity] = await db
      .insert(alertsTable)
      .values({
        groupId: source.groupId,
        groupName: source.groupName,
        entityType: source.entityType,
        entityId: source.entityId,
        entityName: source.entityName,
        workspaceIds: source.workspaceIds,
        threshold: source.threshold,
        spendUsd: source.spendUsd,
        budgetUsd: source.budgetUsd,
        recipients: result.deliveredTo ?? recipients,
        status: result.ok ? "sent" : "failed",
        errorMessage: result.ok ? null : (result.error ?? "unknown error"),
      })
      .returning();
    if (!activity) {
      res.status(500).json({ error: "Unable to record test delivery" });
      return;
    }
    res.json(SendTestAlertResponse.parse(alertToJson(activity)));
  },
);

// System status is account-only configuration; not exposed to workspace admins.
router.get("/status", requireAccountAdmin, async (_req, res): Promise<void> => {
  const health = getApiHealth();
  const emailConfigured = await isEmailConfigured();
  res.json(
    GetStatusResponse.parse({
      enterpriseApiConfigured: isConfigured(),
      enterpriseApiOk: health.ok,
      enterpriseApiError: health.error,
      emailConfigured,
      checkerIntervalMinutes: CHECK_INTERVAL_MINUTES,
      lastCheckAt: getLastCheckAt()?.toISOString() ?? null,
    }),
  );
});

// ---------- Trends: bucketed spend over time ----------

interface TrendBucket {
  startDate: string;
  endDate: string;
}

function generateMonthlyBuckets(): TrendBucket[] {
  const cutoff = new Date(SPEND_DATA_CUTOFF_ISO);
  const now = new Date();
  const buckets: TrendBucket[] = [];

  let monthStart = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1));
  while (monthStart <= now) {
    const y = monthStart.getUTCFullYear();
    const m = monthStart.getUTCMonth();

    const bucketStartMs = Math.max(monthStart.getTime(), cutoff.getTime());
    const lastDayOfMonth = new Date(Date.UTC(y, m + 1, 0)).getTime();
    const bucketEndMs = Math.min(lastDayOfMonth, now.getTime());

    const startDate = new Date(bucketStartMs).toISOString().slice(0, 10);
    const endDate = new Date(bucketEndMs).toISOString().slice(0, 10);

    buckets.push({ startDate, endDate });

    monthStart = new Date(Date.UTC(y, m + 1, 1));
  }
  return buckets;
}

function generateWeeklyBuckets(): TrendBucket[] {
  const cutoff = new Date(SPEND_DATA_CUTOFF_ISO);
  const now = new Date();
  const buckets: TrendBucket[] = [];

  let weekStart = new Date(cutoff.getTime());
  while (weekStart < now) {
    const weekEndMs = Math.min(weekStart.getTime() + 6 * 86_400_000, now.getTime());
    const startDate = weekStart.toISOString().slice(0, 10);
    const endDate = new Date(weekEndMs).toISOString().slice(0, 10);

    buckets.push({ startDate, endDate });

    weekStart = new Date(weekStart.getTime() + 7 * 86_400_000);
  }
  return buckets;
}

router.get("/trends", async (req, res): Promise<void> => {
  const normalizeArrayQuery = (value: unknown): unknown[] | undefined =>
    value == null ? undefined : Array.isArray(value) ? value : [value];
  const parsed = GetTrendsQueryParams.safeParse({
    ...req.query,
    teamNames: normalizeArrayQuery(req.query["teamNames"]),
    groupIds: normalizeArrayQuery(req.query["groupIds"]),
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { granularity, teamNames, groupIds } = parsed.data;

  const buckets = granularity === "week" ? generateWeeklyBuckets() : generateMonthlyBuckets();

  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }

  try {
    const dir = await getDirectory();
    const visible = visibleGroups(req.authz!, dir.groups);
    const groupTeams = await db.select().from(groupTeamsTable);
    const teamNameMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));
    const requestedTeams = teamNames ? new Set(teamNames) : null;
    const requestedGroups = groupIds ? new Set(groupIds) : null;
    const groups = visible.filter((group) => {
      if (requestedGroups && !requestedGroups.has(group.id)) return false;
      const teamName = teamNameMap.get(group.name) ?? null;
      return !requestedTeams || (teamName !== null && requestedTeams.has(teamName));
    });

    const ranges = buckets.map((bucket) =>
      resolveRange("custom", bucket.startDate, bucket.endDate),
    );
    let loadedCount = 0;
    const totalCount = groups.length * ranges.length;

    for (const group of groups) {
      for (const range of ranges) {
        if (getSpend(group.id, range.key)) {
          loadedCount += 1;
        } else {
          // Every missing request enters the shared rate-limited usage queue at
          // once. The queue serializes and paces the Enterprise API calls.
          queueGroupSpendFetch(group, 1, false, undefined, range);
        }
      }
    }

    const duplicateGroupNames = new Set(
      groups
        .filter((group, index) =>
          groups.findIndex((candidate) => candidate.name === group.name) !== index,
        )
        .map((group) => group.name),
    );
    const groupSeries = groups.map((group) => ({
      name: duplicateGroupNames.has(group.name)
        ? `${group.name} (${dir.workspaces.get(group.workspaceId)?.name ?? group.workspaceId})`
        : group.name,
      type: "group" as const,
      data: ranges.map((range) => getSpend(group.id, range.key)?.spendUsd ?? null),
    }));

    const teams = new Map<string, typeof groups>();
    for (const group of groups) {
      const teamName = teamNameMap.get(group.name);
      if (!teamName) continue;
      const teamGroups = teams.get(teamName) ?? [];
      teamGroups.push(group);
      teams.set(teamName, teamGroups);
    }
    const teamSeries = [...teams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, teamGroups]) => ({
        name,
        type: "team" as const,
        data: ranges.map((range) => {
          const spends = teamGroups.map((group) => getSpend(group.id, range.key));
          return spends.every(Boolean)
            ? spends.reduce((sum, spend) => sum + (spend?.spendUsd ?? 0), 0)
            : null;
        }),
      }));

    res.json(
      GetTrendsResponse.parse({
        buckets: buckets.map((bucket) => bucket.startDate),
        bucketRanges: buckets.map((bucket) => ({
          start: bucket.startDate,
          end: bucket.endDate,
        })),
        series: [...teamSeries, ...groupSeries],
        isComplete: loadedCount === totalCount,
        loadedCount,
        totalCount,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "getTrends failed");
    res.status(503).json({ error: getApiHealth().error ?? "Enterprise API unavailable" });
  }
});

// ── GET /export/users.csv ─────────────────────────────────────────────────────
// Returns a CSV of all users across all groups.
// Each user appears once (first custom group wins). Spend is shown where cached;
// groups whose per-member usage has not loaded yet are included with spend=0 and queued.
router.get("/export/users.csv", requireAccountOperator, async (req, res) => {
  let dir: Awaited<ReturnType<typeof getDirectory>>;
  try {
    dir = await getDirectory();
  } catch (err) {
    req.log.error({ err }, "export directory fetch failed");
    res.status(503).json({ error: "Directory unavailable" });
    return;
  }

  const billingRange = resolveRange("billing");
  const groupTeams = await db.select().from(groupTeamsTable);
  const teamNameMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  // Route is account-wide (true account admins and managed editors).
  // Queue member usage + extra workspace fetches so combined spend is populated.
  for (const group of dir.groups) queueMemberUsageFetch(group, billingRange, 1);
  queueExtraWorkspacesFetch(dir, billingRange, 1);
  queueAllWorkspacesFetch(dir, billingRange, 1);
  const exportExtraSpend = getExtraWorkspaceSpend(dir, billingRange.key);

  const groupsLoaded = dir.groups.filter((g) => !!getMemberUsage(g.id, billingRange.key)).length;
  const totalGroups = dir.groups.length;
  const exportComplete = groupsLoaded === totalGroups;

  // Pass 1: register every group member with a default (first-membership) group/team,
  // using the stable sort order (workspaceId → name → id). Attribution is driven by
  // directory group membership so every member gets a group/team even with $0 spend
  // or on a cold cache. Spend and the displayed group are finalized in Pass 1.5.
  const sortedGroupsForCsv = [...dir.groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const userGroupAttr = new Map<string, { groupName: string; teamName: string; spendUsd: number }>();
  for (const group of sortedGroupsForCsv) {
    const teamName = teamNameMap.get(group.name) ?? "";
    for (const userId of dir.groupMembers.get(group.id) ?? []) {
      if (!userGroupAttr.has(userId)) {
        userGroupAttr.set(userId, { groupName: group.name, teamName, spendUsd: 0 });
      }
    }
  }

  // Pass 1.5: compute total spend per user with workspace-level deduplication,
  // mirroring /users/activity exactly.
  // The Replit usage API returns WORKSPACE-level spend per user — every group
  // in the same workspace reports the same dollar amount. Take the MAX across
  // groups within each workspace, then SUM across workspaces.
  const csvTopGroupSpend = new Map<string, number>(); // userId → highest single-group spend
  const csvWorkspaceMaxSpend = new Map<string, Map<string, number>>(); // userId → wsId → maxSpend

  for (const group of sortedGroupsForCsv) {
    const memberUsage = getMemberUsage(group.id, billingRange.key);
    if (!memberUsage) continue;
    const teamName = teamNameMap.get(group.name) ?? "";
    for (const [userId, spend] of memberUsage.byUser) {
      if (spend <= 0) continue;
      const attr = userGroupAttr.get(userId);
      if (!attr) continue;

      // Workspace-level dedup: track max spend per (user, workspace)
      let wsMap = csvWorkspaceMaxSpend.get(userId);
      if (!wsMap) { wsMap = new Map(); csvWorkspaceMaxSpend.set(userId, wsMap); }
      wsMap.set(group.workspaceId, Math.max(wsMap.get(group.workspaceId) ?? 0, spend));

      // Track highest-spend group for display attribution
      const prevTop = csvTopGroupSpend.get(userId) ?? 0;
      if (spend > prevTop) {
        csvTopGroupSpend.set(userId, spend);
        attr.groupName = group.name;
        attr.teamName = teamName;
      }
    }
  }

  // Sum workspace-level maximums → true cross-workspace total per user
  for (const [userId, wsMap] of csvWorkspaceMaxSpend) {
    const attr = userGroupAttr.get(userId);
    if (attr) attr.spendUsd = [...wsMap.values()].reduce((sum, s) => sum + s, 0);
  }

  // Pass 2: emit one row per enterprise member (covers users not in any custom group).
  // Extra-workspace spend (workspaces without custom groups) is added for every user
  // so cross-workspace totals stay complete.
  const rows: { email: string; name: string; username: string; group: string; team: string; workspaces: string; spendUsd: number }[] = [];
  for (const [userId, m] of dir.members) {
    const attr = userGroupAttr.get(userId);
    const wsNames = [...m.workspaces.keys()]
      .map((wsId) => dir.workspaces.get(wsId)?.name ?? wsId)
      .filter(Boolean)
      .join("; ");
    const extraSpend = exportExtraSpend.byUser.get(userId) ?? 0;
    const spendUsd = (attr?.spendUsd ?? 0) + extraSpend;
    rows.push({
      email: m.email,
      name: m.name ?? "",
      username: m.username,
      group: attr?.groupName ?? "",
      team: attr?.teamName ?? "",
      workspaces: wsNames,
      spendUsd,
    });
  }

  // Sort by spend descending
  rows.sort((a, b) => b.spendUsd - a.spendUsd);

  // Build CSV
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["Email", "Name", "Username", "Workspace(s)", "Group", "Team", "Spend (USD)"].map(escape).join(",");
  const lines = rows.map((r) =>
    [r.email, r.name, r.username, r.workspaces, r.group, r.team, r.spendUsd.toFixed(2)].map(escape).join(","),
  );

  const isComplete = exportComplete && exportExtraSpend.isComplete;
  const csv = [header, ...lines].join("\r\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="all-users-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.setHeader("X-Groups-Loaded", String(groupsLoaded));
  res.setHeader("X-Groups-Total", String(totalGroups));
  res.setHeader("X-Export-Complete", String(isComplete));
  res.send(csv);
});

// ── GET /users/activity ───────────────────────────────────────────────────────
// Returns workspace members with their true total billing-period spend.
// The Replit usage API returns WORKSPACE-level spend per user, not group-level:
// every group within the same workspace reports the identical dollar amount.
// Aggregation uses workspace-level max dedup — MAX per (user, workspaceId)
// summed across distinct workspaces — to avoid multiply-counting spend when a
// user belongs to several groups in the same workspace.
// Groups in DIFFERENT workspaces are independent pools and are always summed.
// Account admins also see spend from extra workspaces that have no custom groups.
// The displayed group/team is the user's highest-spend group (primary cost center).
// NOTE: these per-user totals can exceed the deduped budget totals in /groups
// and /summary, which attribute shared users to a single group to avoid
// double-counting group budgets — different accounting views by design.
// Scoped to the caller's visible groups: account admins see all members;
// workspace admins see only members in their visible groups. Responds
// immediately with cached data; isComplete=false while usage is still loading.
router.get("/users/activity", async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.json({ isComplete: true, loadedCount: 0, totalCount: 0, users: [] });
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

  const billingRange = resolveRange("billing");
  const groupTeams = await db.select().from(groupTeamsTable);
  const teamNameMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  // Extra-workspace spend (workspaces with no custom groups) is account-wide
  // data, so include it only for account admins — never leak out-of-scope
  // spend to workspace admins.
  const includeExtraSpend = isAccountWide(req.authz);
  let extraSpend: { byUser: Map<string, number>; isComplete: boolean } = {
    byUser: new Map(),
    isComplete: true,
  };
  if (includeExtraSpend) {
    queueExtraWorkspacesFetch(dir, billingRange, 1);
    queueAllWorkspacesFetch(dir, billingRange, 1);
    extraSpend = getExtraWorkspaceSpend(dir, billingRange.key);
  }

  let groupsLoaded = 0;
  const totalGroups = orderedGroups.length;

  // Pass 1: register every visible group member with a default (first-membership)
  // attribution, and track visibility scoping. Spend and the displayed group are
  // finalized in Pass 1.5: total spend is the SUM across every group's usage data
  // (same-name groups in different workspaces are independent groups with
  // independent spend — no name-based dedup), and the displayed group/team is the
  // one where the user spent the most (their primary cost center).
  const userGroupAttr = new Map<
    string,
    { groupId: string; groupName: string; teamName: string; spendUsd: number; workspaceId: string }
  >();
  const visibleUserIds = new Set<string>();

  for (const group of orderedGroups) {
    const memberUsage = getMemberUsage(group.id, billingRange.key);
    if (!memberUsage) {
      queueMemberUsageFetch(group, billingRange, 1);
    } else {
      groupsLoaded++;
    }
    const teamName = teamNameMap.get(group.name) ?? "";
    for (const userId of dir.groupMembers.get(group.id) ?? []) {
      visibleUserIds.add(userId);
      if (!userGroupAttr.has(userId)) {
        userGroupAttr.set(userId, {
          groupId: group.id,
          groupName: group.name,
          teamName,
          spendUsd: 0,           // accumulated in Pass 1.5
          workspaceId: group.workspaceId,
        });
      }
    }
  }

  // Pass 1.5: compute total spend per user with workspace-level deduplication.
  // The Replit usage API returns WORKSPACE-level spend per user, not group-level:
  // every group in the same workspace reports the same dollar amount for a given user.
  // Naively summing across all groups in a workspace multiplies spend by the number
  // of groups the user belongs to in that workspace.
  // Correct approach: take the MAX across groups within each workspace, then SUM
  // across workspaces for the true cross-workspace total.
  // Groups in DIFFERENT workspaces are always independent pools — "Admins" in
  // workspace A and "Admins" in workspace B represent separate usage and are summed.
  // The displayed group/team is the one with the highest single-group spend.
  const topGroupSpendByUser = new Map<string, number>(); // userId → highest single-group spend
  const userWorkspaceMaxSpend = new Map<string, Map<string, number>>(); // userId → wsId → maxSpend

  for (const group of orderedGroups) {
    const memberUsage = getMemberUsage(group.id, billingRange.key);
    if (!memberUsage) continue;
    const teamName = teamNameMap.get(group.name) ?? "";
    for (const [userId, spend] of memberUsage.byUser) {
      if (spend <= 0) continue;
      const attr = userGroupAttr.get(userId);
      if (!attr) continue;

      // Workspace-level dedup: track max spend per (user, workspace)
      let wsMap = userWorkspaceMaxSpend.get(userId);
      if (!wsMap) { wsMap = new Map(); userWorkspaceMaxSpend.set(userId, wsMap); }
      wsMap.set(group.workspaceId, Math.max(wsMap.get(group.workspaceId) ?? 0, spend));

      // Track the group with the highest single spend for display attribution
      const prevTop = topGroupSpendByUser.get(userId) ?? 0;
      if (spend > prevTop) {
        topGroupSpendByUser.set(userId, spend);
        attr.groupId = group.id;
        attr.groupName = group.name;
        attr.teamName = teamName;
        attr.workspaceId = group.workspaceId;
      }
    }
  }

  // Sum workspace-level maximums → true cross-workspace total per user
  for (const [userId, wsMap] of userWorkspaceMaxSpend) {
    const attr = userGroupAttr.get(userId);
    if (attr) attr.spendUsd = [...wsMap.values()].reduce((sum, s) => sum + s, 0);
  }

  const callerIsAccountAdmin = isAccountWide(req.authz);

  // Pass 2: emit one entry per relevant member.
  // Workspace admins see only members in their visible groups.
  const users: {
    userId: string;
    username: string;
    email: string;
    teamName: string;
    groupName: string;
    spendUsd: number;
    workspaceRole: string;
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
      teamName: attr?.teamName ?? "",
      groupName: attr?.groupName ?? "",
      spendUsd: (attr?.spendUsd ?? 0) + (extraSpend.byUser.get(userId) ?? 0),
      workspaceRole,
    });
  }

  // Sort spend descending
  users.sort((a, b) => b.spendUsd - a.spendUsd);

  const isComplete = groupsLoaded === totalGroups && extraSpend.isComplete;
  res.json({ isComplete, loadedCount: groupsLoaded, totalCount: totalGroups, users });
});

export default router;
