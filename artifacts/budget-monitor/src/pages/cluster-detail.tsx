import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useSearch } from 'wouter';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  getGetGroupDetailQueryOptions,
  getGetGroupDetailQueryKey,
  getGetClusterProjectsQueryOptions,
  getGetClusterProjectsQueryKey,
  useGetCanonicalClusterHeadline,
  getGetCanonicalClusterHeadlineQueryKey,
  useListVisibleWorkspaceMembers,
  getListVisibleWorkspaceMembersQueryKey,
  type WorkspaceMemberBudget,
  useBulkSetWorkspaceMemberBudgets,
  useListWorkspaceUsageLimitAudits,
  getListWorkspaceUsageLimitAuditsQueryKey,
  useGetWorkspaceLimitPolicies,
  getGetWorkspaceLimitPoliciesQueryKey,
  type DirectoryRole,
} from '@workspace/api-client-react';
import { useRange } from '@/components/range-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, DollarSign, Users, AlertCircle, RefreshCw } from 'lucide-react';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';
import {
  roleBadgeClass,
  roleLabel,
} from '@/lib/hierarchy-presentation';
import { GroupUserExport } from '@/components/group-user-export';
import { useAuthContext } from '@/components/auth-context';
import { MemberBudgetInput } from '@/components/member-budget-input';
import { InternalUserBadge } from '@/components/internal-user-badge';
import {
  chunkMemberIds,
  eligibleLimitMemberIds,
  failedBulkSelection,
  indexMemberBudgets,
  toggleDisplayedSelection,
} from '@/lib/member-budgets';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { UsageLimitDialog } from '@/components/usage-limit-dialog';
import { invalidateBudgetCaches } from '@/components/member-budget-input';
import { WorkspacePolicyControl } from '@/components/policy-control';

interface MergedMember {
  userId: string;
  username: string | null;
  email: string | null;
  name: string | null;
  role: DirectoryRole;
  allRoles: DirectoryRole[];
  spendUsd: number;
  spendLoaded: boolean;
  isInternal: boolean;
}

interface ClusterProjectMetric {
  id: string;
  name: string;
  category: string;
  costUsd: number;
}

interface ClusterProject {
  projectId: string;
  title: string | null;
  totalCostUsd: number;
  metrics: ClusterProjectMetric[];
  workspaceId: string | null;
  workspaceName: string | null;
}

interface GroupDetailResult {
  data?: {
    group: {
      groupId: string;
      role: DirectoryRole;
      workspaceId: string | null;
    };
    members: Array<{
      userId: string;
      username?: string | null;
      email?: string | null;
      name?: string | null;
      spendUsd?: number | null;
      isInternal: boolean;
    }>;
    unattributedSpendUsd?: number | null;
    rangeLabel?: string | null;
  };
}

interface WorkspaceMembersData {
  connector: {
    status: string;
    canWrite: boolean;
  };
}

function buildGroupRoleMap(results: readonly GroupDetailResult[]) {
  const roleMap: Record<string, DirectoryRole> = {};
  for (const result of results) {
    if (result.data) roleMap[result.data.group.groupId] = result.data.group.role;
  }
  return roleMap;
}

