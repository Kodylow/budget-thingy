import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, Check, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useSetTeamBudget, useDeleteTeamBudget, getGetTeamsBudgetsQueryKey } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';

interface TeamBudgetInputProps {
  teamName: string;
  currentBudget: number | null;
}

export function TeamBudgetInput({ teamName, currentBudget }: TeamBudgetInputProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentBudget?.toString() || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const setBudget = useSetTeamBudget();
  const deleteBudget = useDeleteTeamBudget();

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) {
      setValue(currentBudget?.toString() || '');
    }
  }, [currentBudget, editing]);

  const handleSave = () => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) {
      toast({
        title: 'Invalid budget',
        description: 'Budget must be a non-negative number',
        variant: 'destructive',
      });
      return;
    }

    setBudget.mutate(
      { teamName: encodeURIComponent(teamName), data: { amountUsd: numValue } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTeamsBudgetsQueryKey() });
          setEditing(false);
          toast({
            title: 'Team budget updated',
            description: `${teamName} set to $${numValue.toFixed(2)}`,
          });
        },
        onError: () => {
          toast({
            title: 'Failed to update team budget',
            variant: 'destructive',
          });
        },
      }
    );
  };

  const handleRemove = () => {
    deleteBudget.mutate(
      { teamName: encodeURIComponent(teamName) },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTeamsBudgetsQueryKey() });
          setEditing(false);
          setValue('');
          toast({ title: 'Team budget removed' });
        },
        onError: () => {
          toast({
            title: 'Failed to remove team budget',
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
    if (e.key === 'Enter') handleSave();
    else if (e.key === 'Escape') handleCancel();
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
          data-testid={`input-team-budget-${teamName}`}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={handleSave}
          disabled={setBudget.isPending}
          data-testid={`button-save-team-budget-${teamName}`}
        >
          <Check className="h-3.5 w-3.5 text-chart-1" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={handleCancel}
          data-testid={`button-cancel-team-budget-${teamName}`}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {currentBudget !== null && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
          onClick={(e) => { e.stopPropagation(); handleRemove(); }}
          disabled={deleteBudget.isPending}
          data-testid={`button-remove-team-budget-${teamName}`}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        data-testid={`button-edit-team-budget-${teamName}`}
      >
        <Pencil className="h-3 w-3" />
      </Button>
      {currentBudget !== null ? (
        <span className="font-mono text-sm tabular-nums font-semibold" data-testid={`text-team-budget-${teamName}`}>
          ${currentBudget.toFixed(2)}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground" data-testid={`text-no-team-budget-${teamName}`}>
          No budget
        </span>
      )}
    </div>
  );
}
