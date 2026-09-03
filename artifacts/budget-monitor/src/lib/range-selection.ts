export const FULL_TERM_START_DATE = '2026-05-20';

export type ApiRangeType = 'billing' | 'mtd' | 'ytd' | 'custom' | 'full-term';
export type RangeSelection = ApiRangeType | 'full-term';

export function toLocalDateInputValue(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function fullTermDates(date = new Date()) {
  return {
    startDate: FULL_TERM_START_DATE,
    endDate: toLocalDateInputValue(date),
  };
}

export function apiRangeType(selection: RangeSelection): ApiRangeType {
  return selection;
}