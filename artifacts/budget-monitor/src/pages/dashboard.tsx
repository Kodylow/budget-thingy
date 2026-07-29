import { useEffect, useMemo, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, AlertTriangle, DollarSign, TrendingUp, Wallet } from 'lucide-react';
import { useListGroups, useGetSummary, getListGroupsQueryKey, getGetSummaryQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ThresholdBadge } from '@/components/threshold-badge';
import { LoadingCell } from '@/components/loading-cell';
import { BudgetInput } from '@/components/budget-input';
import { useLocation } from 'wouter';
import { useRange } from '@/components/range-context';
import { RangeFilter } from '@/components/range-filter';

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { rangeType, startDate, endDate } = useRange();

  const queryParams = useMemo(
    () => ({
      rangeType,
      ...(rangeType === 'custom' ? { startDate, endDate } : {}),
    }),
    [rangeType, startDate, endDate],
  );
  
  const { data: groupsData, isLoading: groupsLoading } = useListGroups(queryParams, {
    query: {
      queryKey: getListGroupsQueryKey(queryParams),
      refetchInterval: (query) => {
        return query.state.data?.isComplete ? false : 8000;
      },
    },
  });

  const { data: summary, isLoading: summaryLoading } = useGetSummary(queryParams, {
    query: {
      queryKey: getGetSummaryQueryKey(queryParams),
      refetchInterval: (query) => {
        return query.state.data?.isComplete ? false : 8000;
      },
    },
  });

  // Invalidate summary only on the transition to complete, not on every render.
  const wasComplete = useRef(false);
  useEffect(() => {
    const complete = groupsData?.isComplete ?? false;
    if (complete && !wasComplete.current) {
      queryClient.invalidateQueries({ queryKey: getGetSummaryQueryKey(queryParams) });
    }
    wasComplete.current = complete;
  }, [groupsData?.isComplete, queryClient, queryParams]);

  const groups = groupsData?.groups || [];
  const isComplete = groupsData?.isComplete ?? false;
  const pendingCount = groupsData?.pendingCount ?? 0;

  const statCards = [
    {
      title: 'Total Spend',
      value: summary ? `$${summary.totalSpendUsd.toFixed(2)}` : '—',
      description: summary?.billingPeriodLabel || 'Loading...',
      icon: DollarSign,
      loading: summaryLoading || !summary?.isComplete,
    },
    {
      title: 'Total Budget',
      value: summary ? `$${summary.totalBudgetUsd.toFixed(2)}` : '—',
      description: `${summary?.budgetedGroups || 0} groups budgeted`,
      icon: TrendingUp,
      loading: summaryLoading,
    },
    {
      title: 'Remaining',
      value: summary && summary.totalRemainingUsd !== undefined ? `$${summary.totalRemainingUsd.toFixed(2)}` : '—',
      description: 'Across budgeted groups',
      icon: Wallet,
      loading: summaryLoading,
      valueClassName: summary && summary.totalRemainingUsd !== undefined && summary.totalRemainingUsd < 0 ? 'text-destructive' : '',
    },
    {
      title: 'Over Threshold',
      value: summary ? summary.groupsOver75.toString() : '—',
      description: `${summary?.groupsOver100 || 0} over budget`,
      icon: AlertTriangle,
      loading: summaryLoading,
    },
    {
      title: 'Alerts Sent',
      value: summary ? summary.alertsSentThisPeriod.toString() : '—',
      description: 'This billing period',
      icon: RefreshCw,
      loading: summaryLoading,
    },
  ];

  return (
    <div className="p-8 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">
            Dashboard
          </h1>
          <p className="text-muted-foreground mt-1" data-testid="text-billing-period">
            {groupsData?.billingPeriodLabel || 'Loading...'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <RangeFilter />
          {!isComplete && (
            <Badge variant="outline" className="flex items-center gap-2" data-testid="badge-loading-status">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Loading {pendingCount} groups...
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title} data-testid={`card-stat-${stat.title.toLowerCase().replace(/\s+/g, '-')}`}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {stat.loading ? (
                  <div className="h-8 w-24 bg-muted animate-pulse-glow rounded" />
                ) : (
                  <div className={`text-2xl font-bold font-mono tabular-nums ${stat.valueClassName || ''}`} data-testid={`text-stat-${stat.title.toLowerCase().replace(/\s+/g, '-')}`}>
                    {stat.value}
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1 whitespace-nowrap overflow-hidden text-ellipsis">
                  {stat.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
          <CardDescription>
            Monitor spending and set budgets for each group
          </CardDescription>
        </CardHeader>
        <CardContent>
          {groupsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted animate-pulse-glow rounded" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="table-groups">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">
                      Group
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">
                      Workspace
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                      Members
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                      Spend
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                      Budget
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                      Remaining
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">
                      Usage
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr
                      key={group.groupId}
                      className="border-b border-border hover:bg-muted/50 transition-colors group cursor-pointer"
                      data-testid={`row-group-${group.groupId}`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button, input, a')) return;
                        setLocation(`/groups/${group.groupId}`);
                      }}
                    >
                      <td className="py-3 px-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium" data-testid={`text-group-name-${group.groupId}`}>
                            {group.name}
                          </span>
                          <span className="text-xs text-muted-foreground uppercase">
                            {group.type}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm" data-testid={`text-workspace-${group.groupId}`}>
                          {group.workspaceName || '—'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums" data-testid={`text-members-${group.groupId}`}>
                          {group.memberCount ?? '—'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!group.spendLoaded ? (
                          <div className="flex justify-end"><LoadingCell /></div>
                        ) : (
                          <span className="text-sm font-mono tabular-nums" data-testid={`text-spend-${group.groupId}`}>
                            ${group.spendUsd?.toFixed(2) ?? '0.00'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex flex-col items-end gap-1">
                          <BudgetInput groupId={group.groupId} currentBudget={group.budgetUsd ?? null} />
                          {group.budgetSource && (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 uppercase bg-muted/50" title={`Budget source: ${group.budgetSource}`}>
                              {group.budgetSource}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!group.spendLoaded || group.budgetUsd === null ? (
                          <span className="text-sm text-muted-foreground">—</span>
                        ) : (
                          <span className={`text-sm font-mono tabular-nums ${group.remainingUsd! < 0 ? 'text-destructive font-bold' : ''}`}>
                            ${group.remainingUsd?.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
                          {!group.spendLoaded || group.budgetUsd === null ? (
                            <span className="text-sm text-muted-foreground">—</span>
                          ) : (
                            <>
                              <ThresholdBadge
                                percentUsed={group.percentUsed ?? null}
                                thresholdsFired={group.thresholdsFired}
                              />
                              <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                                <div 
                                  className={`h-full transition-all duration-500 ${group.percentUsed! >= 100 ? 'bg-destructive' : 'bg-primary'}`} 
                                  style={{ width: `${Math.min(group.percentUsed!, 100)}%` }} 
                                />
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {groups.length === 0 && (
                <div className="text-center py-12 text-muted-foreground" data-testid="text-no-groups">
                  No groups found
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
