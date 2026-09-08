export type RangeSelection = 'full-term' | 'billing';

export function normalizeRangeSelection(value?: string | null): RangeSelection {
  return value === 'billing' ? 'billing' : 'full-term';
}