import { useRoute, Link } from 'wouter';
import { useGetGroupDetail, getGetGroupDetailQueryKey, useGetGroupProjects, getGetGroupProjectsQueryKey } from '@workspace/api-client-react';
import { useRange } from '@/components/range-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, RefreshCw, DollarSign, Wallet, TrendingUp, AlertTriangle } from 'lucide-react';
import { ThresholdBadge } from '@/components/threshold-badge';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';

export default function GroupDetail() {
  const [match, params] = useRoute('/groups/:groupId');
  const groupId = params?.groupId || '';

  const { rangeType, startDate, endDate } = useRange();
  const queryParams = { rangeType, ...(rangeType === 'custom' ? { startDate, endDate } : {}) };

  const { data, isLoading } = useGetGroupDetail(groupId, queryParams, {
    query: {
      queryKey: getGetGroupDetailQueryKey(groupId, queryParams),
      refetchInterval: (query) => query.state.data?.isComplete ? false : 8000,
    }
  });

  const { data: projectsData } = useGetGroupProjects(groupId, queryParams, {
    query: {
      queryKey: getGetGroupProjectsQueryKey(groupId, queryParams),
      refetchInterval: (query) => query.state.data?.isComplete ? false : 8000,
      enabled: !!groupId,
    }
  });

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
        <p className="text-muted-foreground">Group not found.</p>
      </div>
    );
  }

  const { group, members, membersSpendUsd, unattributedSpendUsd, isComplete, rangeLabel } = data;

  // Use project-attributed spend (matches dashboard) when loaded; fall back to member rollup.
  const displaySpend = group.projectSpendLoaded && group.projectSpendUsd !== undefined && group.projectSpendUsd !== null
    ? group.projectSpendUsd
    : (group.spendLoaded && group.spendUsd !== undefined && group.spendUsd !== null ? group.spendUsd : null);
  const displaySpendLoaded = group.projectSpendLoaded ?? group.spendLoaded;

  const statCards = [
    {
      title: 'Spend',
      value: displaySpendLoaded && displaySpend !== null ? `$${displaySpend.toFixed(2)}` : '—',
      icon: DollarSign,
      loading: !displaySpendLoaded,
    },
    {
      title: 'Budget',
      value: group.budgetUsd !== null && group.budgetUsd !== undefined ? `$${group.budgetUsd.toFixed(2)}` : '—',
      description: group.budgetSource ? `Source: ${group.budgetSource.replace('_', ' ')}` : 'No budget set',
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
    const aSpend = a.spendLoaded ? (a.spendUsd || 0) : -1;
    const bSpend = b.spendLoaded ? (b.spendUsd || 0) : -1;
    return bSpend - aSpend;
  });

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

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Per-user spending and budget allocation within the group</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Allocated Budget</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Spend</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Remaining</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Usage</th>
                </tr>
              </thead>
              <tbody>
                {sortedMembers.map(member => (
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
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-sm font-mono tabular-nums">
                          {member.allocatedBudgetUsd !== null && member.allocatedBudgetUsd !== undefined ? `$${member.allocatedBudgetUsd.toFixed(2)}` : '—'}
                        </span>
                        {member.budgetSource && (
                          <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 uppercase bg-muted/50">
                            {member.budgetSource.replace('_', ' ')}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      {!member.spendLoaded ? <div className="flex justify-end"><LoadingCell /></div> : (
                        <span className="text-sm font-mono tabular-nums">${member.spendUsd?.toFixed(2) ?? '0.00'}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {!member.spendLoaded || member.allocatedBudgetUsd === null || member.allocatedBudgetUsd === undefined ? <span className="text-sm text-muted-foreground">—</span> : (
                        <span className={`text-sm font-mono tabular-nums ${member.remainingUsd !== undefined && member.remainingUsd !== null && member.remainingUsd < 0 ? 'text-destructive font-bold' : ''}`}>
                          ${member.remainingUsd?.toFixed(2) ?? '0.00'}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex justify-end">
                        {!member.spendLoaded || member.allocatedBudgetUsd === null || member.allocatedBudgetUsd === undefined ? <span className="text-sm text-muted-foreground">—</span> : (
                          <ThresholdBadge percentUsed={member.percentUsed ?? null} thresholdsFired={[]} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}

                {unattributedSpendUsd > 0 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed Spend</span>
                        <span className="text-xs text-muted-foreground">Deleted users or shared costs</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm text-muted-foreground">—</span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">${unattributedSpendUsd.toFixed(2)}</span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm text-muted-foreground">—</span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm text-muted-foreground">—</span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  <td className="py-3 px-4 text-sm">Group Total</td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      {group.budgetUsd !== null && group.budgetUsd !== undefined ? `$${group.budgetUsd.toFixed(2)}` : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      {displaySpendLoaded && displaySpend !== null ? `$${displaySpend.toFixed(2)}` : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className={`text-sm font-mono tabular-nums ${group.remainingUsd !== undefined && group.remainingUsd !== null && group.remainingUsd < 0 ? 'text-destructive font-bold' : ''}`}>
                      {displaySpendLoaded && group.remainingUsd !== undefined && group.remainingUsd !== null ? `$${group.remainingUsd.toFixed(2)}` : '—'}
                    </span>
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
      </Card>
      <Card>
        <CardHeader>
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
                {!projectsData?.isComplete && (!projectsData || projectsData.projects.length === 0) ? (
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
                    const aiSpend = project.metrics.filter(m => m.category === 'ai').reduce((s, m) => s + m.costUsd, 0);
                    const hostingSpend = project.metrics.filter(m => m.category === 'hosting').reduce((s, m) => s + m.costUsd, 0);
                    const storageSpend = project.metrics.filter(m => m.category === 'storage').reduce((s, m) => s + m.costUsd, 0);
                    // Remainder so the breakdown always sums to the total, regardless of API metric coverage.
                    const otherSpend = Math.max(0, project.totalCostUsd - aiSpend - hostingSpend - storageSpend);
                    return (
                      <tr key={project.projectId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{project.title ?? <span className="italic text-muted-foreground">Untitled</span>}</span>
                            <span className="text-xs text-muted-foreground font-mono">{project.projectId}</span>
                            {project.workspaceName && (
                              <span className="text-xs text-muted-foreground mt-0.5">{project.workspaceName}</span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!projectsData.isComplete ? <div className="flex justify-end"><LoadingCell /></div> : (
                            <span className="text-sm font-mono tabular-nums">{aiSpend > 0 ? `$${aiSpend.toFixed(2)}` : '—'}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!projectsData.isComplete ? <div className="flex justify-end"><LoadingCell /></div> : (
                            <span className="text-sm font-mono tabular-nums">{hostingSpend > 0 ? `$${hostingSpend.toFixed(2)}` : '—'}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!projectsData.isComplete ? <div className="flex justify-end"><LoadingCell /></div> : (
                            <span className="text-sm font-mono tabular-nums">{storageSpend > 0 ? `$${storageSpend.toFixed(2)}` : '—'}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!projectsData.isComplete ? <div className="flex justify-end"><LoadingCell /></div> : (
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
                        <span className="text-sm font-medium italic">Unattributed Spend</span>
                        <span className="text-xs text-muted-foreground">Not linked to a specific project</span>
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
              {projectsData?.isComplete && projectsData.projects.length > 0 && (
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
      </Card>
    </div>
  );
}
