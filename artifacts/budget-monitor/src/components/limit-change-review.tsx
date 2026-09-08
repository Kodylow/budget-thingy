import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetLimitChangesQueryKey,
  getGetLimitsQueryKey,
  getGetSetLimitsWorkspaceQueryKey,
  type LimitChangeOperation,
  type LimitTargetIdentity,
  useCommitLimitChanges,
  useGetLimitChanges,
  useRetryLimitChanges,
} from '@workspace/api-client-react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { invalidateBudgetCaches } from '@/lib/budget-cache';

const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

function chunkLimitTargets(targets: LimitTargetIdentity[], size = 1_000): LimitTargetIdentity[][] {
  const chunks: LimitTargetIdentity[][] = [];
  for (let index = 0; index < targets.length; index += size) chunks.push(targets.slice(index, index + size));
  return chunks;
}

export class LimitBatchRetryError extends Error {
  constructor(message: string, public readonly remaining: number) {
    super(message);
    this.name = 'LimitBatchRetryError';
  }
}

export async function retryLimitTargetsInBatches(
  operationId: string,
  targets: LimitTargetIdentity[],
  request: (input: { operationId: string; data: { idempotencyKey: string; targets: LimitTargetIdentity[] } }) => Promise<LimitChangeOperation>,
  onResponse: (operation: LimitChangeOperation) => void,
) {
  const batches = chunkLimitTargets(targets).map(batchTargets => ({
    targets: batchTargets,
    idempotencyKey: crypto.randomUUID(),
  }));
  for (let index = 0; index < batches.length; index += 1) {
    try {
      onResponse(await request({ operationId, data: batches[index] }));
    } catch (cause) {
      const remaining = batches.slice(index).reduce((count, item) => count + item.targets.length, 0);
      throw new LimitBatchRetryError(
        cause instanceof Error ? cause.message : 'The retry request could not be confirmed.',
        remaining,
      );
    }
  }
}

function targetLabel(target: LimitChangeOperation['targets'][number]) {
  if (target.type === 'workspace_default_user_limit') return 'Workspace default';
  if (target.type === 'workspace_group_limit') return `Group ${target.groupId ?? target.targetId}`;
  return target.memberName ?? target.memberEmail ?? `User ${target.userId ?? target.targetId}`;
}

function amountLabel(amount: number | null) {
  return amount == null ? 'Clear configuration' : `${currency.format(amount)} / month`;
}

