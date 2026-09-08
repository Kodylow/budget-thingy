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

export function isValidCustomRange(startDate?: string, endDate?: string): boolean {
  const validDate = (value?: string) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  return validDate(startDate) && validDate(endDate) && startDate! <= endDate! &&
    (Date.parse(endDate!) - Date.parse(startDate!)) / 86_400_000 < 400;
}