function mergeClusterMembers(
  results: readonly GroupDetailResult[],
  groupRoleMap: Record<string, DirectoryRole>,
  roleOrder: DirectoryRole[],
) {
  const memberMap = new Map<string, MergedMember>();
  let totalUnattributedSpend = 0;
  let rangeLabel = '';

  for (const result of results) {
    if (!result.data) continue;
    const { members, unattributedSpendUsd } = result.data;
    rangeLabel = result.data.rangeLabel ?? '';
    const subRole = groupRoleMap[result.data.group.groupId] ?? 'unsuffixed';
    totalUnattributedSpend += unattributedSpendUsd ?? 0;

    for (const member of members) {
      const existing = memberMap.get(member.userId);
      const spendLoaded = member.spendUsd != null;
      const spend = member.spendUsd ?? 0;
      if (!existing) {
        memberMap.set(member.userId, {
          userId: member.userId,
          username: member.username ?? null,
          email: member.email ?? null,
          name: member.name ?? null,
          role: subRole,
          allRoles: [subRole],
          isInternal: member.isInternal,
          spendUsd: spend,
          spendLoaded,
        });
        continue;
      }

      const bestRole =
        roleOrder.indexOf(subRole) < roleOrder.indexOf(existing.role)
          ? subRole
          : existing.role;
      if (!existing.allRoles.includes(subRole)) existing.allRoles.push(subRole);
      existing.role = bestRole;
      existing.isInternal ||= member.isInternal;
      existing.spendLoaded = existing.spendLoaded || spendLoaded;
      existing.spendUsd += spend;
    }
  }

  const mergedMembers = [...memberMap.values()].sort((a, b) => b.spendUsd - a.spendUsd);
  return {
    mergedMembers,
    totalMembersSpend: mergedMembers.reduce((total, member) => total + member.spendUsd, 0),
    totalUnattributedSpend,
    rangeLabel,
  };
}

function useBulkLimitActions(workspaceId: string | undefined, displayedMemberIds: string[]) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const bulkSetLimits = useBulkSetWorkspaceMemberBudgets();
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [bulkLimit, setBulkLimit] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  const handleBulkApplyClick = () => {
    const amountUsd = Number(bulkLimit);
    if (!workspaceId || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      toast({
        title: 'Invalid Agent limit',
        description: 'Enter a positive USD amount.',
        variant: 'destructive',
      });
      return;
    }
    const userIds = displayedMemberIds.filter((userId) => selectedMemberIds.has(userId));
    if (userIds.length === 0) return;
    setBulkConfirmOpen(true);
  };

  const applyBulkLimit = async () => {
    const amountUsd = Number(bulkLimit);
    const userIds = displayedMemberIds.filter((userId) => selectedMemberIds.has(userId));
    if (userIds.length === 0 || !workspaceId) return;
    setBulkApplying(true);
    const outcomes: Array<{ userId: string; success: boolean }> = [];
    for (const batch of chunkMemberIds(userIds)) {
      try {
        const result = await bulkSetLimits.mutateAsync({
          workspaceId,
          data: { userIds: batch, amountUsd },
        });
        outcomes.push(...result.outcomes);
      } catch {
        outcomes.push(...batch.map((userId) => ({ userId, success: false })));
      }
    }
    const failed = failedBulkSelection(outcomes);
    const succeeded = outcomes.length - failed.size;
    setSelectedMemberIds(failed);
    if (succeeded > 0) invalidateBudgetCaches(queryClient, workspaceId);
    setBulkApplying(false);
    toast({
      title: failed.size === 0
        ? `Updated ${succeeded} usage limit${succeeded === 1 ? '' : 's'}`
        : `Updated ${succeeded}; ${failed.size} failed`,
      description: failed.size === 0
        ? `Set selected members to $${amountUsd.toFixed(2)}.`
        : 'Failed members remain selected so you can retry.',
      variant: failed.size === 0 ? 'default' : 'destructive',
    });
  };

  return {
    applyBulkLimit,
    bulkApplying,
    bulkConfirmOpen,
    bulkLimit,
    handleBulkApplyClick,
    selectedMemberIds,
    setBulkConfirmOpen,
    setBulkLimit,
    setSelectedMemberIds,
  };
}

function parseClusterGroupIds(search: string) {
  const rawIds = new URLSearchParams(search).get('ids') ?? '';
  return rawIds ? rawIds.split(',').filter(Boolean) : [];
}

function createClusterQueryParams(
  rangeType: ReturnType<typeof useRange>['rangeType'],
  startDate: ReturnType<typeof useRange>['startDate'],
  endDate: ReturnType<typeof useRange>['endDate'],
  clusterKey: string,
) {
  return {
    rangeType,
    ...(rangeType === 'custom' ? { startDate, endDate } : {}),
    scopeGroupIds: clusterKey,
  };
}

