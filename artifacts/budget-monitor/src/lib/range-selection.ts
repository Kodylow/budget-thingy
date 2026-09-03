export const FULL_TERM_START_DATE = '2026-05-20';

export type ApiRangeType = 'billing' | 'mtd' | 'ytd' | 'custom' | 'full-term';
export type RangeSelection = ApiRangeType | 'full-term';

export function toLocalDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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