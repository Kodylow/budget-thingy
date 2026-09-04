import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetTeamAllocationAuditQueryKey,
  getGetTeamBudgetHistoryQueryKey,
  useGetTeamAllocationAudit,
  useGetTeamBudgetHistory,
  useRefreshTeamBudgets,
  useUpdateTeamAnnualAllocation,
  useUpdateTeamVisibility,
  type TeamAllocationAuditResponse,
  type TeamBudgetHistoryTeam,
} from '@workspace/api-client-react';
import { Database, Eye, EyeOff, WalletCards } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthContext } from '@/components/auth-context';

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

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function acceptedAdjustmentTotal(team: TeamBudgetHistoryTeam): number {
  return team.adjustments.reduce((sum, adjustment) => sum + adjustment.amountUsd, 0);
}

type AllocationHistoryProps = {
  teams: TeamBudgetHistoryTeam[];
  periods: string[];
  totals: { original: number; effective: number };
  canEdit: boolean;
  isLoading: boolean;
  isError: boolean;
  allocationDrafts: Record<string, string>;
  allocationPending: boolean;
  visibilityPending: boolean;
  displayAllocation: (team: TeamBudgetHistoryTeam) => number;
  displayHidden: (team: TeamBudgetHistoryTeam) => boolean;
  setDraft: (teamName: string, value: string) => void;
  cancelEdit: (teamName: string) => void;
  saveAllocation: (team: TeamBudgetHistoryTeam) => void;
  toggleVisibility: (team: TeamBudgetHistoryTeam) => void;
};

function AdjustmentCell({ team, period }: { team: TeamBudgetHistoryTeam; period: string }) {
  const adjustments = team.adjustments.filter((item) => item.submissionPeriod === period);
  return (
    <td className="px-6 py-4 text-right tabular-nums">
      {adjustments.length
        ? adjustments.map((item) => <div key={item.recordId}>{formatAdjustment(item.amountUsd)}</div>)
        : '—'}
    </td>
  );
}

function AllocationRow(props: AllocationHistoryProps & { team: TeamBudgetHistoryTeam }) {
  const { team, periods, canEdit, allocationDrafts, allocationPending, visibilityPending } = props;
  const allocation = props.displayAllocation(team);
  const hidden = props.displayHidden(team);
  return (
    <tr className={`border-t ${hidden ? 'bg-muted/30 text-muted-foreground' : ''}`}>
      <th className="px-6 py-4 text-left font-medium">
        {team.teamName}
        {hidden && <Badge variant="secondary" className="ml-2">Hidden</Badge>}
      </th>
      <td className="px-6 py-4 text-right tabular-nums">
        {canEdit ? (
          <Input
            type="number"
            min="0"
            step="0.01"
            className="ml-auto w-36 bg-background text-right"
            value={allocationDrafts[team.teamName] ?? String(allocation)}
            onFocus={() => props.setDraft(team.teamName, String(allocation))}
            onChange={(event) => props.setDraft(team.teamName, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                props.saveAllocation(team);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                props.cancelEdit(team.teamName);
                event.currentTarget.blur();
              }
            }}
            disabled={allocationPending}
            aria-label={`Annual baseline allocation for ${team.teamName}`}
            data-testid={`input-team-annual-allocation-${team.teamName}`}
          />
        ) : currency.format(allocation)}
      </td>
      {periods.map((period) => <AdjustmentCell key={period} team={team} period={period} />)}
      <td className="px-6 py-4 text-right font-bold tabular-nums">
        {currency.format(allocation + acceptedAdjustmentTotal(team))}
      </td>
      {canEdit && (
        <td className="px-6 py-4 text-right">
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.toggleVisibility(team)}
            disabled={visibilityPending}
            data-testid={`button-toggle-team-visibility-${team.teamName}`}
          >
            {hidden ? <Eye className="mr-1.5 h-4 w-4" /> : <EyeOff className="mr-1.5 h-4 w-4" />}
            {hidden ? 'Show' : 'Hide'}
          </Button>
        </td>
      )}
    </tr>
  );
}

