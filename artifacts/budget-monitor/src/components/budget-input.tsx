import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, Check, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useSetGroupBudget, useDeleteGroupBudget, getListGroupsQueryKey } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';

interface BudgetInputProps {
  groupId: string;
  currentBudget: number | null;
}

export function BudgetInput({ groupId, currentBudget }: BudgetInputProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentBudget?.toString() || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const setBudget = useSetGroupBudget();
  const deleteBudget = useDeleteGroupBudget();

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleSave = () => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue <= 0) {
      toast({
        title: 'Invalid budget',
        description: 'Budget must be a positive number',
        variant: 'destructive',
      });
      return;
    }

    setBudget.mutate(
      { groupId, data: { amountUsd: numValue } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
          setEditing(false);
          toast({
            title: 'Budget updated',
            description: `Set to $${numValue.toFixed(2)}`,
          });
        },
        onError: () => {
          toast({
            title: 'Failed to update budget',
            variant: 'destructive',
          });
        },
      }
    );
  };

  const handleRemove = () => {
    deleteBudget.mutate(
      { groupId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
          setEditing(false);
          setValue('');
          toast({
            title: 'Budget removed',
          });
        },
        onError: () => {
          toast({
            title: 'Failed to remove budget',
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
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          type="number"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-7 w-28 text-xs font-mono"
          data-testid={`input-budget-${groupId}`}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={handleSave}
          disabled={setBudget.isPending}
          data-testid={`button-save-budget-${groupId}`}
        >
          <Check className="h-3.5 w-3.5 text-chart-1" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={handleCancel}
          data-testid={`button-cancel-budget-${groupId}`}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {currentBudget !== null ? (
        <span className="font-mono text-sm tabular-nums" data-testid={`text-budget-${groupId}`}>
          ${currentBudget.toFixed(2)}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground" data-testid={`text-no-budget-${groupId}`}>
          No budget
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => setEditing(true)}
        data-testid={`button-edit-budget-${groupId}`}
      >
        <Pencil className="h-3 w-3" />
      </Button>
      {currentBudget !== null && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
          onClick={handleRemove}
          disabled={deleteBudget.isPending}
          data-testid={`button-remove-budget-${groupId}`}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
