import { describe, expect, it } from 'vitest';
import type { OrgBudgetOverviewResponse } from '@workspace/api-client-react';
import {
  buildOrgBudgetChartData,
  getFundedTeams,
  TOTAL_SERIES_ID,
  type OrgChartSeries,
} from './org-budget-chart-data';

const reporting = {
  acquisitionCoverage: 'complete',
  rosterAttributionBasis: 'observed_roster',
  creatorCoverage: 'complete',
  creatorAttributionBasis: 'not_applicable',
  freshness: 'fresh',
  valueBasis: 'verified',
  comparisonsVerified: true,
} as const;

const team = (
  id: string,
  allocationUsd: number | null,
  points: { date: string; spendUsd: number | null }[] = [],
  complete = true,
) => ({
  id,
  name: id,
  allocationUsd,
  spendUsd: points.at(-1)?.spendUsd ?? null,
  remainingUsd: null,
  percentUsed: null,
  complete,
  reporting,
  points,
});

const overview = (
  teams: OrgBudgetOverviewResponse['teams'],
  overrides: Partial<OrgBudgetOverviewResponse> = {},
): OrgBudgetOverviewResponse => ({
  periodStart: '2026-05-20',
  periodEnd: '2027-05-20',
  asOf: '2026-09-08',
  complete: true,
  reporting,
  qualification: null,
  summary: {
    accountSpendUsd: null,
    teamAllocationUsd: null,
    remainingUsd: null,
    teamsOverBudget: null,
    unassignedSpendUsd: null,
  },
  accountPoints: [],
  teams,
  ...overrides,
});

const totalSeries = (data: OrgBudgetOverviewResponse): OrgChartSeries => ({
  id: TOTAL_SERIES_ID,
  name: 'Total',
  allocationUsd: data.summary.teamAllocationUsd,
  spendUsd: data.summary.accountSpendUsd,
  complete: data.complete,
  points: data.accountPoints,
});