function AllocationTable(props: AllocationHistoryProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm" data-testid="table-team-budget-history">
        <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-6 py-4 text-left">Team</th>
            <th className="px-6 py-4 text-right">Baseline allocation</th>
            {props.periods.map((period) => <th key={period} className="px-6 py-4 text-right">{formatPeriod(period)}</th>)}
            <th className="px-6 py-4 text-right">Annual allocation</th>
            {props.canEdit && <th className="px-6 py-4 text-right">Visibility</th>}
          </tr>
        </thead>
        <tbody>
          {props.teams.map((team) => <AllocationRow key={team.teamName} {...props} team={team} />)}
        </tbody>
        <tfoot className="border-t-2 bg-muted/40 font-bold">
          <tr>
            <th className="px-6 py-4 text-left">Total</th>
            <td className="px-6 py-4 text-right">{currency.format(props.totals.original)}</td>
            <td className="px-6 py-4 text-right" colSpan={props.periods.length + 1 + (props.canEdit ? 1 : 0)}>
              {currency.format(props.totals.effective)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AllocationHistoryCard(props: AllocationHistoryProps) {
  let content;
  if (props.isLoading) {
    content = <div className="space-y-4 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-16 w-full" /></div>;
  } else if (props.isError) {
    content = <div className="p-12 text-center text-sm text-muted-foreground">Team allocations are unavailable.</div>;
  } else if (props.teams.length === 0) {
    content = <div className="p-12 text-center text-sm text-muted-foreground">No visible team allocations.</div>;
  } else {
    content = <AllocationTable {...props} />;
  }
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b bg-muted/30">
        <CardTitle className="text-lg">Annual allocation history</CardTitle>
        <CardDescription>Admin-managed baseline plus approved Airtable adjustments by submission period. Press Enter to save an allocation or Escape to cancel. Account delegates have read-only access.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">{content}</CardContent>
    </Card>
  );
}

function AuditHistoryCard({ audit, isLoading, isError }: {
  audit?: TeamAllocationAuditResponse;
  isLoading: boolean;
  isError: boolean;
}) {
  let content;
  if (isLoading && !audit) {
    content = <div className="p-6"><Skeleton className="h-20 w-full" /></div>;
  } else if (isError && !audit) {
    content = <div className="p-8 text-center text-sm text-muted-foreground">Allocation history is unavailable.</div>;
  } else if ((audit?.changes.length ?? 0) === 0) {
    content = <div className="p-8 text-center text-sm text-muted-foreground">No administrator changes recorded yet.</div>;
  } else {
    content = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm" data-testid="table-team-allocation-audit">
          <thead className="bg-muted/20 text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-5 py-3">When</th><th className="px-5 py-3">Team</th><th className="px-5 py-3">Field</th><th className="px-5 py-3">Change</th><th className="px-5 py-3">Actor</th></tr>
          </thead>
          <tbody>
            {audit?.changes.map((change) => (
              <tr key={change.id} className="border-t">
                <td className="px-5 py-4 whitespace-nowrap">{new Date(change.timestamp).toLocaleString()}</td>
                <td className="px-5 py-4 font-medium">{change.teamName}</td>
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
    );
  }
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b bg-muted/30">
        <CardTitle className="text-lg">Administrator change history</CardTitle>
        <CardDescription>Allocation and visibility changes are recorded newest first.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">{content}</CardContent>
    </Card>
  );
}

function useTeamBudgetEditor(teams: TeamBudgetHistoryTeam[]) {
  const queryClient = useQueryClient();
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, string>>({});
  const [optimisticAllocations, setOptimisticAllocations] = useState<Record<string, number>>({});
  const [optimisticVisibility, setOptimisticVisibility] = useState<Record<string, boolean>>({});
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetHistoryQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamAllocationAuditQueryKey() });
  };
  const updateAllocation = useUpdateTeamAnnualAllocation();
  const updateVisibility = useUpdateTeamVisibility();
  const displayAllocation = (team: TeamBudgetHistoryTeam) =>
    optimisticAllocations[team.teamName] ?? team.originalAmountUsd;
  const displayHidden = (team: TeamBudgetHistoryTeam) =>
    optimisticVisibility[team.teamName] ?? team.isHidden;
  const cancelEdit = (teamName: string) => setAllocationDrafts((old) => withoutKey(old, teamName));
  const setDraft = (teamName: string, value: string) =>
    setAllocationDrafts((old) => ({ ...old, [teamName]: value }));
  const saveAllocation = (team: TeamBudgetHistoryTeam) => {
    const value = Number(allocationDrafts[team.teamName]);
    if (!Number.isFinite(value) || value < 0) return cancelEdit(team.teamName);
    const previous = displayAllocation(team);
    setOptimisticAllocations((old) => ({ ...old, [team.teamName]: value }));
    updateAllocation.mutate({ teamName: team.teamName, data: { annualAllocationUsd: value } }, {
      onSuccess: () => {
        cancelEdit(team.teamName);
        setOptimisticAllocations((old) => withoutKey(old, team.teamName));
        invalidateAll();
      },
      onError: () => {
        setOptimisticAllocations((old) => ({ ...old, [team.teamName]: previous }));
        cancelEdit(team.teamName);
      },
    });
  };
  const toggleVisibility = (team: TeamBudgetHistoryTeam) => {
    const previous = displayHidden(team);
    const nextValue = !previous;
    setOptimisticVisibility((old) => ({ ...old, [team.teamName]: nextValue }));
    updateVisibility.mutate({ teamName: team.teamName, data: { isHidden: nextValue } }, {
      onSuccess: () => {
        setOptimisticVisibility((old) => withoutKey(old, team.teamName));
        invalidateAll();
      },
      onError: () => setOptimisticVisibility((old) => ({ ...old, [team.teamName]: previous })),
    });
  };
  const totals = useMemo(() => ({
    original: teams.reduce((sum, team) => sum + displayAllocation(team), 0),
    effective: teams.reduce((sum, team) => sum + displayAllocation(team) + acceptedAdjustmentTotal(team), 0),
  }), [teams, optimisticAllocations]);
  return {
    allocationDrafts, allocationPending: updateAllocation.isPending,
    visibilityPending: updateVisibility.isPending, displayAllocation, displayHidden,
    setDraft, cancelEdit, saveAllocation, toggleVisibility, totals, invalidateAll,
  };
}

