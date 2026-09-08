import { describe, expect, it } from 'vitest';
import { selectDefaultTeam, selectDefaultWorkspace } from './budget-panels';
import { trajectoryChartData } from './budget-trajectory';

describe('Home budget selection and trajectory', () => {
  it('prefers a finite workspace with observed spend without pooling limits', () => {
    expect(selectDefaultWorkspace([
      { workspaceId: 'unlimited', amount: null, state: 'no_limit', currentCycleAgentSpendUsd: 12 },
      { workspaceId: 'finite', amount: 100, state: 'explicit', currentCycleAgentSpendUsd: 20 },
    ])).toBe('finite');
  });

  it('selects only a canonical own funding team', () => {
    expect(selectDefaultTeam([
      { teamName: 'Legacy', amountUsd: 1, spendUsd: 1, spendPeriodLabel: 'Term', spendScope: 'complete', monthlyAgentLimitUsd: null, cycleAgentSpendUsd: null, agentRemainingUsd: null, agentPercentUsed: null, agentBlocked: null, workspaceIds: [] },
      { teamName: 'Own', poolId: 'pool:team:Own', amountUsd: 1, spendUsd: 1, spendPeriodLabel: 'Term', spendScope: 'complete', monthlyAgentLimitUsd: null, cycleAgentSpendUsd: null, agentRemainingUsd: null, agentPercentUsed: null, agentBlocked: null, workspaceIds: [] },
    ])).toBe('pool:team:Own');
  });

  it('builds an inclusive even-paced benchmark and preserves null actual gaps', () => {
    const points = trajectoryChartData({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-03',
      periodLabel: 'Budget period',
      asOf: '2026-01-02',
      allocationUsd: 300,
      spendUsd: 10,
      remainingUsd: 290,
      percentUsed: 3.3,
      scopeComplete: true,
      usageComplete: true,
      benchmarkEligible: true,
      qualification: null,
      points: [{ date: '2026-01-01', spendUsd: 0 }, { date: '2026-01-02', spendUsd: null }],
    });
    expect(points.map((point) => point.benchmark)).toEqual([100, 200, 300]);
    expect(points[1].actual).toBeNull();
    expect(points[2].day - points[0].day).toBe(2);
  });

  it('spaces sparse actual dates and the future budget end by calendar time', () => {
    const points = trajectoryChartData({
      periodStart: '2026-05-20',
      periodEnd: '2027-05-20',
      periodLabel: 'Confirmed funding period',
      asOf: '2026-05-21',
      allocationUsd: 366,
      spendUsd: 10,
      remainingUsd: 356,
      percentUsed: 10 / 366 * 100,
      scopeComplete: true,
      usageComplete: true,
      benchmarkEligible: true,
      qualification: null,
      points: [{ date: '2026-05-20', spendUsd: 5 }, { date: '2026-05-21', spendUsd: 10 }],
    });
    expect(points.map((point) => point.benchmark)).toEqual([1, 2, 366]);
    expect(points[2].day - points[1].day).toBe(364);
    expect(points[2].actual).toBeNull();
  });

  it('keeps a selected trajectory on its reporting dates instead of extending it to the allocation end', () => {
    const points = trajectoryChartData({
      periodStart: '2026-05-20',
      periodEnd: '2027-05-20',
      periodLabel: 'Confirmed funding period',
      reportingStart: '2026-09-01',
      reportingEnd: '2026-09-03',
      reportingLabel: 'Sep 1–3, 2026',
      asOf: '2026-09-03',
      allocationUsd: 365,
      spendUsd: 20,
      remainingUsd: null,
      percentUsed: null,
      scopeComplete: true,
      usageComplete: true,
      benchmarkEligible: false,
      qualification: null,
      points: [
        { date: '2026-05-20', spendUsd: 5 },
        { date: '2026-09-02', spendUsd: 10 },
        { date: '2027-05-20', spendUsd: 30 },
      ],
    });
    expect(points.map((point) => point.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);
  });
});