export function LimitChangeReview({
  operationId,
  preparedOperation,
  readOnly,
  notices = [],
  onOperation,
  onClose,
}: {
  operationId: string | null;
  preparedOperation?: LimitChangeOperation | null;
  readOnly: boolean;
  notices?: string[];
  onOperation: (operation: LimitChangeOperation) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState('');
  const [retryingBatches, setRetryingBatches] = useState(false);
  const [batchRetryError, setBatchRetryError] = useState<{ message: string; remaining: number } | null>(null);
  const retryingBatchesRef = useRef(false);
  const operationQuery = useGetLimitChanges(operationId ?? '', {
    query: {
      enabled: !!operationId,
      queryKey: getGetLimitChangesQueryKey(operationId ?? ''),
      initialData: preparedOperation?.id === operationId ? preparedOperation : undefined,
      refetchInterval: query => {
        const state = query.state.data?.state;
        return state === 'queued' || state === 'running' ? 2_000 : false;
      },
    },
  });
  const commit = useCommitLimitChanges({ mutation: { retry: false } });
  const retry = useRetryLimitChanges({ mutation: { retry: false } });
  const operation = operationQuery.data;
  const localPolicyCount = operation?.localPolicyCount ?? 0;
  const hasReviewedChanges = (operation?.targets.length ?? 0) > 0 || localPolicyCount > 0;

  useEffect(() => {
    if (!operation || operation.state !== 'completed' || (operation.counts.verified === 0 && localPolicyCount === 0)) return;
    void queryClient.invalidateQueries({ queryKey: getGetLimitsQueryKey() });
    const workspaceIds = [...new Set(operation.targets.map(target => target.workspaceId))];
    workspaceIds.forEach(workspaceId => {
      void queryClient.invalidateQueries({ queryKey: getGetSetLimitsWorkspaceQueryKey(workspaceId) });
      invalidateBudgetCaches(queryClient, workspaceId);
    });
  }, [operation?.id, operation?.state, operation?.completedAt, operation?.counts.verified, localPolicyCount, queryClient]);

  const unresolved = useMemo(() => operation?.targets.filter(target =>
    target.state === 'failed' || target.state === 'verification_pending') ?? [], [operation]);
  const requestError = commit.error ?? retry.error;

  if (!operationId) return null;
  const commitOperation = () => {
    if (!operation || readOnly || operation.state !== 'prepared') return;
    commit.mutate({
      operationId: operation.id,
      data: {
        reviewFingerprint: operation.reviewFingerprint,
        confirmation: operation.kind === 'clear_all' ? confirmation : undefined,
        targets: operation.targets.map(target => ({
          workspaceId: target.workspaceId,
          type: target.type,
          targetId: target.targetId,
          amountUsd: target.newAmountUsd,
        })),
      },
    }, {
      onSuccess: next => {
        queryClient.setQueryData(getGetLimitChangesQueryKey(next.id), next);
        onOperation(next);
      },
    });
  };
  const retryUnresolved = async () => {
    if (!operation || readOnly || unresolved.length === 0 || retryingBatchesRef.current) return;
    const targets = unresolved.map(target => ({
          workspaceId: target.workspaceId,
          type: target.type,
          targetId: target.targetId,
        }));
    retryingBatchesRef.current = true;
    setRetryingBatches(true);
    setBatchRetryError(null);
    try {
      await retryLimitTargetsInBatches(operation.id, targets, retry.mutateAsync, next => {
        queryClient.setQueryData(getGetLimitChangesQueryKey(next.id), next);
        onOperation(next);
      });
    } catch (cause) {
      const error = cause instanceof LimitBatchRetryError
        ? cause
        : new LimitBatchRetryError('The retry request could not be confirmed.', targets.length);
      setBatchRetryError({ message: error.message, remaining: error.remaining });
    }
    retryingBatchesRef.current = false;
    setRetryingBatches(false);
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex max-h-[92dvh] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b bg-muted/30 p-5 text-left">
          <DialogTitle>{operation?.kind === 'clear_all' ? 'Review complete limits inventory' : 'Review limit changes'}</DialogTitle>
          <DialogDescription>
            {operation ? `${operation.counts.total} exact target${operation.counts.total === 1 ? '' : 's'}${operation.kind === 'clear_all' ? ` and ${localPolicyCount} automatic baseline polic${localPolicyCount === 1 ? 'y' : 'ies'}` : ''} frozen for review. No write occurs until confirmation.` : 'Loading the durable operation…'}
          </DialogDescription>
        </DialogHeader>
        {operationQuery.isError ? (
          <div className="m-5 rounded-md border border-destructive/30 bg-destructive/5 p-4" role="alert">
            <p className="font-semibold">Operation status unavailable</p>
            <p className="mt-1 text-sm">The outcome is not known. Refresh this operation rather than creating a replacement.</p>
            <Button className="mt-3" variant="outline" onClick={() => void operationQuery.refetch()}>Refresh status</Button>
          </div>
        ) : operation ? (
          <>
            {notices.length > 0 && <div className="mx-5 mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><div className="font-semibold">Skipped or ineligible people were not added</div><ul className="mt-1 list-disc pl-5">{notices.map(notice => <li key={notice}>{notice}</li>)}</ul></div>}
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[720px] text-sm" data-testid="table-limit-review">
                <thead className="sticky top-0 border-b bg-muted/90 text-left text-xs text-muted-foreground">
                  <tr><th className="px-5 py-3">Exact target</th><th className="px-5 py-3">Current</th><th className="px-5 py-3">New</th><th className="px-5 py-3">Outcome</th></tr>
                </thead>
                <tbody className="divide-y">
                  {operation.targets.map(target => (
                    <tr key={`${target.workspaceId}:${target.type}:${target.targetId}`} data-testid="row-limit-review-target">
                      <td className="px-5 py-3">
                        <div className="font-medium">{targetLabel(target)}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{target.workspaceId} · {target.type} · {target.targetId}</div>
                      </td>
                      <td className="px-5 py-3">{target.oldAmountUsd == null ? 'Not configured' : amountLabel(target.oldAmountUsd)}</td>
                      <td className="px-5 py-3 font-medium">{amountLabel(target.newAmountUsd)}</td>
                      <td className="px-5 py-3">
                        {target.state === 'verified' ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-4 w-4" />Verified</span>
                          : target.state === 'verification_pending' ? <span className="text-amber-700">Unknown — verify before retry</span>
                          : target.state === 'failed' ? <span className="text-destructive" title={target.errorMessage ?? undefined}>Failed</span>
                          : target.state === 'applying' ? <span className="inline-flex items-center gap-1"><RefreshCw className="h-4 w-4 animate-spin" />Applying</span>
                          : operation.state === 'prepared' ? 'Not applied' : 'Queued'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {operation.targets.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">{localPolicyCount > 0 ? 'No upstream limits are configured. The reviewed automatic baseline policies will be disabled so they cannot create limits on refresh.' : 'There are no configured limits or automatic baseline policies to clear.'}</p>}
            </div>
            {(requestError || batchRetryError) && (
              <div className="mx-5 mb-3 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <div>
                  <strong>Request outcome not confirmed.</strong> {batchRetryError?.message ?? requestError?.message}
                  {batchRetryError && ` ${batchRetryError.remaining} unresolved target${batchRetryError.remaining === 1 ? '' : 's'} remain unsent or unconfirmed.`} Refresh saved status before retrying.
                  <Button variant="outline" size="sm" className="mt-2 block" disabled={operationQuery.isFetching} onClick={async () => {
                    const result = await operationQuery.refetch();
                    if (result.isSuccess) { commit.reset(); retry.reset(); setBatchRetryError(null); }
                  }} data-testid="button-refresh-limit-operation">Refresh saved status</Button>
                </div>
              </div>
            )}
            <DialogFooter className="border-t bg-muted/20 p-4 sm:items-end sm:justify-between">
              <div className="mr-auto max-w-xl text-xs text-muted-foreground">
                Workspace, group, and user identity plus the observed old value must still match at commit. Clear Limits also disables the reviewed automatic workspace/group baseline policies so they cannot restore cleared caps after refresh. Funding allocations and account spending controls are excluded.
                {operation.kind === 'clear_all' && operation.state === 'prepared' && hasReviewedChanges && (
                  <div className="mt-3">
                    <label htmlFor="confirm-clear-limits" className="mb-1 block font-semibold text-destructive">Type CLEAR LIMITS to confirm</label>
                    <Input id="confirm-clear-limits" value={confirmation} onChange={event => setConfirmation(event.target.value)} className="max-w-xs" data-testid="input-confirm-clear-limits" />
                  </div>
                )}
              </div>
              <Button variant="outline" onClick={onClose}>Close</Button>
              {operation.state === 'prepared' && hasReviewedChanges && !readOnly && (
                <Button
                  variant={operation.kind === 'clear_all' ? 'destructive' : 'default'}
                  disabled={commit.isPending || commit.isError || (operation.kind === 'clear_all' && confirmation !== 'CLEAR LIMITS')}
                  onClick={commitOperation}
                  data-testid="button-commit-limit-changes"
                >
                  {commit.isPending ? 'Submitting…' : operation.kind === 'clear_all' ? 'Clear reviewed limits' : 'Confirm and apply'}
                </Button>
              )}
              {operation.state === 'completed' && unresolved.length > 0 && !readOnly && (
                <Button disabled={retryingBatches || retry.isError} onClick={() => void retryUnresolved()} data-testid="button-retry-limit-targets">{retryingBatches ? 'Retrying batches…' : 'Retry unresolved exact targets'}</Button>
              )}
            </DialogFooter>
          </>
        ) : <div className="p-8 text-center text-sm text-muted-foreground">Loading review…</div>}
      </DialogContent>
    </Dialog>
  );
}