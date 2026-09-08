import { describe, expect, it } from 'vitest';
import type { OrgBudgetOverviewResponse } from '@workspace/api-client-react';
import {
  buildOrgBudgetChartData,
  allocationPercent,
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
    fundedTeamCount: 0,
    resolvedTeamCount: 0,
    unresolvedTeamCount: 0,
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
  it('presents per-allocation ratios without changing inclusive trajectory data', () => {
    const alpha = team('alpha', 366, [{ date: '2026-05-20', spendUsd: 183 }], false);
    const beta = team('beta', 3660, [{ date: '2026-05-20', spendUsd: 1830 }]);
    const rows = buildOrgBudgetChartData(overview([alpha, beta]), [alpha, beta]);
    for (const series of [alpha, beta]) {
      expect(allocationPercent(rows[0].values[series.id].actual, series.allocationUsd)).toBe(50);
      expect(allocationPercent(rows[0].values[series.id].benchmark, series.allocationUsd)).toBeCloseTo(100 / 366);
      expect(allocationPercent(rows.at(-1)!.values[series.id].benchmark, series.allocationUsd)).toBe(100);
    }
    expect(rows[0].values.beta.actual).toBe(1830);
  });

  it('does not clamp overspend, replace gaps, or divide by unusable allocations', () => {
    expect(allocationPercent(150, 100)).toBe(150);
    expect(allocationPercent(0, 100)).toBe(0);
    expect(allocationPercent(null, 100)).toBeNull();
    expect(allocationPercent(undefined, 100)).toBeNull();
    for (const allocation of [0, null, undefined, -100, NaN, Infinity]) {
      expect(allocationPercent(50, allocation)).toBeNull();
      expect(allocationPercent(0, allocation)).toBeNull();
    }
    expect(allocationPercent(Number.MAX_VALUE, Number.MIN_VALUE)).toBeNull();
  });

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

  it.each([true, false])('preserves zero and null gaps, and excludes observations after as-of (complete: %s)', complete => {
    const funded = team('a', 366, [
      { date: '2026-05-20', spendUsd: 0 },
      { date: '2026-05-21', spendUsd: null },
      { date: '2026-09-09', spendUsd: 900 },
    ], complete);
    const rows = buildOrgBudgetChartData(overview([funded], { complete }), [funded]);

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
          fundedTeamCount: 1,
          resolvedTeamCount: 1,
          unresolvedTeamCount: 0,
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
          fundedTeamCount: 0,
          resolvedTeamCount: 0,
          unresolvedTeamCount: 0,
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

  it('charts zero allocation with recorded spend against a zero benchmark', () => {
    const zero = team('zero', 0, [{ date: '2026-06-01', spendUsd: 25 }]);
    const data = overview([zero]);
    const funded = getFundedTeams(data.teams);
    const rows = buildOrgBudgetChartData(data, funded);

    expect(funded.map(item => item.id)).toEqual(['zero']);
    expect(rows.find(row => row.date === '2026-06-01')?.values.zero).toEqual({
      actual: 25,
      benchmark: 0,
    });
    expect(rows.at(-1)?.values.zero.benchmark).toBe(0);
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

  it('funds non-negative finite allocations, deduplicated by stable ID', () => {
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
      'zero',
    ]);
    expect(getFundedTeams(teams)[0]).toBe(replacement);
    expect(buildOrgBudgetChartData(overview(teams), [fundedWithoutPoints])).toHaveLength(2);
  });
});