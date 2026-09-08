import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetTeamBudgetSyncStatusQueryKey,
  getGetTeamBudgetTargetsQueryKey,
  getListVisibleWorkspacesQueryKey,
  useApplyTeamBudgetLimits,
  useAssignTeamBudgetTarget,
  useGetTeamBudgetSyncStatus,
  useGetTeamBudgetTargets,
  useListVisibleWorkspaces,
  useRetryTeamBudgetUpstreamSync,
  useUpdateTeamBudgetLimit,
  useUpdateTeamBudgetTarget,
  type TeamBudgetApplyTargetOutcome,
  type TeamBudgetTarget,
  type TeamBudgetUpstreamSync,
} from '@workspace/api-client-react';
import { AlertTriangle, CheckCircle2, RefreshCw, Search, Users } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { invalidateBudgetCaches } from '@/lib/budget-cache';

const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
const targetKey = (target: Pick<TeamBudgetTarget, 'workspaceId' | 'groupId'>) =>
  `${target.workspaceId}:${target.groupId}`;

export type GroupLimitObservation = {
  kind: 'live' | 'absent' | 'unavailable';
  amountUsd: number | null;
  detail: string | null;
};

export function classifyGroupLimitObservation(
  target: TeamBudgetTarget,
  sync: TeamBudgetUpstreamSync | undefined,
  _sourceAvailable: boolean,
  sourceReason: string | null,
): GroupLimitObservation {
  if (!target.isEnabled || target.validationReason) {
    return { kind: 'unavailable', amountUsd: null, detail: target.validationReason ?? 'This saved mapping is disabled.' };
  }
  if (!sync || sync.status === 'failed') {
    return {
      kind: 'unavailable',
      amountUsd: sync?.upstreamAmountUsd ?? null,
      detail: sync?.reason ?? sourceReason ?? 'The current Replit limit could not be observed.',
    };
  }
  if (sync.upstreamAmountUsd == null) {
    return { kind: 'absent', amountUsd: null, detail: sync.reason };
  }
  return { kind: 'live', amountUsd: sync.upstreamAmountUsd, detail: sync.reason };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be confirmed.';
}