export default function TeamBudgets() {
  const { capabilities } = useAuthContext();
  const canEdit = capabilities.canEditAllocations;
  const historyQuery = useGetTeamBudgetHistory({
    query: { queryKey: getGetTeamBudgetHistoryQueryKey(), refetchOnMount: 'always' },
  });
  const auditQuery = useGetTeamAllocationAudit({
    query: { queryKey: getGetTeamAllocationAuditQueryKey(), refetchOnMount: 'always', enabled: canEdit },
  });
  const teams = useMemo(
    () => [...(historyQuery.data?.teams ?? [])].sort((a, b) =>
      a.teamName.localeCompare(b.teamName, 'en', { sensitivity: 'base' })),
    [historyQuery.data?.teams],
  );
  const periods = useMemo(() => {
    const result = new Set<string>();
    teams.forEach((team) => team.adjustments.forEach((item) => result.add(item.submissionPeriod)));
    return [...result].sort((a, b) => periodTimestamp(a) - periodTimestamp(b) || a.localeCompare(b));
  }, [teams]);
  const editor = useTeamBudgetEditor(teams);
  const refresh = useRefreshTeamBudgets({ mutation: { onSuccess: editor.invalidateAll } });
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
        {canEdit && (
          <Button type="button" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending} data-testid="button-refresh-allocations">
            <Database className={`mr-2 h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`} />
            {refresh.isPending ? 'Refreshing…' : 'Refresh allocations'}
          </Button>
        )}
      </div>
      <AllocationHistoryCard
        {...editor}
        teams={teams}
        periods={periods}
        canEdit={canEdit}
        isLoading={historyQuery.isLoading && !historyQuery.data}
        isError={historyQuery.isError && !historyQuery.data}
      />
      {canEdit && <AuditHistoryCard audit={auditQuery.data} isLoading={auditQuery.isLoading} isError={auditQuery.isError} />}
    </div>
  );
}