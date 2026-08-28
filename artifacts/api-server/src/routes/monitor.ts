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
  apiDirectoryCacheTable,
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
  ListWorkspaceAdminsResponse,
  ListAlertsQueryParams,
  ListAlertsResponse,
  RunAlertCheckResponse,
  SendTestAlertResponse,
  GetStatusResponse,
  GetGroupDetailResponse,
  GetGroupProjectsResponse,
  GetCanonicalClusterHeadlineResponse,
  GetTrendsQueryParams,
  GetTrendsResponse,
  ListEditorsResponse,
  AddEditorBody,
  AddEditorResponse,
  DeleteEditorResponse,
  RebuildUsageRangeBody,
  RebuildUsageRangeResponse,
} from "@workspace/api-zod";
import {
  isConfigured,
  getApiHealth,
  getDirectory,
  getSpend,
  getBillingPeriod,
  getBillingPeriodMetadata,
  getAccountTotalVerificationState,
  resolvePaceUsageRange,
  queueFullRangeRebuild,
  queueGroupSpendFetch,
  refreshAllGroupSpends,
  queueMemberUsageFetch,
  getMemberUsage,
  queueAccountUsageFetch,
  queueAllWorkspacesFetch,
  queueWsSpendFetch,
  getWsSpendByUser,
  applyComcastReAttribution,
  getWorkspaceMemberUsage,
  queueProjectUsageFetch,
  getProjectUsage,
  queueProjectTitlesFetch,
  getProjectTitles,
  getProjectInfo,
  hasProjectInfo,
  getCanonicalUsage,
  getUsageSyncSummary,
  isUsageSyncRetryable,
  buildCanonicalGroupMergePlan,
  resolveCanonicalMergedGroupBudget,
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
  isAdminRole,
  scopeGroups,
  type Authorization,
} from "../lib/authz";
import {
  getHistoryForGroups,
  getRosterHistory,
  projectEndOfPeriod,
} from "../lib/history";
import { generateTrendBuckets } from "../lib/trend-buckets";
import {
  attributeHistoricalDay,
  mergeHistoricalGroupSpend,
  partitionTrendBucket,
} from "../lib/historical-attribution";

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

type CanonicalUserAttribution = {
  groupName: string;
  teamName: string;
  workspaceId: string;
  displaySpendUsd: number;
};

/**
 * Choose display metadata from canonical attribution without using it to
 * calculate totals. Totals always come from canonical.byUser.
 */