describe('organization budget chart data', () => {
  it('reuses the Home inclusive budget pace through the exact term end', () => {
    const funded = team('funded', 3660, [{ date: '2026-05-20', spendUsd: 0 }]);
    const rows = buildOrgBudgetChartData(overview([funded]), [funded]);

    expect(rows[0]).toEqual(expect.objectContaining({
      date: '2026-05-20',
      values: { funded: { actual: 0, benchmark: 10 } },
    }));
    expect(rows.at(-1)).toEqual(expect.objectContaining({
      date: '2027-05-20',
      values: { funded: { actual: null, benchmark: 3660 } },
    }));
  });

  it('preserves zero and null gaps, and excludes observations after as-of', () => {
    const funded = team('a', 366, [
      { date: '2026-05-20', spendUsd: 0 },
      { date: '2026-05-21', spendUsd: null },
      { date: '2026-09-09', spendUsd: 900 },
    ]);
    const rows = buildOrgBudgetChartData(overview([funded]), [funded]);

    expect(rows.find(row => row.date === '2026-05-20')?.values.a.actual).toBe(0);
    expect(rows.find(row => row.date === '2026-05-21')?.values.a.actual).toBeNull();
    expect(rows.find(row => row.date === '2026-09-09')).toBeUndefined();
  });

  it('uses the cross-team observation-date union without inventing actuals', () => {
    const alpha = team('alpha', 366, [{ date: '2026-05-21', spendUsd: 12 }]);
    const beta = team('beta', 732, [{ date: '2026-05-22', spendUsd: 34 }]);
    const rows = buildOrgBudgetChartData(overview([alpha, beta]), [alpha, beta]);

    expect(rows.find(row => row.date === '2026-05-21')?.values).toMatchObject({
      alpha: { actual: 12 },
      beta: { actual: null },
    });
    expect(rows.find(row => row.date === '2026-05-22')?.values).toMatchObject({
      alpha: { actual: null },
      beta: { actual: 34 },
    });
  });

  it('uses account observations unchanged for Total, including unassigned spend', () => {
    const data = overview(
      [team('assigned', 200, [{ date: '2026-06-01', spendUsd: 40 }])],
      {
        summary: {
          accountSpendUsd: 65,
          teamAllocationUsd: 366,
          remainingUsd: 301,
          teamsOverBudget: 0,
          unassignedSpendUsd: 25,
        },
        accountPoints: [
          { date: '2026-05-20', spendUsd: 0 },
          { date: '2026-06-01', spendUsd: 65 },
        ],
      },
    );
    const rows = buildOrgBudgetChartData(data, [totalSeries(data)]);

    expect(rows.find(row => row.date === '2026-05-20')?.values[TOTAL_SERIES_ID]).toEqual({
      actual: 0,
      benchmark: 1,
    });
    expect(rows.find(row => row.date === '2026-06-01')?.values[TOTAL_SERIES_ID].actual).toBe(65);
    expect(rows.at(-1)?.values[TOTAL_SERIES_ID]).toEqual({
      actual: null,
      benchmark: 366,
    });
  });

  it('preserves Total nulls and zeroes and clips partial account history at as-of', () => {
    const data = overview([], {
      complete: false,
      asOf: '2026-05-21',
      summary: {
        accountSpendUsd: null,
        teamAllocationUsd: null,
        remainingUsd: null,
        teamsOverBudget: null,
        unassignedSpendUsd: null,
      },
      accountPoints: [
        { date: '2026-05-20', spendUsd: 0 },
        { date: '2026-05-21', spendUsd: null },
        { date: '2026-05-22', spendUsd: 20 },
      ],
    });
    const rows = buildOrgBudgetChartData(data, [totalSeries(data)]);

    expect(rows.find(row => row.date === '2026-05-20')?.values[TOTAL_SERIES_ID]).toEqual({
      actual: 0,
      benchmark: null,
    });
    expect(rows.find(row => row.date === '2026-05-21')?.values[TOTAL_SERIES_ID]).toEqual({
      actual: null,
      benchmark: null,
    });
    expect(rows.find(row => row.date === '2026-05-22')).toBeUndefined();
  });

  it('keeps a known allocation benchmark despite incomplete usage', () => {
    const incomplete = team('partial', 366, [{ date: '2026-06-01', spendUsd: 5 }], false);
    const rows = buildOrgBudgetChartData(overview([incomplete], { complete: false }), [incomplete]);

    expect(rows.at(-1)?.values.partial.benchmark).toBe(366);
  });

  it('shows a known plan but no actual when as-of is missing', () => {
    const funded = team('planned', 366, [{ date: '2026-06-01', spendUsd: 99 }]);
    const rows = buildOrgBudgetChartData(overview([funded], { asOf: null }), [funded]);

    expect(rows.map(row => row.date)).toEqual(['2026-05-20', '2027-05-20']);
    expect(rows.every(row => row.values.planned.actual === null)).toBe(true);
    expect(rows.at(-1)?.values.planned.benchmark).toBe(366);
  });

  it('does not calculate pace for invalid terms', () => {
    const funded = team('funded', 100, [{ date: '2026-06-01', spendUsd: 4 }]);
    const rows = buildOrgBudgetChartData(
      overview([funded], { periodStart: '2027-05-20', periodEnd: '2026-05-20' }),
      [funded],
    );

    expect(rows.every(row => row.values.funded.benchmark === null)).toBe(true);
  });

  it('funds only positive finite allocations, deduplicated by stable ID', () => {
    const first = { ...team('same-id', 10), name: 'Duplicate name' };
    const replacement = { ...team('same-id', 20), name: 'Other duplicate name' };
    const sameName = { ...team('other-id', 30), name: 'Duplicate name' };
    const fundedWithoutPoints = team('no-points', 40);
    const teams = [
      first,
      replacement,
      sameName,
      fundedWithoutPoints,
      team('zero', 0),
      team('negative', -1),
      team('missing', null),
      team('infinite', Number.POSITIVE_INFINITY),
      team('nan', Number.NaN),
    ];

    expect(getFundedTeams(teams).map(item => item.id)).toEqual([
      'same-id',
      'other-id',
      'no-points',
    ]);
    expect(getFundedTeams(teams)[0]).toBe(replacement);
    expect(buildOrgBudgetChartData(overview(teams), [fundedWithoutPoints])).toHaveLength(2);
  });
});