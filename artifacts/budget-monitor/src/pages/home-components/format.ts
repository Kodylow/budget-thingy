export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return (value > 0 ? '+' : '') + value.toFixed(1) + '%';
}
