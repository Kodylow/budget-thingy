import { describe, expect, it } from 'vitest';
import {
  dashboardAllocatedBudget,
  formatObservedCurrency,
  dashboardTotalSpend,
  isUnknownSelectedRangeValue,
  isUnknownSpendTotal,
} from './spend-presentation';

describe('spend observation presentation', () => {
  it('distinguishes an unobserved accumulator zero from authoritative zero', () => {
    expect(formatObservedCurrency(0, false)).toBe('Unknown');
    expect(formatObservedCurrency(0, true)).toBe('$0.00');
    expect(formatObservedCurrency(0, undefined)).toBe('$0.00');
  });

  it('marks only selected-range usage-derived row fields unknown', () => {
    expect(isUnknownSelectedRangeValue(false, 'spendUsd')).toBe(true);
    expect(isUnknownSelectedRangeValue(false, 'remainingUsd')).toBe(true);
    expect(isUnknownSelectedRangeValue(false, 'percentUsed')).toBe(true);
    expect(isUnknownSelectedRangeValue(false, 'currentCycleAgentSpendUsd')).toBe(false);
    expect(isUnknownSelectedRangeValue(false, 'currentCycleRemainingUsd')).toBe(false);
    expect(isUnknownSelectedRangeValue(false, 'allocationUsd')).toBe(false);
  });

  it('marks a partial or empty total unknown only without an observation timestamp', () => {
    expect(isUnknownSpendTotal({ status: 'partial', dataAsOf: null })).toBe(true);
    expect(isUnknownSpendTotal({ status: 'empty' })).toBe(true);
    expect(isUnknownSpendTotal({ status: 'partial', dataAsOf: '2026-09-04T00:00:00Z' })).toBe(false);
    expect(isUnknownSpendTotal({ status: 'complete', dataAsOf: null })).toBe(false);
  });

  it('reads the canonical all-service dashboard total instead of variant card keys', () => {
    const response = {
      cards: [
        { key: 'your_agent_spend', value: 90 },
        { key: 'monthly_agent_limit', value: 100 },
      ],
      scope: { isPersonal: true },
      accounting: { eligibleSpendUsd: 0, grossSpendUsd: 237.76 },
      metadata: { status: 'complete', dataAsOf: '2026-09-04T00:00:00Z' },
    };
    expect(dashboardTotalSpend(response)).toBe(237.76);
    expect(dashboardTotalSpend({
      ...response,
      accounting: { eligibleSpendUsd: 0, grossSpendUsd: 0 },
      metadata: { status: 'partial', dataAsOf: null },
    })).toBeNull();
  });

  it('does not require a spend card for a managed budget-health response', () => {
    expect(dashboardTotalSpend({
      scope: { isPersonal: false },
      accounting: { eligibleSpendUsd: 112936, grossSpendUsd: 113100 },
      metadata: { status: 'complete', dataAsOf: '2026-09-04T00:00:00Z' },
    })).toBe(112936);
  });

  it('uses only the canonical allocated-budget card as the organization denominator', () => {
    expect(dashboardAllocatedBudget({
      cards: [
        { key: 'eligible_spend', value: 112_936.27 },
        { key: 'allocated_budget', value: 771_620.02 },
        { key: 'allocation_remaining', value: 658_683.75 },
      ],
    })).toBe(771_620.02);
    expect(dashboardAllocatedBudget({
      cards: [{ key: 'allocated_budget', value: null }],
    })).toBeNull();
  });
});