import { useEffect, useMemo } from 'react';
import { useRoute, Link, useSearch } from 'wouter';
import {
  useGetGroupDetail,
  getGetGroupDetailQueryKey,
  useGetGroupProjects,
  getGetGroupProjectsQueryKey,
  getListGroupsQueryKey,
  getGetSummaryQueryKey,
  useListVisibleWorkspaceMembers,
  getListVisibleWorkspaceMembersQueryKey,
  useGetWorkspaceLimitPolicies,
  getGetWorkspaceLimitPoliciesQueryKey,
  type WorkspaceMemberBudget,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRange } from '@/components/range-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, DollarSign, Wallet, TrendingUp, AlertTriangle, AlertCircle, RefreshCw } from 'lucide-react';
import { ThresholdBadge } from '@/components/threshold-badge';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GroupUserExport } from '@/components/group-user-export';
import { useAuthContext } from '@/components/auth-context';
import { MemberBudgetInput } from '@/components/member-budget-input';
import { GroupPolicyControl } from '@/components/policy-control';
import { indexMemberBudgets } from '@/lib/member-budgets';
import { VirtualizedTableRows } from '@/components/virtualized-table-rows';
import { InternalSpendExplanation, InternalUserBadge } from '@/components/internal-user-badge';

function useGroupDetailModel() {
  const [match, params] = useRoute('/groups/:groupId');
  const groupId = params?.groupId || '';

  const { rangeType, startDate, endDate } = useRange();
  const queryParams = { rangeType, ...(rangeType === 'custom' ? { startDate, endDate } : {}) };

  const queryClient = useQueryClient();
  const { capabilities } = useAuthContext();

  // Keep the last dashboard snapshot visible when navigating back while
  // marking it stale so React Query refreshes it in the background.
  useEffect(() => {
    return () => {
      void queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey(), exact: false });
      void queryClient.invalidateQueries({ queryKey: getGetSummaryQueryKey(), exact: false });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data, isLoading, isError, isFetching } = useGetGroupDetail(groupId, queryParams, {
    query: {
      queryKey: getGetGroupDetailQueryKey(groupId, queryParams),
    }
  });

  const projectsQuery = useGetGroupProjects(groupId, queryParams, {
    query: {
      queryKey: getGetGroupProjectsQueryKey(groupId, queryParams),
      enabled: !!groupId,
    }
  });
  const projectsData = projectsQuery.data;
  const workspaceId = data?.group.workspaceId;
  const canWriteUserLimits = Boolean(
    workspaceId && capabilities.canWriteUserLimitsIn.includes(workspaceId),
  );
  const workspaceMembersQuery = useListVisibleWorkspaceMembers(workspaceId as string, {
    query: {
      enabled: !!workspaceId,
      queryKey: workspaceId
        ? getListVisibleWorkspaceMembersQueryKey(workspaceId)
        : ['workspaceMembers', ''],
    },
  });
  const workspaceMembersMap = useMemo(
    () => indexMemberBudgets<WorkspaceMemberBudget>(
      data?.members ?? [],
      workspaceMembersQuery.data?.members ?? [],
    ),
    [data?.members, workspaceMembersQuery.data],
  );

  const workspacePoliciesQuery = useGetWorkspaceLimitPolicies(workspaceId as string, {
    query: {
      enabled: !!workspaceId && canWriteUserLimits,
      queryKey: workspaceId ? getGetWorkspaceLimitPoliciesQueryKey(workspaceId) : ['getWorkspaceLimitPolicies', ''],
    }
  });

  const groupPolicy = useMemo(() => {
    if (!workspacePoliciesQuery.data) return null;
    return workspacePoliciesQuery.data.groups?.find(g => g.groupId === groupId) ?? null;
  }, [workspacePoliciesQuery.data, groupId]);

  return {
    canWriteUserLimits,
    data,
    groupId,
    groupPolicy,
    isError,
    isLoading,
    isFetching,
    projectsData,
    projectsQuery,
    workspaceId,
    workspaceMembersMap,
    workspaceMembersQuery,
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

function GroupDetailUnavailable() {
  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]" data-testid="group-detail-unavailable">
      <BackLink />
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertCircle className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Group unavailable</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            This group does not exist or is outside your authorized account scope.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function GroupDetailLoading() {
  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
        <BackLink />
      </div>
      <div className="h-10 w-64 bg-muted animate-pulse-glow rounded" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {[1,2,3,4].map(i => <div key={i} className="h-28 bg-muted animate-pulse-glow rounded" />)}
      </div>
      <div className="h-64 bg-muted animate-pulse-glow rounded mt-8" />
    </div>
  );
}

export default function GroupDetail() {
  const model = useGroupDetailModel();

  if ((model.isError && !model.data) || (!model.groupId && !model.isLoading)) return <GroupDetailUnavailable />;
  if (!model.data || projectsQueryNeedsColdLoad(model.projectsQuery)) return <GroupDetailLoading />;
  return renderGroupDetailContent(model, model.data);
}

function projectsQueryNeedsColdLoad(query: { isLoading: boolean; data?: unknown }) {
  return query.isLoading && !query.data;
}

function renderGroupDetailContent(
  model: ReturnType<typeof useGroupDetailModel>,
  data: NonNullable<ReturnType<typeof useGroupDetailModel>['data']>,
) {
  const {
    canWriteUserLimits,
    groupId,
    groupPolicy,
    projectsData,
    workspaceId,
    workspaceMembersMap,
    workspaceMembersQuery,
    isFetching,
  } = model;

  const { group, members, membersSpendUsd, unattributedSpendUsd, rangeLabel } = data;
  // Use member-deduped rollup spend as the primary display — matches the dashboard row.
  // rollupSpendUsd is always populated (unlike spendUsd which is null until all groups
  // finish loading), so it gives a live value immediately. projectSpendUsd remains on
  // the object for drill-downs but is not the header figure.
  const displaySpend = group.rollupSpendUsd !== undefined && group.rollupSpendUsd !== null
    ? group.rollupSpendUsd
    : null;
  const statCards = [
    {
      title: 'Spend',
      value: displaySpend !== null ? `$${displaySpend.toFixed(2)}` : '—',
      icon: DollarSign,
      loading: false,
    },
    {
      title: group.budgetSource === 'platform' ? 'Monthly Agent limit' : 'Allocation',
      value: group.budgetUsd !== null && group.budgetUsd !== undefined ? `$${group.budgetUsd.toFixed(2)}` : '—',
      description: group.budgetSource === 'platform'
        ? 'Resets on billing cycle day · hard block'
        : group.budgetSource
          ? `Source: ${group.budgetSource.replace('_', ' ')}`
          : 'No allocation set',
      icon: TrendingUp,
      loading: false,
    },
    {
      title: 'Remaining',
      value: group.remainingUsd !== undefined && group.remainingUsd !== null ? `$${group.remainingUsd.toFixed(2)}` : '—',
      valueClassName: group.remainingUsd !== undefined && group.remainingUsd !== null && group.remainingUsd < 0 ? 'text-destructive' : '',
      icon: Wallet,
      loading: false,
    },
    {
      title: 'Usage',
      value: group.percentUsed !== undefined && group.percentUsed !== null ? `${group.percentUsed.toFixed(1)}%` : '—',
      valueClassName: group.percentUsed !== undefined && group.percentUsed !== null && group.percentUsed >= 100 ? 'text-destructive' : '',
      icon: AlertTriangle,
      loading: false,
    }
  ];

  const sortedMembers = [...members].sort((a, b) => {
    const aSpend = typeof a.spendUsd === 'number' ? a.spendUsd : -1;
    const bSpend = typeof b.spendUsd === 'number' ? b.spendUsd : -1;
    return bSpend - aSpend;
  });
  const connector = workspaceMembersQuery.data?.connector;
  const connectorUnavailable =
    connector?.status === 'unavailable' ||
    connector?.status === 'error';
  const mutationUnavailable =
    canWriteUserLimits && connector?.status === 'available' && !connector.canWrite;

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]" data-testid="page-group-detail">
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
        <BackLink />
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight flex items-center gap-3">
            {group.name}
            <Badge variant="secondary" className="uppercase text-[10px]">{group.type}</Badge>
            {isFetching && (
              <Badge variant="outline" className="text-muted-foreground" data-testid="status-group-detail-updating">
                <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> Updating
              </Badge>
            )}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Workspace: {group.workspaceName || '—'} • {group.memberCount} members • {rangeLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <GroupUserExport groupIds={[groupId]} />
          <RangeFilter />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {stat.loading ? (
                  <div className="h-8 w-24 bg-muted animate-pulse-glow rounded" />
                ) : (
                  <div className={`text-2xl font-bold font-mono tabular-nums ${stat.valueClassName || ''}`}>
                    {stat.value}
                  </div>
                )}
                {stat.description && (
                  <p className="text-xs text-muted-foreground mt-1 capitalize">
                    {stat.description}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {(connectorUnavailable || mutationUnavailable) && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm px-4 py-3 rounded-md flex items-start gap-3">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {mutationUnavailable ? 'Limit editing unavailable' : 'Member limits unavailable'}
            </p>
            <p className="text-xs opacity-90 mt-0.5">
              A workspace administrator must enable the approved Replit integration
              with <code>write:budgets</code> permission. No API key or token can be
              entered here.
            </p>
          </div>
        </div>
      )}

      <Tabs defaultValue="members">
      <Card>
        <CardHeader>
          <TabsList aria-label="Group spending breakdown">
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="projects">Projects</TabsTrigger>
          </TabsList>
        </CardHeader>
        <TabsContent value="members" className="mt-0">
          <CardHeader className="pt-0">
            <CardTitle>Members</CardTitle>
            <CardDescription>
              Each total combines deduplicated member AI usage with non-AI hosting,
              storage, and other project costs attributed to that project&apos;s creator.
            </CardDescription>
            <InternalSpendExplanation />
          </CardHeader>
          <CardContent>
          {canWriteUserLimits && workspaceId && (
            <GroupPolicyControl
              workspaceId={workspaceId}
              groupId={groupId}
              currentAmount={groupPolicy?.amountUsd ?? null}
            />
          )}
          <div className="max-h-[70vh] overflow-auto" data-virtual-scroll>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Status</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Agent Limit</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Agent Spend</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Agent Remaining</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Overall Spend</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Overall AI</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Overall Non-AI</th>
                </tr>
              </thead>
              <VirtualizedTableRows columnCount={8} estimatedRowHeight={72}>
                {sortedMembers.map(member => {
                  const budget = workspaceMembersMap.get(member.userId);
                  const hasConnector = connector?.status === 'available';
                  return (
                  <tr key={member.userId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{member.name || member.username || member.userId}</span>
                          <span className="text-xs text-muted-foreground">{member.email || '—'}</span>
                        </div>
                        <div className="flex gap-1 ml-2">
                          {member.role && <Badge variant="outline" className="text-[10px] h-5 capitalize">{member.role}</Badge>}
                           {member.isInternal && <InternalUserBadge />}
                          {member.isDisabled && <Badge variant="secondary" className="text-[10px] h-5 opacity-50">Disabled</Badge>}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 align-middle">
                      {budget?.budgetUsd != null && budget?.usageUsd != null && budget.usageUsd >= budget.budgetUsd ? (
                        <Badge variant="destructive" className="uppercase text-[10px]" data-testid={`badge-blocked-${member.userId}`}>Blocked</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Active</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right w-32">
                      {workspaceMembersQuery.isLoading ? (
                        <div className="flex justify-end"><LoadingCell /></div>
                      ) : hasConnector && workspaceId ? (
                        <MemberBudgetInput
                          workspaceId={workspaceId}
                          userId={member.userId}
                          currentBudget={budget?.budgetUsd ?? null}
                           canWrite={
                             !member.isInternal && canWriteUserLimits && connector.canWrite
                           }
                           disabledReason={
                             member.isInternal
                               ? 'Internal Replit usage is excluded from locally managed limits'
                               : undefined
                           }
                        />
                      ) : <span className="text-sm text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {workspaceMembersQuery.isLoading ? <div className="flex justify-end"><LoadingCell /></div> : (
                        budget?.usageUsd != null ? <span className="text-sm font-mono tabular-nums">${budget.usageUsd.toFixed(2)}</span> : <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {workspaceMembersQuery.isLoading ? <div className="flex justify-end"><LoadingCell /></div> : (
                        budget?.remainingUsd != null ? (
                          <span className={`text-sm font-mono tabular-nums ${budget.remainingUsd <= 0 ? 'text-destructive font-bold' : ''}`}>
                             {budget.remainingUsd < 0 ? '-' : ''}${Math.abs(budget.remainingUsd).toFixed(2)}
                          </span>
                        ) : <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {typeof member.spendUsd === 'number' ? (
                        <span className="text-sm font-mono tabular-nums">${member.spendUsd.toFixed(2)}</span>
                      ) : <div className="flex justify-end"><LoadingCell /></div>}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                      {typeof member.aiSpendUsd === 'number' ? `$${member.aiSpendUsd.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                      {typeof member.nonAiSpendUsd === 'number' ? `$${member.nonAiSpendUsd.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                  );
                })}

                {unattributedSpendUsd > 0 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed residual</span>
                        <span className="text-xs text-muted-foreground">No project ID, missing creator, or creator no longer a member</span>
                      </div>
                    </td>
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                    <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                    <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">${unattributedSpendUsd.toFixed(2)}</span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                    <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                  </tr>
                )}
              </VirtualizedTableRows>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  <td className="py-3 px-4 text-sm">Group Total</td>
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      —
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                  <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      {displaySpend !== null ? `$${displaySpend.toFixed(2)}` : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                    ${members.reduce((sum, member) => sum + (member.aiSpendUsd ?? 0), 0).toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                    ${members.reduce((sum, member) => sum + (member.nonAiSpendUsd ?? 0), 0).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          </CardContent>
        </TabsContent>
        <TabsContent value="projects" className="mt-0">
          <CardHeader className="pt-0">
            <CardTitle>Projects</CardTitle>
            <CardDescription>Per-project spending within the group for the selected period</CardDescription>
          </CardHeader>
          <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Project</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">AI</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Hosting</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Storage</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Other</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Total</th>
                </tr>
              </thead>
              <tbody>
                {!projectsData ? (
                  // Skeleton rows while loading
                  [1, 2, 3].map((i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-3 px-4"><LoadingCell /></td>
                      <td className="py-3 px-4 text-right"><div className="flex justify-end"><LoadingCell /></div></td>
                      <td className="py-3 px-4 text-right"><div className="flex justify-end"><LoadingCell /></div></td>
                      <td className="py-3 px-4 text-right"><div className="flex justify-end"><LoadingCell /></div></td>
                      <td className="py-3 px-4 text-right"><div className="flex justify-end"><LoadingCell /></div></td>
                      <td className="py-3 px-4 text-right"><div className="flex justify-end"><LoadingCell /></div></td>
                    </tr>
                  ))
                ) : (
                  projectsData?.projects.map((project) => {
                    const aiSpend = project.aiSpendUsd;
                    const hostingSpend = project.metrics.filter(m => m.category === 'hosting').reduce((s, m) => s + m.costUsd, 0);
                    const storageSpend = project.metrics.filter(m => m.category === 'storage').reduce((s, m) => s + m.costUsd, 0);
                    // Remainder so the breakdown always sums to the total, regardless of API metric coverage.
                    const otherSpend = Math.max(0, project.nonAiSpendUsd - hostingSpend - storageSpend);
                    return (
                      <tr key={project.projectId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {!projectsData.titlesComplete
                                ? <LoadingCell />
                                : project.title ?? <span className="italic text-muted-foreground">Untitled</span>}
                            </span>
                            <span className="text-xs text-muted-foreground font-mono">{project.projectId}</span>
                            {project.workspaceName && (
                              <span className="text-xs text-muted-foreground mt-0.5">{project.workspaceName}</span>
                            )}
                            <span className="text-xs text-muted-foreground mt-0.5">
                              Creator: {project.creatorName ?? 'Unknown'}
                              {!project.creatorIsCurrentMember && ' (not currently attributable)'}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums">{aiSpend > 0 ? `$${aiSpend.toFixed(2)}` : '—'}</span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums">{hostingSpend > 0 ? `$${hostingSpend.toFixed(2)}` : '—'}</span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums">{storageSpend > 0 ? `$${storageSpend.toFixed(2)}` : '—'}</span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums">{otherSpend > 0 ? `$${otherSpend.toFixed(2)}` : '—'}</span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums font-medium">${project.totalCostUsd.toFixed(2)}</span>
                        </td>
                      </tr>
                    );
                  })
                )}

                {projectsData && projectsData.unattributedSpendUsd > 0 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed project residual</span>
                        <span className="text-xs text-muted-foreground">No project ID, missing creator, or creator no longer a member</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                    <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                    <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                    <td className="py-3 px-4 text-right"><span className="text-sm text-muted-foreground">—</span></td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">${projectsData.unattributedSpendUsd.toFixed(2)}</span>
                    </td>
                  </tr>
                )}
              </tbody>
              {projectsData && projectsData.projects.length > 0 && (
                <tfoot>
                  <tr className="bg-muted/30 font-medium border-t border-border">
                    <td className="py-3 px-4 text-sm">Total</td>
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">
                        ${(
                          (projectsData.projects.reduce((s, p) => s + p.totalCostUsd, 0)) +
                          projectsData.unattributedSpendUsd
                        ).toFixed(2)}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          </CardContent>
        </TabsContent>
      </Card>
      </Tabs>
    </div>
  );
}
