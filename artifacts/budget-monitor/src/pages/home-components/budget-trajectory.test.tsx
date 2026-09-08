import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BudgetTrajectory, trajectoryChartData } from './budget-trajectory';
import type { TeamBudgetTracking } from './budget-panels';

const qualifiedAnnual: TeamBudgetTracking = {
  budgetKind: 'annual',
  periodStart: '2026-05-20',
  periodEnd: '2027-05-20',
  periodLabel: 'May 20, 2026–May 20, 2027',
  reportingStart: '2026-05-20',
  reportingEnd: '2027-05-20',
  reportingLabel: 'May 20–Sep 8, 2026',
  asOf: '2026-09-08T12:00:00Z',
  allocationUsd: 9368.38,
  spendUsd: 1234,
  remainingUsd: null,
  percentUsed: null,
  scopeComplete: true,
  usageComplete: false,
  benchmarkEligible: true,
  comparisonsMatchBudgetWindow: true,
  qualification: 'Current-membership qualified.',
  reporting: {
    acquisitionCoverage: 'partial',
    rosterAttributionBasis: 'current_membership',
    creatorCoverage: 'not_applicable',
    creatorAttributionBasis: 'not_applicable',
    freshness: 'fresh',
    valueBasis: 'current_membership_qualified',
    comparisonsVerified: false,
  },
  points: [
    { date: '2026-05-20', spendUsd: 10 },
    { date: '2026-09-08', spendUsd: 1234 },
    { date: '2026-09-09', spendUsd: 9999 },
  ],
};

describe('Home budget trajectory', () => {
  it('keeps qualified actuals through as-of and extends only the benchmark through the annual term', () => {
    const data = trajectoryChartData(qualifiedAnnual);

    expect(data.find((point) => point.date === '2026-09-08')?.actual).toBe(1234);
    expect(data.find((point) => point.date === '2026-09-09')).toBeUndefined();
    expect(data.at(-1)).toEqual(expect.objectContaining({
      date: '2027-05-20',
      actual: null,
      benchmark: 9368.38,
    }));
  });

  it('shows the canonical term, tracked allocation, and benchmark without inventing remaining or utilization', () => {
    const markup = renderToStaticMarkup(
      <BudgetTrajectory
        teamName="GPO Connected Living"
        tracking={qualifiedAnnual}
        loading={false}
        error={false}
        onRetry={() => undefined}
        comparisonsMatchBudgetWindow
      />,
    );

    expect(markup).toContain('May 20, 2026–May 20, 2027');
    expect(markup).not.toContain('May 20–Sep 8, 2026');
    expect(markup).toContain('Annual allocation');
    expect(markup).toContain('$9,368.38');
    expect(markup).toContain('Even-paced benchmark');
    expect(markup).toContain('Budget term chart endpoints');
    expect(markup).toContain('May 20, 2027');
    expect(markup).not.toContain('Funding not yet spent');
    expect(markup).not.toContain('% of funding used');
  });
});