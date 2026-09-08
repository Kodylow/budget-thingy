import { describe, expect, it } from 'vitest';
import { normalizeRangeSelection } from './range-selection';

describe('normalizeRangeSelection', () => {
  it('keeps the two supported reporting selections', () => {
    expect(normalizeRangeSelection('full-term')).toBe('full-term');
    expect(normalizeRangeSelection('billing')).toBe('billing');
  });

  it.each([null, undefined, '', 'mtd', 'ytd', 'custom', 'invalid'])(
    'normalizes %s to full term',
    raw => {
      expect(normalizeRangeSelection(raw)).toBe('full-term');
    },
  );
});