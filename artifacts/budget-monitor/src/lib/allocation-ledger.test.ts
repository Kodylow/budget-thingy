import { describe, expect, it } from 'vitest';
import type { TeamBudgetHistoryTeam } from '@workspace/api-client-react';
import { buildAllocationRow, parsePeriod, sumUsd } from './allocation-ledger';

function team(entries: [string, number][]): TeamBudgetHistoryTeam {
  return {
    teamName: 'Example',
    originalAmountUsd: 100,
    annualAllocationUsd: 500,
    effectiveAmountUsd: 500,
    monthlyLimitUsd: null,
    monthlyLimitSource: 'derived',
    isHidden: false,
    adjustments: entries.map(([submissionPeriod, amountUsd], i) => ({
      recordId: String(i), source: 'manual-allocation', sourceKind: 'manual_allocation',
      amountUsd, submissionPeriod, sourceBaseId: null, sourceTableId: null,
      sourceUrl: null, sourceCreatedAt: null, sourceUpdatedAt: null,
      ingestedAt: '2026-09-01T00:00:00Z',
    })),
  };
}

describe('allocation ledger', () => {
  it('uses the original opening, never the effective allocation, and adds each entry once', () => {
    const row = buildAllocationRow(team([['2026-09', 10], ['2026-09', 15]]), 2026);
    expect(row.baseline).toBe(100);
    expect(row.monthsData[8]).toBe(25);
    expect(row.rowTotal).toBe(125);
  });
  it('carries prior years forward, preserves undated funds, and excludes future years from year-end total', () => {
    const row = buildAllocationRow(team([['2025-03', 20], ['unknown', 5], ['2027-02', 70]]), 2026);
    expect(row.carryForward).toBe(20);
    expect(row.undated).toBe(5);
    expect(row.rowTotal).toBe(125);
  });
  it('keeps invalid months and absent periods visible as undated rather than dropping them', () => {
    expect(parsePeriod('2026-13').unparseable).toBe(true);
    expect(parsePeriod('0/2026').unparseable).toBe(true);
    expect(parsePeriod(null).unparseable).toBe(true);
    expect(buildAllocationRow(team([['2026-13', 10]]), 2026).undated).toBe(10);
  });
  it('sums currency in integer cents and accepts legacy month formats', () => {
    expect(sumUsd([0.1, 0.2])).toBe(0.3);
    const row = buildAllocationRow(team([['09/2026', 0.1], ['2026-09', 0.2]]), 2026);
    expect(row.monthsData[8]).toBe(0.3);
    expect(row.rowTotal).toBe(100.3);
  });
  it('folds opening, undated, carried, and January through July funding into the compact starting amount', () => {
    const row = buildAllocationRow(team([
      ['2025-12', 20],
      ['unknown', 5],
      ['2026-01', 10],
      ['2026-07', 15],
      ['2026-08', 30],
      ['2026-09', 40],
    ]), 2026);
    expect(row.startingAllocation).toBe(150);
    expect(row.august).toBe(30);
    expect(row.september).toBe(40);
    expect(row.laterAdditions).toBe(0);
    expect(row.rowTotal).toBe(220);
  });
  it('keeps October through December additions in the total and exposes them for reconciliation', () => {
    const row = buildAllocationRow(team([
      ['2026-08', 10],
      ['2026-09', 20],
      ['2026-10', 30],
      ['2026-12', 40],
      ['2027-01', 500],
    ]), 2026);
    expect(row.startingAllocation).toBe(100);
    expect(row.laterAdditions).toBe(70);
    expect(row.futureAdditions).toBe(500);
    expect(row.rowTotal).toBe(200);
    expect(sumUsd([row.startingAllocation, row.august, row.september, row.laterAdditions]))
      .toBe(row.rowTotal);
  });
});
