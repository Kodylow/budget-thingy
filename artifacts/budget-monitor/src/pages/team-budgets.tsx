import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetTeamBudgetHistory,
  getGetTeamBudgetHistoryQueryKey,
  useGetTeamBudgetSyncStatus,
  getGetTeamBudgetSyncStatusQueryKey,
  useRefreshTeamBudgets,
  useRetryTeamBudgetUpstreamSync
} from '@workspace/api-client-react';

import {
  AlertCircle, CalendarClock, CheckCircle2, RefreshCw, WalletCards,
  Clock, XCircle, HelpCircle, Network, UploadCloud, Database
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthContext } from '@/components/auth-context';
import { formatTeamName } from '@/lib/team-names';

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

function getErrorMessage(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'error' in err) return String((err as any).error);
  if (typeof err === 'object' && 'message' in err) return String((err as any).message);
  return String(err);
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'synced':
      return (
        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800 font-medium">
          <CheckCircle2 className="mr-1.5 w-3 h-3" /> Synced
        </Badge>
      );
    case 'pending':
      return (
        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800 font-medium">
          <Clock className="mr-1.5 w-3 h-3" /> Pending
        </Badge>
      );
    case 'unresolved':
      return (
        <Badge variant="outline" className="bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700 font-medium">
          <HelpCircle className="mr-1.5 w-3 h-3" /> Unresolved Target
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800 font-medium">
          <XCircle className="mr-1.5 w-3 h-3" /> Failed
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="bg-muted text-muted-foreground font-medium">
          {status}
        </Badge>
      );
  }
}

