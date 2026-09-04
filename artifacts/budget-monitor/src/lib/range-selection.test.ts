// @ts-nocheck
import { test, expect } from "vitest";
import {
  FULL_TERM_START_DATE,
  apiRangeType,
  fullTermDates,
  toLocalDateInputValue,
} from './range-selection.ts';

test('full term uses the spend cutoff through the UTC calendar date', () => {
  const utcInstant = new Date('2026-08-28T23:59:59.000Z');
  expect(fullTermDates(utcInstant)).toEqual({
    startDate: '2026-05-20',
    endDate: '2026-08-28',
  });
  expect(FULL_TERM_START_DATE).toBe('2026-05-20');
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