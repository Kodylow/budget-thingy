import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FULL_TERM_START_DATE,
  apiRangeType,
  fullTermDates,
  toLocalDateInputValue,
} from './range-selection.ts';

test('full term uses the spend cutoff through the local calendar date', () => {
  const localDate = new Date(2026, 7, 28, 23, 59, 59);
  assert.deepEqual(fullTermDates(localDate), {
    startDate: '2026-05-20',
    endDate: '2026-08-28',
  });
  assert.equal(FULL_TERM_START_DATE, '2026-05-20');
});

test('local date formatting does not use the UTC calendar day', () => {
  const localDate = new Date(2026, 0, 2, 0, 30);
  assert.equal(toLocalDateInputValue(localDate), '2026-01-02');
});

test('full term reuses the validated custom-range API contract', () => {
  assert.equal(apiRangeType('full-term'), 'custom');
  assert.equal(apiRangeType('billing'), 'billing');
  assert.equal(apiRangeType('custom'), 'custom');
});