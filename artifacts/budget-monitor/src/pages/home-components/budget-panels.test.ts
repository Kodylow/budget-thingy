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
    expect(points.map((point) => point.benchmark)).toEqual([0, 150, 300]);
    expect(points[1].actual).toBeNull();
  });
});