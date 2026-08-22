import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, AlertTriangle, DollarSign, TrendingUp, Wallet, ChevronDown, ChevronRight, Layers, TrendingDown, Download, Search, ChevronsUpDown, ChevronUp } from 'lucide-react';

// Credit pool period: May 20 2026 (spend cutoff) → May 17 2027 (expiry)
import { useCanWrite } from '@/components/auth-context';
const PACE_PERIOD_START_MS = new Date('2026-05-20T00:00:00.000Z').getTime();
const PACE_PERIOD_END_MS   = new Date('2027-05-17T00:00:00.000Z').getTime();
const PACE_TOTAL_DAYS = (PACE_PERIOD_END_MS - PACE_PERIOD_START_MS) / 86_400_000;

type PaceStatus = 'on-track' | 'at-risk' | 'over-pace';
interface PaceResult { status: PaceStatus; projectedUsd: number; daysRemaining: number; }

function calcPace(spendUsd: number, budgetUsd: number): PaceResult | null {
  if (budgetUsd <= 0 || spendUsd == null) return null;
  const now = Date.now();
  const daysElapsed = (now - PACE_PERIOD_START_MS) / 86_400_000;
  if (daysElapsed <= 0) return null;
  const daysRemaining = Math.max(0, (PACE_PERIOD_END_MS - now) / 86_400_000);
  const projectedUsd = (spendUsd / daysElapsed) * PACE_TOTAL_DAYS;
  const ratio = projectedUsd / budgetUsd;
  const status: PaceStatus = ratio <= 1.0 ? 'on-track' : ratio <= 1.15 ? 'at-risk' : 'over-pace';
  return { status, projectedUsd, daysRemaining };
}

