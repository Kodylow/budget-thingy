import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetTeamBudgetHistoryQueryKey,
  getGetTeamAllocationAuditQueryKey,
  getGetTeamBudgetSyncStatusQueryKey,
  getGetTeamBudgetTargetsQueryKey,
  getListGroupsQueryKey,
  useApplyTeamBudgetLimits,
  useAssignTeamBudgetTarget,
  useGetTeamBudgetHistory,
  useGetTeamAllocationAudit,
  useGetTeamBudgetSyncStatus,
  useGetTeamBudgetTargets,
  useListGroups,
  useRefreshTeamBudgets,
  useRetryTeamBudgetUpstreamSync,
  useUpdateLegacyWorkspaceLimit,
  useUpdateTeamBudgetLimit,
  useUpdateTeamAnnualAllocation,
  useUpdateTeamVisibility,
  useUpdateTeamBudgetTarget,
  type TeamBudgetApplySelection,
} from '@workspace/api-client-react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  UploadCloud,
  WalletCards,
  XCircle,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

function getErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'error' in error) return String((error as { error: unknown }).error);
  if (typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'synced') {
    return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700"><CheckCircle2 className="mr-1 h-3 w-3" />synced</Badge>;
  }
  if (status === 'failed') {
    return <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700"><XCircle className="mr-1 h-3 w-3" />failed</Badge>;
  }
  return <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700"><AlertCircle className="mr-1 h-3 w-3" />drift</Badge>;
}

type ConfirmationRow = {
  workspace: string;
  group: string;
  amountUsd: number;
};

type Confirmation = {
  title: string;
  selection: TeamBudgetApplySelection;
  rows: ConfirmationRow[];
};

