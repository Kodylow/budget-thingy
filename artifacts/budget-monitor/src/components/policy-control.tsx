import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import {
  type MemberLimitPolicyOutcome,
  type MemberLimitPolicyMutationResult,
  useSetGroupMemberLimitPolicy,
  useSetWorkspaceDefaultLimitPolicy
} from '@workspace/api-client-react';
import { UsageLimitDialog } from './usage-limit-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateBudgetCaches } from './member-budget-input';
import { useToast } from '@/hooks/use-toast';

export function PolicyOutcomeSummary({ result, onDismiss }: { result: MemberLimitPolicyMutationResult; onDismiss: () => void }) {
  const overrides = result.outcomes.filter(o => o.status === 'override_preserved');
  const failures = result.outcomes.filter(o => o.status === 'failed');
  const applied = result.outcomes.filter(o => o.status === 'applied');
  const cleared = result.outcomes.filter(o => o.status === 'cleared');
  const unchanged = result.outcomes.filter(o => o.status === 'unchanged');
  
  // Also count unchanged as applied if they were already at target, or just ignore. 
  // Let's just group them.
  const totalSuccess = applied.length + cleared.length + unchanged.length;

  return (
    <div className="mt-4 p-4 border rounded-md bg-muted/30 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">Policy Update Summary</h4>
        <Button variant="ghost" size="sm" onClick={onDismiss} className="h-6 text-xs">Dismiss</Button>
      </div>
      
      {totalSuccess > 0 && (
        <div className="flex gap-2 items-start text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 mt-0.5" />
          <div>
            {applied.length > 0 && <div>Successfully applied to {applied.length} member{applied.length === 1 ? '' : 's'}.</div>}
            {cleared.length > 0 && <div>Successfully cleared for {cleared.length} member{cleared.length === 1 ? '' : 's'}.</div>}
            {unchanged.length > 0 && <div>{unchanged.length} member{unchanged.length === 1 ? '' : 's'} already matched the policy.</div>}
          </div>
        </div>
      )}

      {overrides.length > 0 && (
        <div className="flex gap-2 items-start text-sm text-blue-600 dark:text-blue-400">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium mb-1">Preserved {overrides.length} hand-set override{overrides.length === 1 ? '' : 's'}:</div>
            <ul className="list-disc pl-4 space-y-1 opacity-90 max-h-32 overflow-y-auto">
              {overrides.map(o => (
                <li key={o.userId} className="truncate">User <code>{o.userId}</code> kept manual limit of ${o.previousAmountUsd?.toFixed(2) ?? '0.00'}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {failures.length > 0 && (
        <div className="flex gap-2 items-start text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium mb-1">Failed to update {failures.length} member{failures.length === 1 ? '' : 's'}:</div>
            <ul className="list-disc pl-4 space-y-1 opacity-90 max-h-32 overflow-y-auto">
              {failures.map(o => (
                <li key={o.userId} className="truncate">User <code>{o.userId}</code>: {o.error || 'Unknown error'}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export function GroupPolicyControl({ workspaceId, groupId, currentAmount }: { workspaceId: string; groupId: string; currentAmount: number | null }) {
  const [value, setValue] = useState(currentAmount?.toString() || '');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastResult, setLastResult] = useState<MemberLimitPolicyMutationResult | null>(null);
  
  const setPolicy = useSetGroupMemberLimitPolicy();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!dialogOpen && !setPolicy.isPending) {
      setValue(currentAmount?.toString() || '');
    }
  }, [currentAmount, dialogOpen, setPolicy.isPending]);

  const handleApply = () => {
    const numValue = value === '' ? null : Number(value);
    if (numValue !== null && (!Number.isFinite(numValue) || numValue <= 0)) {
      toast({ title: 'Invalid limit', description: 'Enter a positive USD amount or leave blank to clear.', variant: 'destructive' });
      return;
    }
    setDialogOpen(true);
  };

  const handleConfirm = () => {
    const amountUsd = value === '' ? null : Number(value);
    setPolicy.mutate({ workspaceId, groupId, data: { amountUsd } }, {
      onSuccess: (result) => {
        invalidateBudgetCaches(queryClient, workspaceId);
        queryClient.invalidateQueries({ queryKey: ['getWorkspaceLimitPolicies'] });
        setLastResult(result);
        toast({ title: 'Group policy processed' });
      },
      onError: (err) => {
        toast({ title: 'Failed to apply policy', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
      }
    });
  };

  return (
    <div className="mb-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border bg-muted/20 p-3">
        <div className="text-sm font-medium min-w-fit">Group Baseline Policy</div>
        <Input 
          type="number" 
          min="0" 
          step="0.01" 
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Usage limit (USD)"
          className="sm:max-w-48"
          disabled={setPolicy.isPending}
        />
        <Button onClick={handleApply} disabled={setPolicy.isPending || (value === (currentAmount?.toString() || ''))}>
          {setPolicy.isPending ? 'Applying...' : 'Apply Baseline'}
        </Button>
        {currentAmount !== null && (
          <Button variant="ghost" className="text-destructive px-2" onClick={() => { setValue(''); setDialogOpen(true); }} disabled={setPolicy.isPending}>
            <X className="h-4 w-4 mr-1" /> Clear Policy
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          Applies to all members without a manual override.
        </span>
      </div>

      {lastResult && (
        <PolicyOutcomeSummary result={lastResult} onDismiss={() => setLastResult(null)} />
      )}

      {dialogOpen && (
        <UsageLimitDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onConfirm={handleConfirm}
          title={value === '' ? 'Clear Group Baseline Policy' : 'Set Group Baseline Policy'}
          description={
            <>
              <p>
                {value === '' 
                  ? 'Clearing this policy will remove the limit for all members who do not have a manual override.' 
                  : `Setting a baseline of $${Number(value).toFixed(2)} will apply to all members of this group who do not have a manual override, hard-blocking their Agent usage when reached.`}
              </p>
              <p>Manual overrides will be preserved. This action takes effect immediately.</p>
            </>
          }
          confirmText={value === '' ? 'Clear Policy' : 'Apply Policy'}
        />
      )}
    </div>
  );
}

export function WorkspacePolicyControl({ workspaceId, currentAmount }: { workspaceId: string; currentAmount: number | null }) {
  const [value, setValue] = useState(currentAmount?.toString() || '');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastResult, setLastResult] = useState<MemberLimitPolicyMutationResult | null>(null);
  
  const setPolicy = useSetWorkspaceDefaultLimitPolicy();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!dialogOpen && !setPolicy.isPending) {
      setValue(currentAmount?.toString() || '');
    }
  }, [currentAmount, dialogOpen, setPolicy.isPending]);

  const handleApply = () => {
    const numValue = value === '' ? null : Number(value);
    if (numValue !== null && (!Number.isFinite(numValue) || numValue <= 0)) {
      toast({ title: 'Invalid limit', description: 'Enter a positive USD amount or leave blank to clear.', variant: 'destructive' });
      return;
    }
    setDialogOpen(true);
  };

  const handleConfirm = () => {
    const amountUsd = value === '' ? null : Number(value);
    setPolicy.mutate({ workspaceId, data: { amountUsd } }, {
      onSuccess: (result) => {
        invalidateBudgetCaches(queryClient, workspaceId);
        queryClient.invalidateQueries({ queryKey: ['getWorkspaceLimitPolicies'] });
        setLastResult(result);
        toast({ title: 'Workspace policy processed' });
      },
      onError: (err) => {
        toast({ title: 'Failed to apply policy', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
      }
    });
  };

  return (
    <div className="mb-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border bg-muted/20 p-3">
        <div className="text-sm font-medium min-w-fit">Workspace Default Policy</div>
        <Input 
          type="number" 
          min="0" 
          step="0.01" 
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Usage limit (USD)"
          className="sm:max-w-48"
          disabled={setPolicy.isPending}
        />
        <Button onClick={handleApply} disabled={setPolicy.isPending || (value === (currentAmount?.toString() || ''))}>
          {setPolicy.isPending ? 'Applying...' : 'Apply Default'}
        </Button>
        {currentAmount !== null && (
          <Button variant="ghost" className="text-destructive px-2" onClick={() => { setValue(''); setDialogOpen(true); }} disabled={setPolicy.isPending}>
            <X className="h-4 w-4 mr-1" /> Clear Default
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          Applies to all members without a group policy or manual override.
        </span>
      </div>

      {lastResult && (
        <PolicyOutcomeSummary result={lastResult} onDismiss={() => setLastResult(null)} />
      )}

      {dialogOpen && (
        <UsageLimitDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onConfirm={handleConfirm}
          title={value === '' ? 'Clear Workspace Default Policy' : 'Set Workspace Default Policy'}
          description={
            <>
              <p>
                {value === '' 
                  ? 'Clearing this default will remove the limit for all workspace members who are not covered by a group policy or manual override.' 
                  : `Setting a default of $${Number(value).toFixed(2)} will apply to all workspace members who lack a group policy or manual override, hard-blocking their Agent usage when reached.`}
              </p>
              <p>Group policies and manual overrides will be preserved. This action takes effect immediately.</p>
            </>
          }
          confirmText={value === '' ? 'Clear Default' : 'Apply Default'}
        />
      )}
    </div>
  );
}
