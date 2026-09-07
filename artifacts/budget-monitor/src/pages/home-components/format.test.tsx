import { describe, it, expect } from 'vitest';
import { formatUsd, formatPct, formatInt } from './format';

describe('Home Budget Format', () => {
  it('formats USD correctly', () => {
    expect(formatUsd(1800.36)).toBe('$1,800.36');
    expect(formatUsd(2000)).toBe('$2,000.00');
    expect(formatUsd(null)).toBe('Unavailable');
    expect(formatUsd(undefined)).toBe('Unavailable');
  });

  it('formats Pct correctly', () => {
    expect(formatPct(4.8)).toBe('+4.8%');
    expect(formatPct(-2.5)).toBe('-2.5%');
    expect(formatPct(0)).toBe('0.0%');
    expect(formatPct(null)).toBe('—');
  });

  it('formats Int correctly', () => {
    expect(formatInt(1234)).toBe('1,234');
    expect(formatInt(null)).toBe('—');
  });
});