function canonicalUserAttribution(
  canonical: ReturnType<typeof getCanonicalUsage>,
  groups: EnterpriseGroup[],
  groupMembers: ReadonlyMap<string, readonly string[]>,
  teamNameMap: ReadonlyMap<string, string>,
): Map<string, CanonicalUserAttribution> {
  const ordered = [...groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const byId = new Map(groups.map((group) => [group.id, group]));
  const result = new Map<string, CanonicalUserAttribution>();

  // Give every directory member a stable group/team even when their spend is zero.
  for (const group of ordered) {
    const primaryId = canonical.mergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const primary = byId.get(primaryId) ?? group;
    for (const userId of groupMembers.get(group.id) ?? []) {
      if (!result.has(userId)) {
        result.set(userId, {
          groupName: primary.name,
          teamName: teamNameMap.get(primary.name) ?? "",
          workspaceId: group.workspaceId,
          displaySpendUsd: 0,
        });
      }
    }
  }

  // Preserve the existing primary-cost-center presentation, but only compare
  // canonical workspace observations. This never changes the canonical total.
  for (const group of ordered) {
    const primaryId = canonical.mergePlan.primaryByGroupId.get(group.id) ?? group.id;
    const primary = byId.get(primaryId) ?? group;
    for (const [userId, spendUsd] of canonical.byGroup.get(group.id)?.byUser ?? []) {
      const current = result.get(userId);
      if (!current || spendUsd > current.displaySpendUsd) {
        result.set(userId, {
          groupName: primary.name,
          teamName: teamNameMap.get(primary.name) ?? "",
          workspaceId: group.workspaceId,
          displaySpendUsd: spendUsd,
        });
      }
    }
  }

  return result;
}

interface CurrentAlertUsage {
  spendUsd: number | null;
  percentUsed: number | null;
  isComplete: boolean;
}

function alertToJson(
  a: typeof alertsTable.$inferSelect,
  current?: CurrentAlertUsage,
) {
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
    currentSpendUsd: current?.spendUsd ?? null,
    currentPercentUsed: current?.percentUsed ?? null,
    currentUsageComplete: current?.isComplete ?? false,
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
    const isAccountAdmin = isAccountWide(req.authz);
    const groupedWorkspaceIds = scoped.map((group) => group.workspaceId);
    const scopedWorkspaceIds = isAccountAdmin
      ? new Set([...dir.workspaces.keys(), ...groupedWorkspaceIds])
      : new Set([...req.authz!.workspaceIds, ...groupedWorkspaceIds]);

    // Detect same-name groups across workspaces (e.g. after a workspace migration)
    // so only the preferred workspace version shows as a single merged row.
    const mergePlan = buildCanonicalGroupMergePlan(scoped, dir.workspaces);
    const displayGroups = scoped.filter((g) => !mergePlan.hiddenGroupIds.has(g.id));
    const paceMetadata = getBillingPeriodMetadata();
    // Pace is meaningful only on the current billing view. When discovery is
    // unavailable, the reporting range already matches the safe cutoff fallback.
    const paceRange = range.key.startsWith("billing:")
      ? (paceMetadata.isFallback ? range : resolvePaceUsageRange())
      : null;

    // Queue the one-call account headline and the much smaller workspace set
    // before hundreds of group detail calls. /groups and /summary launch
    // together; without distinct priorities, whichever route arrives first can
    // leave a newly selected custom range looking unchanged for many minutes.
    if (isAccountAdmin) {
      queueAccountUsageFetch(range, -30);
    }
    for (const workspaceId of scopedWorkspaceIds) {
      queueWsSpendFetch(workspaceId, range, -20);
      queueProjectTitlesFetch(workspaceId, -20);
    }
    // Member/project detail fills in after the range headline and canonical
    // workspace rollup have had a chance to update.
    for (const group of scoped) {
      queueMemberUsageFetch(group, range, 0);
      queueProjectUsageFetch(group, range, 0);
      queueProjectTitlesFetch(group.workspaceId, 0);
    }
    if (paceRange) {
      for (const group of scoped) {
        queueMemberUsageFetch(group, paceRange, -20);
        queueProjectUsageFetch(group, paceRange, -20);
      }
      for (const workspaceId of scopedWorkspaceIds) {
        queueWsSpendFetch(workspaceId, paceRange, -20);
      }
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
    // Pass ALL scoped groups (including aliases) so the dedup rollup correctly
    // attributes shared users across both the old and new workspace versions.
    const canonical = getCanonicalUsage(
      scoped,
      range.key,
      scopedWorkspaceIds,
      dir.groupMembers,
      dir.members,
      groupTeamMap,
      dir.workspaces,
      isAccountAdmin,
    );
    const rollup = canonical;
    const paceCanonical = paceRange
      ? getCanonicalUsage(
          scoped,
          paceRange.key,
          scopedWorkspaceIds,
          dir.groupMembers,
          dir.members,
          groupTeamMap,
          dir.workspaces,
          false,
        )
      : null;
    const rollupMemberCounts = getDedupedMemberCounts(scoped, dir.groupMembers);
    const projectAttribution = canonical.projectAttribution!;
    const sync = getUsageSyncSummary(
      range.key,
      scoped,
      scopedWorkspaceIds,
      false,
    );

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
        const fullyLoaded = rollup.isComplete;

        // Sum spend across all same-name source groups. The rollup already deduplicates
        // users so summing byGroup values produces the correct combined total without
        // double-counting: each user's spend appears in exactly one source group.
        const combinedSpend = sourceIds.reduce(
          (sum, id) => sum + (rollup.byGroup.get(id)?.spendUsd ?? 0),
          0,
        );
        const paceSpend = paceCanonical?.spendByPrimaryGroup.get(g.id) ?? 0;
        const projectSpendUsd = sourceIds.reduce(
          (sum, id) => sum + (projectAttribution.spendByGroup.get(id) ?? 0),
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

        const mergedBudget = resolveCanonicalMergedGroupBudget(g.id, mergePlan, budgetMap);
        const budget = effectiveGroupBudget(mergedBudget?.amountUsd);
        // Threshold state is always tracked against the cutoff-anchored billing period.
        const billingPeriodStart = getBillingPeriod().start;
        const fired =
          billingPeriodStart && budget.amountUsd != null
            ? await getFiredThresholds(g.id, billingPeriodStart)
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
          isSynthetic: false,
          syntheticKind: undefined as "no_group" | undefined,
          memberCount: rawMemberCount || (dir.groupMembers.get(g.id)?.length ?? null),
          rollupMemberCount: mergedRollupMemberCount,
          spendLoaded: fullyLoaded,
          spendUsd: fullyLoaded ? combinedSpend : null,
          paceSpendLoaded: paceCanonical?.isComplete ?? false,
          paceSpendUsd: paceCanonical?.isComplete ? paceSpend : null,
          projectSpendLoaded: projectAttribution.isComplete,
          projectSpendUsd: projectAttribution.isComplete ? projectSpendUsd : null,
          rollupSpendLoaded: rollup.isComplete,
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

    for (const [workspaceId, ungrouped] of rollup.ungroupedByWorkspace) {
      const workspaceUsage = getWorkspaceMemberUsage(workspaceId, range.key);
      const paceUngrouped = paceCanonical?.ungroupedByWorkspace.get(workspaceId);
      groups.push({
        groupId: `synthetic:no-group:${workspaceId}`,
        workspaceId,
        workspaceName: dir.workspaces.get(workspaceId)?.name ?? null,
        name: "No group",
        teamName: null,
        type: "synthetic",
        isSynthetic: true,
        syntheticKind: "no_group",
        memberCount: ungrouped.memberCount,
        rollupMemberCount: ungrouped.memberCount,
        spendLoaded: rollup.isComplete,
        spendUsd: rollup.isComplete ? ungrouped.spendUsd : null,
        paceSpendLoaded: paceCanonical?.isComplete ?? false,
        paceSpendUsd: paceCanonical?.isComplete ? (paceUngrouped?.spendUsd ?? 0) : null,
        projectSpendLoaded: true,
        projectSpendUsd: null,
        rollupSpendLoaded: rollup.isComplete,
        rollupSpendUsd: ungrouped.spendUsd,
        rawMemberSpendUsd: null,
        rawMemberSpendLoaded: false,
        spendUpdatedAt: workspaceUsage
          ? new Date(workspaceUsage.fetchedAt).toISOString()
          : null,
        budgetUsd: null,
        budgetSource: null,
        remainingUsd: null,
        percentUsed: null,
        thresholdsFired: [],
        history: [],
        projectedSpendUsd: null,
      });
    }

    // Member-deduped team spend. Sum the rollup byGroup values per team so that
    // team totals stay consistent with the member-deduped spend shown on each
    // group row and on each group's detail page.
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
      let teamRollupSpend = 0;
      for (const g of tGroups) {
        const srcIds = mergePlan.mergeMap.get(g.id) ?? [g.id];
        for (const srcId of srcIds) {
          teamRollupSpend += rollup.byGroup.get(srcId)?.spendUsd ?? 0;
        }
      }
      // spendUsd is the current deduped rollup estimate for this team — it is
      // always emitted (non-null) so the dashboard can display it as a
      // provisional figure while loading is still in progress. spendLoaded
      // remains a global flag because the two-phase dedup algorithm can change
      // any team's attributed total when any other group loads (Phase 1 sums
      // spend across ALL groups before Phase 2 attributes it to the first
      // sorted group). The dashboard uses spendUsd immediately and treats
      // spendLoaded as "is the value now final?" rather than "is there a
      // value to show?".
      teamRawSpend[teamName] = {
        spendUsd: teamRollupSpend,
        spendLoaded: rollup.isComplete,
      };
    }

    res.json(
      ListGroupsResponse.parse({
        groups,
        isComplete: sync.status === "complete" && canonical.isComplete,
        syncStatus:
          sync.status === "complete" && !canonical.isComplete
            ? "syncing"
            : sync.status,
        syncError: sync.error,
        // Durable sync status covers API usage scopes, while canonical readiness
        // also waits for creator metadata when non-AI attribution needs it.
        pendingCount: Math.max(sync.pendingCount, canonical.pendingCount),
        failedCount: sync.failedCount,
        partialCount: sync.partialCount,
        billingPeriodLabel: range.label,
        projectSpendLoaded: projectAttribution.isComplete,
        unattributedProjectSpendUsd: projectAttribution.unattributedSpendUsd,
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
    const accountScoped = visibleGroups(req.authz!, dir.groups);

    // Build merge plan so alias (hidden) groups redirect and primaries aggregate
    // member usage and spend from all same-name workspace variants.
    const mergePlan = buildCanonicalGroupMergePlan(accountScoped, dir.workspaces);

    // If this group is a hidden alias, treat it as not found (the primary carries
    // all the data; direct navigation to an alias would show misleading $0 spend).
    if (mergePlan.hiddenGroupIds.has(group.id)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    // Source group IDs: this primary plus any same-name aliases.
    const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
    const requestedScopeIds = String(req.query["scopeGroupIds"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const requestedScopeGroups = requestedScopeIds.map((id) =>
      accountScoped.find((candidate) => candidate.id === id),
    );
    if (
      requestedScopeIds.length > 0 &&
      requestedScopeGroups.some((candidate) => !candidate)
    ) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const detailScopeIds = requestedScopeIds.length > 0
      ? new Set(
          requestedScopeIds.flatMap((id) => {
            const primaryId = mergePlan.primaryByGroupId.get(id) ?? id;
            return mergePlan.mergeMap.get(primaryId) ?? [id];
          }),
        )
      : undefined;
    // Ownership must be resolved against the same complete caller-visible scope
    // as /groups. scopeGroupIds only validates the cluster requested by the
    // client; narrowing attribution to that cluster changes the owner of shared
    // and cross-workspace users and makes detail totals disagree with dashboard.
    const scoped = accountScoped;

    // Promote the selected group's data ahead of dashboard background work.
    // Other visible groups continue warming at low priority, but no longer block
    // this cluster's readiness.
    for (const srcId of sourceIds) {
      const srcGroup = dir.groups.find((g) => g.id === srcId);
      if (srcGroup) {
        queueGroupSpendFetch(srcGroup, 0, false, undefined, range);
      }
    }
    const interactiveDetailIds = detailScopeIds ?? new Set(sourceIds);
    for (const g of scoped) {
      const isInteractiveDetail = interactiveDetailIds.has(g.id);
      queueMemberUsageFetch(g, range, isInteractiveDetail ? -10 : 1);
      // Queue project usage for other groups at lower priority so that
      // getProjectAttribution eventually reflects full cross-group data here too,
      // making projectSpendUsd consistent between the detail page and dashboard.
      queueProjectUsageFetch(g, range, isInteractiveDetail ? -10 : 2);
      if (isInteractiveDetail) queueProjectTitlesFetch(g.workspaceId, -10);
    }

    const spend = getSpend(group.id, range.key);

    const isAccountAdmin = isAccountWide(req.authz);
    const groupedWorkspaceIds = scoped.map((item) => item.workspaceId);
    const scopedWorkspaceIds = isAccountAdmin
      ? new Set([...dir.workspaces.keys(), ...groupedWorkspaceIds])
      : new Set([...req.authz!.workspaceIds, ...groupedWorkspaceIds]);
    for (const workspaceId of scopedWorkspaceIds) {
      queueWsSpendFetch(workspaceId, range, 0);
      queueProjectTitlesFetch(workspaceId, 0);
    }
    const canonical = getCanonicalUsage(
      scoped,
      range.key,
      scopedWorkspaceIds,
      dir.groupMembers,
      dir.members,
      undefined,
      dir.workspaces,
      isAccountAdmin,
      true,
      detailScopeIds,
    );
    const rollup = canonical;
    const rollupMemberCounts = getDedupedMemberCounts(scoped, dir.groupMembers);
    const projectAttribution = canonical.projectAttribution!;
    const projectSpendUsd = sourceIds.reduce(
      (sum, id) => sum + (projectAttribution.spendByGroup.get(id) ?? 0),
      0,
    );
    const projectSpendLoaded = projectAttribution.isComplete;

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
    const mergedBudget = resolveCanonicalMergedGroupBudget(group.id, mergePlan, budgetMap);
    const budget = effectiveGroupBudget(mergedBudget?.amountUsd);
    const hasBudget = budget.amountUsd != null && budget.amountUsd > 0;
    const billingPeriodStart = getBillingPeriod().start;
    const billingSpend = getSpend(group.id, resolveRange("billing").key);
    const fired =
      billingPeriodStart && budget.amountUsd != null
        ? await getFiredThresholds(group.id, billingPeriodStart)
        : [];

    // Merge history from all source groups by date.
    const detailHistoryArr: { date: string; spendUsd: number }[] = [];
    if (billingPeriodStart) {
      const histResult = await getHistoryForGroups(
        [...new Set(sourceIds)],
        billingPeriodStart,
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
      // Every per-user surface uses the same canonical all-metric total for the
      // caller's selected range and visible workspaces.
      const spendLoaded = canonical.isComplete;
      const totalSpendLoaded = canonical.authoritativeSpendComplete;
      const totalSpendUsd = sourceIds.reduce(
        (sum, id) => sum + (canonical.authoritativeSpendByGroup.get(id)?.get(userId) ?? 0),
        0,
      );
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
        spendUsd: totalSpendLoaded ? totalSpendUsd : null,
        aiSpendUsd: spendLoaded ? aiSpendUsd : null,
        nonAiSpendUsd: spendLoaded ? nonAiSpendUsd : null,
        remainingUsd: null,
        percentUsed: null,
      };
    });

    // Reconciliation: members removed from the group since the last sync still count
    // toward group spend (they are captured in the rollup).  unattributedSpendUsd
    // surfaces that residual so the cluster page can show an accurate attributed total.
    const combinedSpend = attributed.spendUsd;
    const combinedLoaded = canonical.isComplete;
    const totalSpendLoaded = canonical.authoritativeSpendComplete;
    let listedMembersSpend = 0;
    if (totalSpendLoaded) {
      for (const userId of userIds) {
        listedMembersSpend += sourceIds.reduce(
          (sum, id) => sum + (canonical.authoritativeSpendByGroup.get(id)?.get(userId) ?? 0),
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
          teamName: groupTeamMap.get(group.name) ?? null,
          type: group.type,
          memberCount: userIds.length,
          rollupMemberCount: mergedRollupMemberCount,
          spendLoaded: totalSpendLoaded,
          spendUsd: totalSpendLoaded ? combinedSpend : null,
          paceSpendLoaded: false,
          paceSpendUsd: null,
          projectSpendLoaded,
          projectSpendUsd: projectSpendLoaded ? projectSpendUsd : null,
          rollupSpendLoaded: rollup.isComplete,
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
        isComplete: combinedLoaded,
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

    const titlesComplete = hasProjectInfo(group.workspaceId);
    const isComplete = !!projectUsage && titlesComplete;

    const projects = projectUsage
      ? Array.from(projectUsage.byProject.values())
          .map((p) => {
            const info = getProjectInfo(group.workspaceId, p.projectId);
            const aiSpendUsd = Math.min(
              p.totalCostUsd,
              Math.max(0, p.metrics
                .filter((metric) => metric.category.toLowerCase() === "ai")
                .reduce((sum, metric) => sum + metric.costUsd, 0)),
            );
            const creatorId = info?.creatorId ?? null;
            return {
              projectId: p.projectId,
              title: titleMap.get(p.projectId) ?? null,
              totalCostUsd: p.totalCostUsd,
              aiSpendUsd,
              nonAiSpendUsd: Math.max(0, p.totalCostUsd - aiSpendUsd),
              creatorId,
              creatorName: creatorId
                ? (dir.members.get(creatorId)?.name ?? dir.members.get(creatorId)?.username ?? null)
                : null,
              creatorIsCurrentMember:
                creatorId !== null &&
                (dir.groupMembers.get(group.id) ?? []).includes(creatorId),
              metrics: p.metrics,
              workspaceId: p.workspaceId,
              workspaceName: p.workspaceId ? (dir.workspaces.get(p.workspaceId)?.name ?? null) : null,
            };
          })
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
        titlesComplete,
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

router.get("/clusters/:clusterKey/headline", async (req, res): Promise<void> => {
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
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
    const visible = visibleGroups(req.authz!, dir.groups);
    const accountMergePlan = buildCanonicalGroupMergePlan(visible, dir.workspaces);
    const relevantGroupIds = new Set(
      groupIds.flatMap((groupId) => {
        const primaryId = accountMergePlan.primaryByGroupId.get(groupId) ?? groupId;
        return accountMergePlan.mergeMap.get(primaryId) ?? [groupId];
      }),
    );
    // Match /groups exactly: resolve ownership across every group and workspace
    // visible to this caller, then return only the requested cluster slice.
    const scoped = visible;
    const isAccountAdmin = isAccountWide(req.authz);
    const groupedWorkspaceIds = scoped.map((group) => group.workspaceId);
    const scopedWorkspaceIds = isAccountAdmin
      ? new Set([...dir.workspaces.keys(), ...groupedWorkspaceIds])
      : new Set([...req.authz!.workspaceIds, ...groupedWorkspaceIds]);
    for (const workspaceId of scopedWorkspaceIds) {
      queueWsSpendFetch(workspaceId, range, -20);
    }
    for (const group of scoped) {
      const priority = relevantGroupIds.has(group.id) ? -10 : 0;
      queueMemberUsageFetch(group, range, priority);
      queueProjectUsageFetch(group, range, priority);
      queueProjectTitlesFetch(group.workspaceId, priority);
    }
    const canonical = getCanonicalUsage(
      scoped,
      range.key,
      scopedWorkspaceIds,
      dir.groupMembers,
      dir.members,
      undefined,
      dir.workspaces,
      false,
      false,
      relevantGroupIds,
    );
    const primaryIds = new Set(
      groupIds.map((groupId) => canonical.mergePlan.primaryByGroupId.get(groupId) ?? groupId),
    );
    const spendUsd = [...primaryIds].reduce(
      (sum, groupId) => sum + (canonical.spendByPrimaryGroup.get(groupId) ?? 0),
      0,
    );
    res.json(GetCanonicalClusterHeadlineResponse.parse({
      spendUsd: canonical.authoritativeSpendComplete ? spendUsd : null,
      isComplete: canonical.authoritativeSpendComplete,
      pendingCount: canonical.authoritativePendingCount,
    }));
  } catch (err) {
    req.log.error({ err }, "getClusterHeadline failed");
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
      {
        entry: { projectId: string; totalCostUsd: number; metrics: ProjectUsageMetric[] };
        workspaceId: string;
        groupId: string;
      }
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
        if (
          !existing ||
          entry.totalCostUsd > existing.entry.totalCostUsd ||
          (
            entry.totalCostUsd === existing.entry.totalCostUsd &&
            g.id.localeCompare(existing.groupId) < 0
          )
        ) {
          projectMap.set(entry.projectId, {
            entry,
            workspaceId: g.workspaceId,
            groupId: g.id,
          });
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
      aiSpendUsd: number;
      nonAiSpendUsd: number;
      creatorId: string | null;
      creatorName: string | null;
      creatorIsCurrentMember: boolean;
      metrics: ProjectUsageMetric[];
      workspaceId: string | null;
      workspaceName: string | null;
    }[] = [];
    let unattributedSpendUsd = 0;

    for (const { entry, workspaceId } of projectMap.values()) {
      const info = getProjectInfo(workspaceId, entry.projectId);
      const creatorId = info?.creatorId ?? null;
      const aiSpendUsd = Math.min(
        entry.totalCostUsd,
        Math.max(0, entry.metrics
          .filter((metric) => metric.category.toLowerCase() === "ai")
          .reduce((sum, metric) => sum + metric.costUsd, 0)),
      );
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
        metrics: entry.metrics,
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
        isComplete: allGroupsLoaded && projectInfoLoaded,
        titlesComplete: projectInfoLoaded,
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

router.post("/usage/retry", async (req, res): Promise<void> => {
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const dir = await getDirectory();
  const scoped = visibleGroups(req.authz!, dir.groups);
  const groupedWorkspaceIds = scoped.map((group) => group.workspaceId);
  const workspaceIds = isAccountWide(req.authz)
    ? new Set([...dir.workspaces.keys(), ...groupedWorkspaceIds])
    : new Set([...req.authz!.workspaceIds, ...groupedWorkspaceIds]);
  for (const group of scoped) {
    if (isUsageSyncRetryable("group_member", range.key, group.id)) {
      queueMemberUsageFetch(group, range, -20, true);
    }
    if (isUsageSyncRetryable("group_project", range.key, group.id)) {
      queueProjectUsageFetch(group, range, -20, true);
    }
  }
  for (const workspaceId of workspaceIds) {
    if (isUsageSyncRetryable("workspace_member", range.key, workspaceId)) {
      queueWsSpendFetch(workspaceId, range, -20, true);
    }
  }
  if (
    isAccountWide(req.authz) &&
    isUsageSyncRetryable("account_total", range.key, "enterprise")
  ) {
    queueAccountUsageFetch(range, -20, true);
  }
  res.status(202).json(RefreshGroupUsageResponse.parse({ ok: true }));
});

router.get("/summary", async (req, res): Promise<void> => {
  const selectedRangeType =
    typeof req.query["rangeType"] === "string" ? req.query["rangeType"] : "billing";
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const authz = req.authz!;
  const isAccount = isAccountWide(authz);

  // Defensive timeout: the entire handler must respond within 25 s even if an
  // upstream call (DB, getDirectory) stalls.  Any unhandled throw in the outer
  // body is caught here so Express never sees an unanswered request.
  const SUMMARY_TIMEOUT_MS = 25_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("summary handler timed out")), SUMMARY_TIMEOUT_MS),
  );

  try {
    await Promise.race([
      (async () => {
        const [budgets, teamBudgets, groupTeams] = await Promise.all([
          db.select().from(groupBudgetsTable),
          db.select().from(teamBudgetsTable),
          db.select().from(groupTeamsTable),
        ]);
        const budgetMap = new Map(budgets.map((b) => [b.groupId, b.amountUsd]));

        let totalGroups = 0;
        let totalSpendUsd = 0;
        let memberBasedTotalSpendUsd = 0;
        let accountUsageTotalSpendUsd: number | null = null;
        let accountUsageAttributableSpendUsd: number | null = null;
        let accountUsageUnattributableSpendUsd: number | null = null;
        let reconciliationSpendUsd: number | null = null;
        let totalRemainingUsd = 0;
        let totalBudgetUsd = 0;
        let budgetedGroups = 0;
        let pending = 0;
        let summaryExtraComplete = true; // tracks extra-workspace load state for isComplete
        let over50 = 0;
        let over75 = 0;
        let over90 = 0;
        let over100 = 0;
        let scoped: EnterpriseGroup[] = [];
        let scopedWorkspaceIds = new Set<string>();

        // Set of visible groups, used both to scope spend and to filter alerts.
        let visibleGroupIds = new Set<string>();

        if (isConfigured()) {
          try {
            const dir = await getDirectory();
            scoped = visibleGroups(authz, dir.groups);
            visibleGroupIds = new Set(scoped.map((g) => g.id));
            scopedWorkspaceIds = isAccount
              ? new Set([
                  ...dir.workspaces.keys(),
                  ...scoped.map((group) => group.workspaceId),
                ])
              : new Set([
                  ...authz.workspaceIds,
                  ...scoped.map((group) => group.workspaceId),
                ]);
            // The selected-range headline and workspace-authoritative rollup
            // must preempt the hundreds of slower group detail requests.
            if (isAccount) {
              queueAccountUsageFetch(range, -30);
            }
            for (const workspaceId of scopedWorkspaceIds) {
              queueWsSpendFetch(workspaceId, range, -20);
              queueProjectTitlesFetch(workspaceId, -20);
            }
            // Queue both detail models independently so /summary can eventually
            // become fully attributable without requiring /groups first.
            for (const group of scoped) {
              queueMemberUsageFetch(group, range, 1);
              queueProjectUsageFetch(group, range, 1);
            }
            const groupTeamMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));
            const canonical = getCanonicalUsage(
              scoped,
              range.key,
              scopedWorkspaceIds,
              dir.groupMembers,
              dir.members,
              groupTeamMap,
              dir.workspaces,
              isAccount,
            );
            memberBasedTotalSpendUsd = canonical.totalSpendUsd;
            totalGroups = canonical.displayGroups.length;
            budgetedGroups = canonical.displayGroups.filter(
              (group) =>
                (resolveCanonicalMergedGroupBudget(
                  group.id,
                  canonical.mergePlan,
                  budgetMap,
                )?.amountUsd ?? 0) > 0,
            ).length;
            // Workspace-aware member attribution is the source of truth for rows,
            // budgets, teams, and alerts. For account-wide viewers, the unfiltered
            // account /usage anchor is the headline total and the difference is an
            // explicit reconciliation row so the visible table sums to gross usage.
            totalSpendUsd = canonical.totalSpendUsd;
            if (isAccount) {
              const accountUsage = canonical.accountUsage;
              if (accountUsage) {
                accountUsageTotalSpendUsd = accountUsage.totalCostUsd;
                accountUsageAttributableSpendUsd = accountUsage.attributableTotalCostUsd;
                accountUsageUnattributableSpendUsd = accountUsage.unattributableTotalCostUsd;
                reconciliationSpendUsd = canonical.accountReconciliationSpendUsd;
                totalSpendUsd = accountUsage.totalCostUsd;
              }
            }
            pending = canonical.pendingCount;
            summaryExtraComplete = canonical.isComplete;

            // Compute over-threshold counts using the same top-level pool logic as tableTotals.
            // Groups assigned to a team: aggregate attributed spend per team and compare against team budget.
            // Unassigned groups: compare attributed spend against the group's own budget.
            const teamBudgetAmountMap = new Map(teamBudgets.map((tb) => [tb.teamName, tb.amountUsd]));
            const teamAttributedSpend = canonical.byTeam;
            for (const group of canonical.displayGroups) {
              const spend = canonical.spendByPrimaryGroup.get(group.id) ?? 0;
              const teamName = groupTeamMap.get(group.name);
              if (!teamName) {
                const groupBudget = resolveCanonicalMergedGroupBudget(
                  group.id,
                  canonical.mergePlan,
                  budgetMap,
                )?.amountUsd;
                if (groupBudget != null && groupBudget > 0) {
                  const pct = (spend / groupBudget) * 100;
                  if (pct >= 50) over50++;
                  if (pct >= 75) over75++;
                  if (pct >= 90) over90++;
                  if (pct >= 100) over100++;
                }
              }
            }
            for (const [teamName, spend] of teamAttributedSpend) {
              const budget = teamBudgetAmountMap.get(teamName);
              if (budget != null && budget > 0) {
                const pct = (spend / budget) * 100;
                if (pct >= 50) over50++;
                if (pct >= 75) over75++;
                if (pct >= 90) over90++;
                if (pct >= 100) over100++;
              }
            }

            // Compute totalBudgetUsd and totalRemainingUsd using the same top-level pool model as
            // tableTotals: one budget entry per team pool, plus each unassigned group's own budget.
            // Remaining subtracts only the attributed spend from budgeted pools so it reconciles
            // with the table footer (unattributed / unbudgeted spend does not reduce remaining).
            const seenTeams = new Set<string>();
            let budgetedPoolSpend = 0;
            totalBudgetUsd = 0; // override outer default; set correctly below
            for (const group of canonical.displayGroups) {
              const teamName = groupTeamMap.get(group.name);
              if (teamName) {
                if (!seenTeams.has(teamName)) {
                  seenTeams.add(teamName);
                  const budget = teamBudgetAmountMap.get(teamName);
                  if (budget != null && budget > 0) {
                    totalBudgetUsd += budget;
                    budgetedPoolSpend += teamAttributedSpend.get(teamName) ?? 0;
                  }
                }
              } else {
                const budget = resolveCanonicalMergedGroupBudget(
                  group.id,
                  canonical.mergePlan,
                  budgetMap,
                )?.amountUsd;
                if (budget != null && budget > 0) {
                  totalBudgetUsd += budget;
                  budgetedPoolSpend += canonical.spendByPrimaryGroup.get(group.id) ?? 0;
                }
              }
            }
            totalRemainingUsd = totalBudgetUsd - budgetedPoolSpend;
          } catch (err) {
            req.log.error({ err }, "summary directory fetch failed");
          }
        }

        const billing = getBillingPeriod();
        const pacePeriod = getBillingPeriodMetadata();
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

        const sync = getUsageSyncSummary(
          range.key,
          scoped,
          scopedWorkspaceIds,
          isAccount,
          false,
        );
        res.json(
          GetSummaryResponse.parse({
            totalGroups,
            budgetedGroups,
            totalSpendUsd,
            memberBasedTotalSpendUsd,
            accountUsageTotalSpendUsd,
            accountUsageAttributableSpendUsd,
            accountUsageUnattributableSpendUsd,
            reconciliationSpendUsd,
            totalBudgetUsd,
            totalRemainingUsd,
            groupsOver50: over50,
            groupsOver75: over75,
            groupsOver90: over90,
            groupsOver100: over100,
            alertsSentThisPeriod,
            billingPeriodLabel: range.label,
            reportingRangeStart: range.params.startTime,
            reportingRangeEnd: range.params.endTime,
            billingPeriodDiffersFromReportingCutoff:
              selectedRangeType === "billing" && pacePeriod.differsFromReportingCutoff,
            pacePeriodStart: pacePeriod.start,
            pacePeriodEnd: pacePeriod.end,
            pacePeriodLabel: pacePeriod.label,
            pacePeriodIsFallback: pacePeriod.isFallback,
            isComplete:
              sync.status === "complete" &&
              pending === 0 &&
              summaryExtraComplete &&
              (!isAccount || accountUsageTotalSpendUsd !== null),
            syncStatus: sync.status,
            syncError: sync.error,
            pendingCount: sync.pendingCount,
            failedCount: sync.failedCount,
            partialCount: sync.partialCount,
          }),
        );
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    req.log.error({ err }, "summary handler failed or timed out");
    if (!res.headersSent) {
      res.status(503).json({ error: "Summary unavailable — please retry" });
    }
  }
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

router.get("/workspace-admins", requireAccountAdmin, async (_req, res): Promise<void> => {
  const [rows, groupTeams] = await Promise.all([
    db.select({ directoryJson: apiDirectoryCacheTable.directoryJson }).from(apiDirectoryCacheTable),
    db.select().from(groupTeamsTable),
  ]);

  if (!rows[0]) {
    res.json(ListWorkspaceAdminsResponse.parse([]));
    return;
  }

  const groupTeamMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  const raw = rows[0].directoryJson as Record<string, unknown>;
  const rawWorkspaces = (raw["workspaces"] ?? {}) as Record<string, Record<string, unknown>>;
  const rawMembers = (raw["members"] ?? {}) as Record<string, Record<string, unknown>>;
  const rawGroupMembers = (raw["groupMembers"] ?? {}) as Record<string, string[]>;
  const rawGroups = (raw["groups"] ?? []) as Array<{
    id: string;
    name: string;
    type: string;
    workspaceId: string;
  }>;

  const BUILT_IN = new Set(["admin", "member", "guest"]);
  const result = rawGroups
    .filter((g) => !BUILT_IN.has(g.type.toLowerCase()))
    .map((g) => {
      // Resolve the actual members of this group from the directory's groupMembers map.
      const memberIds = rawGroupMembers[g.id] ?? [];
      const admins = memberIds.flatMap((userId) => {
        const m = rawMembers[userId] as Record<string, unknown> | undefined;
        if (!m) return [];
        return [{
          userId,
          username: m["username"] as string,
          email: (m["email"] as string | null) ?? null,
          name: (m["name"] as string | null) ?? null,
        }];
      });
      return {
        groupId: g.id,
        groupName: g.name,
        workspaceId: g.workspaceId,
        workspaceName: (rawWorkspaces[g.workspaceId]?.["name"] as string | undefined) ?? g.workspaceId,
        teamName: groupTeamMap.get(g.name) ?? null,
        admins,
      };
    })
    .sort((a, b) => a.groupName.localeCompare(b.groupName));

  res.json(ListWorkspaceAdminsResponse.parse(result));
});

// ---------------------------------------------------------------------------
// Project spend CSV export — all groups, one row per project
// ---------------------------------------------------------------------------
router.get("/projects/export", requireAccountAdmin, async (req, res): Promise<void> => {
  if (!isConfigured()) {
    res.status(503).json({ error: "REPLIT_ENTERPRISE_API_KEY is not configured" });
    return;
  }

  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
  } catch {
    range = rangeFromQuery({});
  }

  try {
    const [dir, groupTeams] = await Promise.all([
      getDirectory(),
      db.select().from(groupTeamsTable),
    ]);

    const groupTeamMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));
    const groups = visibleGroups(req.authz!, dir.groups);

    // Kick off background fetches so future calls are warmer (low priority —
    // data may already be in cache from normal dashboard polling).
    const workspaceIds = new Set(groups.map((g) => g.workspaceId));
    for (const g of groups) queueProjectUsageFetch(g, range, 10);
    for (const wsId of workspaceIds) queueProjectTitlesFetch(wsId, 10);

    // Aggregate across all groups: one row per projectId.
    // Dedup strategy: keep the entry with the highest reported spend to avoid
    // double-counting when a project appears in multiple groups because its
    // creator belongs to more than one group.  Track every group that
    // reported the project for informational columns.
    const projectMap = new Map<string, {
      entry: { projectId: string; totalCostUsd: number; metrics: ProjectUsageMetric[] };
      workspaceId: string;
      winnerGroupId: string;
      groupNames: Set<string>;
    }>();

    for (const g of groups) {
      const usage = getProjectUsage(g.id, range.key);
      if (!usage) continue;
      for (const entry of usage.byProject.values()) {
        const existing = projectMap.get(entry.projectId);
        if (!existing) {
          projectMap.set(entry.projectId, {
            entry,
            workspaceId: g.workspaceId,
            winnerGroupId: g.id,
            groupNames: new Set([g.name]),
          });
        } else {
          existing.groupNames.add(g.name);
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
    for (const { entry, workspaceId, groupNames } of projectMap.values()) {
      const info = getProjectInfo(workspaceId, entry.projectId);
      const creatorId = info?.creatorId ?? null;
      const member = creatorId ? dir.members.get(creatorId) : undefined;

      const groupArr = Array.from(groupNames).sort();
      const teamSet = new Set<string>();
      for (const gn of groupArr) {
        const t = groupTeamMap.get(gn);
        if (t) teamSet.add(t);
      }

      const aiUsd = entry.metrics
        .filter((m) => m.category === "ai")
        .reduce((s, m) => s + m.costUsd, 0);
      const hostingUsd = entry.metrics
        .filter((m) => m.category === "hosting")
        .reduce((s, m) => s + m.costUsd, 0);
      const storageUsd = entry.metrics
        .filter((m) => m.category === "storage")
        .reduce((s, m) => s + m.costUsd, 0);
      // totalCostUsd is authoritative even when the API omits or introduces a
      // metric category, so the non-AI breakdown always reconciles to it.
      const otherUsd = Math.max(0, entry.totalCostUsd - aiUsd - hostingUsd - storageUsd);
      const nonAiUsd = Math.max(0, entry.totalCostUsd - aiUsd);
      const creatorOwner = creatorId
        ? orderedGroups.find(
          (group) =>
            group.workspaceId === workspaceId &&
            (dir.groupMembers.get(group.id) ?? []).includes(creatorId),
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
    const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
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

    const lines: string[] = [header.map(esc).join(",")];
    for (const r of rows) {
      lines.push(
        [
          esc(r.title),
          esc(r.projectId),
          esc(r.workspaceName),
          esc(r.ownerName),
          esc(r.ownerUsername),
          esc(r.creatorIsCurrentMember ? "Yes" : "No"),
          esc(r.attributedGroup),
          esc(r.teams),
          esc(r.groups),
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
  let allowedIds = new Set<string>();
  let currentByEntity = new Map<string, CurrentAlertUsage>();
  try {
    const dir = await getDirectory();
    const scoped = visibleGroups(authz, dir.groups);
    allowedIds = new Set(scoped.map((g) => g.id));
    const [groupTeams, groupBudgets, teamBudgets] = await Promise.all([
      db.select().from(groupTeamsTable),
      db.select().from(groupBudgetsTable),
      db.select().from(teamBudgetsTable),
    ]);
    const teamByGroupName = new Map(groupTeams.map((row) => [row.groupName, row.teamName]));
    const groupBudgetById = new Map(groupBudgets.map((row) => [row.groupId, row.amountUsd]));
    const teamBudgetByName = new Map(teamBudgets.map((row) => [row.teamName, row.amountUsd]));
    const range = resolveRange("billing");
    const workspaceIds = accountWide
      ? new Set([...dir.workspaces.keys(), ...scoped.map((group) => group.workspaceId)])
      : new Set([...authz.workspaceIds, ...scoped.map((group) => group.workspaceId)]);
    for (const group of scoped) {
      queueMemberUsageFetch(group, range, 1);
      queueProjectUsageFetch(group, range, 1);
      queueProjectTitlesFetch(group.workspaceId, 1);
    }
    for (const workspaceId of workspaceIds) queueWsSpendFetch(workspaceId, range, 1);
    const canonical = getCanonicalUsage(
      scoped,
      range.key,
      workspaceIds,
      dir.groupMembers,
      dir.members,
      teamByGroupName,
      dir.workspaces,
    );
    for (const group of canonical.displayGroups) {
      const budget = resolveCanonicalMergedGroupBudget(
        group.id,
        canonical.mergePlan,
        groupBudgetById,
      )?.amountUsd;
      const spend = canonical.spendByPrimaryGroup.get(group.id) ?? 0;
      currentByEntity.set(`group|${group.id}`, {
        spendUsd: canonical.isComplete ? spend : null,
        percentUsed: canonical.isComplete && budget != null && budget > 0
          ? (spend / budget) * 100
          : null,
        isComplete: canonical.isComplete,
      });
    }
    for (const [teamName, spend] of canonical.byTeam) {
      const budget = teamBudgetByName.get(teamName);
      currentByEntity.set(`team|${teamName}`, {
        spendUsd: canonical.isComplete ? spend : null,
        percentUsed: canonical.isComplete && budget != null && budget > 0
          ? (spend / budget) * 100
          : null,
        isComplete: canonical.isComplete,
      });
    }
  } catch {
    if (!accountWide) {
      // Fail closed: expose no alert history if workspace scope can't be resolved.
      res.json(ListAlertsResponse.parse([]));
      return;
    }
  }
  const allAlerts = await db
    .select()
    .from(alertsTable)
    .orderBy(desc(alertsTable.sentAt));
  const allowedWorkspaceIds = new Set(authz.workspaceIds);
  const scoped = allAlerts
    .filter((a) => accountWide || (
      a.entityType === "team"
        ? a.workspaceIds.length > 0 &&
          a.workspaceIds.every((workspaceId) => allowedWorkspaceIds.has(workspaceId))
        : allowedIds.has(a.entityId || a.groupId)
    ))
    .slice(0, limit)
    .map((a) => {
      const entityId = a.entityId || a.groupId;
      const alert = alertToJson(a, currentByEntity.get(`${a.entityType}|${entityId}`));
      return canSeeRecipients ? alert : { ...alert, recipients: [] };
    });
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
        alerts: result.alerts.map((alert) => alertToJson(alert)),
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
  const billingPeriod = getBillingPeriodMetadata();
  const reportingRange = resolveRange("billing");
  res.json(
    GetStatusResponse.parse({
      enterpriseApiConfigured: isConfigured(),
      enterpriseApiOk: health.ok,
      enterpriseApiError: health.error,
      emailConfigured,
      checkerIntervalMinutes: CHECK_INTERVAL_MINUTES,
      lastCheckAt: getLastCheckAt()?.toISOString() ?? null,
      billingPeriodStart: billingPeriod.start,
      billingPeriodEnd: billingPeriod.end,
      billingPeriodLabel: billingPeriod.label,
      billingPeriodFetchedAt: billingPeriod.fetchedAt,
      billingPeriodFresh: billingPeriod.isFresh,
      billingPeriodFallback: billingPeriod.isFallback,
      billingPeriodDiffersFromReportingCutoff: billingPeriod.differsFromReportingCutoff,
      reportingCutoff: SPEND_DATA_CUTOFF_ISO,
      reportingRangeKey: reportingRange.key,
      reportingRangeStart: reportingRange.params.startTime,
      reportingRangeEnd: reportingRange.params.endTime,
      reportingRangeLabel: reportingRange.label,
      accountTotalVerification: getAccountTotalVerificationState(),
    }),
  );
});

router.post(
  "/usage/ranges/rebuild",
  requireAccountAdmin,
  async (req, res): Promise<void> => {
    const parsed = RebuildUsageRangeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid usage range" });
      return;
    }
    let range: UsageRange;
    try {
      range = resolveRange(
        parsed.data.rangeType,
        parsed.data.startDate,
        parsed.data.endDate,
      );
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const dir = await getDirectory();
    queueFullRangeRebuild(range, dir.groups, [...dir.workspaces.keys()]);
    res.status(202).json(RebuildUsageRangeResponse.parse({ ok: true }));
  },
);

// ---------- Trends: bucketed spend over time ----------

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
  let selectedRange: UsageRange;
  try {
    selectedRange = rangeFromQuery(parsed.data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const buckets = generateTrendBuckets(selectedRange, granularity);

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
    const mergePlan = buildCanonicalGroupMergePlan(visible, dir.workspaces);
    const displayGroups = visible.filter((group) => !mergePlan.hiddenGroupIds.has(group.id));
    const groups = displayGroups.filter((group) => {
      const sourceIds = mergePlan.mergeMap.get(group.id) ?? [group.id];
      if (requestedGroups && !sourceIds.some((id) => requestedGroups.has(id))) return false;
      const teamName = teamNameMap.get(group.name) ?? null;
      return !requestedTeams || (teamName !== null && requestedTeams.has(teamName));
    });

    const accountWide = isAccountWide(req.authz);
    const scopedWorkspaceIds = accountWide
      ? new Set([...dir.workspaces.keys(), ...visible.map((group) => group.workspaceId)])
      : new Set([...req.authz!.workspaceIds, ...visible.map((group) => group.workspaceId)]);
    const rosterHistory = await getRosterHistory(
      visible.map((group) => group.id),
      buckets[0]!.startDate,
      buckets.at(-1)!.endDate,
    );
    const currentUtcDay = new Date().toISOString().slice(0, 10);
    const bucketPlans = buckets.map((bucket) => ({
      bucket,
      components: partitionTrendBucket(
        bucket.startDate,
        bucket.endDate,
        rosterHistory.completedDays,
        currentUtcDay,
      ).map((component) => ({
        ...component,
        range: resolveRange("custom", component.startDate, component.endDate),
      })),
    }));

    const queuedLiveRanges = new Set<string>();
    const queuedWorkspaceRanges = new Set<string>();
    for (const { components } of bucketPlans) {
      for (const component of components) {
        if (!queuedWorkspaceRanges.has(component.range.key)) {
          for (const workspaceId of scopedWorkspaceIds) {
            queueWsSpendFetch(workspaceId, component.range, 1);
          }
          queuedWorkspaceRanges.add(component.range.key);
        }
        if (component.rosterDate === null && !queuedLiveRanges.has(component.range.key)) {
          for (const group of visible) {
            queueMemberUsageFetch(group, component.range, 1);
            queueProjectUsageFetch(group, component.range, 1);
            queueProjectTitlesFetch(group.workspaceId, 1);
          }
          queuedLiveRanges.add(component.range.key);
        }
      }
    }

    interface TrendUsageResult {
      spendByPrimaryGroup: Map<string, number>;
      totalSpendUsd: number;
      isComplete: boolean;
    }

    const resultByRange = new Map<string, TrendUsageResult>();
    for (const { components } of bucketPlans) {
      for (const component of components) {
        if (resultByRange.has(component.range.key)) continue;
        if (component.rosterDate === null) {
          const canonical = getCanonicalUsage(
            visible,
            component.range.key,
            scopedWorkspaceIds,
            dir.groupMembers,
            dir.members,
            teamNameMap,
            dir.workspaces,
          );
          resultByRange.set(component.range.key, {
            spendByPrimaryGroup: new Map(canonical.spendByPrimaryGroup),
            totalSpendUsd: canonical.totalSpendUsd,
            isComplete: canonical.isComplete,
          });
          continue;
        }

        const usageByWorkspace = new Map(
          [...scopedWorkspaceIds].flatMap((workspaceId) => {
            const usage = getWorkspaceMemberUsage(workspaceId, component.range.key);
            return usage
              ? [[workspaceId, {
                byUser: usage.byUser,
                unattributableTotalCostUsd: usage.unattributableTotalCostUsd,
              }] as const]
              : [];
          }),
        );
        const historical = attributeHistoricalDay(
          visible,
          rosterHistory.membersByDate.get(component.rosterDate) ?? new Map(),
          scopedWorkspaceIds,
          usageByWorkspace,
        );
        const spendByPrimaryGroup = mergeHistoricalGroupSpend(
          displayGroups.map((group) => group.id),
          mergePlan.mergeMap,
          historical.spendByGroup,
        );
        resultByRange.set(component.range.key, {
          spendByPrimaryGroup,
          totalSpendUsd: historical.totalSpendUsd,
          isComplete: historical.isComplete,
        });
      }
    }

    const bucketResults = bucketPlans.map(({ components }): TrendUsageResult => {
      const spendByPrimaryGroup = new Map<string, number>();
      let totalSpendUsd = 0;
      let isComplete = true;
      for (const component of components) {
        const result = resultByRange.get(component.range.key)!;
        isComplete &&= result.isComplete;
        totalSpendUsd += result.totalSpendUsd;
        for (const [groupId, spendUsd] of result.spendByPrimaryGroup) {
          spendByPrimaryGroup.set(
            groupId,
            (spendByPrimaryGroup.get(groupId) ?? 0) + spendUsd,
          );
        }
      }
      return { spendByPrimaryGroup, totalSpendUsd, isComplete };
    });
    const totalCount = bucketResults.length;
    const loadedCount = bucketResults.filter((result) => result.isComplete).length;

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
      data: bucketResults.map((result) => {
        return result.isComplete
          ? (result.spendByPrimaryGroup.get(group.id) ?? 0)
          : null;
      }),
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
        data: bucketResults.map((result) => {
          return result.isComplete
            ? teamGroups.reduce(
                (sum, group) => sum + (result.spendByPrimaryGroup.get(group.id) ?? 0),
                0,
              )
            : null;
        }),
      }));

    const totals = bucketResults.map((result) => {
      if (!result.isComplete) return null;
      if (!requestedTeams && !requestedGroups) return result.totalSpendUsd;
      return groups.reduce(
        (sum, group) => sum + (result.spendByPrimaryGroup.get(group.id) ?? 0),
        0,
      );
    });

    res.json(
      GetTrendsResponse.parse({
        buckets: buckets.map((bucket) => bucket.startDate),
        bucketRanges: buckets.map((bucket) => ({
          start: bucket.startDate,
          end: bucket.endDate,
          isPartial: bucket.isPartial,
        })),
        totals,
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
  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
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

  const groupTeams = await db.select().from(groupTeamsTable);
  const teamNameMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  // Route is account-wide (true account admins and managed editors). Workspace
  // payloads are authoritative for canonical per-user totals.
  queueAllWorkspacesFetch(dir, range, 1);
  const workspaceIds = new Set(dir.workspaces.keys());
  for (const group of dir.groups) {
    queueMemberUsageFetch(group, range, 1);
    queueProjectUsageFetch(group, range, 1);
  }
  for (const workspaceId of workspaceIds) queueProjectTitlesFetch(workspaceId, 1);
  const canonical = getCanonicalUsage(
    dir.groups,
    range.key,
    workspaceIds,
    dir.groupMembers,
    dir.members,
    teamNameMap,
    dir.workspaces,
    true,
    true,
  );

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
  const userGroupAttr = canonicalUserAttribution(
    canonical,
    sortedGroupsForCsv,
    dir.groupMembers,
    teamNameMap,
  );

  // Pass 2: emit one row per enterprise member (covers users not in any custom group).
  // Extra-workspace spend (workspaces without custom groups) is added for every user
  // so cross-workspace totals stay complete.
  const rows: { email: string; name: string; username: string; group: string; team: string; workspaces: string; aiSpendUsd: number; nonAiSpendUsd: number; spendUsd: number }[] = [];
  for (const [userId, m] of dir.members) {
    const attr = userGroupAttr.get(userId);
    const wsNames = [...m.workspaces.keys()]
      .map((wsId) => dir.workspaces.get(wsId)?.name ?? wsId)
      .filter(Boolean)
      .join("; ");
    const spendUsd = canonical.byUser.get(userId) ?? 0;
    rows.push({
      email: m.email,
      name: m.name ?? "",
      username: m.username,
      group: attr?.groupName ?? "",
      team: attr?.teamName ?? "",
      workspaces: wsNames,
      aiSpendUsd: canonical.aiSpendByUser.get(userId) ?? 0,
      nonAiSpendUsd: canonical.nonAiSpendByUser.get(userId) ?? 0,
      spendUsd,
    });
  }

  // Sort by spend descending
  rows.sort((a, b) => b.spendUsd - a.spendUsd);

  // Build CSV
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["Email", "Name", "Username", "Workspace(s)", "Group", "Team", "AI Spend (USD)", "Hosting / Non-AI Spend (USD)", "Spend (USD)"].map(escape).join(",");
  const lines = rows.map((r) =>
    [r.email, r.name, r.username, r.workspaces, r.group, r.team, r.aiSpendUsd.toFixed(2), r.nonAiSpendUsd.toFixed(2), r.spendUsd.toFixed(2)].map(escape).join(","),
  );

  const isComplete = canonical.isComplete;
  const csv = [header, ...lines].join("\r\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="all-users-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.setHeader("X-Groups-Loaded", String(Math.max(0, workspaceIds.size - canonical.pendingCount)));
  res.setHeader("X-Groups-Total", String(workspaceIds.size));
  res.setHeader("X-Export-Complete", String(isComplete));
  res.setHeader("X-Usage-Range", range.key);
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
  if (!isConfigured()) {
    res.json({ isComplete: true, loadedCount: 0, totalCount: 0, users: [] });
    return;
  }

  let range: UsageRange;
  try {
    range = rangeFromQuery(req.query as Record<string, unknown>);
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

  const groupTeams = await db.select().from(groupTeamsTable);
  const teamNameMap = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  const callerIsAccountAdmin = isAccountWide(req.authz);
  const groupedWorkspaceIds = orderedGroups.map((group) => group.workspaceId);
  const scopedWorkspaceIds = callerIsAccountAdmin
    ? new Set([...dir.workspaces.keys(), ...groupedWorkspaceIds])
    : new Set([...req.authz!.workspaceIds, ...groupedWorkspaceIds]);
  for (const workspaceId of scopedWorkspaceIds) {
    queueWsSpendFetch(workspaceId, range, 1);
    queueProjectTitlesFetch(workspaceId, 1);
  }
  for (const group of orderedGroups) {
    queueMemberUsageFetch(group, range, 1);
    queueProjectUsageFetch(group, range, 1);
  }

  const visibleUserIds = new Set<string>();
  for (const group of orderedGroups) {
    for (const userId of dir.groupMembers.get(group.id) ?? []) {
      visibleUserIds.add(userId);
    }
  }

  const canonical = getCanonicalUsage(
    orderedGroups,
    range.key,
    scopedWorkspaceIds,
    dir.groupMembers,
    dir.members,
    teamNameMap,
    dir.workspaces,
    callerIsAccountAdmin,
    true,
  );
  const userGroupAttr = canonicalUserAttribution(
    canonical,
    orderedGroups,
    dir.groupMembers,
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
      spendUsd: canonical.byUser.get(userId) ?? 0,
      aiSpendUsd: canonical.aiSpendByUser.get(userId) ?? 0,
      nonAiSpendUsd: canonical.nonAiSpendByUser.get(userId) ?? 0,
      workspaceRole,
    });
  }

  // Sort spend descending
  users.sort((a, b) => b.spendUsd - a.spendUsd);

  const totalCount = scopedWorkspaceIds.size;
  res.json({
    isComplete: canonical.isComplete,
    loadedCount: Math.max(0, totalCount - canonical.pendingCount),
    totalCount,
    users,
  });
});

// ---------- Directory members ----------

router.get("/directory/members", requireAccountAdmin, async (req, res): Promise<void> => {
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
    if (!dir) {
      res.status(503).json({ error: "Directory not yet available" });
      return;
    }

    const members = [...dir.members.values()].map((m) => {
      const rawSpendByWorkspace = new Map(
        [...m.workspaces.keys()].map((workspaceId) => [
          workspaceId,
          getWsSpendByUser(workspaceId, range.key)?.get(m.userId) ?? 0,
        ]),
      );
      const {
        spendByWorkspace,
        reAttributedSpendByWorkspace,
      } = applyComcastReAttribution(dir.workspaces, rawSpendByWorkspace);

      return {
        userId: m.userId,
        username: m.username,
        name: m.name,
        email: m.email,
        isAccountAdmin: m.isAccountAdmin,
        workspaces: [...m.workspaces.entries()].map(([workspaceId, ws]) => {
          const reAttributedSpendUsd = reAttributedSpendByWorkspace.get(workspaceId) ?? 0;
          return {
            workspaceId,
            workspaceName: dir.workspaces.get(workspaceId)?.name ?? workspaceId,
            role: ws.role,
            isDisabled: ws.isDisabled,
            spendUsd: spendByWorkspace.get(workspaceId) ?? 0,
            ...(reAttributedSpendUsd > 0 ? { reAttributedSpendUsd } : {}),
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