function useClusterQueries(
  groupIds: string[],
  clusterKey: string,
  queryParams: ReturnType<typeof createClusterQueryParams>,
) {
  const results = useQueries({
    queries: groupIds.map((id) =>
      getGetGroupDetailQueryOptions(id, queryParams, {
        query: { queryKey: getGetGroupDetailQueryKey(id, queryParams) },
      }),
    ),
  });
  const clusterProjectsQuery = useQuery(
    getGetClusterProjectsQueryOptions(clusterKey, queryParams, {
      query: {
        queryKey: getGetClusterProjectsQueryKey(clusterKey, queryParams),
        enabled: groupIds.length > 0,
      },
    }),
  );
  const clusterHeadlineQuery = useGetCanonicalClusterHeadline(clusterKey, queryParams, {
    query: {
      queryKey: getGetCanonicalClusterHeadlineQueryKey(clusterKey, queryParams),
      enabled: groupIds.length > 0,
    },
  });
  return {
    clusterHeadline: clusterHeadlineQuery.data,
    clusterHeadlineQuery,
    clusterProjectsData: clusterProjectsQuery.data,
    clusterProjectsQuery,
    results,
  };
}

function getWorkspaceId(results: readonly GroupDetailResult[]) {
  const workspaceIds = new Set(
    results
      .map((result) => result.data?.group.workspaceId)
      .filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
  );
  return workspaceIds.size === 1 ? [...workspaceIds][0] : undefined;
}

function getClusterPresentationData(
  clusterProjectsData: { projects?: ClusterProject[]; unattributedSpendUsd?: number } | undefined,
  clusterHeadline: { spendUsd?: number | null; roles?: DirectoryRole[] } | undefined,
) {
  return {
    clusterAttributedTotal: clusterHeadline?.spendUsd ?? 0,
    clusterSpendLoaded: typeof clusterHeadline?.spendUsd === 'number',
    mergedProjects: clusterProjectsData?.projects ?? [],
    projectsUnattributedSpend: clusterProjectsData?.unattributedSpendUsd ?? 0,
    sortedRoleLabels: clusterHeadline?.roles ?? [],
  };
}

function getLimitPermissions(
  workspaceId: string | undefined,
  workspaceMembersData: WorkspaceMembersData | undefined,
  workspaceMembersError: boolean,
  writableWorkspaceIds: string[],
) {
  const connectorUnavailable =
    workspaceMembersData?.connector.status === 'unavailable' ||
    workspaceMembersData?.connector.status === 'error';
  const mutationUnavailable =
    Boolean(workspaceId && writableWorkspaceIds.includes(workspaceId)) &&
    workspaceMembersData?.connector.status === 'available' &&
    !workspaceMembersData.connector.canWrite;
  const canEditLimits = Boolean(
    workspaceId &&
    writableWorkspaceIds.includes(workspaceId) &&
    workspaceMembersData?.connector.status === 'available' &&
    workspaceMembersData.connector.canWrite,
  );
  const editingDisabledReason = mutationUnavailable || connectorUnavailable || workspaceMembersError
    ? 'Ask your workspace admin to enable the approved Replit integration with write:budgets permission.'
    : !workspaceMembersData
      ? 'Checking Replit integration permissions…'
      : undefined;
  return { canEditLimits, connectorUnavailable, editingDisabledReason, mutationUnavailable };
}

function getDisplayedSelection(
  displayedMemberIds: string[],
  selectedMemberIds: Set<string>,
) {
  return {
    allDisplayedSelected:
      displayedMemberIds.length > 0 &&
      displayedMemberIds.every((userId) => selectedMemberIds.has(userId)),
    displayedSelectedCount:
      displayedMemberIds.filter((userId) => selectedMemberIds.has(userId)).length,
    someDisplayedSelected:
      displayedMemberIds.some((userId) => selectedMemberIds.has(userId)),
  };
}