function PaceCell({ spendUsd, budgetUsd, spendLoaded, semibold }: {
  spendUsd: number; budgetUsd: number | null; spendLoaded: boolean; semibold?: boolean;
}) {
  if (!spendLoaded) return <span className="text-sm text-muted-foreground">—</span>;
  if (budgetUsd == null || budgetUsd <= 0) return <span className="text-sm text-muted-foreground">—</span>;
  const pace = calcPace(spendUsd, budgetUsd);
  if (!pace) return <span className="text-sm text-muted-foreground">—</span>;
  const cfg = {
    'on-track':  { label: 'On Track',  cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
    'at-risk':   { label: 'At Risk',   cls: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300' },
    'over-pace': { label: 'Over Pace', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
  }[pace.status];
  return (
    <div className="flex flex-col items-end gap-0.5">
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
import { LoadingCell } from '@/components/loading-cell';
import { BudgetInput } from '@/components/budget-input';
import { TeamBudgetInput } from '@/components/team-budget-input';
import { useLocation } from 'wouter';
import { useRange } from '@/components/range-context';
import { RangeFilter } from '@/components/range-filter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TrendsTab from './trends-tab';
import { buildGroupClusters, roleBadgeClass, sumAttributedRollup, type GroupCluster } from '@/lib/group-clusters';

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
  const canWrite = useCanWrite();
  const { rangeType, startDate, endDate } = useRange();
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set());
  const [byGroupSearch, setByGroupSearch] = useState('');
  type ByGroupSortCol = 'name' | 'team' | 'workspace' | 'members' | 'spend';
  const [byGroupSort, setByGroupSort] = useState<{ col: ByGroupSortCol; dir: 'asc' | 'desc' }>({ col: 'spend', dir: 'desc' });

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

  const { data: teamBudgetsData, isLoading: teamBudgetsLoading } = useGetTeamsBudgets({
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

  const groups = useMemo(
    () =>
      (groupsData?.groups ?? []).map((group) => {
        // Prefer group.spendUsd (deduped across overlapping groups) once available.
        // Fall back to group.rollupSpendUsd while spendUsd is still null (i.e. not
        // all groups have finished loading), so rows populate immediately with no
        // blank or $0.00 flash during the loading window.
        const spendUsd = group.spendUsd ?? group.rollupSpendUsd ?? 0;
        const spendLoaded = group.spendLoaded ?? group.rollupSpendLoaded ?? false;
        const hasBudget = group.budgetUsd != null && group.budgetUsd > 0;
        return {
          ...group,
          spendUsd,
          spendLoaded,
          rollupSpendUsd: spendUsd,
          rollupSpendLoaded: spendLoaded,
          remainingUsd: spendLoaded && hasBudget ? group.budgetUsd! - spendUsd : null,
          percentUsed: spendLoaded && hasBudget ? (spendUsd / group.budgetUsd!) * 100 : null,
        };
      }),
    [groupsData?.groups],
  );
  const isComplete = groupsData?.isComplete ?? false;
  const pendingCount = groupsData?.pendingCount ?? 0;
  const projectSpendLoaded = groupsData?.projectSpendLoaded ?? false;
  const unattributedProjectSpendUsd = groupsData?.unattributedProjectSpendUsd ?? 0;

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
      const { memberCount, spendUsd: rollupSpend, spendLoaded: rollupLoaded } = sumAttributedRollup(teamGroups);
      // Use the member-deduped rollup sum from the updated group rows, which now
      // carry spendUsd = member-deduped spend. This keeps team totals consistent
      // with individual group rows and the group detail page.
      const spendUsd = rollupSpend;
      const spendLoaded = rollupLoaded;
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

  // Financial summary cards and the table footer must reconcile to the same
  // visible top-level rows: each team pool once, plus each unassigned group.
  // Nested group budgets are not added on top of their team's pool.
  const tableTotals = useMemo(() => {
    let totalSpendUsd = 0;
    let totalBudgetUsd = 0;
    let budgetedSpendUsd = 0;
    let budgetedPools = 0;
    let poolsOver75 = 0;
    let poolsOver100 = 0;

    const addRow = (spendUsd: number, budgetUsd: number | null, spendLoaded: boolean) => {
      totalSpendUsd += spendUsd;
      if (budgetUsd === null || budgetUsd <= 0) return;
      totalBudgetUsd += budgetUsd;
      budgetedPools += 1;
      if (!spendLoaded) return;
      budgetedSpendUsd += spendUsd;
      const percentUsed = (spendUsd / budgetUsd) * 100;
      if (percentUsed >= 75) poolsOver75 += 1;
      if (percentUsed >= 100) poolsOver100 += 1;
    };

    for (const team of teamSections) {
      addRow(team.spendUsd, team.budgetUsd, team.spendLoaded);
    }
    for (const group of unassigned) {
      addRow(group.spendUsd ?? 0, group.budgetUsd ?? null, group.spendLoaded);
    }
    if (projectSpendLoaded) {
      addRow(unattributedProjectSpendUsd, null, true);
    }

    return {
      totalSpendUsd,
      totalBudgetUsd,
      budgetedSpendUsd,
      totalRemainingUsd: totalBudgetUsd - budgetedSpendUsd,
      budgetedPools,
      poolsOver75,
      poolsOver100,
    };
  }, [projectSpendLoaded, teamSections, unattributedProjectSpendUsd, unassigned]);

  const byGroupRows = useMemo(() => {
    const q = byGroupSearch.trim().toLowerCase();
    const filtered = groups.filter((g) =>
      !q ||
      g.name.toLowerCase().includes(q) ||
      (g.teamName ?? '').toLowerCase().includes(q) ||
      (g.workspaceName ?? '').toLowerCase().includes(q),
    );
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (byGroupSort.col === 'spend') cmp = (a.spendUsd ?? 0) - (b.spendUsd ?? 0);
      else if (byGroupSort.col === 'name') cmp = a.name.localeCompare(b.name);
      else if (byGroupSort.col === 'team') cmp = (a.teamName ?? '').localeCompare(b.teamName ?? '');
      else if (byGroupSort.col === 'workspace') cmp = (a.workspaceName ?? '').localeCompare(b.workspaceName ?? '');
      else if (byGroupSort.col === 'members') cmp = (a.memberCount ?? 0) - (b.memberCount ?? 0);
      return byGroupSort.dir === 'asc' ? cmp : -cmp;
    });
  }, [groups, byGroupSearch, byGroupSort]);

  const handleByGroupSort = (col: ByGroupSortCol) => {
    setByGroupSort((prev) =>
      prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'spend' || col === 'members' ? 'desc' : 'asc' },
    );
  };

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
      value: `$${(summary?.totalSpendUsd ?? tableTotals.totalSpendUsd).toFixed(2)}`,
      description: summary?.billingPeriodLabel || 'Loading...',
      icon: DollarSign,
      loading: summaryLoading,
    },
    {
      title: 'Total Budget',
      value: `$${tableTotals.totalBudgetUsd.toFixed(2)}`,
      description: `${tableTotals.budgetedPools} visible pools budgeted`,
      icon: TrendingUp,
      loading: groupsLoading || teamBudgetsLoading,
    },
    {
      title: 'Remaining',
      value: `$${(summary?.totalRemainingUsd ?? tableTotals.totalRemainingUsd).toFixed(2)}`,
      description: 'Across visible budgeted pools',
      icon: Wallet,
      loading: summaryLoading,
      valueClassName: (summary?.totalRemainingUsd ?? tableTotals.totalRemainingUsd) < 0 ? 'text-destructive' : '',
    },
    {
      title: 'Over Threshold',
      value: (summary?.groupsOver75 ?? tableTotals.poolsOver75).toString(),
      description: `${summary?.groupsOver100 ?? tableTotals.poolsOver100} over budget`,
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
      <td className="py-3 px-4 text-right">
        <PaceCell
          spendUsd={group.spendUsd ?? 0}
          budgetUsd={group.budgetUsd ?? null}
          spendLoaded={group.spendLoaded}
        />
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
          {canWrite ? (
            <TeamBudgetInput teamName={team.teamName} currentBudget={team.budgetUsd} />
          ) : (
            <span className="text-sm font-mono tabular-nums font-semibold" data-testid={`text-team-budget-${team.teamName}`}>
              {team.budgetUsd !== null && team.budgetUsd !== undefined ? `$${team.budgetUsd.toFixed(2)}` : '—'}
            </span>
          )}
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
        <td className="py-3 px-4 text-right">
          <PaceCell
            spendUsd={team.spendUsd}
            budgetUsd={team.budgetUsd}
            spendLoaded={team.spendLoaded}
            semibold
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
        onClick={() => toggleTeam('__unassigned__')}
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

  const hasTeams = teamSections.length > 0;

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">
            Dashboard
          </h1>
          <p className="text-muted-foreground mt-1" data-testid="text-billing-period">
            {groupsData?.billingPeriodLabel || 'Loading...'}
          </p>
          <p className="text-[10px] md:text-xs text-muted-foreground mt-1" data-testid="text-reconciliation-scope">
            All workspaces you can access · Custom dates use inclusive UTC days
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="/api/export/users.csv"
            download
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Export Users</span>
            <span className="sm:hidden">Export</span>
          </a>
          <RangeFilter />
          {!isComplete && (
            <Badge
              variant="outline"
              className="flex items-center gap-2"
              data-testid="badge-loading-status"
              title={
                projectSpendLoaded
                  ? "Stored usage is available as each group finishes its one-time member-level history sync."
                  : "Existing member totals remain visible while project-level spend is synchronized."
              }
            >
              <RefreshCw className="h-3 w-3 animate-spin" />
              <span className="hidden sm:inline">
                {projectSpendLoaded ? "Syncing history" : "Syncing project spend"} · {pendingCount} remaining
              </span>
              <span className="sm:hidden">Syncing...</span>
            </Badge>
          )}
        </div>
      </div>

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
                {stat.loading ? (
                  <div className="h-8 w-24 bg-muted animate-pulse-glow rounded" />
                ) : (
                  <div className={`text-xl sm:text-2xl font-bold font-mono tabular-nums ${stat.valueClassName || ''}`} data-testid={`text-stat-${stat.title.toLowerCase().replace(/\s+/g, '-')}`}>
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

      <Tabs defaultValue="groups" className="space-y-4">
        <TabsList aria-label="Dashboard views">
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="by-group">By Group</TabsTrigger>
          <TabsTrigger value="trends">Trends</TabsTrigger>
        </TabsList>
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
                    <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4" title="Projected total spend by May 17 2027 vs budget">
                      Pace <span className="font-normal opacity-60">→ May '27</span>
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
                  {projectSpendLoaded && unattributedProjectSpendUsd > 0 && (
                    <tr
                      className="border-b border-border bg-muted/10"
                      data-testid="row-unattributed-projects"
                    >
                      <td className="py-3 px-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium italic">Unattributed projects</span>
                          <span className="text-xs text-muted-foreground">
                            Project spend with no matching group
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                          ${unattributedProjectSpendUsd.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                      <td className="py-3 px-4 text-right text-sm text-muted-foreground">—</td>
                    </tr>
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
                        {isComplete ? (
                          <span className="text-sm font-mono tabular-nums">
                            {groups.reduce((s, g) => s + g.rollupMemberCount, 0)}
                          </span>
                        ) : (
                          <div className="flex justify-end"><LoadingCell /></div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {isComplete ? (
                          <span className="text-sm font-mono tabular-nums">
                            ${tableTotals.totalSpendUsd.toFixed(2)}
                          </span>
                        ) : (
                          <div className="flex justify-end"><LoadingCell /></div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-mono tabular-nums">
                          ${tableTotals.totalBudgetUsd.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {isComplete ? (
                          <span className={`text-sm font-mono tabular-nums ${tableTotals.totalRemainingUsd < 0 ? 'text-destructive' : ''}`}>
                            ${tableTotals.totalRemainingUsd.toFixed(2)}
                          </span>
                        ) : (
                          <div className="flex justify-end"><LoadingCell /></div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {isComplete && tableTotals.totalBudgetUsd > 0 ? (
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
                        {isComplete && tableTotals.totalBudgetUsd > 0 ? (
                          <PaceCell
                            spendUsd={tableTotals.budgetedSpendUsd}
                            budgetUsd={tableTotals.totalBudgetUsd}
                            spendLoaded={isComplete}
                            semibold
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
          )}
        </CardContent>
      </Card>
        </TabsContent>
        <TabsContent value="by-group">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle>Spend by Group</CardTitle>
                  <CardDescription>Raw API spend per group — same figure shown on each group's detail page</CardDescription>
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Filter groups or teams…"
                    value={byGroupSearch}
                    onChange={(e) => setByGroupSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      {(
                        [
                          { col: 'name' as ByGroupSortCol, label: 'Group', align: 'left' },
                          { col: 'team' as ByGroupSortCol, label: 'Team', align: 'left' },
                          { col: 'workspace' as ByGroupSortCol, label: 'Workspace', align: 'left' },
                          { col: 'members' as ByGroupSortCol, label: 'Members', align: 'right' },
                          { col: 'spend' as ByGroupSortCol, label: 'Spend', align: 'right' },
                        ] as const
                      ).map(({ col, label, align }) => (
                        <th
                          key={col}
                          className={`text-${align} text-xs font-medium text-muted-foreground py-3 px-4 cursor-pointer select-none hover:text-foreground transition-colors`}
                          onClick={() => handleByGroupSort(col)}
                        >
                          <span className="inline-flex items-center gap-1">
                            {label}
                            {byGroupSort.col === col ? (
                              byGroupSort.dir === 'asc' ? (
                                <ChevronUp className="h-3 w-3 opacity-70" />
                              ) : (
                                <ChevronDown className="h-3 w-3 opacity-70" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-30" />
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groupsLoading ? (
                      [1, 2, 3, 4, 5].map((i) => (
                        <tr key={i} className="border-b border-border/50">
                          {[1, 2, 3, 4, 5].map((j) => (
                            <td key={j} className="py-3 px-4">
                              <div className="h-4 bg-muted animate-pulse-glow rounded w-3/4" />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : byGroupRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-muted-foreground text-sm">
                          {byGroupSearch ? 'No groups match your filter.' : 'No groups found.'}
                        </td>
                      </tr>
                    ) : (
                      byGroupRows.map((group, idx) => (
                        <tr
                          key={group.groupId}
                          className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer"
                          onClick={() => setLocation(`/groups/${group.groupId}`)}
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground w-6 text-right tabular-nums">{idx + 1}</span>
                              <span className="text-sm font-medium">{group.name}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-sm text-muted-foreground">{group.teamName ?? <span className="italic opacity-50">—</span>}</span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-sm text-muted-foreground">{group.workspaceName ?? '—'}</span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className="text-sm tabular-nums">{group.memberCount ?? '—'}</span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            {!group.spendLoaded ? (
                              <div className="flex justify-end"><LoadingCell /></div>
                            ) : (
                              <span className="text-sm font-mono font-medium tabular-nums">
                                ${(group.spendUsd ?? 0).toFixed(2)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {!groupsLoading && byGroupRows.length > 0 && (
                    <tfoot>
                      <tr className="bg-muted/30 border-t border-border font-medium">
                        <td className="py-3 px-4 text-sm" colSpan={3}>
                          {byGroupRows.length} group{byGroupRows.length !== 1 ? 's' : ''}
                          {byGroupSearch ? ' (filtered)' : ''}
                        </td>
                        <td className="py-3 px-4 text-right text-sm tabular-nums">
                          {byGroupRows.reduce((s, g) => s + (g.memberCount ?? 0), 0)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-sm tabular-nums">
                          {isComplete
                            ? `$${byGroupRows.reduce((s, g) => s + (g.spendUsd ?? 0), 0).toFixed(2)}`
                            : '—'}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="trends">
          <TrendsTab
            teamNames={teamSections.map((team) => team.teamName)}
            groups={groups.map((group) => ({
              groupId: group.groupId,
              name: group.name,
              teamName: group.teamName ?? null,
            }))}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
