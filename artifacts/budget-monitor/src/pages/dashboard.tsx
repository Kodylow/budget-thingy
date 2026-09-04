import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, AlertTriangle, DollarSign, TrendingUp, Wallet, ChevronDown, ChevronRight, Layers, TrendingDown } from 'lucide-react';

import { useAuthContext, useCanWrite } from '@/components/auth-context';

type PaceStatus = 'on-track' | 'at-risk' | 'over-pace';
interface PaceResult { status: PaceStatus; projectedUsd: number; daysRemaining: number; }

function calcPace(
  spendUsd: number,
  budgetUsd: number,
  periodStart: string,
  periodEnd: string,
): PaceResult | null {
  if (budgetUsd <= 0 || spendUsd == null) return null;
  const now = Date.now();
  const startMs = new Date(periodStart).getTime();
  const endMs = new Date(periodEnd).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const daysElapsed = (now - startMs) / 86_400_000;
  if (daysElapsed <= 0) return null;
  const daysRemaining = Math.max(0, (endMs - now) / 86_400_000);
  const projectedUsd = (spendUsd / daysElapsed) * ((endMs - startMs) / 86_400_000);
  const ratio = projectedUsd / budgetUsd;
  const status: PaceStatus = ratio <= 1.0 ? 'on-track' : ratio <= 1.15 ? 'at-risk' : 'over-pace';
  return { status, projectedUsd, daysRemaining };
}

