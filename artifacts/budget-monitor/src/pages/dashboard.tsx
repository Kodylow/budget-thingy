import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, AlertTriangle, DollarSign, TrendingUp, Wallet, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import {
  useListGroups,
  useGetSummary,
  useGetTeamsBudgets,
  getListGroupsQueryKey,
  getGetSummaryQueryKey,
  getGetTeamsBudgetsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ThresholdBadge } from '@/components/threshold-badge';
import { LoadingCell } from '@/components/loading-cell';
import { BudgetInput } from '@/components/budget-input';
import { TeamBudgetInput } from '@/components/team-budget-input';
import { useLocation } from 'wouter';
import { useRange } from '@/components/range-context';
import { RangeFilter } from '@/components/range-filter';
import { buildGroupClusters, roleBadgeClass, type GroupCluster } from '@/lib/group-clusters';

interface TeamSection {
  teamName: string;
  memberCount: number;
  spendUsd: number;
  spendLoaded: boolean;
  budgetUsd: number | null;
  remainingUsd: number | null;
  percentUsed: number | null;
  groups: ReturnType<typeof useListGroups>['data'] extends { groups: infer G } ? G : never[];
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { rangeType, startDate, endDate } = useRange();
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set());

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

  const { data: teamBudgetsData } = useGetTeamsBudgets({
    query: { queryKey: getGetTeamsBudgetsQueryKey() },
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

  // Build team budget map
  const teamBudgetMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const tb of teamBudgetsData?.budgets ?? []) {
      m.set(tb.teamName, tb.amountUsd);
    }
    return m;
  }, [teamBudgetsData]);

  // Compute team sections
  const { teamSections, unassigned } = useMemo(() => {
    const teamMap = new Map<string, typeof groups>();
    const unassigned: typeof groups = [];

    for (const g of groups) {
      if (g.teamName) {
        const existing = teamMap.get(g.teamName) ?? [];
        existing.push(g);
        teamMap.set(g.teamName, existing);
      } else {
        unassigned.push(g);
      }
    }

    const teamSections: TeamSection[] = [];
    for (const [teamName, teamGroups] of teamMap) {
      let memberCount = 0;
      let spendUsd = 0;
      let spendLoaded = true;
      for (const g of teamGroups) {
        memberCount += g.memberCount ?? 0;
        if (!g.spendLoaded) {
          spendLoaded = false;
        } else {
          spendUsd += g.spendUsd ?? 0;
        }
      }
      const budgetUsd = teamBudgetMap.has(teamName) ? (teamBudgetMap.get(teamName) ?? null) : null;
      const hasBudget = budgetUsd !== null && budgetUsd > 0;
      const remainingUsd = spendLoaded && hasBudget ? budgetUsd! - spendUsd : null;
      const percentUsed = spendLoaded && hasBudget ? (spendUsd / budgetUsd!) * 100 : null;

      teamSections.push({
        teamName,
        memberCount,
        spendUsd,
        spendLoaded,
        budgetUsd: budgetUsd ?? null,
        remainingUsd,
        percentUsed,
        groups: teamGroups as any,
      });
    }

    // Sort teams alphabetically
    teamSections.sort((a, b) => a.teamName.localeCompare(b.teamName));

    return { teamSections, unassigned };
  }, [groups, teamBudgetMap]);

  const toggleTeam = (teamName: string) => {
    setExpandedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamName)) next.delete(teamName);
      else next.add(teamName);
      return next;
    });
  };

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

  const renderGroupRow = (group: (typeof groups)[0]) => (
    <tr
      key={group.groupId}
      className="border-b border-border hover:bg-muted/50 transition-colors group cursor-pointer"
      data-testid={`row-group-${group.groupId}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, a')) return;
        setLocation(`/groups/${group.groupId}`);
      }}
    >
      <td className="py-3 px-4 pl-10">
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
            ${(group.spendUsd ?? 0).toFixed(2)}
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
  );

  const renderClusterRow = (cluster: GroupCluster) => {
    const roles = Object.values(cluster.groupRoles);
    const uniqueRoles = [...new Set(roles)].sort(
      (a, b) => (roleBadgeClass(a) ? 0 : 0) || a.localeCompare(b),
    );
    const clusterUrl =
      `/clusters?ids=${encodeURIComponent(cluster.groupIds.join(','))}&name=${encodeURIComponent(cluster.baseName)}`;
    return (
      <tr
        key={cluster.clusterKey}
        className="border-b border-border hover:bg-muted/50 transition-colors cursor-pointer"
        onClick={() => setLocation(clusterUrl)}
      >
        <td className="py-3 px-4 pl-10">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{cluster.baseName}</span>
            <div className="flex items-center gap-1">
              <Layers className="h-3 w-3 text-muted-foreground" />
              <div className="flex gap-1">
                {uniqueRoles.map((r) => (
                  <span
                    key={r}
                    className={`inline-flex items-center border rounded px-1.5 py-0 text-[9px] font-medium ${roleBadgeClass(r)}`}
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </td>
        <td className="py-3 px-4">
          <span className="text-sm text-muted-foreground">
            {cluster.workspaceName || '—'}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm font-mono tabular-nums">
            {cluster.memberCount}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          {!cluster.spendLoaded ? (
            <div className="flex justify-end"><LoadingCell /></div>
          ) : (
            <span className="text-sm font-mono tabular-nums">
              ${cluster.spendUsd.toFixed(2)}
            </span>
          )}
        </td>
        {/* Budget, Remaining, Usage — not applicable at cluster level */}
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
      </tr>
    );
  };

  const renderTeamGroups = (team: TeamSection) => {
    const clusters = buildGroupClusters(team.groups as any[]);
    return clusters.map((cluster) =>
      cluster.isSingleGroup
        ? renderGroupRow(cluster.singleGroup as any)
        : renderClusterRow(cluster),
    );
  };

  const renderTeamHeader = (team: TeamSection) => {
    const expanded = expandedTeams.has(team.teamName);
    const hasBudget = team.budgetUsd !== null && team.budgetUsd > 0;
    const clusterCount = buildGroupClusters(team.groups as any[]).length;
    return (
      <tr
        key={`team-${team.teamName}`}
        className="border-b border-border bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer group select-none"
        data-testid={`row-team-${team.teamName}`}
        onClick={() => toggleTeam(team.teamName)}
      >
        <td className="py-3 px-4 font-semibold text-sm" colSpan={1}>
          <div className="flex items-center gap-2">
            {expanded
              ? <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              : <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            }
            <span>{team.teamName}</span>
            <Badge variant="outline" className="text-[9px] h-4 px-1 ml-1 font-normal">
              {clusterCount} group{clusterCount !== 1 ? 's' : ''}
            </Badge>
          </div>
        </td>
        <td className="py-3 px-4">
          {/* workspace col — blank for team header */}
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm font-mono tabular-nums font-semibold">
            {team.memberCount}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          {!team.spendLoaded ? (
            <div className="flex justify-end"><LoadingCell /></div>
          ) : (
            <span className="text-sm font-mono tabular-nums font-semibold">
              ${team.spendUsd.toFixed(2)}
            </span>
          )}
        </td>
        <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
          <TeamBudgetInput teamName={team.teamName} currentBudget={team.budgetUsd} />
        </td>
        <td className="py-3 px-4 text-right">
          {!team.spendLoaded || !hasBudget ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <span className={`text-sm font-mono tabular-nums font-semibold ${team.remainingUsd! < 0 ? 'text-destructive' : ''}`}>
              ${team.remainingUsd!.toFixed(2)}
            </span>
          )}
        </td>
        <td className="py-3 px-4 text-right">
          <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
            {!team.spendLoaded || !hasBudget ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              <>
                <span className={`text-xs font-mono tabular-nums font-semibold ${team.percentUsed! >= 100 ? 'text-destructive' : team.percentUsed! >= 75 ? 'text-yellow-600' : ''}`}>
                  {team.percentUsed!.toFixed(1)}%
                </span>
                <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                  <div
                    className={`h-full transition-all duration-500 ${team.percentUsed! >= 100 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.min(team.percentUsed!, 100)}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const renderUnassignedHeader = () => {
    const expanded = expandedTeams.has('__unassigned__');
    return (
      <tr
        key="team-unassigned"
        className="border-b border-border bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer select-none"
        data-testid="row-team-unassigned"
        onClick={() => toggleTeam('__unassigned__')}
      >
        <td className="py-3 px-4 font-semibold text-sm text-muted-foreground" colSpan={7}>
          <div className="flex items-center gap-2">
            {expanded
              ? <ChevronDown className="h-4 w-4 flex-shrink-0" />
              : <ChevronRight className="h-4 w-4 flex-shrink-0" />
            }
            <span>Unassigned</span>
            <Badge variant="outline" className="text-[9px] h-4 px-1 ml-1 font-normal">
              {unassigned.length} group{unassigned.length !== 1 ? 's' : ''}
            </Badge>
          </div>
        </td>
      </tr>
    );
  };

  const hasTeams = teamSections.length > 0;

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
            Monitor spending and set budgets by team
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
                  {hasTeams ? (
                    <>
                      {teamSections.map((team) => (
                        <React.Fragment key={`team-section-${team.teamName}`}>
                          {renderTeamHeader(team)}
                          {expandedTeams.has(team.teamName) &&
                            renderTeamGroups(team)}
                        </React.Fragment>
                      ))}
                      {unassigned.length > 0 && (
                        <React.Fragment key="team-section-unassigned">
                          {renderUnassignedHeader()}
                          {expandedTeams.has('__unassigned__') &&
                            unassigned.map((g) => renderGroupRow(g))}
                        </React.Fragment>
                      )}
                    </>
                  ) : (
                    groups.map((group) => renderGroupRow(group))
                  )}
                </tbody>
                {groups.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                      <td className="py-3 px-4 text-sm">
                        Total
                      </td>
                      <td className="py-3 px-4" />
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                          {groups.reduce((s, g) => s + (g.memberCount ?? 0), 0)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {summary ? (
                          <span className="text-sm font-mono tabular-nums">
                            ${summary.totalSpendUsd.toFixed(2)}
                          </span>
                        ) : (
                          <div className="flex justify-end"><LoadingCell /></div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                          {summary ? `$${summary.totalBudgetUsd.toFixed(2)}` : '—'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className={`text-sm font-mono tabular-nums ${summary && summary.totalRemainingUsd < 0 ? 'text-destructive' : ''}`}>
                          {summary ? `$${summary.totalRemainingUsd.toFixed(2)}` : '—'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {summary && summary.totalBudgetUsd > 0 ? (
                          <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
                            <span className={`text-xs font-mono tabular-nums ${(summary.totalSpendUsd / summary.totalBudgetUsd) * 100 >= 100 ? 'text-destructive' : ''}`}>
                              {((summary.totalSpendUsd / summary.totalBudgetUsd) * 100).toFixed(1)}%
                            </span>
                            <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                              <div
                                className={`h-full transition-all duration-500 ${(summary.totalSpendUsd / summary.totalBudgetUsd) * 100 >= 100 ? 'bg-destructive' : 'bg-primary'}`}
                                style={{ width: `${Math.min((summary.totalSpendUsd / summary.totalBudgetUsd) * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  </tfoot>
                )}
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
