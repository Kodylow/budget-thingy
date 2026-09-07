const SELECTED_RANGE_USAGE_COLUMNS = new Set([
  'spendUsd',
  'agentSpendUsd',
  'otherServicesUsd',
  'remainingUsd',
  'percentUsed',
]);

export function isUnknownSelectedRangeValue(
  usageObserved: boolean | undefined,
  column: string,
): boolean {
  return usageObserved === false && SELECTED_RANGE_USAGE_COLUMNS.has(column);
}

export function formatObservedCurrency(
  value: number | null | undefined,
  usageObserved: boolean | undefined,
): string {
  if (usageObserved === false) return 'Unknown';
  if (value == null) return '—';
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function isUnknownSpendTotal(metadata: {
  status: string;
  dataAsOf?: string | null;
}): boolean {
  return metadata.dataAsOf == null &&
    (metadata.status === 'partial' || metadata.status === 'empty');
}

export function dashboardTotalSpend(response: {
  scope?: { isPersonal?: boolean };
  accounting: { eligibleSpendUsd: number; grossSpendUsd?: number };
  metadata: { status: string; dataAsOf?: string | null };
} | null | undefined): number | null {
  if (!response || isUnknownSpendTotal(response.metadata)) return null;
  const total = response.scope?.isPersonal
    ? response.accounting.grossSpendUsd
    : response.accounting.eligibleSpendUsd;
  return total != null && Number.isFinite(total)
    ? total
    : null;
}

export function dashboardAllocatedBudget(response: {
  cards: Array<{ key: string; value: number | null }>;
} | null | undefined): number | null {
  const value = response?.cards.find((card) => card.key === 'allocated_budget')?.value;
  return value != null && Number.isFinite(value) ? value : null;
}