function useWorkspaceLimitModel(
  workspaceId: string | undefined,
  mergedMembers: MergedMember[],
  capabilities: ReturnType<typeof useAuthContext>['capabilities'],
) {
  const workspaceMembersQuery = useListVisibleWorkspaceMembers(workspaceId as string, {
    query: {
      enabled: !!workspaceId,
      queryKey: workspaceId
        ? getListVisibleWorkspaceMembersQueryKey(workspaceId)
        : ['workspaceMembers', ''],
    },
  });
  const workspaceMembersData = workspaceMembersQuery.data;
  const canReviewUsageLimitHistory = capabilities.canManageAccess;
  const usageLimitAuditsQuery = useListWorkspaceUsageLimitAudits(workspaceId as string, {
    query: {
      enabled: Boolean(workspaceId && canReviewUsageLimitHistory),
      queryKey: workspaceId
        ? getListWorkspaceUsageLimitAuditsQueryKey(workspaceId)
        : ['workspaceUsageLimitAudits', ''],
    },
  });
  const workspaceMembersMap = useMemo(
    () => indexMemberBudgets<WorkspaceMemberBudget>(
      mergedMembers,
      workspaceMembersData?.members ?? [],
    ),
    [mergedMembers, workspaceMembersData],
  );
  const permissions = getLimitPermissions(
    workspaceId,
    workspaceMembersData as WorkspaceMembersData | undefined,
    workspaceMembersQuery.isError,
    capabilities.canWriteUserLimitsIn,
  );
  const displayedMemberIds = useMemo(
    () => eligibleLimitMemberIds(mergedMembers),
    [mergedMembers],
  );
  const bulkActions = useBulkLimitActions(workspaceId, displayedMemberIds);
  const selection = getDisplayedSelection(displayedMemberIds, bulkActions.selectedMemberIds);
  const workspacePoliciesQuery = useGetWorkspaceLimitPolicies(workspaceId as string, {
    query: {
      enabled: Boolean(workspaceId && capabilities.canWriteUserLimitsIn.includes(workspaceId)),
      queryKey: workspaceId
        ? getGetWorkspaceLimitPoliciesQueryKey(workspaceId)
        : ['getWorkspaceLimitPolicies', ''],
    },
  });

  return {
    ...bulkActions,
    ...permissions,
    ...selection,
    canReviewUsageLimitHistory,
    displayedMemberIds,
    usageLimitAuditsQuery,
    workspaceMembersData,
    workspaceMembersMap,
    workspaceMembersQuery,
    workspacePoliciesQuery,
  };
}

function useClusterDetailModel() {
  const search = useSearch();
  const groupIds = parseClusterGroupIds(search);
  const { role, capabilities } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const clusterKey = groupIds.join(',');
  const queryParams = createClusterQueryParams(rangeType, startDate, endDate, clusterKey);
  const {
    clusterHeadline,
    clusterHeadlineQuery,
    clusterProjectsData,
    clusterProjectsQuery,
    results,
  } =
    useClusterQueries(groupIds, clusterKey, queryParams);
  const allLoaded =
    results.every((r) => !r.isLoading) &&
    !clusterHeadlineQuery.isLoading &&
    !clusterProjectsQuery.isLoading;
  const detailResults = results as unknown as readonly GroupDetailResult[];
  const groupRoleMap = useMemo(() => buildGroupRoleMap(detailResults), [detailResults]);
  const { mergedMembers, totalMembersSpend, totalUnattributedSpend, rangeLabel } =
    useMemo(
      () => mergeClusterMembers(detailResults, groupRoleMap, clusterHeadline?.roles ?? []),
      [detailResults, groupRoleMap, clusterHeadline?.roles],
    );
  const workspaceId = getWorkspaceId(detailResults);
  const presentation = getClusterPresentationData(clusterProjectsData, clusterHeadline);
  const workspaceLimits = useWorkspaceLimitModel(workspaceId, mergedMembers, capabilities);
  const clusterUnavailable =
    groupIds.length === 0 ||
    results.some((result) => result.isError && !result.data) ||
    (clusterHeadlineQuery.isError && !clusterHeadlineQuery.data) ||
    (clusterProjectsQuery.isError && !clusterProjectsQuery.data);
  const isFetching =
    results.some((result) => result.isFetching) ||
    clusterHeadlineQuery.isFetching ||
    clusterProjectsQuery.isFetching;

  return {
    ...presentation,
    ...workspaceLimits,
    allLoaded,
    clusterHeadline,
    clusterHeadlineQuery,
    clusterProjectsData,
    clusterUnavailable,
    groupIds,
    isFetching,
    mergedMembers,
    rangeLabel,
    results,
    totalMembersSpend,
    totalUnattributedSpend,
    workspaceId,
  };
}