export default function TeamBudgets() {
  const queryClient = useQueryClient();
  const { realRole } = useAuthContext();
  const canManage = realRole === 'account_admin';
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, string>>({});
  const [optimisticAllocations, setOptimisticAllocations] = useState<Record<string, number>>({});
  const [optimisticVisibility, setOptimisticVisibility] = useState<Record<string, boolean>>({});
  const [managementError, setManagementError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [applyOutcomeError, setApplyOutcomeError] = useState<string | null>(null);

  const historyQuery = useGetTeamBudgetHistory({
    query: { queryKey: getGetTeamBudgetHistoryQueryKey(), staleTime: 60_000, refetchOnMount: 'always' },
  });
  const auditQuery = useGetTeamAllocationAudit({
    query: {
      queryKey: getGetTeamAllocationAuditQueryKey(),
      staleTime: 30_000,
      refetchOnMount: 'always',
      enabled: canManage,
    },
  });
  const syncQuery = useGetTeamBudgetSyncStatus({
    query: {
      queryKey: getGetTeamBudgetSyncStatusQueryKey(),
      staleTime: 30_000,
      refetchOnMount: 'always',
      enabled: canManage,
    },
  });
  const configQuery = useGetTeamBudgetTargets({
    query: {
      queryKey: getGetTeamBudgetTargetsQueryKey(),
      staleTime: 30_000,
      refetchOnMount: 'always',
      enabled: canManage,
    },
  });
  const groupsQuery = useListGroups(undefined, {
    query: {
      queryKey: getListGroupsQueryKey(),
      staleTime: 60_000,
      enabled: canManage,
    },
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetHistoryQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamAllocationAuditQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetSyncStatusQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamBudgetTargetsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
  };

  const refresh = useRefreshTeamBudgets({ mutation: { onSuccess: invalidateAll } });
  const refreshStatus = useRetryTeamBudgetUpstreamSync({
    mutation: {
      onSuccess: invalidateAll,
    },
  });
  const updateTeam = useUpdateTeamBudgetLimit({
    mutation: { onSuccess: () => { setDrafts({}); invalidateAll(); } },
  });
  const updateAllocation = useUpdateTeamAnnualAllocation();
  const updateVisibility = useUpdateTeamVisibility();
  const updateTarget = useUpdateTeamBudgetTarget({
    mutation: { onSuccess: () => { setDrafts({}); invalidateAll(); } },
  });
  const updateLegacy = useUpdateLegacyWorkspaceLimit({
    mutation: { onSuccess: () => { setDrafts({}); invalidateAll(); } },
  });
  const assignTarget = useAssignTeamBudgetTarget({
    mutation: { onSuccess: () => { setAssignments({}); invalidateAll(); } },
  });
  const applyLimits = useApplyTeamBudgetLimits({
    mutation: {
      onSuccess: (response) => {
        const failures = response.teams.flatMap((team) =>
          team.targets
            .filter((target) => target.outcome === 'failed')
            .map((target) => `${target.targetGroupName}: ${target.error ?? 'Upstream write failed'}`),
        );
        setApplyOutcomeError(failures.length ? failures.join(' · ') : null);
        setConfirmation(null);
        invalidateAll();
      },
    },
  });

  const history = historyQuery.data;
  const sync = syncQuery.data;
  const config = configQuery.data;
  const directoryGroups = groupsQuery.data?.groups ?? [];

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
  const displayMonthlyLimit = (team: (typeof teams)[number]) =>
    team.monthlyLimitSource === 'manual'
      ? team.monthlyLimitUsd
      : Math.round(displayAnnualTotal(team) / 12 * 100) / 100;
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

  const groupDetails = useMemo(() => new Map(directoryGroups.map((group) => [
    `${group.workspaceId}:${group.groupId}`,
    group,
  ])), [directoryGroups]);
  const syncByTarget = useMemo(() => new Map((sync?.teams ?? []).map((target) => [
    `${target.workspaceId ?? ''}:${target.targetGroupId ?? ''}`,
    target,
  ])), [sync?.teams]);
  const legacyCopiesByTeam = useMemo(() => {
    const result = new Map<string, typeof directoryGroups>();
    directoryGroups.filter((group) => group.isLegacyDisplayOnly && group.teamName).forEach((group) => {
      const existing = result.get(group.teamName!) ?? [];
      existing.push(group);
      result.set(group.teamName!, existing);
    });
    return result;
  }, [directoryGroups]);

  const workspaceLabel = (workspaceId: string) => {
    const group = directoryGroups.find((item) => item.workspaceId === workspaceId && item.workspaceName);
    return group?.workspaceName ?? workspaceId;
  };
  const rowsFor = (predicate: (item: NonNullable<typeof sync>['teams'][number]) => boolean) =>
    (sync?.teams ?? []).filter(predicate).map((item) => ({
      workspace: item.workspaceId ? workspaceLabel(item.workspaceId) : 'Unknown workspace',
      group: item.targetGroupName ?? (item.targetType === 'workspace_default' ? 'Legacy workspace per-user cap' : 'Unknown member group'),
      amountUsd: item.desiredAmountUsd,
    }));

  const requestConfirmation = (title: string, selection: TeamBudgetApplySelection, rows: ConfirmationRow[]) => {
    if (rows.length > 0) setConfirmation({ title, selection, rows });
  };
  const saveNumber = (key: string, action: (value: number) => void) => {
    const value = Number(drafts[key]);
    if (Number.isFinite(value) && value >= 0) action(value);
  };
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
      setManagementError('Annual allocation must be a non-negative number.');
      cancelAllocationEdit(team.teamName);
      return;
    }
    const previous = displayAllocation(team);
    setManagementError(null);
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
        onError: (error) => {
          setOptimisticAllocations((old) => ({ ...old, [team.teamName]: previous }));
          cancelAllocationEdit(team.teamName);
          setManagementError(getErrorMessage(error) ?? 'Annual allocation could not be saved.');
        },
      },
    );
  };
  const toggleVisibility = (team: (typeof teams)[number]) => {
    const previous = displayHidden(team);
    const nextValue = !previous;
    setManagementError(null);
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
        onError: (error) => {
          setOptimisticVisibility((old) => ({ ...old, [team.teamName]: previous }));
          setManagementError(getErrorMessage(error) ?? 'Team visibility could not be saved.');
        },
      },
    );
  };

  const requestErrors = [
    getErrorMessage(historyQuery.error),
    canManage ? getErrorMessage(auditQuery.error) : null,
    canManage ? getErrorMessage(syncQuery.error) : null,
    canManage ? getErrorMessage(configQuery.error) : null,
    canManage ? getErrorMessage(groupsQuery.error) : null,
    getErrorMessage(refresh.error),
    getErrorMessage(refreshStatus.error),
    getErrorMessage(updateTeam.error),
    getErrorMessage(updateAllocation.error),
    getErrorMessage(updateVisibility.error),
    getErrorMessage(updateTarget.error),
    getErrorMessage(updateLegacy.error),
    getErrorMessage(assignTarget.error),
    getErrorMessage(applyLimits.error),
    applyOutcomeError,
    managementError,
  ].filter(Boolean);

  const driftRows = rowsFor((item) => item.status === 'drift');
  const knownTeamNames = [...new Set(teams.map((team) => team.teamName))];

  return (
    <div className="max-w-[100vw] space-y-8 p-4 pb-24 md:p-8" data-testid="page-team-budgets">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <WalletCards className="h-7 w-7 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl" data-testid="text-team-budgets-title">Team allocations &amp; limits</h1>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Annual allocations use an admin-managed baseline plus approved Airtable adjustments. Monthly Agent limits reset on the billing cycle day and are hard blocks.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && (
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
          {canManage && (
            <Button
              type="button"
              onClick={() => requestConfirmation('Apply all drift', { all: true }, driftRows)}
              disabled={driftRows.length === 0 || applyLimits.isPending}
              data-testid="button-apply-all-drift"
            >
              <UploadCloud className="mr-2 h-4 w-4" />Apply all drift
            </Button>
          )}
        </div>
      </div>

      {requestErrors.length > 0 && (
        <Alert variant="destructive" data-testid="alert-team-budget-request-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Action needs attention</AlertTitle>
          <AlertDescription>{requestErrors.join(' · ')}</AlertDescription>
        </Alert>
      )}

      {canManage && (
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Monthly Agent limit · resets on billing cycle day · hard block</AlertTitle>
          <AlertDescription>
            Reaching a limit blocks paid services for members of that group. A team’s target total may differ from its monthly limit; the difference is informational and does not prevent applying changes.
          </AlertDescription>
        </Alert>
      )}

      {canManage && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="gap-3 border-b bg-muted/30 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg"><Network className="h-5 w-5" />Legacy workspace per-user cap</CardTitle>
              <CardDescription>Defaults to $1.00 per user. This workspace-wide limit uses the same drift and apply workflow.</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshStatus.mutate()}
              disabled={refreshStatus.isPending}
              data-testid="button-refresh-upstream-status"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshStatus.isPending ? 'animate-spin' : ''}`} />
              Refresh upstream status
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {configQuery.isLoading ? <div className="p-6"><Skeleton className="h-12 w-full" /></div> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-muted/20 text-left text-xs uppercase text-muted-foreground">
                    <tr><th className="px-5 py-3">Workspace</th><th className="px-5 py-3">Desired per-user limit</th><th className="px-5 py-3">Upstream</th><th className="px-5 py-3">Status</th><th className="px-5 py-3 text-right">Actions</th></tr>
                  </thead>
                  <tbody>
                    {(config?.legacy ?? []).map((legacy) => {
                      const key = `legacy:${legacy.workspaceId}`;
                      const status = syncByTarget.get(`${legacy.workspaceId}:`);
                      return (
                        <tr key={legacy.workspaceId} className="border-t">
                          <td className="px-5 py-4 font-medium">{legacy.displayName}<div className="font-mono text-xs text-muted-foreground">{legacy.workspaceId}</div></td>
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-2">
                              <Input type="number" min="0" step="0.01" className="w-28" value={drafts[key] ?? String(legacy.monthlyLimitUsd)} onChange={(event) => setDrafts((old) => ({ ...old, [key]: event.target.value }))} data-testid={`input-legacy-limit-${legacy.workspaceId}`} />
                              <Button size="icon" variant="ghost" title="Save" onClick={() => saveNumber(key, (value) => updateLegacy.mutate({ data: { monthlyLimitUsd: value } }))} data-testid={`button-save-legacy-limit-${legacy.workspaceId}`}><Save className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" title="Reset to $1.00" onClick={() => updateLegacy.mutate({ data: { monthlyLimitUsd: null } })} data-testid={`button-reset-legacy-limit-${legacy.workspaceId}`}><RotateCcw className="h-4 w-4" /></Button>
                            </div>
                          </td>
                          <td className="px-5 py-4 tabular-nums">{status?.upstreamAmountUsd == null ? '—' : currency.format(status.upstreamAmountUsd)}</td>
                          <td className="px-5 py-4">{status ? <StatusBadge status={status.status} /> : <span className="text-muted-foreground">—</span>}</td>
                          <td className="px-5 py-4 text-right">
                            <Button size="sm" variant="outline" disabled={!status || status.status === 'synced'} onClick={() => requestConfirmation('Apply legacy per-user cap', { targets: [{ workspaceId: legacy.workspaceId, groupId: null }] }, rowsFor((item) => item.workspaceId === legacy.workspaceId && item.targetType === 'workspace_default'))} data-testid={`button-apply-legacy-limit-${legacy.workspaceId}`}>Apply</Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (configQuery.isLoading ? (
        <Card><CardContent className="space-y-3 p-6"><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></CardContent></Card>
      ) : teams.map((team) => {
        const teamConfig = config?.teams.find((item) => item.teamName === team.teamName);
        const targets = (config?.targets ?? []).filter((target) => target.teamName === team.teamName);
        const teamKey = `team:${team.teamName}`;
        const teamRows = rowsFor((item) => item.teamName === team.teamName && item.status !== 'synced');
        const legacyCopies = legacyCopiesByTeam.get(team.teamName) ?? [];
        return (
          <Card key={team.teamName} className={`overflow-hidden shadow-sm ${displayHidden(team) ? 'opacity-70' : ''}`} data-testid={`card-team-limits-${team.teamName}`}>
            <CardHeader className="border-b bg-muted/30">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle>{formatTeamName(team.teamName)}</CardTitle>
                  <CardDescription className="mt-1">
                    Annual allocation {currency.format(displayAnnualTotal(team))}
                    {displayHidden(team) && <Badge variant="secondary" className="ml-2">Hidden</Badge>}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Monthly Agent limit
                    <Input type="number" min="0" step="0.01" className="mt-1 w-36 bg-background" value={drafts[teamKey] ?? String(displayMonthlyLimit(team))} onChange={(event) => setDrafts((old) => ({ ...old, [teamKey]: event.target.value }))} data-testid={`input-team-monthly-limit-${team.teamName}`} />
                  </label>
                  <Button size="sm" variant="outline" onClick={() => saveNumber(teamKey, (value) => updateTeam.mutate({ teamName: team.teamName, data: { monthlyLimitUsd: value } }))} data-testid={`button-save-team-limit-${team.teamName}`}><Save className="mr-1.5 h-4 w-4" />Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => updateTeam.mutate({ teamName: team.teamName, data: { monthlyLimitUsd: null } })} data-testid={`button-reset-team-limit-${team.teamName}`}><RotateCcw className="mr-1.5 h-4 w-4" />Reset to ÷12</Button>
                  <Button size="sm" disabled={teamRows.length === 0} onClick={() => requestConfirmation(`Apply ${formatTeamName(team.teamName)}`, { teamNames: [team.teamName] }, teamRows)} data-testid={`button-apply-team-limit-${team.teamName}`}>Apply team drift</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1040px] text-sm">
                  <thead className="bg-muted/20 text-left text-xs uppercase text-muted-foreground">
                    <tr><th className="px-5 py-3">Workspace</th><th className="px-5 py-3">Member group</th><th className="px-5 py-3 text-right">Members</th><th className="px-5 py-3">Desired limit</th><th className="px-5 py-3 text-right">Upstream limit</th><th className="px-5 py-3">Status</th><th className="px-5 py-3 text-right">Action</th></tr>
                  </thead>
                  <tbody>
                    {targets.map((target) => {
                      const key = `target:${target.workspaceId}:${target.groupId}`;
                      const detail = groupDetails.get(`${target.workspaceId}:${target.groupId}`);
                      const status = syncByTarget.get(`${target.workspaceId}:${target.groupId}`);
                      return (
                        <tr key={`${target.workspaceId}:${target.groupId}`} className="border-t">
                          <td className="px-5 py-4">{detail?.workspaceName ?? target.workspaceId}</td>
                          <td className="px-5 py-4 font-medium">{target.groupName}</td>
                          <td className="px-5 py-4 text-right tabular-nums">{detail?.memberCount ?? '—'}</td>
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-1">
                              <Input type="number" min="0" step="0.01" className="w-28" value={drafts[key] ?? String(target.targetAmountUsd)} onChange={(event) => setDrafts((old) => ({ ...old, [key]: event.target.value }))} data-testid={`input-target-limit-${target.workspaceId}-${target.groupId}`} />
                              <Button size="icon" variant="ghost" title="Save" onClick={() => saveNumber(key, (value) => updateTarget.mutate({ workspaceId: target.workspaceId, groupId: target.groupId, data: { monthlyLimitUsd: value } }))} data-testid={`button-save-target-limit-${target.workspaceId}-${target.groupId}`}><Save className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" title="Reset to team monthly limit" onClick={() => updateTarget.mutate({ workspaceId: target.workspaceId, groupId: target.groupId, data: { monthlyLimitUsd: null } })} data-testid={`button-reset-target-limit-${target.workspaceId}-${target.groupId}`}><RotateCcw className="h-4 w-4" /></Button>
                            </div>
                          </td>
                          <td className="px-5 py-4 text-right tabular-nums">{status?.upstreamAmountUsd == null ? '—' : currency.format(status.upstreamAmountUsd)}</td>
                          <td className="px-5 py-4">{status ? <StatusBadge status={status.status} /> : '—'}</td>
                          <td className="px-5 py-4 text-right"><Button size="sm" variant="outline" disabled={!status || status.status === 'synced'} onClick={() => requestConfirmation(`Apply ${target.groupName}`, { targets: [{ workspaceId: target.workspaceId, groupId: target.groupId }] }, rowsFor((item) => item.workspaceId === target.workspaceId && item.targetGroupId === target.groupId))} data-testid={`button-apply-target-${target.workspaceId}-${target.groupId}`}>Apply</Button></td>
                        </tr>
                      );
                    })}
                    {legacyCopies.map((group) => (
                      <tr key={`legacy-copy:${group.workspaceId}:${group.groupId}`} className="border-t bg-muted/40 text-muted-foreground">
                        <td className="px-5 py-4">{group.workspaceName ?? group.workspaceId}</td>
                        <td className="px-5 py-4">{group.name} <Badge variant="secondary" className="ml-2">Legacy copy · not capped</Badge></td>
                        <td className="px-5 py-4 text-right">{group.memberCount ?? '—'}</td>
                        <td className="px-5 py-4" colSpan={4}>Shown for reference only; no member-group limit is applied.</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 bg-muted/30 font-medium">
                    <tr>
                      <td className="px-5 py-4" colSpan={3}>Team target total</td>
                      <td className="px-5 py-4 tabular-nums">{currency.format(teamConfig?.targetAmountSumUsd ?? 0)}</td>
                      <td className="px-5 py-4" colSpan={3}>
                        Difference from monthly limit: <span className="tabular-nums">{formatAdjustment(teamConfig?.differenceUsd ?? -(teamConfig?.monthlyLimitUsd ?? team.monthlyLimitUsd))}</span>
                        <span className="ml-2 text-xs font-normal text-muted-foreground">(informational; does not block apply)</span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      }))}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Unassigned member groups</CardTitle>
            <CardDescription>Choose a team to create an explicit target. Groups listed here come from the current API configuration.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(config?.unassignedGroups ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No unassigned member groups.</p> : (config?.unassignedGroups ?? []).map((group) => {
              const key = `${group.workspaceId}:${group.groupId}`;
              return (
                <div key={key} className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div><div className="font-medium" data-testid={`text-unassigned-group-${group.groupId}`}>{group.groupName}</div><div className="text-xs text-muted-foreground">{workspaceLabel(group.workspaceId)}</div></div>
                  <div className="flex w-full gap-2 sm:w-auto">
                    <Select value={assignments[key]} onValueChange={(value) => setAssignments((old) => ({ ...old, [key]: value }))}>
                      <SelectTrigger className="w-full sm:w-56" data-testid={`select-team-assignment-${group.groupId}`}><SelectValue placeholder="Choose team" /></SelectTrigger>
                      <SelectContent>{knownTeamNames.map((teamName) => <SelectItem key={teamName} value={teamName}>{formatTeamName(teamName)}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button disabled={!assignments[key] || assignTarget.isPending} onClick={() => assignTarget.mutate({ data: { teamName: assignments[key], workspaceId: group.workspaceId, groupId: group.groupId } })} data-testid={`button-assign-group-${group.groupId}`}>Assign</Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="border-b bg-muted/30">
          <CardTitle className="text-lg">Annual allocation history</CardTitle>
          <CardDescription>Admin-managed baseline plus approved Airtable adjustments by submission period. Press Enter to save an allocation or Escape to cancel. Account delegates have read-only access.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {historyQuery.isLoading ? <div className="space-y-4 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-16 w-full" /></div> : teams.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">No visible team allocations.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm" data-testid="table-team-budget-history">
                <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                  <tr><th className="px-6 py-4 text-left">Team</th><th className="px-6 py-4 text-right">Baseline allocation</th>{periods.map((period) => <th key={period} className="px-6 py-4 text-right">{formatPeriod(period)}</th>)}<th className="px-6 py-4 text-right">Annual allocation</th>{canManage && <th className="px-6 py-4 text-right">Visibility</th>}</tr>
                </thead>
                <tbody>
                  {teams.map((team) => (
                    <tr key={team.teamName} className={`border-t ${displayHidden(team) ? 'bg-muted/30 text-muted-foreground' : ''}`}>
                      <th className="px-6 py-4 text-left font-medium">{formatTeamName(team.teamName)}{displayHidden(team) && <Badge variant="secondary" className="ml-2">Hidden</Badge>}</th>
                      <td className="px-6 py-4 text-right tabular-nums">
                        {canManage ? (
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
                      {canManage && (
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
                  <tr><th className="px-6 py-4 text-left">Total</th><td className="px-6 py-4 text-right">{currency.format(totals.original)}</td><td className="px-6 py-4 text-right" colSpan={periods.length + 1 + (canManage ? 1 : 0)}>{currency.format(totals.effective)}</td></tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="border-b bg-muted/30">
            <CardTitle className="text-lg">Administrator change history</CardTitle>
            <CardDescription>Allocation and visibility changes are recorded newest first.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {auditQuery.isLoading ? <div className="p-6"><Skeleton className="h-20 w-full" /></div> : (auditQuery.data?.changes.length ?? 0) === 0 ? (
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

      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !applyLimits.isPending) setConfirmation(null); }}>
        <DialogContent data-testid="dialog-confirm-apply-limits">
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>Review every upstream write before continuing.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {confirmation?.rows.map((row, index) => (
              <div key={`${row.workspace}:${row.group}:${index}`} className="rounded-md border p-3 text-sm">
                <div className="font-medium">{row.workspace}</div>
                <div className="flex justify-between gap-4 text-muted-foreground"><span>{row.group}</span><span className="font-mono text-foreground">{currency.format(row.amountUsd)}</span></div>
              </div>
            ))}
          </div>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Reaching a limit blocks all members of the group from paid services until the next billing cycle.</AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)} disabled={applyLimits.isPending} data-testid="button-cancel-apply-limits">Cancel</Button>
            <Button onClick={() => confirmation && applyLimits.mutate({ data: confirmation.selection })} disabled={!confirmation || applyLimits.isPending} data-testid="button-confirm-apply-limits">
              {applyLimits.isPending ? 'Applying…' : 'Confirm and apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sync?.lastSuccessfulAt && canManage && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-last-budget-refresh">
          <CalendarClock className="h-3.5 w-3.5" />Upstream status refreshed {new Date(sync.lastSuccessfulAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}