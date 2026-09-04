import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetTeamBudgetHistoryQueryKey,
  getGetTeamAllocationAuditQueryKey,
  useGetTeamBudgetHistory,
  useGetTeamAllocationAudit,
  useRefreshTeamBudgets,
  useUpdateTeamAnnualAllocation,
  useUpdateTeamVisibility,
} from '@workspace/api-client-react';
import {
  Database,
  Eye,
  EyeOff,
  WalletCards,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthContext } from '@/components/auth-context';
import { formatTeamName } from '@/lib/team-names';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

function periodTimestamp(period: string): number {
  const normalized = period.trim();
  const monthYear = normalized.match(/^(\d{1,2})[/-](\d{4})$/);
  if (monthYear) return Date.UTC(Number(monthYear[2]), Number(monthYear[1]) - 1, 1);
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function formatPeriod(period: string): string {
  const timestamp = periodTimestamp(period);
  if (timestamp === Number.MAX_SAFE_INTEGER) return period;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(timestamp);
}

function formatAdjustment(amountUsd: number): string {
  return `${amountUsd >= 0 ? '+' : '−'}${currency.format(Math.abs(amountUsd))}`;
}

export default function TeamBudgets() {
  const queryClient = useQueryClient();
  const { capabilities } = useAuthContext();
  const canEditAllocations = capabilities.canEditAllocations;
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, string>>({});
  const [optimisticAllocations, setOptimisticAllocations] = useState<Record<string, number>>({});
  const [optimisticVisibility, setOptimisticVisibility] = useState<Record<string, boolean>>({});

  const historyQuery = useGetTeamBudgetHistory({
    query: { queryKey: getGetTeamBudgetHistoryQueryKey(), staleTime: 60_000, refetchOnMount: 'always' },
  });
  const auditQuery = useGetTeamAllocationAudit({
    query: {
      queryKey: getGetTeamAllocationAuditQueryKey(),
      staleTime: 30_000,
      refetchOnMount: 'always',
      enabled: canEditAllocations,
    },
  });
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetHistoryQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamAllocationAuditQueryKey() });
  };

  const refresh = useRefreshTeamBudgets({ mutation: { onSuccess: invalidateAll } });
  const updateAllocation = useUpdateTeamAnnualAllocation();
  const updateVisibility = useUpdateTeamVisibility();

  const history = historyQuery.data;

  const teams = useMemo(
    () => [...(history?.teams ?? [])].sort((a, b) =>
      formatTeamName(a.teamName).localeCompare(formatTeamName(b.teamName), 'en', { sensitivity: 'base' })),
    [history?.teams],
  );
  const displayAllocation = (team: (typeof teams)[number]) =>
    optimisticAllocations[team.teamName] ?? team.originalAmountUsd;
  const displayHidden = (team: (typeof teams)[number]) =>
    optimisticVisibility[team.teamName] ?? team.isHidden;
  const acceptedAdjustmentTotal = (team: (typeof teams)[number]) =>
    team.adjustments.reduce((sum, adjustment) => sum + adjustment.amountUsd, 0);
  const displayAnnualTotal = (team: (typeof teams)[number]) =>
    displayAllocation(team) + acceptedAdjustmentTotal(team);
  const periods = useMemo(() => {
    const result = new Set<string>();
    teams.forEach((team) => team.adjustments.forEach((adjustment) => result.add(adjustment.submissionPeriod)));
    return [...result].sort((a, b) => periodTimestamp(a) - periodTimestamp(b) || a.localeCompare(b));
  }, [teams]);
  const totals = useMemo(() => ({
    original: teams.reduce(
      (sum, team) => sum + (optimisticAllocations[team.teamName] ?? team.originalAmountUsd),
      0,
    ),
    effective: teams.reduce(
      (sum, team) =>
        sum +
        (optimisticAllocations[team.teamName] ?? team.originalAmountUsd) +
        team.adjustments.reduce((adjustmentSum, adjustment) => adjustmentSum + adjustment.amountUsd, 0),
      0,
    ),
  }), [teams, optimisticAllocations]);

  const cancelAllocationEdit = (teamName: string) => {
    setAllocationDrafts((old) => {
      const next = { ...old };
      delete next[teamName];
      return next;
    });
  };
  const saveAllocation = (team: (typeof teams)[number]) => {
    const value = Number(allocationDrafts[team.teamName]);
    if (!Number.isFinite(value) || value < 0) {
      cancelAllocationEdit(team.teamName);
      return;
    }
    const previous = displayAllocation(team);
    setOptimisticAllocations((old) => ({ ...old, [team.teamName]: value }));
    updateAllocation.mutate(
      { teamName: team.teamName, data: { annualAllocationUsd: value } },
      {
        onSuccess: () => {
          cancelAllocationEdit(team.teamName);
          setOptimisticAllocations((old) => {
            const next = { ...old };
            delete next[team.teamName];
            return next;
          });
          invalidateAll();
        },
        onError: () => {
          setOptimisticAllocations((old) => ({ ...old, [team.teamName]: previous }));
          cancelAllocationEdit(team.teamName);
        },
      },
    );
  };
  const toggleVisibility = (team: (typeof teams)[number]) => {
    const previous = displayHidden(team);
    const nextValue = !previous;
    setOptimisticVisibility((old) => ({ ...old, [team.teamName]: nextValue }));
    updateVisibility.mutate(
      { teamName: team.teamName, data: { isHidden: nextValue } },
      {
        onSuccess: () => {
          setOptimisticVisibility((old) => {
            const next = { ...old };
            delete next[team.teamName];
            return next;
          });
          invalidateAll();
        },
        onError: () => {
          setOptimisticVisibility((old) => ({ ...old, [team.teamName]: previous }));
        },
      },
    );
  };

  return (
    <div className="max-w-[100vw] space-y-8 p-4 pb-24 md:p-8" data-testid="page-team-budgets">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <WalletCards className="h-7 w-7 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl" data-testid="text-team-budgets-title">Team allocations</h1>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Annual allocations use an admin-managed baseline plus approved Airtable adjustments.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEditAllocations && (
            <Button
              type="button"
              variant="outline"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              data-testid="button-refresh-allocations"
            >
              <Database className={`mr-2 h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`} />
              {refresh.isPending ? 'Refreshing…' : 'Refresh allocations'}
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="border-b bg-muted/30">
          <CardTitle className="text-lg">Annual allocation history</CardTitle>
          <CardDescription>Admin-managed baseline plus approved Airtable adjustments by submission period. Press Enter to save an allocation or Escape to cancel. Account delegates have read-only access.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {historyQuery.isLoading && !history ? <div className="space-y-4 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-16 w-full" /></div> :
          historyQuery.isError && !history ? (
            <div className="p-12 text-center text-sm text-muted-foreground">Team allocations are unavailable.</div>
          ) : teams.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">No visible team allocations.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm" data-testid="table-team-budget-history">
                <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                  <tr><th className="px-6 py-4 text-left">Team</th><th className="px-6 py-4 text-right">Baseline allocation</th>{periods.map((period) => <th key={period} className="px-6 py-4 text-right">{formatPeriod(period)}</th>)}<th className="px-6 py-4 text-right">Annual allocation</th>{canEditAllocations && <th className="px-6 py-4 text-right">Visibility</th>}</tr>
                </thead>
                <tbody>
                  {teams.map((team) => (
                    <tr key={team.teamName} className={`border-t ${displayHidden(team) ? 'bg-muted/30 text-muted-foreground' : ''}`}>
                      <th className="px-6 py-4 text-left font-medium">{formatTeamName(team.teamName)}{displayHidden(team) && <Badge variant="secondary" className="ml-2">Hidden</Badge>}</th>
                      <td className="px-6 py-4 text-right tabular-nums">
                        {canEditAllocations ? (
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            className="ml-auto w-36 bg-background text-right"
                            value={allocationDrafts[team.teamName] ?? String(displayAllocation(team))}
                            onFocus={() => setAllocationDrafts((old) => ({ ...old, [team.teamName]: String(displayAllocation(team)) }))}
                            onChange={(event) => setAllocationDrafts((old) => ({ ...old, [team.teamName]: event.target.value }))}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                saveAllocation(team);
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelAllocationEdit(team.teamName);
                                event.currentTarget.blur();
                              }
                            }}
                            disabled={updateAllocation.isPending}
                            aria-label={`Annual baseline allocation for ${formatTeamName(team.teamName)}`}
                            data-testid={`input-team-annual-allocation-${team.teamName}`}
                          />
                        ) : currency.format(displayAllocation(team))}
                      </td>
                      {periods.map((period) => {
                        const adjustments = team.adjustments.filter((item) => item.submissionPeriod === period);
                        return <td key={period} className="px-6 py-4 text-right tabular-nums">{adjustments.length ? adjustments.map((item) => <div key={item.recordId}>{formatAdjustment(item.amountUsd)}</div>) : '—'}</td>;
                      })}
                      <td className="px-6 py-4 text-right font-bold tabular-nums">{currency.format(displayAnnualTotal(team))}</td>
                      {canEditAllocations && (
                        <td className="px-6 py-4 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => toggleVisibility(team)}
                            disabled={updateVisibility.isPending}
                            data-testid={`button-toggle-team-visibility-${team.teamName}`}
                          >
                            {displayHidden(team) ? <Eye className="mr-1.5 h-4 w-4" /> : <EyeOff className="mr-1.5 h-4 w-4" />}
                            {displayHidden(team) ? 'Show' : 'Hide'}
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted/40 font-bold">
                  <tr><th className="px-6 py-4 text-left">Total</th><td className="px-6 py-4 text-right">{currency.format(totals.original)}</td><td className="px-6 py-4 text-right" colSpan={periods.length + 1 + (canEditAllocations ? 1 : 0)}>{currency.format(totals.effective)}</td></tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {canEditAllocations && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="border-b bg-muted/30">
            <CardTitle className="text-lg">Administrator change history</CardTitle>
            <CardDescription>Allocation and visibility changes are recorded newest first.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {auditQuery.isLoading && !auditQuery.data ? <div className="p-6"><Skeleton className="h-20 w-full" /></div> :
            auditQuery.isError && !auditQuery.data ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Allocation history is unavailable.</div>
            ) : (auditQuery.data?.changes.length ?? 0) === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No administrator changes recorded yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm" data-testid="table-team-allocation-audit">
                  <thead className="bg-muted/20 text-left text-xs uppercase text-muted-foreground">
                    <tr><th className="px-5 py-3">When</th><th className="px-5 py-3">Team</th><th className="px-5 py-3">Field</th><th className="px-5 py-3">Change</th><th className="px-5 py-3">Actor</th></tr>
                  </thead>
                  <tbody>
                    {auditQuery.data?.changes.map((change) => (
                      <tr key={change.id} className="border-t">
                        <td className="px-5 py-4 whitespace-nowrap">{new Date(change.timestamp).toLocaleString()}</td>
                        <td className="px-5 py-4 font-medium">{formatTeamName(change.teamName)}</td>
                        <td className="px-5 py-4">{change.field === 'annualAllocationUsd' ? 'Baseline allocation' : 'Visibility'}</td>
                        <td className="px-5 py-4 tabular-nums">
                          {change.field === 'annualAllocationUsd'
                            ? `${currency.format(Number(change.oldValue))} → ${currency.format(Number(change.newValue))}`
                            : `${change.oldValue ? 'Hidden' : 'Visible'} → ${change.newValue ? 'Hidden' : 'Visible'}`}
                        </td>
                        <td className="px-5 py-4 font-mono text-xs">{change.actor}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