export function GroupLimitsView() {
  const { auth, capabilities, isPreviewing, authorizationKey } = useAuthContext();
  const queryClient = useQueryClient();
  const canWriteBudgets =
    capabilities.canWriteGroupLimits === true &&
    !isPreviewing &&
    auth?.previewReadOnly !== true;
  const targetsQuery = useGetTeamBudgetTargets({
    query: {
      enabled: canWriteBudgets,
      queryKey: getGetTeamBudgetTargetsQueryKey(),
      staleTime: 30_000,
    },
  });
  const syncQuery = useGetTeamBudgetSyncStatus({
    query: {
      enabled: canWriteBudgets,
      queryKey: getGetTeamBudgetSyncStatusQueryKey(),
      staleTime: 30_000,
    },
  });
  const workspacesQuery = useListVisibleWorkspaces({ scope: 'operator' }, {
    query: {
      enabled: canWriteBudgets,
      queryKey: getListVisibleWorkspacesQueryKey({ scope: 'operator' }),
      staleTime: 30_000,
    },
  });
  const [search, setSearch] = useState('');
  const [editingTarget, setEditingTarget] = useState<TeamBudgetTarget | null>(null);
  const [editingTeam, setEditingTeam] = useState<{ teamName: string; monthlyLimitUsd: number } | null>(null);
  const [review, setReview] = useState<{
    target: TeamBudgetTarget;
    oldAmountUsd: number | null;
    newAmountUsd: number;
  } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{
    state: 'confirmed' | 'failed' | 'uncertain';
    detail: string;
  } | null>(null);
  const reconcile = useRetryTeamBudgetUpstreamSync({ mutation: { retry: false } });
  const updateTarget = useUpdateTeamBudgetTarget({ mutation: { retry: false } });
  const updateTeam = useUpdateTeamBudgetLimit({ mutation: { retry: false } });
  const assignTarget = useAssignTeamBudgetTarget({ mutation: { retry: false } });
  const apply = useApplyTeamBudgetLimits({ mutation: { retry: false } });

  const teams = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (targetsQuery.data?.teams ?? [])
      .filter(team => !query || team.teamName.toLowerCase().includes(query))
      .map(team => ({
        ...team,
        targets: (targetsQuery.data?.targets ?? []).filter(target => target.teamName === team.teamName),
      }));
  }, [search, targetsQuery.data]);

  if (!canWriteBudgets) return null;
  if (targetsQuery.isLoading || syncQuery.isLoading) {
    return <div className="space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-48 w-full" /></div>;
  }
  if (targetsQuery.isError || syncQuery.isError || !targetsQuery.data || !syncQuery.data) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-5" role="alert" data-testid="status-group-limits-load-error">
        <p className="font-semibold">Group limits couldn&apos;t be loaded</p>
        <p className="mt-1 text-sm text-muted-foreground">No group limit changes are available until both mappings and live observations load.</p>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => {
          void targetsQuery.refetch();
          void syncQuery.refetch();
        }} data-testid="button-retry-group-limits">Retry</Button>
      </div>
    );
  }

  const findSync = (target: TeamBudgetTarget, rows = syncQuery.data.teams) =>
    rows.find(row =>
      row.workspaceId === target.workspaceId &&
      row.targetGroupId === target.groupId &&
      row.teamName === target.teamName);
  const workspaceLabel = (workspaceId: string) => {
    const name = workspacesQuery.data?.find(workspace => workspace.workspaceId === workspaceId)?.workspaceName;
    return name ? `${name} (${workspaceId})` : workspaceId;
  };

  const refresh = async () => {
    await Promise.all([targetsQuery.refetch(), syncQuery.refetch()]);
  };

  const beginReview = async (target: TeamBudgetTarget) => {
    if (!canWriteBudgets) return;
    setReviewError(null);
    setApplyResult(null);
    try {
      const latestSync = await reconcile.mutateAsync();
      const latestTargets = await targetsQuery.refetch({ throwOnError: true });
      const latestTarget = latestTargets.data?.targets.find(item => targetKey(item) === targetKey(target));
      if (!latestTarget || !latestTarget.isEnabled || latestTarget.validationReason) {
        throw new Error('The selected Members target is no longer valid. Repair its stable-ID assignment before reviewing.');
      }
      const observed = classifyGroupLimitObservation(
        latestTarget,
        findSync(latestTarget, latestSync.teams),
        latestSync.sourceAvailable,
        latestSync.unavailableReason,
      );
      if (observed.kind === 'unavailable') {
        throw new Error(observed.detail ?? 'The current Replit limit is unavailable.');
      }
      setReview({
        target: latestTarget,
        oldAmountUsd: observed.amountUsd,
        newAmountUsd: latestTarget.targetAmountUsd,
      });
    } catch (error) {
      setReviewError(errorMessage(error));
    }
  };

  const applyReviewed = () => {
    if (!canWriteBudgets || !review) return;
    setApplyResult(null);
    apply.mutate({
      data: {
        targets: [{
          teamName: review.target.teamName,
          workspaceId: review.target.workspaceId,
          groupId: review.target.groupId,
          reviewedDesiredAmountUsd: review.newAmountUsd,
          reviewedUpstreamAmountUsd: review.oldAmountUsd,
        }],
      },
    }, {
      onSuccess: result => {
        const team = result.teams.find(item => item.teamName === review.target.teamName);
        const outcome = team?.targets.find(item =>
          item.workspaceId === review.target.workspaceId &&
          item.targetGroupId === review.target.groupId);
        setApplyResult(describeApplyOutcome(outcome));
        if (outcome?.outcome === 'success') {
          invalidateBudgetCaches(queryClient, review.target.workspaceId);
          void refresh();
        }
      },
      onError: error => {
        setApplyResult({ state: 'uncertain', detail: `${errorMessage(error)} Retry this exact reviewed target to confirm its outcome.` });
      },
    });
  };

  return (
    <section key={authorizationKey} className="space-y-5" aria-labelledby="group-limits-heading">
      <div>
        <h2 id="group-limits-heading" className="text-2xl font-semibold">Group limits</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Monthly Replit Agent platform limits for explicitly mapped Members groups. These are not annual funding allocations.
        </p>
      </div>
      <div className="rounded-md border bg-muted/30 p-4 text-sm">
        Only the exact Members target reviewed here is changed. Admins, Viewers, legacy workspace defaults, and unrelated targets are not changed.
        A person who also belongs to Members is still covered by its cap; leaving an Admins group uncapped is not a personal exemption.
        Each target is an independent cap, not part of a transferable team pool.
      </div>
      <p className="text-sm text-muted-foreground">
        Limits reset usage each billing cycle. The saved cap continues into following cycles until it is changed.
      </p>
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search budgeted teams"
          aria-label="Search budgeted teams"
          className="pl-9"
          data-testid="input-search-group-limit-teams"
        />
      </div>
      {reviewError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert" data-testid="status-group-limit-review-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> {reviewError}
        </div>
      )}
      {teams.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-sm text-muted-foreground" data-testid="status-no-group-limit-teams">
          No budgeted teams match this search.
        </p>
      ) : teams.map(team => (
        <Card key={team.teamName} className="rounded-md shadow-none" data-testid={`card-group-limit-team-${team.teamName}`}>
          <CardHeader className="gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">{team.teamName}</CardTitle>
              <CardDescription>
                Team proposal {currency.format(team.monthlyLimitUsd)}/month · target proposals total {currency.format(team.targetAmountSumUsd)}
                {Math.abs(team.differenceUsd) > 0.001 ? ` · split difference ${currency.format(team.differenceUsd)}` : ''}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => {
              updateTeam.reset();
              setEditingTeam(team);
            }} data-testid={`button-edit-team-default-${team.teamName}`}>
              Edit team default
            </Button>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            {team.targets.length === 0 && (
              <MissingAssignment
                teamName={team.teamName}
                title="No explicit Members target is assigned"
                groups={targetsQuery.data.unassignedGroups}
                pending={assignTarget.isPending}
                error={assignTarget.isError ? errorMessage(assignTarget.error) : null}
                onAssign={(workspaceId, groupId) => assignTarget.mutate({
                  data: { teamName: team.teamName, workspaceId, groupId },
                }, { onSuccess: refresh })}
              />
            )}
            {team.targets.some(target => !target.isEnabled || target.validationReason) && (
              <MissingAssignment
                teamName={`${team.teamName}-replacement`}
                title="Assign a replacement for the invalid mapping"
                groups={targetsQuery.data.unassignedGroups}
                pending={assignTarget.isPending}
                error={assignTarget.isError ? errorMessage(assignTarget.error) : null}
                onAssign={(workspaceId, groupId) => assignTarget.mutate({
                  data: { teamName: team.teamName, workspaceId, groupId },
                }, { onSuccess: refresh })}
              />
            )}
            {team.targets.map(target => {
              const observation = classifyGroupLimitObservation(
                target,
                findSync(target),
                syncQuery.data.sourceAvailable,
                syncQuery.data.unavailableReason,
              );
              const changed = observation.kind !== 'unavailable' &&
                (target.targetAmountUsd === 0
                  ? observation.amountUsd !== null
                  : observation.amountUsd == null || Math.abs(observation.amountUsd - target.targetAmountUsd) > 0.001);
              return (
                <div key={targetKey(target)} className="grid gap-3 rounded-md border p-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center" data-testid={`row-group-limit-${target.workspaceId}-${target.groupId}`}>
                  <div className="min-w-0">
                    <p className="font-medium"><Users className="mr-1.5 inline h-4 w-4" />{target.groupName}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      Workspace {workspaceLabel(target.workspaceId)} · Group {target.groupId} · Members target
                    </p>
                    {(!target.isEnabled || target.validationReason) && <p className="mt-2 text-xs text-destructive">Mapping needs repair before this target can be reviewed or applied.</p>}
                  </div>
                  <div className="text-sm md:text-right" data-testid={`status-group-limit-observation-${target.workspaceId}-${target.groupId}`}>
                    <div><ObservationBadge observation={observation} /></div>
                    <p className="mt-1 text-muted-foreground">
                      {observation.amountUsd == null ? 'No observed cap' : `${currency.format(observation.amountUsd)}/month`}
                    </p>
                    {changed ? (
                      <p className="font-medium text-primary">Unapplied proposal: {currency.format(target.targetAmountUsd)}/month</p>
                    ) : observation.kind === 'unavailable' ? (
                      <p className="font-medium">Saved proposal: {currency.format(target.targetAmountUsd)}/month · apply status unknown</p>
                    ) : (
                      <p className="text-muted-foreground">No unapplied change</p>
                    )}
                    {observation.detail && <p className="max-w-sm text-xs text-muted-foreground">{observation.detail}</p>}
                    {target.monthlyLimitUsd != null && <p className="text-xs text-muted-foreground">Target override</p>}
                    {target.targetAmountUsd === 0 && <p className="text-xs text-muted-foreground">Zero proposal means remove this cap, not block all Agent usage.</p>}
                  </div>
                  <div className="flex gap-2 md:justify-end">
                    <Button variant="outline" size="sm" onClick={() => {
                      updateTarget.reset();
                      setEditingTarget(target);
                    }} data-testid={`button-edit-group-limit-${target.workspaceId}-${target.groupId}`}>
                      Edit
                    </Button>
                    <Button size="sm" disabled={!target.isEnabled || !!target.validationReason || reconcile.isPending} onClick={() => void beginReview(target)} data-testid={`button-review-group-limit-${target.workspaceId}-${target.groupId}`}>
                      {reconcile.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Review'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      <AmountDialog
        key={editingTarget ? targetKey(editingTarget) : 'closed-target'}
        open={editingTarget != null}
        title="Edit Members target proposal"
        description={editingTarget ? `${editingTarget.teamName} · Workspace ${editingTarget.workspaceId} · ${editingTarget.groupName}` : ''}
        current={editingTarget?.monthlyLimitUsd ?? editingTarget?.targetAmountUsd ?? 0}
        resetLabel="Use team default"
        pending={updateTarget.isPending}
        onClose={() => setEditingTarget(null)}
        onSave={(amount) => {
          if (!editingTarget || !canWriteBudgets) return;
          updateTarget.mutate({
            workspaceId: editingTarget.workspaceId,
            groupId: editingTarget.groupId,
            data: { monthlyLimitUsd: amount },
          }, {
            onSuccess: async updated => {
              setEditingTarget(null);
              await refresh();
              void beginReview(updated);
            },
          });
        }}
        error={updateTarget.isError ? errorMessage(updateTarget.error) : null}
      />
      <AmountDialog
        key={editingTeam?.teamName ?? 'closed-team'}
        open={editingTeam != null}
        title="Edit team monthly proposal"
        description={editingTeam ? `${editingTeam.teamName} · saved locally until an exact target is reviewed and applied` : ''}
        current={editingTeam?.monthlyLimitUsd ?? 0}
        resetLabel="Reset to annual allocation ÷ 12"
        pending={updateTeam.isPending}
        onClose={() => setEditingTeam(null)}
        onSave={(amount) => {
          if (!editingTeam || !canWriteBudgets) return;
          updateTeam.mutate({
            teamName: editingTeam.teamName,
            data: { monthlyLimitUsd: amount },
          }, {
            onSuccess: async () => {
              setEditingTeam(null);
              await refresh();
            },
          });
        }}
        error={updateTeam.isError ? errorMessage(updateTeam.error) : null}
      />
      <ReviewDialog
        review={review}
        pending={apply.isPending}
        result={applyResult}
        onClose={() => setReview(null)}
        onApply={applyReviewed}
        onRenew={() => review && void beginReview(review.target)}
      />
    </section>
  );
}

function ObservationBadge({ observation }: { observation: GroupLimitObservation }) {
  if (observation.kind === 'live') return <Badge variant="outline" className="border-emerald-300 text-emerald-700">Live</Badge>;
  if (observation.kind === 'absent') return <Badge variant="outline">Absent</Badge>;
  return <Badge variant="outline" className="border-amber-300 text-amber-700" title={observation.detail ?? undefined}>Unavailable</Badge>;
}

export function describeApplyOutcome(outcome: TeamBudgetApplyTargetOutcome | undefined) {
  if (!outcome) {
    return { state: 'uncertain' as const, detail: 'No outcome was returned for this exact target. Retry to confirm it.' };
  }
  if (outcome.outcome === 'success') {
    return { state: 'confirmed' as const, detail: outcome.desiredAmountUsd === 0 ? 'Confirmed: this group has no monthly Agent cap.' : `Confirmed at ${currency.format(outcome.desiredAmountUsd)}/month.` };
  }
  if (outcome.outcome === 'uncertain') {
    return { state: 'uncertain' as const, detail: outcome.error ?? 'Replit did not confirm the final value. Retry this exact reviewed target.' };
  }
  return { state: 'failed' as const, detail: outcome.error ?? 'Replit rejected the change. Retry this exact reviewed target.' };
}

function MissingAssignment({
  teamName, title,
  groups,
  pending,
  error,
  onAssign,
}: {
  teamName: string;
  title: string;
  groups: Array<{ workspaceId: string; groupId: string; groupName: string }>;
  pending: boolean;
  error: string | null;
  onAssign: (workspaceId: string, groupId: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [selection, setSelection] = useState('');
  const selected = groups.find(group => `${group.workspaceId}:${group.groupId}` === selection);
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50/50 p-4 dark:bg-amber-950/20">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">Choose only by stable workspace and group IDs; names are shown for review, not inference.</p>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      {!revealed ? (
        <Button className="mt-3" variant="outline" size="sm" onClick={() => setRevealed(true)} data-testid={`button-reveal-assignment-${teamName}`}>
          Assign Members target
        </Button>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-sm text-destructive">No eligible unassigned Members groups are available. Repair the directory mapping first.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Select value={selection} onValueChange={setSelection}>
            <SelectTrigger className="sm:max-w-md" data-testid={`select-assignment-${teamName}`}><SelectValue placeholder="Select workspace / Members group" /></SelectTrigger>
            <SelectContent>
              {groups.map(group => (
                <SelectItem key={`${group.workspaceId}:${group.groupId}`} value={`${group.workspaceId}:${group.groupId}`}>
                  {group.groupName} · workspace {group.workspaceId} · group {group.groupId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!selected || pending} onClick={() => selected && onAssign(selected.workspaceId, selected.groupId)} data-testid={`button-save-assignment-${teamName}`}>
            Save assignment
          </Button>
        </div>
      )}
    </div>
  );
}

function AmountDialog({
  open, title, description, current, resetLabel, pending, error, onClose, onSave,
}: {
  open: boolean;
  title: string;
  description: string;
  current: number;
  resetLabel: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (amount: number | null) => void;
}) {
  const [value, setValue] = useState(String(current));
  const amount = Number(value);
  const valid = /^\d+(?:\.\d{1,2})?$/.test(value) && Number.isFinite(amount) && amount > 0;
  return (
    <Dialog open={open} onOpenChange={next => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor="group-limit-amount" className="text-sm font-medium">Monthly Agent limit (USD)</label>
          <Input id="group-limit-amount" value={value} onChange={event => setValue(event.target.value)} inputMode="decimal" data-testid="input-group-limit-amount" />
          <p className="text-xs text-muted-foreground">Saving changes the local proposal only. It does not apply a Replit platform limit.</p>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={pending} onClick={() => onSave(null)} data-testid="button-reset-group-limit-proposal">{resetLabel}</Button>
          <Button disabled={!valid || pending} onClick={() => onSave(amount)} data-testid="button-save-group-limit-proposal">Save local proposal</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialog({
  review, pending, result, onClose, onApply, onRenew,
}: {
  review: { target: TeamBudgetTarget; oldAmountUsd: number | null; newAmountUsd: number } | null;
  pending: boolean;
  result: { state: 'confirmed' | 'failed' | 'uncertain'; detail: string } | null;
  onClose: () => void;
  onApply: () => void;
  onRenew: () => void;
}) {
  return (
    <Dialog open={review != null} onOpenChange={next => !next && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review exact group limit</DialogTitle>
          <DialogDescription>This changes one monthly Replit Agent platform limit, not annual funding. Usage resets each billing cycle; the cap persists until changed.</DialogDescription>
        </DialogHeader>
        {review && (
          <div className="space-y-3 rounded-md border p-4 text-sm" data-testid="review-group-limit-target">
            <p className="font-semibold">{review.target.teamName} · {review.target.groupName}</p>
            <p className="font-mono text-xs">Workspace {review.target.workspaceId} · Group {review.target.groupId} · Members</p>
            <div className="grid grid-cols-2 gap-3">
              <div><span className="block text-xs text-muted-foreground">Observed Replit cap</span>{review.oldAmountUsd == null ? 'Absent' : `${currency.format(review.oldAmountUsd)}/month`}</div>
              <div><span className="block text-xs text-muted-foreground">New Replit cap</span><strong>{review.newAmountUsd === 0 ? 'No cap (remove limit)' : `${currency.format(review.newAmountUsd)}/month`}</strong></div>
            </div>
            {review.newAmountUsd === 0 && <p>Applying this $0.00 local proposal removes the Members-group cap; it does not impose a zero-dollar blocking limit.</p>}
          </div>
        )}
        {result && (
          <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${result.state === 'confirmed' ? 'border-emerald-300' : 'border-destructive/30'}`} role="status" data-testid="status-group-limit-apply">
            {result.state === 'confirmed' ? <CheckCircle2 className="h-4 w-4 text-emerald-700" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
            <div><strong className="capitalize">{result.state}</strong><p>{result.detail}</p></div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose} data-testid="button-close-group-limit-review">Close</Button>
          {(result?.state === 'failed' || result?.state === 'uncertain') && (
            <Button variant="outline" disabled={pending} onClick={onRenew} data-testid="button-renew-group-limit-review">Renew review</Button>
          )}
          {result?.state !== 'confirmed' && (
            <Button disabled={pending} onClick={onApply} data-testid="button-apply-group-limit">
              {pending ? 'Applying…' : result ? 'Retry exact target' : 'Apply this exact target'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}