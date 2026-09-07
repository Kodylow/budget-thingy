import { describe, expect, it } from 'vitest';
import { formatFinancialAxis, formatFinancialUsd } from './financial-format';

describe('financial visualization formatting', () => {
  it('uses exact dollars for values and compact labels only for axes', () => {
    expect(formatFinancialUsd(1234567.89)).toBe('$1,234,567.89');
    expect(formatFinancialAxis(1234567.89)).toBe('$1.2M');
    expect(formatFinancialAxis(1234)).toBe('$1.2K');
    expect(formatFinancialUsd(-12.5)).toBe('-$12.50');
    expect(formatFinancialUsd(0)).toBe('$0.00');
  });

  it('never formats missing or non-finite values as zero', () => {
    for (const value of [null, undefined, NaN, Infinity]) {
      expect(formatFinancialUsd(value)).toBe('Unavailable');
    }
  });
});