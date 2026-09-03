import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, Check, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useSetWorkspaceMemberBudget,
  useClearWorkspaceMemberBudget,
  getListVisibleWorkspaceMembersQueryKey,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';

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
            aria-label={`Edit usage limit unavailable: ${disabledReason}`}
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

  const handleSave = () => {
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue <= 0) {
      toast({
        title: 'Invalid usage limit',
        description: 'Usage limit must be a positive number',
        variant: 'destructive',
      });
      return;
    }

    setBudget.mutate(
      { workspaceId, userId, data: { amountUsd: numValue } },
      {
        onSuccess: () => {
          if (workspaceId) {
            queryClient.invalidateQueries({ queryKey: getListVisibleWorkspaceMembersQueryKey(workspaceId) });
          }
          setEditing(false);
          toast({
            title: 'Usage limit updated',
            description: `Set to $${numValue.toFixed(2)}`,
          });
        },
        onError: (error) => {
          toast({
            title: 'Failed to update usage limit',
            description: error instanceof Error
              ? error.message
              : 'The Replit integration rejected the change.',
            variant: 'destructive',
          });
        },
      }
    );
  };

  const handleRemove = () => {
    clearBudget.mutate(
      { workspaceId, userId },
      {
        onSuccess: () => {
          if (workspaceId) {
            queryClient.invalidateQueries({ queryKey: getListVisibleWorkspaceMembersQueryKey(workspaceId) });
          }
          setEditing(false);
          setValue('');
          toast({
            title: 'Usage limit cleared',
          });
        },
        onError: (error) => {
          toast({
            title: 'Failed to clear usage limit',
            description: error instanceof Error
              ? error.message
              : 'The Replit integration rejected the change.',
            variant: 'destructive',
          });
        },
      }
    );
  };

  const handleCancel = () => {
    setValue(currentBudget?.toString() || '');
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (editing) {
    return (
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
          aria-label="Usage limit in US dollars"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 shrink-0"
          onClick={handleSave}
          disabled={setBudget.isPending || clearBudget.isPending}
          data-testid={`button-save-budget-${userId}`}
          aria-label="Save usage limit"
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
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5 group">
      {currentBudget !== null && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-destructive shrink-0"
          onClick={handleRemove}
          disabled={clearBudget.isPending || setBudget.isPending}
          data-testid={`button-remove-budget-${userId}`}
          aria-label="Clear usage limit"
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
        aria-label="Edit usage limit"
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
  );
}
