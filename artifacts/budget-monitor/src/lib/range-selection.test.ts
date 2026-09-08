// @ts-nocheck
import { test, expect } from "vitest";
import {
  apiRangeType,
  defaultCustomDates,
  isValidCustomRange,
  toLocalDateInputValue,
} from './range-selection.ts';

test('custom dates default to the active month through the UTC calendar date', () => {
  const utcInstant = new Date('2026-08-28T23:59:59.000Z');
  expect(defaultCustomDates(utcInstant)).toEqual({
    startDate: '2026-08-01',
    endDate: '2026-08-28',
  });
});

test('date formatting always uses the UTC calendar day', () => {
  const instant = new Date('2026-01-02T00:30:00+14:00');
  expect(toLocalDateInputValue(instant)).toBe('2026-01-01');
});

test('full term uses its stable rolling API identity', () => {
  expect(apiRangeType('full-term')).toBe('full-term');
  expect(apiRangeType('billing')).toBe('billing');
  expect(apiRangeType('custom')).toBe('custom');
});

test('custom ranges commit only as a complete ordered pair during ordinary date editing', () => {
  expect(isValidCustomRange('', '2026-09-10')).toBe(false);
  expect(isValidCustomRange('2026-09-12', '2026-09-10')).toBe(false);
  expect(isValidCustomRange('2026-09-02', '2026-09-10')).toBe(true);
  expect(isValidCustomRange('2026-02-30', '2026-03-10')).toBe(false);
});