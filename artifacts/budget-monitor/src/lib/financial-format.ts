/** Exact USD for financial labels; compact USD is reserved for chart axes. */
export function formatFinancialUsd(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? 'Unavailable'
    : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatFinancialAxis(value: number): string {
  return Number.isFinite(value)
    ? value.toLocaleString('en-US', {
      style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
    })
    : '—';
}