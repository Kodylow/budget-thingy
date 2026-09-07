export type ApiRangeType = 'billing' | 'mtd' | 'ytd' | 'custom' | 'full-term';
export type RangeSelection = ApiRangeType | 'full-term';

export function toLocalDateInputValue(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function defaultCustomDates(date = new Date()) {
  const endDate = toLocalDateInputValue(date);
  return {
    startDate: `${endDate.slice(0, 8)}01`,
    endDate,
  };
}

export function apiRangeType(selection: RangeSelection): ApiRangeType {
  return selection;
}