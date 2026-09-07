import React, { useState } from 'react';
import { MetricCard } from '@/components/journey-primitives';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatUsd } from './format';
import {
  aggregatePersonalLimits,
  personalLimitBudgetRows,
  personalLimitSummaryRows,
  type PersonalLimitSummary,
} from './budget-logic';

function limitText(row: ReturnType<typeof personalLimitBudgetRows>[number]) {
  if (row.limitState === 'no_limit') return 'No limit';
  return row.allocationUsd == null ? 'Unavailable' : formatUsd(row.allocationUsd);
}

function remainingText(row: ReturnType<typeof personalLimitBudgetRows>[number]) {
  if (row.limitState === 'no_limit') return 'No limit';
  return row.currentCycleRemainingUsd == null
    ? 'Unavailable'
    : formatUsd(row.currentCycleRemainingUsd);
}

export function MyBudgetDetails({
  limits,
  showAll,
  onToggle,
}: {
  limits: PersonalLimitSummary[];
  showAll: boolean;
  onToggle: () => void;
}) {
  const allRows = personalLimitBudgetRows(limits);
  const summaryRows = personalLimitSummaryRows(limits);
  const rows = showAll ? allRows : summaryRows;
  const hiddenCount = allRows.length - summaryRows.length;

  return (
    <>
      <div className="border-b border-border p-4">
        <p className="font-semibold">Agent budget by workspace</p>
        <p className="mt-1 text-xs text-muted-foreground">This billing cycle</p>
      </div>
      <div className="max-h-72 overflow-y-auto p-2">
        {rows.map((row) => (
          <div key={row.id} className="border-t border-border px-2 py-3 first:border-t-0">
            <p className="truncate text-xs font-medium">{row.workspaceName || row.workspaceId}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Spent</dt>
                <dd className="mt-0.5 font-mono">{formatUsd(row.currentCycleAgentSpendUsd)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Limit</dt>
                <dd className="mt-0.5 font-mono">{limitText(row)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Remaining</dt>
                <dd className="mt-0.5 font-mono">{remainingText(row)}</dd>
              </div>
            </dl>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No spend or finite limits to show.
          </p>
        )}
      </div>
      {hiddenCount > 0 && (
        <div className="border-t border-border p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={onToggle}
          >
            {showAll ? 'Show used and finite-limit workspaces' : `Show all ${allRows.length} workspaces`}
          </Button>
        </div>
      )}
    </>
  );
}

export function MyBudgetSummary({ limits }: { limits: PersonalLimitSummary[] }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const allRows = personalLimitBudgetRows(limits);
  const aggregate = aggregatePersonalLimits(limits);
  const allLimitsKnown = aggregate.unknownLimitCount === 0;
  const budget = aggregate.finiteCount > 0
    ? formatUsd(aggregate.finiteBudgetUsd)
    : allLimitsKnown && aggregate.unlimitedCount > 0
      ? 'No limit'
      : 'Unavailable';
  const detail = aggregate.finiteCount > 0
    ? `${aggregate.finiteCount < aggregate.workspaceCount ? 'Finite-limit subtotal · ' : ''}${aggregate.unknownLimitCount ? 'Known · ' : ''}${aggregate.finiteCount} workspace limit${aggregate.finiteCount === 1 ? '' : 's'} · This billing cycle`
    : allLimitsKnown && aggregate.unlimitedCount > 0
      ? `${aggregate.unlimitedCount} unlimited workspace${aggregate.unlimitedCount === 1 ? '' : 's'} · This billing cycle`
    : 'Workspace limits · This billing cycle';

  const value = allRows.length === 0
    ? budget
    : (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Show Agent limits by workspace"
            className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {budget}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(92vw,38rem)] p-0"
        >
          <MyBudgetDetails
            limits={limits}
            showAll={showAll}
            onToggle={() => setShowAll((current) => !current)}
          />
        </PopoverContent>
      </Popover>
    );

  return <MetricCard label="My Budget" value={value} detail={detail} />;
}