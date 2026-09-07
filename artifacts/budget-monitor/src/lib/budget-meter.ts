export type BudgetMeterTone = 'neutral' | 'green' | 'amber' | 'red';
export type BudgetMeterState = 'loading' | 'unknown' | 'no-budget' | 'invalid-budget' | 'zero-budget' | 'ready';

export interface BudgetMeterModel {
  state: BudgetMeterState;
  actualPercent: number | null;
  projectedPercent: number | null;
  actualWidth: number;
  projectedWidth: number;
  capacityWidth: number;
  projectionTone: BudgetMeterTone;
}

const finiteAmount = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const visualWidth = (percent: number) => Math.min(100, Math.max(0, percent));

export function projectionTone(percent: number | null): BudgetMeterTone {
  if (percent == null) return 'neutral';
  if (percent > 100) return 'red';
  if (percent >= 90) return 'amber';
  return 'green';
}

export function getBudgetMeterModel({
  actualUsd,
  budgetUsd,
  projectedUsd,
  loading = false,
}: {
  actualUsd: number | null;
  budgetUsd: number | null;
  projectedUsd?: number | null;
  loading?: boolean;
}): BudgetMeterModel {
  const empty = (state: BudgetMeterState): BudgetMeterModel => ({
    state,
    actualPercent: null,
    projectedPercent: null,
    actualWidth: 0,
    projectedWidth: 0,
    capacityWidth: 100,
    projectionTone: 'neutral',
  });

  if (loading) return empty('loading');
  if (budgetUsd == null) return empty('no-budget');
  if (!finiteAmount(budgetUsd) || budgetUsd < 0) return empty('invalid-budget');
  if (budgetUsd === 0) return empty('zero-budget');
  if (!finiteAmount(actualUsd)) return empty('unknown');

  const actualPercent = actualUsd / budgetUsd * 100;
  const projectedPercent = finiteAmount(projectedUsd) ? projectedUsd / budgetUsd * 100 : null;
  const actualWidth = visualWidth(actualPercent);
  const projectedTotalWidth = projectedPercent == null
    ? actualWidth
    : Math.max(actualWidth, visualWidth(projectedPercent));

  return {
    state: 'ready',
    actualPercent,
    projectedPercent,
    actualWidth,
    projectedWidth: Math.max(0, projectedTotalWidth - actualWidth),
    capacityWidth: Math.max(0, 100 - projectedTotalWidth),
    projectionTone: projectionTone(projectedPercent),
  };
}

export function formatBudgetPercent(percent: number): string {
  return `${percent.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function getProjectionThresholdExplanation(percent: number | null): string {
  if (percent == null) {
    return 'Projection threshold unavailable; within is below 90%, near limit is 90%–100%, and over budget is above 100%';
  }
  if (percent > 100) return 'Over budget: projection exceeds 100% of capacity';
  if (percent >= 90) return 'Near limit: projection is 90%–100% of capacity';
  return 'Within budget: projection is below 90% of capacity';
}

export function formatBudgetDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

export function getTimeElapsedPercent(
  periodStart?: string | null,
  periodEnd?: string | null,
  dataThrough?: string | null,
): number | null {
  if (!periodStart || !periodEnd || !dataThrough) return null;
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  const through = Date.parse(dataThrough) + (/^\d{4}-\d{2}-\d{2}$/.test(dataThrough) ? 86_400_000 : 0);
  if (![start, end, through].every(Number.isFinite) || end <= start) return null;
  return Math.min(100, Math.max(0, (through - start) / (end - start) * 100));
}