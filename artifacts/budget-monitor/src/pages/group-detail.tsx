import { useEffect, useMemo } from 'react';
import { useRoute, Link } from 'wouter';
import {
  useGetGroupDetail,
  getGetGroupDetailQueryKey,
  useGetGroupProjects,
  getGetGroupProjectsQueryKey,
  getListGroupsQueryKey,
  getGetSummaryQueryKey,
  useListVisibleWorkspaceMembers,
  getListVisibleWorkspaceMembersQueryKey,
  type WorkspaceMemberBudget,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRange } from '@/components/range-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, RefreshCw, DollarSign, Wallet, TrendingUp, AlertTriangle, AlertCircle } from 'lucide-react';
import { ThresholdBadge } from '@/components/threshold-badge';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GroupUserExport } from '@/components/group-user-export';
import { useAuthContext } from '@/components/auth-context';
import { MemberBudgetInput } from '@/components/member-budget-input';
import { indexMemberBudgets } from '@/lib/member-budgets';
import { VirtualizedTableRows } from '@/components/virtualized-table-rows';

export default function GroupDetail() {
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

  const { data, isLoading } = useGetGroupDetail(groupId, queryParams, {
    query: {
      queryKey: getGetGroupDetailQueryKey(groupId, queryParams),
      refetchInterval: (query) =>
        query.state.status === 'error' || query.state.data?.usageHealth ? false : 8000,
    }
  });

  const { data: projectsData, isError: projectsError } = useGetGroupProjects(groupId, queryParams, {
    query: {
      queryKey: getGetGroupProjectsQueryKey(groupId, queryParams),
      refetchInterval: (query) =>
        query.state.status === 'error' ||
        (query.state.data?.usageHealth && query.state.data.titlesComplete) ? false : 8000,
      enabled: !!groupId,
    }
  });
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
      refetchInterval: (query) => {
        if (query.state.status === 'error') return false;
        const response = query.state.data;
        if (!response || response.connector.status !== 'available') return false;
        return response.members.some(
          (member) => member.budgetUsd !== null && member.usageUsd === null,
        ) ? 8000 : false;
      },
    },
  });
  const workspaceMembersMap = useMemo(
    () => indexMemberBudgets<WorkspaceMemberBudget>(
      data?.members ?? [],
      workspaceMembersQuery.data?.members ?? [],
    ),
    [data?.members, workspaceMembersQuery.data],
  );

  if (isLoading && !data) {
    return (
      <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
        <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
          <Link href="/" className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
            <ChevronLeft className="h-4 w-4" /> Back to Dashboard
          </Link>
        </div>
        <div className="h-10 w-64 bg-muted animate-pulse-glow rounded" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          {[1,2,3,4].map(i => <div key={i} className="h-28 bg-muted animate-pulse-glow rounded" />)}
        </div>
        <div className="h-64 bg-muted animate-pulse-glow rounded mt-8" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4 md:p-8 max-w-[100vw]">
        <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
          <Link href="/" className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
            <ChevronLeft className="h-4 w-4" /> Back to Dashboard
          </Link>
        </div>
        <p className="text-muted-foreground">Group data is unavailable.</p>
      </div>
    );
  }

  const { group, members, membersSpendUsd, unattributedSpendUsd, rangeLabel } = data;
  const usageAvailable = data.usageHealth.status !== 'empty';
  const isComplete = data.usageHealth.status === 'complete' ||
    data.usageHealth.status === 'stale';
  const projectsUsageAvailable = projectsData?.usageHealth.status !== 'empty';

  // Use member-deduped rollup spend as the primary display — matches the dashboard row.
  // rollupSpendUsd is always populated (unlike spendUsd which is null until all groups
  // finish loading), so it gives a live value immediately. projectSpendUsd remains on
  // the object for drill-downs but is not the header figure.
  const displaySpend = group.rollupSpendUsd !== undefined && group.rollupSpendUsd !== null
    ? group.rollupSpendUsd
    : null;
  const displaySpendLoaded = usageAvailable;

  const statCards = [
    {
      title: 'Spend',
      value: displaySpendLoaded && displaySpend !== null ? `$${displaySpend.toFixed(2)}` : '—',
      icon: DollarSign,
      loading: !displaySpendLoaded,
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
      loading: !displaySpendLoaded,
    },
    {
      title: 'Usage',
      value: group.percentUsed !== undefined && group.percentUsed !== null ? `${group.percentUsed.toFixed(1)}%` : '—',
      valueClassName: group.percentUsed !== undefined && group.percentUsed !== null && group.percentUsed >= 100 ? 'text-destructive' : '',
      icon: AlertTriangle,
      loading: !displaySpendLoaded,
    }
  ];

  const sortedMembers = [...members].sort((a, b) => {
    const aSpend = usageAvailable ? a.spendUsd : -1;
    const bSpend = usageAvailable ? b.spendUsd : -1;
    return bSpend - aSpend;
  });
  const connector = workspaceMembersQuery.data?.connector;
  const connectorUnavailable =
    connector?.status === 'unavailable' ||
    connector?.status === 'error';
  const mutationUnavailable =
    canWriteUserLimits && connector?.status === 'available' && !connector.canWrite;

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
        <Link href="/" className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
          <ChevronLeft className="h-4 w-4" /> Back to Dashboard
        </Link>
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight flex items-center gap-3">
            {group.name}
            <Badge variant="secondary" className="uppercase text-[10px]">{group.type}</Badge>
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Workspace: {group.workspaceName || '—'} • {group.memberCount} members • {rangeLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <GroupUserExport groupIds={[groupId]} />
          <RangeFilter />
          {!isComplete && (
            <Badge variant="outline" className="flex items-center gap-2 shrink-0">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Loading usage...
            </Badge>
          )}
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
          </CardHeader>
          <CardContent>
          <div className="max-h-[70vh] overflow-auto" data-virtual-scroll>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Monthly limit</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Spend</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">AI</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Hosting / Non-AI</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Remaining</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Usage</th>
                </tr>
              </thead>
              <VirtualizedTableRows columnCount={7} estimatedRowHeight={72}>
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
                          {member.isDisabled && <Badge variant="secondary" className="text-[10px] h-5 opacity-50">Disabled</Badge>}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      {workspaceMembersQuery.isLoading ? (
                        <div className="flex justify-end"><LoadingCell /></div>
                      ) : hasConnector && workspaceId ? (
                        <MemberBudgetInput
                          workspaceId={workspaceId}
                          userId={member.userId}
                          currentBudget={budget?.budgetUsd ?? null}
                           canWrite={canWriteUserLimits && connector.canWrite}
                        />
                      ) : <span className="text-sm text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {!usageAvailable ? <div className="flex justify-end"><LoadingCell /></div> : (
                        <span className="text-sm font-mono tabular-nums">${member.spendUsd.toFixed(2)}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                      {usageAvailable ? `$${member.aiSpendUsd.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                      {usageAvailable ? `$${member.nonAiSpendUsd.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {workspaceMembersQuery.isLoading ? (
                        <div className="flex justify-end"><LoadingCell /></div>
                      ) : !hasConnector || budget?.remainingUsd === null || budget?.remainingUsd === undefined ? <span className="text-sm text-muted-foreground">—</span> : (
                        <span className={`text-sm font-mono tabular-nums ${budget.remainingUsd < 0 ? 'text-destructive font-bold' : ''}`}>
                          {budget.remainingUsd < 0 ? '-' : ''}${Math.abs(budget.remainingUsd).toFixed(2)}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex justify-end">
                        {!usageAvailable || member.allocatedBudgetUsd === null || member.allocatedBudgetUsd === undefined ? <span className="text-sm text-muted-foreground">—</span> : (
                          <ThresholdBadge percentUsed={member.percentUsed ?? null} thresholdsFired={[]} />
                        )}
                      </div>
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
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm text-muted-foreground">—</span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">${unattributedSpendUsd.toFixed(2)}</span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                    <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm text-muted-foreground">—</span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm text-muted-foreground">—</span>
                    </td>
                  </tr>
                )}
              </VirtualizedTableRows>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  <td className="py-3 px-4 text-sm">Group Total</td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      —
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      {displaySpendLoaded && displaySpend !== null ? `$${displaySpend.toFixed(2)}` : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                    {isComplete ? `$${members.reduce((sum, member) => sum + (member.aiSpendUsd ?? 0), 0).toFixed(2)}` : '—'}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-sm">
                    {isComplete ? `$${members.reduce((sum, member) => sum + (member.nonAiSpendUsd ?? 0), 0).toFixed(2)}` : '—'}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm text-muted-foreground">—</span>
                  </td>
                  <td className="py-3 px-4 text-right flex justify-end">
                    {displaySpendLoaded && group.budgetUsd !== null && group.budgetUsd !== undefined ? (
                      <ThresholdBadge percentUsed={group.percentUsed ?? null} thresholdsFired={group.thresholdsFired} />
                    ) : <span className="text-sm text-muted-foreground">—</span>}
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
                {projectsError && !projectsData ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      Project data is unavailable.
                    </td>
                  </tr>
                ) : !projectsUsageAvailable && (!projectsData || projectsData.projects.length === 0) ? (
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
                          {!projectsUsageAvailable ? <div className="flex justify-end"><LoadingCell /></div> : (
                            <span className="text-sm font-mono tabular-nums">{aiSpend > 0 ? `$${aiSpend.toFixed(2)}` : '—'}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!projectsUsageAvailable ? <div className="flex justify-end"><LoadingCell /></div> : (
                            <span className="text-sm font-mono tabular-nums">{hostingSpend > 0 ? `$${hostingSpend.toFixed(2)}` : '—'}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!projectsUsageAvailable ? <div className="flex justify-end"><LoadingCell /></div> : (
                            <span className="text-sm font-mono tabular-nums">{storageSpend > 0 ? `$${storageSpend.toFixed(2)}` : '—'}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!projectsUsageAvailable ? <div className="flex justify-end"><LoadingCell /></div> : (
                            <span className="text-sm font-mono tabular-nums">{otherSpend > 0 ? `$${otherSpend.toFixed(2)}` : '—'}</span>
                          )}
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
              {projectsUsageAvailable && projectsData && projectsData.projects.length > 0 && (
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
