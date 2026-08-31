import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CalendarClock, CheckCircle2, RefreshCw, WalletCards } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type BudgetAdjustment = {
  recordId: string;
  amountUsd: number;
  submissionPeriod: string;
};

type TeamBudgetHistory = {
  teamName: string;
  originalAmountUsd: number;
  effectiveAmountUsd: number;
  adjustments: BudgetAdjustment[];
};

type BudgetHistoryResponse = {
  teams: TeamBudgetHistory[];
  issues: Array<{
    recordId: string;
    sourceTeamName: string | null;
    matchState: 'unmatched' | 'invalid';
    error: string | null;
  }>;
};

type BudgetSyncStatus = {
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string | null;
  recordCount: number;
  acceptedCount: number;
  issueCount: number;
};

const historyQueryKey = ['team-budget-history'] as const;
const syncQueryKey = ['team-budget-sync-status'] as const;

async function requestBudgetApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
    throw new Error(body?.message || body?.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

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

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

function formatAdjustment(amountUsd: number): string {
  return `${amountUsd >= 0 ? '+' : '−'}${currency.format(Math.abs(amountUsd))}`;
}

function formatTeamName(teamName: string): string {
  if (teamName === 'DXP') return 'Growth Strategy & Operations DXP';
  if (teamName === 'Non-DXP') return 'Growth Strategy & Operations Non-DXP';
  return teamName;
}

export default function TeamBudgets() {
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: historyQueryKey,
    queryFn: () => requestBudgetApi<BudgetHistoryResponse>('/admin/team-budgets/history'),
    staleTime: 60_000,
    refetchOnMount: 'always',
  });
  const syncQuery = useQuery({
    queryKey: syncQueryKey,
    queryFn: () => requestBudgetApi<BudgetSyncStatus>('/admin/team-budgets/sync'),
    staleTime: 60_000,
    refetchOnMount: 'always',
  });
  const refresh = useMutation({
    mutationFn: () => requestBudgetApi('/admin/team-budgets/refresh', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: historyQueryKey });
      void queryClient.invalidateQueries({ queryKey: syncQueryKey });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: syncQueryKey });
    },
  });

  const data = historyQuery.data;
  const sync = syncQuery.data;
  const teams = useMemo(
    () => [...(data?.teams ?? [])].sort((a, b) =>
      formatTeamName(a.teamName).localeCompare(formatTeamName(b.teamName), 'en', {
        sensitivity: 'base',
      }),
    ),
    [data?.teams],
  );
  const periods = useMemo(() => {
    const values = new Set<string>();
    for (const team of teams) {
      for (const adjustment of team.adjustments ?? []) values.add(adjustment.submissionPeriod);
    }
    return [...values].sort((a, b) => periodTimestamp(a) - periodTimestamp(b) || a.localeCompare(b));
  }, [teams]);
  const totals = useMemo(() => ({
    originalAmountUsd: teams.reduce((sum, team) => sum + team.originalAmountUsd, 0),
    effectiveAmountUsd: teams.reduce((sum, team) => sum + team.effectiveAmountUsd, 0),
    adjustmentsByPeriod: new Map(
      periods.map((period) => [
        period,
        teams.reduce(
          (sum, team) => sum + (team.adjustments ?? [])
            .filter((adjustment) => adjustment.submissionPeriod === period)
            .reduce((teamSum, adjustment) => teamSum + adjustment.amountUsd, 0),
          0,
        ),
      ]),
    ),
  }), [periods, teams]);
  const syncErrors = (data?.issues ?? []).map((issue) => {
    const team = issue.sourceTeamName ? ` for “${issue.sourceTeamName}”` : '';
    return `Airtable record ${issue.recordId}${team}: ${issue.error ?? issue.matchState}`;
  });
  if (sync?.lastError) syncErrors.unshift(`Latest refresh failed: ${sync.lastError}`);
  const refreshError = refresh.error instanceof Error ? refresh.error.message : null;
  const historyError = historyQuery.error instanceof Error ? historyQuery.error.message : null;
  const statusError = syncQuery.error instanceof Error ? syncQuery.error.message : null;
  const loadError = historyError || statusError;
  const isRefreshing = refresh.isPending;

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[100vw]" data-testid="page-team-budgets">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <WalletCards className="h-6 w-6 text-primary" aria-hidden="true" />
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-team-budgets-title">
              Team Budgets
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Original annual allocations and read-only additional-credit history.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={isRefreshing}
          data-testid="button-refresh-team-budgets"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {isRefreshing ? 'Refreshing…' : 'Refresh from Airtable'}
        </Button>
      </div>

      {(loadError || refreshError) && (
        <Alert variant="destructive" data-testid="alert-team-budget-request-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{loadError ? 'Budgets could not be loaded' : 'Refresh failed'}</AlertTitle>
          <AlertDescription>
            {loadError || refreshError}
            {refreshError && data && ' The last successfully synchronized budgets remain visible below.'}
          </AlertDescription>
        </Alert>
      )}

      {syncErrors.length > 0 && (
        <Alert variant="destructive" data-testid="alert-team-budget-sync-errors">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Some records need review</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {syncErrors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Annual allocation audit</CardTitle>
            <CardDescription className="mt-1">
              Each request is shown separately in its submission period.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="status-team-budget-sync">
            {sync?.lastError || syncErrors.length > 0 ? (
              <Badge variant="destructive">Sync needs attention</Badge>
            ) : isRefreshing ? (
              <Badge variant="outline"><RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />Syncing</Badge>
            ) : data && sync ? (
              <Badge variant="secondary"><CheckCircle2 className="mr-1.5 h-3 w-3" />Last good data</Badge>
            ) : null}
            {sync?.lastSuccessfulAt && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-last-budget-refresh">
                <CalendarClock className="h-3.5 w-3.5" />
                Refreshed {new Date(sync.lastSuccessfulAt).toLocaleString()}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {historyQuery.isLoading ? (
            <div className="space-y-3" data-testid="loading-team-budgets">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : teams.length === 0 && !loadError ? (
            <div className="rounded-lg border border-dashed px-6 py-12 text-center" data-testid="empty-team-budgets">
              <WalletCards className="mx-auto h-8 w-8 text-muted-foreground" />
              <h2 className="mt-3 font-semibold">No visible team budgets</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Refresh to synchronize the latest approved credit requests.
              </p>
            </div>
          ) : teams.length > 0 ? (
            <div className="-mx-2 overflow-x-auto px-2">
              <table className="w-full min-w-max border-separate border-spacing-0" data-testid="table-team-budget-history">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-20 min-w-52 border-b bg-background px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                      Team
                    </th>
                    <th className="min-w-36 border-b px-4 py-3 text-right text-xs font-medium text-muted-foreground">
                      Original budget
                    </th>
                    {periods.map((period) => (
                      <th key={period} className="min-w-44 border-b px-4 py-3 text-right text-xs font-medium text-muted-foreground">
                        {formatPeriod(period)}
                      </th>
                    ))}
                    <th className="sticky right-0 z-20 min-w-36 border-b bg-background px-4 py-3 text-right text-xs font-semibold">
                      Updated total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((team) => (
                    <tr key={team.teamName} data-testid={`row-team-budget-${team.teamName}`}>
                      <th className="sticky left-0 z-10 border-b bg-background px-4 py-4 text-left text-sm font-semibold">
                        {formatTeamName(team.teamName)}
                      </th>
                      <td className="border-b px-4 py-4 text-right font-mono text-sm tabular-nums">
                        {currency.format(team.originalAmountUsd)}
                      </td>
                      {periods.map((period) => {
                        const adjustments = (team.adjustments ?? []).filter(
                          (adjustment) => adjustment.submissionPeriod === period,
                        );
                        return (
                          <td key={period} className="border-b px-4 py-3 text-right align-top">
                            {adjustments.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <ul className="space-y-1.5">
                                {adjustments.map((adjustment) => (
                                  <li
                                    key={adjustment.recordId}
                                    className="font-mono text-sm tabular-nums"
                                    data-testid={`text-budget-adjustment-${adjustment.recordId}`}
                                  >
                                    {formatAdjustment(adjustment.amountUsd)}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        );
                      })}
                      <td className="sticky right-0 z-10 border-b bg-background px-4 py-4 text-right font-mono text-sm font-bold tabular-nums" data-testid={`text-updated-budget-${team.teamName}`}>
                        {currency.format(team.effectiveAmountUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="row-team-budget-total">
                    <th className="sticky left-0 z-10 border-t-2 bg-muted px-4 py-4 text-left text-sm font-bold">
                      Total
                    </th>
                    <td className="border-t-2 bg-muted px-4 py-4 text-right font-mono text-sm font-bold tabular-nums">
                      {currency.format(totals.originalAmountUsd)}
                    </td>
                    {periods.map((period) => (
                      <td
                        key={period}
                        className="border-t-2 bg-muted px-4 py-4 text-right font-mono text-sm font-bold tabular-nums"
                      >
                        {formatAdjustment(totals.adjustmentsByPeriod.get(period) ?? 0)}
                      </td>
                    ))}
                    <td
                      className="sticky right-0 z-10 border-t-2 bg-muted px-4 py-4 text-right font-mono text-sm font-bold tabular-nums"
                      data-testid="text-team-budget-grand-total"
                    >
                      {currency.format(totals.effectiveAmountUsd)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}