import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, Check, X } from 'lucide-react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useSetWorkspaceMemberBudget,
  useClearWorkspaceMemberBudget,
  getListVisibleWorkspaceMembersQueryKey,
  getListWorkspaceUsageLimitAuditsQueryKey,
  getListGroupsQueryKey,
  getGetSummaryQueryKey,
  getGetWorkspaceLimitPoliciesQueryKey,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { UsageLimitDialog } from './usage-limit-dialog';

export const invalidateBudgetCaches = (queryClient: QueryClient, workspaceId?: string) => {
  if (workspaceId) {
    queryClient.invalidateQueries({ queryKey: getListVisibleWorkspaceMembersQueryKey(workspaceId) });
    queryClient.invalidateQueries({ queryKey: getListWorkspaceUsageLimitAuditsQueryKey(workspaceId) });
    queryClient.invalidateQueries({ queryKey: getGetWorkspaceLimitPoliciesQueryKey(workspaceId) });
  }
  queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetSummaryQueryKey() });
  queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' &&
      (query.queryKey[0].startsWith('/api/clusters/') ||
       query.queryKey[0].startsWith('/api/groups/'))
  });
};

interface MemberBudgetInputProps {
  workspaceId: string;
  userId: string;
  currentBudget: number | null;
  canWrite: boolean;
  disabledReason?: string;
}

export function MemberBudgetInput({
  workspaceId,
  userId,
  currentBudget,
  canWrite,
  disabledReason,
}: MemberBudgetInputProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentBudget?.toString() || '');
  const [dialogState, setDialogState] = useState<{ open: boolean; action: 'save' | 'clear' | null }>({ open: false, action: null });
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const setBudget = useSetWorkspaceMemberBudget();
  const clearBudget = useClearWorkspaceMemberBudget();

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setValue(currentBudget?.toString() ?? '');
  }, [currentBudget, editing]);

  if (!canWrite) {
    return (
      <div className="flex items-center justify-end gap-1.5">
        {disabledReason && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 shrink-0"
            disabled
            title={disabledReason}
            aria-label={`Edit Agent limit unavailable: ${disabledReason}`}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        )}
        {currentBudget !== null ? (
          <span className="font-mono text-sm tabular-nums" data-testid={`text-budget-${userId}`}>
            ${currentBudget.toFixed(2)}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground" data-testid={`text-no-budget-${userId}`}>
            Not set
          </span>
        )}
      </div>
    );
  }

  const initiateSave = () => {
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue <= 0) {
      toast({
        title: 'Invalid Agent limit',
        description: 'Agent limit must be a positive number',
        variant: 'destructive',
      });
      return;
    }
    setDialogState({ open: true, action: 'save' });
  };

  const initiateRemove = () => {
    setDialogState({ open: true, action: 'clear' });
  };

  const handleConfirm = () => {
    if (dialogState.action === 'save') {
      const numValue = Number(value);
      setBudget.mutate(
        { workspaceId, userId, data: { amountUsd: numValue } },
        {
          onSuccess: () => {
            invalidateBudgetCaches(queryClient, workspaceId);
            setEditing(false);
            toast({
              title: 'Agent limit updated',
              description: `Set to $${numValue.toFixed(2)}`,
            });
          },
          onError: (error) => {
            toast({
              title: 'Failed to update Agent limit',
              description: error instanceof Error
                ? error.message
                : 'The Replit integration rejected the change.',
              variant: 'destructive',
            });
          },
        }
      );
    } else if (dialogState.action === 'clear') {
      clearBudget.mutate(
        { workspaceId, userId },
        {
          onSuccess: () => {
            invalidateBudgetCaches(queryClient, workspaceId);
            setEditing(false);
            setValue('');
            toast({
              title: 'Agent limit cleared',
            });
          },
          onError: (error) => {
            toast({
              title: 'Failed to clear Agent limit',
              description: error instanceof Error
                ? error.message
                : 'The Replit integration rejected the change.',
              variant: 'destructive',
            });
          },
        }
      );
    }
  };

  const handleCancel = () => {
    setValue(currentBudget?.toString() || '');
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      initiateSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (editing) {
    return (
      <>
        <div className="flex items-center gap-1 justify-end">
          <Input
            ref={inputRef}
            type="number"
            step="0.01"
            min="0"
            aria-invalid={value !== '' && (!Number.isFinite(Number(value)) || Number(value) <= 0)}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 w-20 text-xs font-mono px-2"
            data-testid={`input-budget-${userId}`}
            aria-label="Agent limit in US dollars"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 shrink-0"
            onClick={initiateSave}
            disabled={setBudget.isPending || clearBudget.isPending}
            data-testid={`button-save-budget-${userId}`}
            aria-label="Save Agent limit"
          >
            <Check className="h-3.5 w-3.5 text-chart-1" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 shrink-0"
            onClick={handleCancel}
            data-testid={`button-cancel-budget-${userId}`}
            aria-label="Cancel editing"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
        {dialogState.open && (
          <UsageLimitDialog
            open={dialogState.open}
            onOpenChange={(open) => setDialogState(prev => ({ ...prev, open }))}
            onConfirm={handleConfirm}
            title="Set Agent Limit"
            description={
              <>
                <p>Setting this limit will <strong>hard-block Agent usage</strong> for this member once they reach <strong>${Number(value).toFixed(2)}</strong> in the current cycle.</p>
                <p>This action takes effect immediately.</p>
              </>
            }
            confirmText="Set Limit"
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1.5 group">
        {currentBudget !== null && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-destructive shrink-0"
            onClick={initiateRemove}
            disabled={clearBudget.isPending || setBudget.isPending}
            data-testid={`button-remove-budget-${userId}`}
            aria-label="Clear Agent limit"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
          onClick={() => setEditing(true)}
          data-testid={`button-edit-budget-${userId}`}
          aria-label="Edit Agent limit"
        >
          <Pencil className="h-3 w-3" />
        </Button>
        {currentBudget !== null ? (
          <span className="font-mono text-sm tabular-nums whitespace-nowrap" data-testid={`text-budget-${userId}`}>
            ${currentBudget.toFixed(2)}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-no-budget-${userId}`}>
            Not set
          </span>
        )}
      </div>
      {dialogState.open && dialogState.action === 'clear' && (
        <UsageLimitDialog
          open={dialogState.open}
          onOpenChange={(open) => setDialogState(prev => ({ ...prev, open }))}
          onConfirm={handleConfirm}
          title="Clear Agent Limit"
          description={
            <>
              <p>Clearing this limit will <strong>remove the hard block</strong> on Agent usage for this member.</p>
              <p>This action takes effect immediately.</p>
            </>
          }
          confirmText="Clear Limit"
        />
      )}
    </>
  );
}