export default function TeamBudgets() {
  const queryClient = useQueryClient();
  const { realRole } = useAuthContext();
  const canManageUpstreamSync = realRole === 'account_admin';

  const historyQuery = useGetTeamBudgetHistory({
    query: { queryKey: getGetTeamBudgetHistoryQueryKey(), staleTime: 60_000, refetchOnMount: 'always' }
  });

  const syncQuery = useGetTeamBudgetSyncStatus({
    query: {
      queryKey: getGetTeamBudgetSyncStatusQueryKey(),
      staleTime: 60_000,
      refetchOnMount: 'always',
      enabled: canManageUpstreamSync,
    }
  });

  const refresh = useRefreshTeamBudgets({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetHistoryQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetSyncStatusQueryKey() });
      },
      onError: () => {
        void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetSyncStatusQueryKey() });
      }
    }
  });

  const retrySync = useRetryTeamBudgetUpstreamSync({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetHistoryQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetSyncStatusQueryKey() });
      }
    }
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

  const refreshError = getErrorMessage(refresh.error);
  const historyError = getErrorMessage(historyQuery.error);
  const statusError = canManageUpstreamSync ? getErrorMessage(syncQuery.error) : null;
  const retryError = getErrorMessage(retrySync.error);
  const loadError = historyError || statusError;
  const isRefreshing = refresh.isPending;
  const isRetrying = retrySync.isPending;

  const upstreamTeams = useMemo(() => {
    return [...(sync?.teams ?? [])].sort((a, b) =>
      formatTeamName(a.teamName).localeCompare(formatTeamName(b.teamName), 'en', { sensitivity: 'base' })
    );
  }, [sync?.teams]);

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-[100vw] pb-24" data-testid="page-team-budgets">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <WalletCards className="h-7 w-7 text-primary" aria-hidden="true" />
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground" data-testid="text-team-budgets-title">
              Team Budgets
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground leading-relaxed">
            Audit annual allocations from Airtable and monitor their effective enforcement upstream across Replit workspaces.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={isRefreshing}
            data-testid="button-refresh-team-budgets"
            className="bg-card shadow-xs font-medium"
          >
            <Database className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
            {isRefreshing ? 'Syncing Airtable…' : 'Pull from Airtable'}
          </Button>
        </div>
      </div>

      {(loadError || refreshError || retryError) && (
        <Alert variant="destructive" className="border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400" data-testid="alert-team-budget-request-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="font-semibold">{loadError ? 'Budgets could not be loaded' : 'Action failed'}</AlertTitle>
          <AlertDescription className="mt-1">
            {loadError || refreshError || retryError}
            {refreshError && data && ' The last successfully synchronized budgets remain visible below.'}
          </AlertDescription>
        </Alert>
      )}

      {syncErrors.length > 0 && (
        <Alert variant="destructive" className="border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400" data-testid="alert-team-budget-sync-errors">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="font-semibold">Some records need review</AlertTitle>
          <AlertDescription>
            <ul className="mt-2 list-disc space-y-1 pl-5 marker:text-red-500/50">
              {syncErrors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {canManageUpstreamSync && <Card className="shadow-sm border-border overflow-hidden">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between border-b bg-muted/30 pb-5">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Network className="h-5 w-5 text-muted-foreground" />
              Upstream Enforcement
            </CardTitle>
            <CardDescription className="mt-1.5">
              Synchronization status between authorized budget allocations and Replit workspace limits.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => retrySync.mutate()}
              disabled={isRetrying || syncQuery.isLoading}
              className="h-8 shadow-xs"
              data-testid="button-retry-team-budget-sync"
            >
              <UploadCloud className={`mr-2 h-3.5 w-3.5 ${isRetrying ? 'animate-pulse text-primary' : 'text-muted-foreground'}`} />
              {isRetrying ? 'Reconciling…' : 'Reconcile with Replit'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {syncQuery.isLoading ? (
            <div className="p-6 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : upstreamTeams.length > 0 ? (
            <div className="overflow-x-auto">
               <table className="w-full text-sm text-left border-collapse">
                  <thead>
                     <tr>
                        <th className="px-6 py-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider border-b border-border/50">Team</th>
                        <th className="px-6 py-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider border-b border-border/50">Target Workspace Group</th>
                        <th className="px-6 py-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider border-b border-border/50 text-right">Desired Allocation</th>
                        <th className="px-6 py-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider border-b border-border/50 text-right">Enforced Upstream</th>
                        <th className="px-6 py-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider border-b border-border/50">Sync Status</th>
                        <th className="px-6 py-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider border-b border-border/50 text-right">Last Attempt</th>
                     </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40 bg-card">
                     {upstreamTeams.map((team, idx) => (
                        <tr key={`${team.teamName}-${idx}`} className="hover:bg-muted/30 transition-colors group">
                           <td className="px-6 py-4 font-medium text-foreground whitespace-nowrap">
                              {formatTeamName(team.teamName)}
                           </td>
                           <td className="px-6 py-4">
                              {team.targetGroupName ? (
                                 <div className="flex flex-col gap-0.5">
                                   <span className="font-medium text-foreground">{team.targetGroupName}</span>
                                    <span className="text-xs text-muted-foreground font-mono">
                                      {[team.workspaceId, team.targetGroupId].filter(Boolean).join(' · ')}
                                    </span>
                                 </div>
                              ) : (
                                 <span className="text-muted-foreground italic text-xs">Unassigned</span>
                              )}
                           </td>
                           <td className="px-6 py-4 text-right tabular-nums font-mono text-muted-foreground">
                              {currency.format(team.desiredAmountUsd)}
                           </td>
                           <td className="px-6 py-4 text-right tabular-nums font-mono font-medium text-foreground">
                              {team.upstreamAmountUsd != null ? currency.format(team.upstreamAmountUsd) : <span className="text-muted-foreground">—</span>}
                           </td>
                           <td className="px-6 py-4 align-top">
                              <div className="flex flex-col gap-2 items-start max-w-[280px]">
                                 <StatusBadge status={team.status} />
                                 {team.reason && (
                                    <span className="text-xs text-muted-foreground/80 leading-relaxed block break-words" title={team.reason}>
                                      {team.reason}
                                    </span>
                                 )}
                              </div>
                           </td>
                           <td className="px-6 py-4 text-right text-muted-foreground text-xs whitespace-nowrap align-top pt-5">
                              {team.lastAttemptAt ? new Date(team.lastAttemptAt).toLocaleString(undefined, {
                                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                              }) : '—'}
                           </td>
                        </tr>
                     ))}
                  </tbody>
               </table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center p-16 text-center text-muted-foreground bg-card">
              <Network className="w-12 h-12 mb-4 text-muted-foreground/30" />
              <h3 className="font-medium text-foreground">No reconciliation attempts yet</h3>
              <p className="text-sm mt-1 max-w-md">
                Reconcile to resolve each team’s live Member group and compare its enforced Replit budget.
              </p>
            </div>
          )}
        </CardContent>
      </Card>}

      <Card className="shadow-sm border-border overflow-hidden">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between border-b bg-muted/30 pb-5">
          <div>
            <CardTitle className="text-lg">Annual Allocation Audit</CardTitle>
            <CardDescription className="mt-1.5">
              Each credit request is shown separately in its submission period to form the updated budget total.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="status-team-budget-sync">
            {sync?.lastError || syncErrors.length > 0 ? (
              <Badge variant="destructive" className="font-medium">Sync needs attention</Badge>
            ) : isRefreshing ? (
              <Badge variant="outline" className="font-medium bg-background"><RefreshCw className="mr-1.5 h-3 w-3 animate-spin text-primary" />Syncing</Badge>
            ) : data && sync ? (
              <Badge variant="secondary" className="font-medium"><CheckCircle2 className="mr-1.5 h-3 w-3 text-muted-foreground" />Last good data</Badge>
            ) : null}
            {sync?.lastSuccessfulAt && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium ml-2" data-testid="text-last-budget-refresh">
                <CalendarClock className="h-3.5 w-3.5" />
                Refreshed {new Date(sync.lastSuccessfulAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {historyQuery.isLoading ? (
            <div className="p-6 space-y-4" data-testid="loading-team-budgets">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : teams.length === 0 && !loadError ? (
            <div className="flex flex-col items-center justify-center p-16 text-center text-muted-foreground bg-card" data-testid="empty-team-budgets">
              <WalletCards className="mx-auto h-12 w-12 text-muted-foreground/30 mb-4" />
              <h3 className="font-medium text-foreground">No visible team budgets</h3>
              <p className="mt-1 text-sm max-w-md">
                Refresh to synchronize the latest approved credit requests from Airtable.
              </p>
            </div>
          ) : teams.length > 0 ? (
            <div className="overflow-x-auto relative">
              <table className="w-full min-w-max border-separate border-spacing-0" data-testid="table-team-budget-history">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-20 min-w-52 border-b border-border/50 bg-muted/40 px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Team
                    </th>
                    <th className="min-w-36 border-b border-border/50 bg-muted/40 px-6 py-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Original budget
                    </th>
                    {periods.map((period) => (
                      <th key={period} className="min-w-44 border-b border-border/50 bg-muted/40 px-6 py-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        {formatPeriod(period)}
                      </th>
                    ))}
                    <th className="sticky right-0 z-20 min-w-36 border-b border-border/50 bg-muted/40 px-6 py-4 text-right text-xs font-bold text-foreground uppercase tracking-wider shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.05)] dark:shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.3)]">
                      Updated total
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-card">
                  {teams.map((team) => (
                    <tr key={team.teamName} data-testid={`row-team-budget-${team.teamName}`} className="hover:bg-muted/30 transition-colors group">
                      <th className="sticky left-0 z-10 border-b border-border/40 bg-card group-hover:bg-muted/10 px-6 py-4 text-left text-sm font-medium text-foreground whitespace-nowrap transition-colors">
                        {formatTeamName(team.teamName)}
                      </th>
                      <td className="border-b border-border/40 px-6 py-4 text-right font-mono text-sm tabular-nums text-muted-foreground">
                        {currency.format(team.originalAmountUsd)}
                      </td>
                      {periods.map((period) => {
                        const adjustments = (team.adjustments ?? []).filter(
                          (adjustment) => adjustment.submissionPeriod === period,
                        );
                        return (
                          <td key={period} className="border-b border-border/40 px-6 py-4 text-right align-top">
                            {adjustments.length === 0 ? (
                              <span className="text-muted-foreground/40">—</span>
                            ) : (
                              <ul className="space-y-2 flex flex-col items-end">
                                {adjustments.map((adjustment) => (
                                  <li
                                    key={adjustment.recordId}
                                    className="font-mono text-sm tabular-nums text-foreground/90 bg-muted/50 inline-block px-2 py-0.5 rounded"
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
                      <td className="sticky right-0 z-10 border-b border-border/40 bg-card group-hover:bg-muted/10 px-6 py-4 text-right font-mono text-sm font-bold tabular-nums text-foreground shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.05)] dark:shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.3)] transition-colors" data-testid={`text-updated-budget-${team.teamName}`}>
                        {currency.format(team.effectiveAmountUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="row-team-budget-total">
                    <th className="sticky left-0 z-10 border-t-2 border-border/60 bg-muted/60 px-6 py-5 text-left text-sm font-bold text-foreground">
                      Total
                    </th>
                    <td className="border-t-2 border-border/60 bg-muted/60 px-6 py-5 text-right font-mono text-sm font-bold tabular-nums text-foreground">
                      {currency.format(totals.originalAmountUsd)}
                    </td>
                    {periods.map((period) => (
                      <td
                        key={period}
                        className="border-t-2 border-border/60 bg-muted/60 px-6 py-5 text-right font-mono text-sm font-bold tabular-nums text-foreground"
                      >
                        {formatAdjustment(totals.adjustmentsByPeriod.get(period) ?? 0)}
                      </td>
                    ))}
                    <td
                      className="sticky right-0 z-10 border-t-2 border-border/60 bg-muted/60 px-6 py-5 text-right font-mono text-sm font-bold tabular-nums text-foreground shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.05)] dark:shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.3)]"
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