function BackLink() {
  const search = useSearch();
  const returnTo = new URLSearchParams(search).get('returnTo');
  const backHref = (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) ? returnTo : '/spend';

  return (
    <Link href={backHref} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
      <ChevronLeft className="h-4 w-4" /> Back
    </Link>
  );
}

function ClusterDetailUnavailable() {
  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]" data-testid="cluster-detail-unavailable">
      <BackLink />
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertCircle className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Cluster unavailable</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            Choose a visible group cluster from the dashboard or check that the requested groups are in your scope.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ClusterDetailLoading() {
  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
        <BackLink />
      </div>
      <div className="h-10 w-64 bg-muted animate-pulse-glow rounded" />
      <div className="grid grid-cols-2 gap-3 md:gap-4">
        {[1, 2].map((i) => <div key={i} className="h-28 bg-muted animate-pulse-glow rounded" />)}
      </div>
      <div className="h-64 bg-muted animate-pulse-glow rounded mt-8" />
    </div>
  );
}

export default function ClusterDetail() {
  const model = useClusterDetailModel();

  if (model.clusterUnavailable) return <ClusterDetailUnavailable />;
  if (!model.allLoaded) return <ClusterDetailLoading />;
  return renderClusterDetailContent(model);
}

function renderClusterDetailContent(model: ReturnType<typeof useClusterDetailModel>) {
  const {
    allDisplayedSelected,
    allLoaded,
    applyBulkLimit,
    bulkApplying,
    bulkConfirmOpen,
    bulkLimit,
    canEditLimits,
    canReviewUsageLimitHistory,
    clusterAttributedTotal,
    clusterHeadline,
    clusterProjectsData,
    clusterSpendLoaded,
    connectorUnavailable,
    displayedMemberIds,
    displayedSelectedCount,
    editingDisabledReason,
    groupIds,
    isFetching,
    handleBulkApplyClick,
    mergedMembers,
    mergedProjects,
    mutationUnavailable,
    projectsUnattributedSpend,
    rangeLabel,
    results,
    selectedMemberIds,
    setBulkConfirmOpen,
    setBulkLimit,
    setSelectedMemberIds,
    someDisplayedSelected,
    sortedRoleLabels,
    totalMembersSpend,
    totalUnattributedSpend,
    usageLimitAuditsQuery,
    workspaceId,
    workspaceMembersData,
    workspaceMembersMap,
    workspaceMembersQuery,
    workspacePoliciesQuery,
  } = model;

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]" data-testid="page-cluster-detail">
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
        <BackLink />
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight flex items-center gap-3 flex-wrap">
             {clusterHeadline?.familyName ?? 'Group Cluster'}
            {isFetching && (
              <Badge variant="outline" className="text-muted-foreground" data-testid="status-cluster-detail-updating">
                <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> Updating
              </Badge>
            )}
            <div className="flex gap-1.5">
              {sortedRoleLabels.map((r) => (
                <span
                  key={r}
                  className={`inline-flex items-center border rounded px-2 py-0.5 text-[10px] font-medium ${roleBadgeClass(r)}`}
                >
                   {roleLabel(r)}
                </span>
              ))}
            </div>
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            {workspaceId ? `Workspace: ${results.find(r => r.data)?.data?.group.workspaceName} • ` : ''}
            {mergedMembers.length} unique member{mergedMembers.length !== 1 ? 's' : ''}
            {rangeLabel ? ` • ${rangeLabel}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <GroupUserExport groupIds={groupIds} />
          <RangeFilter />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Group Spend</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!clusterSpendLoaded ? (
              <div className="h-8 w-24 bg-muted animate-pulse-glow rounded" />
            ) : (
              <div className="text-2xl font-bold font-mono tabular-nums">
                ${clusterAttributedTotal.toFixed(2)}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Total spend used for allocations and alerts
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unique Members</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!allLoaded ? (
              <div className="h-8 w-24 bg-muted animate-pulse-glow rounded" />
            ) : (
              <div className="text-2xl font-bold font-mono tabular-nums">
                {mergedMembers.length}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Deduplicated across all roles
            </p>
          </CardContent>
        </Card>
      </div>

      {(connectorUnavailable || mutationUnavailable) && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm px-4 py-3 rounded-md flex items-start gap-3">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {mutationUnavailable ? 'Usage limit editing unavailable' : 'Member usage limits unavailable'}
            </p>
            <p className="text-xs opacity-90 mt-0.5">
               Reach out to your workspace admin to enable the approved Replit integration
              with <code>write:budgets</code> permission. No API key or token can be
              entered here.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Each person appears once. Role shows their highest privilege across{' '}
             {sortedRoleLabels.map(roleLabel).join(' / ')} sub-groups. Spend combines member AI with
            creator-attributed project hosting and other non-AI costs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEditLimits && workspaceId && (
            <WorkspacePolicyControl
              workspaceId={workspaceId}
              currentAmount={workspacePoliciesQuery.data?.defaultAmountUsd ?? null}
            />
          )}
          {canEditLimits && (
            <div className="mb-4 flex flex-col gap-2 rounded-md border bg-muted/20 p-3 sm:flex-row sm:items-center">
              <div className="text-sm font-medium min-w-fit">
                {displayedSelectedCount} selected
              </div>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={bulkLimit}
                onChange={(event) => setBulkLimit(event.target.value)}
                placeholder="Usage limit (USD)"
                aria-label="Bulk usage limit in US dollars"
                className="sm:max-w-48"
                disabled={!canEditLimits || bulkApplying}
              />
              <Button
                onClick={handleBulkApplyClick}
                disabled={!canEditLimits || displayedSelectedCount === 0 || bulkApplying}
              >
                {bulkApplying ? 'Applying…' : 'Apply Agent limit'}
              </Button>
              <span className="text-xs text-muted-foreground">
                {editingDisabledReason ??
                  'Applies one workspace-scoped Agent limit to each selected member.'}
              </span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {canEditLimits && (
                    <th className="w-10 py-3 pl-4">
                      <Checkbox
                        checked={allDisplayedSelected ? true : someDisplayedSelected ? 'indeterminate' : false}
                        onCheckedChange={(checked) =>
                          setSelectedMemberIds((current) =>
                            toggleDisplayedSelection(current, displayedMemberIds, checked === true),
                          )
                        }
                        aria-label="Select all displayed members"
                        disabled={!canEditLimits || bulkApplying}
                      />
                    </th>
                  )}
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Role</th>
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Status</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Agent Limit</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Agent Spend</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Agent Remaining</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Overall Spend</th>
                </tr>
              </thead>
              <tbody>
                {mergedMembers.map((member) => {
                  const wsm = workspaceMembersMap.get(member.userId);
                  const hasConnector = workspaceMembersData?.connector.status === 'available';
                  return (
                    <tr
                      key={member.userId}
                      className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                    >
                      {canEditLimits && (
                        <td className="py-3 pl-4 align-middle">
                          <Checkbox
                            checked={selectedMemberIds.has(member.userId)}
                            onCheckedChange={(checked) =>
                              setSelectedMemberIds((current) => {
                                const next = new Set(current);
                                if (checked === true) next.add(member.userId);
                                else next.delete(member.userId);
                                return next;
                              })
                            }
                            aria-label={`Select ${member.name || member.username || member.userId}`}
                            disabled={!canEditLimits || bulkApplying || member.isInternal}
                          />
                        </td>
                      )}
                      <td className="py-3 px-4 align-middle">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">
                            {member.name || member.username || member.userId}
                          </span>
                          {member.isInternal && <InternalUserBadge />}
                          <span className="text-xs text-muted-foreground">{member.email || '—'}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 align-middle">
                        <div className="flex flex-wrap gap-1">
                          <span
                            className={`inline-flex items-center border rounded px-2 py-0.5 text-[10px] font-medium ${roleBadgeClass(member.role)}`}
                          >
                             {roleLabel(member.role)}
                          </span>
                          {member.allRoles.length > 1 &&
                            member.allRoles
                              .filter((r) => r !== member.role)
                              .map((r) => (
                                <span
                                  key={r}
                                  className={`inline-flex items-center border rounded px-2 py-0.5 text-[10px] font-medium opacity-60 ${roleBadgeClass(r)}`}
                                >
                                   {roleLabel(r)}
                                </span>
                              ))}
                        </div>
                      </td>
                      <td className="py-3 px-4 align-middle">
                        {wsm?.budgetUsd != null && wsm?.usageUsd != null && wsm.usageUsd >= wsm.budgetUsd ? (
                          <Badge variant="destructive" className="uppercase text-[10px]" data-testid={`badge-blocked-${member.userId}`}>Blocked</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">Active</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right align-middle w-32">
                        {workspaceMembersQuery.isLoading ? (
                          <div className="flex justify-end"><LoadingCell /></div>
                        ) : hasConnector && workspaceId ? (
                          <MemberBudgetInput
                            workspaceId={workspaceId}
                            userId={member.userId}
                            currentBudget={wsm?.budgetUsd ?? null}
                             canWrite={
                               !member.isInternal &&
                               canEditLimits &&
                               workspaceMembersData.connector.canWrite
                             }
                             disabledReason={
                               member.isInternal
                                 ? 'Internal Replit usage is excluded from locally managed limits'
                                 : editingDisabledReason
                             }
                          />
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right align-middle">
                        {workspaceMembersQuery.isLoading ? <div className="flex justify-end"><LoadingCell /></div> : (
                          wsm?.usageUsd != null ? <span className="text-sm font-mono tabular-nums">${wsm.usageUsd.toFixed(2)}</span> : <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right align-middle">
                        {workspaceMembersQuery.isLoading ? <div className="flex justify-end"><LoadingCell /></div> : (
                          wsm?.remainingUsd != null ? (
                            <span className={`text-sm font-mono tabular-nums ${wsm.remainingUsd <= 0 ? 'text-destructive font-bold' : ''}`}>
                               {wsm.remainingUsd < 0 ? '-' : ''}${Math.abs(wsm.remainingUsd).toFixed(2)}
                            </span>
                          ) : <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right align-middle">
                        {member.spendLoaded ? (
                          <span className="text-sm font-mono tabular-nums">
                            ${member.spendUsd.toFixed(2)}
                          </span>
                        ) : <div className="flex justify-end"><LoadingCell /></div>}
                      </td>
                    </tr>
                  );
                })}

                {totalUnattributedSpend > 0.005 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    {canEditLimits && <td className="py-3 pl-4" />}
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed residual</span>
                        <span className="text-xs text-muted-foreground">
                          Usage not assignable to a current displayed member
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">
                        ${totalUnattributedSpend.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  {canEditLimits && <td className="py-3 pl-4" />}
                  <td className="py-3 px-4 text-sm">Combined Total</td>
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      ${(totalMembersSpend + totalUnattributedSpend).toFixed(2)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>

            {mergedMembers.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                {allLoaded ? 'No members found.' : 'Loading members...'}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {canReviewUsageLimitHistory && workspaceId && (
        <Card>
          <CardHeader>
            <CardTitle>Usage Limit History</CardTitle>
            <CardDescription>
              Account administrator audit trail for changes in this workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usageLimitAuditsQuery.isLoading || !usageLimitAuditsQuery.data ? (
              <div className="h-16 bg-muted animate-pulse-glow rounded" />
            ) : usageLimitAuditsQuery.data?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">When</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Operator</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Change</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageLimitAuditsQuery.data.map((entry) => (
                      <tr key={entry.id} className="border-b border-border/50">
                        <td className="py-3 px-4 text-sm whitespace-nowrap">
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          <div>{entry.operatorName || entry.operatorEmail || entry.operatorUserId}</div>
                          {entry.operatorName && entry.operatorEmail && (
                            <div className="text-xs text-muted-foreground">{entry.operatorEmail}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          <div>{entry.memberName || entry.memberEmail || entry.memberUserId}</div>
                          {entry.memberName && entry.memberEmail && (
                            <div className="text-xs text-muted-foreground">{entry.memberEmail}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          {entry.action === 'clear'
                            ? 'Cleared limit'
                            : `${entry.operation === 'bulk' ? 'Bulk set' : 'Set'} to $${entry.requestedAmountUsd!.toFixed(2)}`}
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={entry.outcome === 'success' ? 'outline' : 'destructive'}>
                            {entry.outcome === 'success' ? 'Succeeded' : 'Failed'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No usage limit changes recorded yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      <UsageLimitDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        onConfirm={applyBulkLimit}
        title="Set Bulk Agent Limit"
        description={
          <>
            <p>Setting a limit of <strong>${Number(bulkLimit).toFixed(2)}</strong> for {displayedSelectedCount} member{displayedSelectedCount === 1 ? '' : 's'} will <strong>hard-block their Agent usage</strong> when reached in the current cycle.</p>
            <p>This action takes effect immediately.</p>
          </>
        }
        confirmText="Set Limits"
      />

      <Card>
        <CardHeader>
            <CardTitle>Project-Attributed Spend</CardTitle>
          <CardDescription>
            Project attribution by creator. These rows explain project ownership and are not expected to reconcile to the canonical rollup total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Project</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Total</th>
                </tr>
              </thead>
              <tbody>
                {!clusterProjectsData ? (
                  [1, 2, 3].map((i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-3 px-4"><LoadingCell /></td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex justify-end"><LoadingCell /></div>
                      </td>
                    </tr>
                  ))
                ) : (
                  mergedProjects.map((project) => (
                      <tr key={project.projectId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {project.title ?? <span className="italic text-muted-foreground">Untitled</span>}
                            </span>
                            {project.workspaceName && (
                              <span className="text-xs text-muted-foreground mt-0.5">{project.workspaceName}</span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums font-medium">
                            ${project.totalCostUsd.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))
                )}

                {projectsUnattributedSpend > 0 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed Spend</span>
                        <span className="text-xs text-muted-foreground">Creator not in this team or unknown</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">${projectsUnattributedSpend.toFixed(2)}</span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  <td className="py-3 px-4 text-sm">Total</td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      ${mergedProjects.reduce((s, p) => s + p.totalCostUsd, 0).toFixed(2)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>

            {clusterProjectsData && mergedProjects.length === 0 && projectsUnattributedSpend === 0 && (
              <div className="text-center py-12 text-muted-foreground">No project spend found.</div>
            )}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
