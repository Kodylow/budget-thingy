import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FULL_TERM_START_DATE,
  apiRangeType,
  fullTermDates,
  toLocalDateInputValue,
} from './range-selection.ts';

test('full term uses the spend cutoff through the UTC calendar date', () => {
  const localDate = new Date(2026, 7, 28, 23, 59, 59);
  assert.deepEqual(fullTermDates(localDate), {
    startDate: '2026-05-20',
    endDate: '2026-08-28',
  });
  assert.equal(FULL_TERM_START_DATE, '2026-05-20');
});

test('date formatting always uses the UTC calendar day', () => {
  const instant = new Date('2026-01-02T00:30:00+14:00');
  assert.equal(toLocalDateInputValue(instant), '2026-01-01');
});

test('full term uses its stable rolling API identity', () => {
  assert.equal(apiRangeType('full-term'), 'full-term');
  assert.equal(apiRangeType('billing'), 'billing');
  assert.equal(apiRangeType('custom'), 'custom');
});