function PaceCell({
  spendUsd,
  budgetUsd,
  spendLoaded,
  semibold,
  periodStart,
  periodEnd,
  periodLabel,
  isFallback,
}: {
  spendUsd: number;
  budgetUsd: number | null;
  spendLoaded: boolean;
  semibold?: boolean;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  isFallback: boolean;
}) {
  if (budgetUsd == null || budgetUsd <= 0) return <span className="text-sm text-muted-foreground">—</span>;
  const pace = calcPace(spendUsd, budgetUsd, periodStart, periodEnd);
  if (!pace) return <span className="text-sm text-muted-foreground">—</span>;
  const cfg = {
    'on-track':  { label: 'On Track',  cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
    'at-risk':   { label: 'At Risk',   cls: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300' },
    'over-pace': { label: 'Over Pace', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
  }[pace.status];
  return (
    <div
      className={`flex flex-col items-end gap-0.5${!spendLoaded ? ' opacity-60' : ''}`}
      title={
        !spendLoaded
          ? `Latest available pace; background sync is still running. Pace period: ${periodLabel}${isFallback ? ' (safe fallback)' : ''}`
          : `Pace period: ${periodLabel}${isFallback ? ' (safe fallback)' : ''}`
      }
    >
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.cls} ${semibold ? 'font-semibold' : ''}`}>
        {cfg.label}
      </span>
      <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
        ${pace.projectedUsd.toFixed(0)} proj.
      </span>
    </div>
  );
}
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
import { BudgetInput } from '@/components/budget-input';
import { useLocation } from 'wouter';
import { useRange } from '@/components/range-context';
import { RangeFilter } from '@/components/range-filter';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { buildGroupClusters, roleBadgeClass, sumAttributedRollup, type GroupCluster } from '@/lib/group-clusters';
import { filterGroupsForView } from '@/lib/rbac-view';
import { compareTeamNames, formatTeamName } from '@/lib/team-names';
import { VirtualizedTableRows } from '@/components/virtualized-table-rows';
import { dashboardPollInterval } from '@/lib/client-performance';

interface TeamSection {
  teamName: string;
  memberCount: number;
  spendUsd: number;
  spendLoaded: boolean;
  paceSpendUsd: number;
  paceSpendLoaded: boolean;
  budgetUsd: number | null;
  remainingUsd: number | null;
  percentUsed: number | null;
  groups: ReturnType<typeof useListGroups>['data'] extends { groups: infer G } ? G : never[];
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const canWrite = useCanWrite();
  const { isAccountWide, role, preview, isPreviewing } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set());
  const [retrySyncError, setRetrySyncError] = useState<string | null>(null);

  const queryParams = useMemo(
    () => ({
      rangeType,
      ...(rangeType === 'custom' ? { startDate, endDate } : {}),
    }),
    [rangeType, startDate, endDate],
  );

  const {
    data: groupsData,
    isError: groupsRequestFailed,
    error: groupsRequestError,
    refetch: refetchGroups,
    isFetching: groupsFetching,
  } = useListGroups(queryParams, {
    query: {
      queryKey: getListGroupsQueryKey(queryParams),
      placeholderData: (previousData) => previousData,
      refetchInterval: (query) =>
        dashboardPollInterval(query.state.data, query.state.dataUpdateCount, query.state.status),
    },
  });

  const {
    data: summary,
    isError: summaryRequestFailed,
    error: summaryRequestError,
    refetch: refetchSummary,
    isFetching: summaryFetching,
  } = useGetSummary(queryParams, {
    query: {
      queryKey: getGetSummaryQueryKey(queryParams),
      placeholderData: (previousData) => previousData,
      refetchInterval: (query) => {
        return dashboardPollInterval(
          query.state.data,
          query.state.dataUpdateCount,
          query.state.status,
        );
      },
    },
  });

  const { data: teamBudgetsData, isLoading: teamBudgetsLoading } = useGetTeamsBudgets({
    query: { queryKey: getGetTeamsBudgetsQueryKey() },
  });

  const usageAvailable = groupsData?.usageHealth.status !== 'empty';
  const groups = useMemo(
    () =>
      filterGroupsForView(groupsData?.groups ?? [], role, preview).map((group) => {
        return {
          ...group,
          spendUsd: group.rollupSpendUsd,
          spendLoaded: usageAvailable,
          paceSpendLoaded: usageAvailable,
        };
      }),
    [groupsData?.groups, role, preview, usageAvailable],
  );

  const retryRequests = async () => {
    setRetrySyncError(null);
    const [groupsResult, summaryResult] = await Promise.all([
      refetchGroups(),
      refetchSummary(),
    ]);
    const error = groupsResult.error ?? summaryResult.error;
    if (error) {
      setRetrySyncError(
        error instanceof Error ? error.message : 'Dashboard data is still unavailable.',
      );
    }
  };

  const requestErrorMessage = groupsRequestFailed
    ? (groupsRequestError instanceof Error
        ? groupsRequestError.message
        : 'Group data is unavailable.')
    : summaryRequestFailed
      ? (summaryRequestError instanceof Error
          ? summaryRequestError.message
          : 'Summary data is unavailable.')
      : null;

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
      const { memberCount } = sumAttributedRollup(teamGroups);
      // Financial values remain server-owned. Provisional server values stay
      // visible while canonical data refreshes in the background.
      const serverTeamSpend = groupsData?.teamRawSpend?.[teamName];
      const spendUsd = isPreviewing
        ? teamGroups.reduce((sum, group) => sum + (group.spendUsd ?? 0), 0)
        : (serverTeamSpend?.spendUsd ?? 0);
      const spendLoaded = isPreviewing
        ? teamGroups.every((group) => group.spendLoaded)
        : usageAvailable;
      const paceSpendLoaded = teamGroups.every((group) => group.paceSpendLoaded);
      const paceSpendUsd = teamGroups.reduce(
        (sum, group) => sum + (group.paceSpendUsd ?? 0),
        0,
      );
      const budgetUsd = teamBudgetMap.has(teamName) ? (teamBudgetMap.get(teamName) ?? null) : null;
      const hasBudget = budgetUsd !== null && budgetUsd > 0;
      const remainingUsd = hasBudget ? budgetUsd! - spendUsd : null;
      const percentUsed = hasBudget ? (spendUsd / budgetUsd!) * 100 : null;

      teamSections.push({
        teamName,
        memberCount,
        spendUsd,
        spendLoaded,
        paceSpendUsd,
        paceSpendLoaded,
        budgetUsd: budgetUsd ?? null,
        remainingUsd,
        percentUsed,
        groups: teamGroups as any,
      });
    }

    // Canonical budgets may exist before any Replit group is assigned. Keep
    // those teams visible with zero spend so dashboard totals reconcile.
    if (isAccountWide && !isPreviewing) {
      for (const [teamName, budgetUsd] of teamBudgetMap) {
        if (teamMap.has(teamName)) continue;
        teamSections.push({
          teamName,
          memberCount: 0,
          spendUsd: 0,
          spendLoaded: true,
          paceSpendUsd: 0,
          paceSpendLoaded: true,
          budgetUsd,
          remainingUsd: budgetUsd != null && budgetUsd > 0 ? budgetUsd : null,
          percentUsed: budgetUsd != null && budgetUsd > 0 ? 0 : null,
          groups: [] as any,
        });
      }
    }

    // Sort by the names shown in the table, not internal team keys.
    teamSections.sort((a, b) => compareTeamNames(a.teamName, b.teamName));
    unassigned.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return { teamSections, unassigned };
  }, [groups, teamBudgetMap, groupsData, isPreviewing, isAccountWide]);

  // Financial summary cards and the table footer must reconcile to the same
  // visible top-level rows: each team pool once, plus each unassigned group.
  // Nested group budgets are not added on top of their team's pool.
  const tableTotals = useMemo(() => {
    let totalSpendUsd = 0;
    let totalBudgetUsd = 0;
    let budgetedSpendUsd = 0;
    let budgetedPaceSpendUsd = 0;
    let paceSpendLoaded = true;
    let budgetedPools = 0;

    const addRow = (
      spendUsd: number,
      budgetUsd: number | null,
      spendLoaded: boolean,
      paceSpendUsd: number,
      rowPaceSpendLoaded: boolean,
    ) => {
      totalSpendUsd += spendUsd;
      if (budgetUsd === null || budgetUsd <= 0) return;
      totalBudgetUsd += budgetUsd;
      budgetedPools += 1;
      budgetedSpendUsd += spendUsd;
      if (!rowPaceSpendLoaded) {
        paceSpendLoaded = false;
        return;
      }
      budgetedPaceSpendUsd += paceSpendUsd;
    };

    for (const team of teamSections) {
      addRow(
        team.spendUsd,
        team.budgetUsd,
        team.spendLoaded,
        team.paceSpendUsd,
        team.paceSpendLoaded,
      );
    }
    for (const group of unassigned) {
      addRow(
        group.spendUsd ?? 0,
        group.budgetUsd ?? null,
        group.spendLoaded,
        group.paceSpendUsd ?? 0,
        group.paceSpendLoaded,
      );
    }
    return {
      totalSpendUsd,
      totalBudgetUsd,
      budgetedSpendUsd,
      budgetedPaceSpendUsd,
      paceSpendLoaded,
      totalRemainingUsd: totalBudgetUsd - budgetedSpendUsd,
      budgetedPools,
    };
  }, [teamSections, unassigned]);

  const assignedGroupsSubtotal = useMemo(() => {
    const memberCount = teamSections.reduce((sum, team) => sum + team.memberCount, 0);
    const spendUsd = teamSections.reduce((sum, team) => sum + team.spendUsd, 0);
    const spendLoaded = teamSections.every((team) => team.spendLoaded);
    const totalBudgetUsd = teamSections.reduce(
      (sum, team) => sum + (team.budgetUsd != null && team.budgetUsd > 0 ? team.budgetUsd : 0),
      0,
    );
    const budgetedSpendUsd = teamSections.reduce(
      (sum, team) =>
        sum + (team.budgetUsd != null && team.budgetUsd > 0 ? team.spendUsd : 0),
      0,
    );
    const budgetedPaceSpendUsd = teamSections.reduce(
      (sum, team) =>
        sum + (
          team.paceSpendLoaded && team.budgetUsd != null && team.budgetUsd > 0
            ? team.paceSpendUsd
            : 0
        ),
      0,
    );
    const paceSpendLoaded = teamSections
      .filter((team) => team.budgetUsd != null && team.budgetUsd > 0)
      .every((team) => team.paceSpendLoaded);

    return {
      memberCount,
      spendUsd,
      spendLoaded,
      totalBudgetUsd,
      budgetedSpendUsd,
      budgetedPaceSpendUsd,
      paceSpendLoaded,
      totalRemainingUsd: totalBudgetUsd - budgetedSpendUsd,
    };
  }, [teamSections]);

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
      value: role === 'workspace_admin' && isPreviewing
        ? `$${tableTotals.totalSpendUsd.toFixed(2)}`
        : `$${(summary?.totalSpendUsd ?? tableTotals.totalSpendUsd).toFixed(2)}`,
      description: summary?.billingPeriodLabel ?? groupsData?.billingPeriodLabel ?? 'Current period',
      icon: DollarSign,
    },
    {
      title: 'Total Budget',
      value: `$${tableTotals.totalBudgetUsd.toFixed(2)}`,
      description: `${tableTotals.budgetedPools} visible pools budgeted`,
      icon: TrendingUp,
    },
    {
      title: 'Remaining',
      value: role === 'workspace_admin' && isPreviewing
        ? `$${tableTotals.totalRemainingUsd.toFixed(2)}`
        : `$${(summary?.totalRemainingUsd ?? tableTotals.totalRemainingUsd).toFixed(2)}`,
      description: 'Across visible budgeted pools',
      icon: Wallet,
      valueClassName: (role === 'workspace_admin' && isPreviewing
        ? tableTotals.totalRemainingUsd
        : (summary?.totalRemainingUsd ?? 0)) < 0 ? 'text-destructive' : '',
    },
    {
      title: 'Over Threshold',
      value: role === 'workspace_admin' && isPreviewing
        ? groups.filter((group) => (group.percentUsed ?? 0) >= 75).length.toString()
        : summary ? summary.groupsOver75.toString() : '—',
      description: role === 'workspace_admin' && isPreviewing
        ? `${groups.filter((group) => (group.percentUsed ?? 0) >= 100).length} over budget`
        : `${summary?.groupsOver100 ?? 0} over budget`,
      icon: AlertTriangle,
    },
    {
      title: 'Alerts Sent',
      value: summary ? summary.alertsSentThisPeriod.toString() : '—',
      description: 'This billing period',
      icon: RefreshCw,
    },
  ].filter((card) => !(role === 'workspace_admin' && card.title === 'Alerts Sent'));

  const renderGroupRow = (group: (typeof groups)[0]) => {
    const hasBudget = group.budgetUsd != null && group.budgetUsd > 0;
    const displaySpend = group.spendUsd ?? 0;
    const displayRemaining = hasBudget
      ? (group.remainingUsd ?? group.budgetUsd! - displaySpend)
      : null;
    const displayPercentUsed = hasBudget
      ? (group.percentUsed ?? (displaySpend / group.budgetUsd!) * 100)
      : null;

    return (
      <tr
      key={group.groupId}
      className={`border-b border-border transition-colors group ${
        group.isSynthetic ? 'bg-muted/10' : 'hover:bg-muted/50 cursor-pointer'
      }`}
      data-testid={`row-group-${group.groupId}`}
      tabIndex={group.isSynthetic ? undefined : 0}
      onClick={(e) => {
        if (group.isSynthetic) return;
        if ((e.target as HTMLElement).closest('button, input, a')) return;
        setLocation(`/groups/${group.groupId}`);
      }}
      onKeyDown={(e) => {
        if (group.isSynthetic || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
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
        <span
          className={`text-sm font-mono tabular-nums${!group.spendLoaded ? ' text-muted-foreground' : ''}`}
          data-testid={`text-spend-${group.groupId}`}
          title={!group.spendLoaded ? 'Latest available value; background sync is still running' : undefined}
        >
          ${displaySpend.toFixed(2)}
        </span>
      </td>
      <td className="py-3 px-4 text-right">
        <div className="flex flex-col items-end gap-1">
          {canWrite ? (
            <BudgetInput groupId={group.groupId} currentBudget={group.budgetUsd ?? null} />
          ) : (
            <span className="text-sm font-mono tabular-nums" data-testid={`text-budget-${group.groupId}`}>
              {group.budgetUsd !== null && group.budgetUsd !== undefined ? `$${group.budgetUsd.toFixed(2)}` : '—'}
            </span>
          )}
          {group.budgetSource && (
            <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 uppercase bg-muted/50" title={`Budget source: ${group.budgetSource}`}>
              {group.budgetSource}
            </Badge>
          )}
        </div>
      </td>
      <td className="py-3 px-4 text-right">
        {displayRemaining === null ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <span className={`text-sm font-mono tabular-nums ${displayRemaining < 0 ? 'text-destructive font-bold' : ''}${!group.spendLoaded ? ' text-muted-foreground' : ''}`}>
            ${displayRemaining.toFixed(2)}
          </span>
        )}
      </td>
      <td className="py-3 px-4 text-right">
        <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
          {displayPercentUsed === null ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <>
              <ThresholdBadge
                percentUsed={displayPercentUsed}
                thresholdsFired={group.thresholdsFired}
              />
              <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                <div
                  className={`h-full transition-all duration-500 ${displayPercentUsed >= 100 ? 'bg-destructive' : 'bg-primary'}`}
                  style={{ width: `${Math.min(displayPercentUsed, 100)}%` }}
                />
              </div>
            </>
          )}
        </div>
      </td>
      <td className="py-3 px-4 text-right">
        <PaceCell
          spendUsd={group.paceSpendUsd ?? 0}
          budgetUsd={group.budgetUsd ?? null}
          spendLoaded={group.paceSpendLoaded}
          periodStart={summary?.pacePeriodStart ?? ''}
          periodEnd={summary?.pacePeriodEnd ?? ''}
          periodLabel={summary?.pacePeriodLabel ?? ''}
          isFallback={summary?.pacePeriodIsFallback ?? true}
        />
      </td>
      </tr>
    );
  };

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
        tabIndex={0}
        onClick={() => setLocation(clusterUrl)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          setLocation(clusterUrl);
        }}
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
          <span
            className={`text-sm font-mono tabular-nums${!cluster.spendLoaded ? ' text-muted-foreground' : ''}`}
            title={!cluster.spendLoaded ? 'Latest available value; background sync is still running' : undefined}
          >
            ${cluster.spendUsd.toFixed(2)}
          </span>
        </td>
        {/* Budget, Remaining, Usage, Pace — not applicable at cluster level */}
        <td className="py-3 px-4 text-right">
          <span className="text-sm text-muted-foreground">—</span>
        </td>
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
    const displayRemaining = hasBudget ? team.budgetUsd! - team.spendUsd : null;
    const displayPercentUsed = hasBudget ? (team.spendUsd / team.budgetUsd!) * 100 : null;
    const clusterCount = buildGroupClusters(team.groups as any[]).length;
    return (
      <tr
        key={`team-${team.teamName}`}
        className={`border-b border-border bg-muted/30 transition-colors group select-none ${
          clusterCount > 0 ? 'hover:bg-muted/50 cursor-pointer' : ''
        }`}
        data-testid={`row-team-${team.teamName}`}
        tabIndex={clusterCount > 0 ? 0 : undefined}
        onClick={() => {
          if (clusterCount > 0) toggleTeam(team.teamName);
        }}
        onKeyDown={(e) => {
          if (clusterCount === 0 || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          toggleTeam(team.teamName);
        }}
      >
        <td className="py-3 px-4 font-semibold text-sm" colSpan={1}>
          <div className="flex items-center gap-2">
            {clusterCount > 0 ? (
              expanded
                ? <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : <span className="w-4" aria-hidden="true" />}
            <span>{formatTeamName(team.teamName)}</span>
            <Badge variant="outline" className="text-[9px] h-4 px-1 ml-1 font-normal">
              {clusterCount > 0 ? `${clusterCount} group${clusterCount !== 1 ? 's' : ''}` : 'Budget only'}
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
          <span
            className={`text-sm font-mono tabular-nums font-semibold${!team.spendLoaded ? ' text-muted-foreground' : ''}`}
            title={!team.spendLoaded ? 'Latest available value; background sync is still running' : undefined}
          >
            ${team.spendUsd.toFixed(2)}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <span className="text-sm font-mono tabular-nums font-semibold" data-testid={`text-team-budget-${team.teamName}`}>
            {team.budgetUsd !== null && team.budgetUsd !== undefined ? `$${team.budgetUsd.toFixed(2)}` : '—'}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          {displayRemaining === null ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <span
              className={`text-sm font-mono tabular-nums font-semibold ${displayRemaining < 0 ? 'text-destructive' : ''}${!team.spendLoaded ? ' text-muted-foreground' : ''}`}
              title={!team.spendLoaded ? 'Latest available value; background sync is still running' : undefined}
            >
              ${displayRemaining.toFixed(2)}
            </span>
          )}
        </td>
        <td className="py-3 px-4 text-right">
          <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
            {displayPercentUsed === null ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              <>
                <span
                  className={`text-xs font-mono tabular-nums font-semibold ${displayPercentUsed >= 100 ? 'text-destructive' : displayPercentUsed >= 75 ? 'text-yellow-600' : ''}${!team.spendLoaded ? ' text-muted-foreground' : ''}`}
                  title={!team.spendLoaded ? 'Latest available value; background sync is still running' : undefined}
                >
                  {displayPercentUsed.toFixed(1)}%
                </span>
                <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                  <div
                    className={`h-full transition-all duration-500 ${displayPercentUsed >= 100 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.min(displayPercentUsed, 100)}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </td>
        <td className="py-3 px-4 text-right">
          <PaceCell
            spendUsd={team.paceSpendUsd}
            budgetUsd={team.budgetUsd}
            spendLoaded={team.paceSpendLoaded}
            semibold
            periodStart={summary?.pacePeriodStart ?? ''}
            periodEnd={summary?.pacePeriodEnd ?? ''}
            periodLabel={summary?.pacePeriodLabel ?? ''}
            isFallback={summary?.pacePeriodIsFallback ?? true}
          />
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
      tabIndex={0}
        onClick={() => toggleTeam('__unassigned__')}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleTeam('__unassigned__');
      }}
      >
        <td className="py-3 px-4 font-semibold text-sm text-muted-foreground" colSpan={8}>
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

  const renderAssignedGroupsSubtotal = () => (
    <tr
      className="border-y-2 border-border bg-muted/40 font-semibold"
      data-testid="row-assigned-groups-subtotal"
    >
      <td className="py-3 px-4 text-sm">Assigned groups subtotal</td>
      <td className="py-3 px-4" />
      <td className="py-3 px-4 text-right">
        <span className="text-sm font-mono tabular-nums">
          {assignedGroupsSubtotal.memberCount}
        </span>
      </td>
      <td className="py-3 px-4 text-right">
        <span className={`text-sm font-mono tabular-nums${!assignedGroupsSubtotal.spendLoaded ? ' text-muted-foreground' : ''}`}>
          ${assignedGroupsSubtotal.spendUsd.toFixed(2)}
        </span>
      </td>
      <td className="py-3 px-4 text-right">
        <span className="text-sm font-mono tabular-nums">
          ${assignedGroupsSubtotal.totalBudgetUsd.toFixed(2)}
        </span>
      </td>
      <td className="py-3 px-4 text-right">
        <span className={`text-sm font-mono tabular-nums ${assignedGroupsSubtotal.totalRemainingUsd < 0 ? 'text-destructive' : ''}${!assignedGroupsSubtotal.spendLoaded ? ' text-muted-foreground' : ''}`}>
          ${assignedGroupsSubtotal.totalRemainingUsd.toFixed(2)}
        </span>
      </td>
      <td className="py-3 px-4 text-right">
        {assignedGroupsSubtotal.totalBudgetUsd > 0 ? (
          <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
            <span className={`text-xs font-mono tabular-nums ${assignedGroupsSubtotal.budgetedSpendUsd / assignedGroupsSubtotal.totalBudgetUsd >= 1 ? 'text-destructive' : ''}`}>
              {((assignedGroupsSubtotal.budgetedSpendUsd / assignedGroupsSubtotal.totalBudgetUsd) * 100).toFixed(1)}%
            </span>
            <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
              <div
                className={`h-full transition-all duration-500 ${assignedGroupsSubtotal.budgetedSpendUsd / assignedGroupsSubtotal.totalBudgetUsd >= 1 ? 'bg-destructive' : 'bg-primary'}`}
                style={{ width: `${Math.min((assignedGroupsSubtotal.budgetedSpendUsd / assignedGroupsSubtotal.totalBudgetUsd) * 100, 100)}%` }}
              />
            </div>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-3 px-4 text-right">
        {assignedGroupsSubtotal.paceSpendLoaded && assignedGroupsSubtotal.totalBudgetUsd > 0 ? (
          <PaceCell
            spendUsd={assignedGroupsSubtotal.budgetedPaceSpendUsd}
            budgetUsd={assignedGroupsSubtotal.totalBudgetUsd}
            spendLoaded={assignedGroupsSubtotal.paceSpendLoaded}
            semibold
            periodStart={summary?.pacePeriodStart ?? ''}
            periodEnd={summary?.pacePeriodEnd ?? ''}
            periodLabel={summary?.pacePeriodLabel ?? ''}
            isFallback={summary?.pacePeriodIsFallback ?? true}
          />
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );

  const hasTeams = teamSections.length > 0;

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">
            Dashboard
          </h1>
          <p className="text-muted-foreground mt-1" data-testid="text-billing-period">
            {groupsData?.billingPeriodLabel ?? summary?.billingPeriodLabel ?? 'Current period'}
          </p>
          <p className="text-[10px] md:text-xs text-muted-foreground mt-1" data-testid="text-reconciliation-scope">
            {role === 'workspace_admin'
              ? `${preview?.groupName ? `Group admin preview · ${preview.groupName}` : 'Your authorized group scope'} · Custom dates use inclusive UTC days`
              : 'All workspaces you can access · Custom dates use inclusive UTC days'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RangeFilter />
          {(groupsData?.usageHealth.status === 'partial' ||
            groupsData?.usageHealth.status === 'stale' ||
            groupsData?.usageHealth.status === 'empty') && (
            <Badge
              variant="outline"
              className="flex items-center gap-2 border-yellow-500/50 text-yellow-700 dark:text-yellow-300"
              data-testid="badge-usage-health"
              title={`Usage coverage: ${Math.round(groupsData.usageHealth.coverage.ratio * 100)}%`}
            >
              <AlertTriangle className="h-3 w-3" />
              <span className="hidden sm:inline">
                Usage data {groupsData.usageHealth.status}
              </span>
            </Badge>
          )}
        </div>
      </div>
      {requestErrorMessage && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          data-testid="dashboard-request-error"
        >
          <div>
            <p className="font-medium text-destructive">Dashboard data could not be refreshed.</p>
            <p className="text-muted-foreground">
              {groupsData || summary
                ? 'Showing the last available data. '
                : ''}
              {requestErrorMessage}
            </p>
          </div>
          <button
            type="button"
            className="self-start rounded-md border px-3 py-1.5 font-medium hover:bg-muted disabled:opacity-50 sm:self-auto"
            disabled={groupsFetching || summaryFetching}
            onClick={() => void retryRequests()}
          >
            {groupsFetching || summaryFetching ? 'Retrying…' : 'Retry requests'}
          </button>
        </div>
      )}
      {retrySyncError && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          data-testid="dashboard-retry-error"
        >
          {retrySyncError}
        </div>
      )}
      {summary && (
        <p className="text-xs text-muted-foreground">
          Pace period: {summary.pacePeriodLabel}
          {summary.pacePeriodIsFallback ? ' (safe fallback)' : ''}
        </p>
      )}
      {rangeType === 'billing' && summary?.billingPeriodDiffersFromReportingCutoff && (
        <div
          className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm"
          data-testid="billing-window-banner"
        >
          Total Spend uses the verified Enterprise billing window shown above, beginning{' '}
          {new Date(summary.reportingRangeStart).toLocaleDateString()}, rather than the earlier
          data-availability cutoff.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title} data-testid={`card-stat-${stat.title.toLowerCase().replace(/\s+/g, '-')}`}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 md:p-6 md:pb-2">
                <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
                <CardContent className="px-4 pb-4 md:px-6 md:pb-6">
                <div className={`text-xl sm:text-2xl font-bold font-mono tabular-nums ${stat.valueClassName || ''}`} data-testid={`text-stat-${stat.title.toLowerCase().replace(/\s+/g, '-')}`}>
                  {stat.value}
                </div>
                <p className="text-xs text-muted-foreground mt-1 whitespace-nowrap overflow-hidden text-ellipsis">
                  {stat.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Tabs defaultValue="groups" className="space-y-4">
        <TabsContent value="groups">
      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
          <CardDescription>
            Monitor spending and set budgets by team
          </CardDescription>
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
            Current credit pool expires May 17, 2027.
          </p>
        </CardHeader>
        <CardContent>
            <div className="max-h-[70vh] overflow-auto" data-virtual-scroll>
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
                    <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4" title="Projected total spend by May 17 2027 vs budget">
                      Pace <span className="font-normal opacity-60">→ May '27</span>
                    </th>
                  </tr>
                </thead>
                <VirtualizedTableRows columnCount={8}>
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
                           {renderAssignedGroupsSubtotal()}
                          {renderUnassignedHeader()}
                          {expandedTeams.has('__unassigned__') &&
                            unassigned.map((g) => renderGroupRow(g))}
                        </React.Fragment>
                      )}
                    </>
                  ) : (
                    [...groups]
                      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
                      .map((group) => renderGroupRow(group))
                  )}
                  {!isPreviewing && summary &&
                    (isAccountWide || summary.usageHealth.accountWorkspaceUnreconciledUsd > 0) && (
                    <tr
                      className="border-b border-border bg-muted/10"
                      data-testid={isAccountWide ? "row-account-reconciliation" : "row-unattributed-projects"}
                    >
                      <td className="py-3 px-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium italic">
                            {isAccountWide
                              ? 'True unattributed residual'
                              : 'Unattributed project residual'}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {isAccountWide
                              ? 'No group/project ID, missing creator, or creator no longer a member'
                              : 'No project ID, missing creator, or creator no longer a member'}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                           ${summary.usageHealth.accountWorkspaceUnreconciledUsd.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                    </tr>
                  )}
                </VirtualizedTableRows>
                {groups.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                      <td className="py-3 px-4 text-sm">
                        Total
                      </td>
                      <td className="py-3 px-4" />
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                          {groups.reduce((s, g) => s + g.rollupMemberCount, 0)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                          ${(isPreviewing ? tableTotals.totalSpendUsd : (summary?.totalSpendUsd ?? tableTotals.totalSpendUsd)).toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                          ${tableTotals.totalBudgetUsd.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className={`text-sm font-mono tabular-nums ${tableTotals.totalRemainingUsd < 0 ? 'text-destructive' : ''}`}>
                          ${tableTotals.totalRemainingUsd.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {tableTotals.totalBudgetUsd > 0 ? (
                          <div className="flex flex-col gap-1.5 items-end w-32 ml-auto">
                            <span className={`text-xs font-mono tabular-nums ${(tableTotals.budgetedSpendUsd / tableTotals.totalBudgetUsd) * 100 >= 100 ? 'text-destructive' : ''}`}>
                              {((tableTotals.budgetedSpendUsd / tableTotals.totalBudgetUsd) * 100).toFixed(1)}%
                            </span>
                            <div className="h-1.5 w-full bg-muted overflow-hidden rounded-full">
                              <div
                                className={`h-full transition-all duration-500 ${(tableTotals.budgetedSpendUsd / tableTotals.totalBudgetUsd) * 100 >= 100 ? 'bg-destructive' : 'bg-primary'}`}
                                style={{ width: `${Math.min((tableTotals.budgetedSpendUsd / tableTotals.totalBudgetUsd) * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {tableTotals.totalBudgetUsd > 0 ? (
                          <PaceCell
                            spendUsd={tableTotals.budgetedPaceSpendUsd}
                            budgetUsd={tableTotals.totalBudgetUsd}
                            spendLoaded={tableTotals.paceSpendLoaded}
                            semibold
                            periodStart={summary?.pacePeriodStart ?? ''}
                            periodEnd={summary?.pacePeriodEnd ?? ''}
                            periodLabel={summary?.pacePeriodLabel ?? ''}
                            isFallback={summary?.pacePeriodIsFallback ?? true}
                          />
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
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
