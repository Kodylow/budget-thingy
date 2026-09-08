import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PersonalBudgetPanel, TeamBudgetPanel, type CanonicalTeamBudget, type TeamBudgetTracking } from './budget-panels';

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    isAccountAdmin: false,
    isWorkspaceAdmin: false,
    isTeamAdmin: false,
    capabilities: { canEditAllocations: false },
  }),
}));

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const team: CanonicalTeamBudget = {
  poolId: 'pool:one',
  teamName: 'One',
  amountUsd: 1200,
  spendUsd: 900,
  spendPeriodLabel: '2026 funding year',
  spendScope: 'complete',
  monthlyAgentLimitUsd: null,
  cycleAgentSpendUsd: null,
  agentRemainingUsd: null,
  agentPercentUsed: null,
  agentBlocked: null,
  workspaceIds: ['workspace'],
};

const tracking: TeamBudgetTracking = {
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  periodLabel: '2026 funding year',
  reportingLabel: 'Wrong API label',
  asOf: '2026-06-01',
  allocationUsd: 1200,
  spendUsd: 0,
  remainingUsd: 1200,
  percentUsed: 0,
  scopeComplete: true,
  usageComplete: true,
  benchmarkEligible: true,
  qualification: 'Internal qualification',
  points: [],
};

describe('home budget panels', () => {
  it('renders selected spend once and keeps nonmatching limit comparisons hidden', () => {
    const markup = renderToStaticMarkup(<PersonalBudgetPanel
      workspaceName="Workspace"
      selectedAgentSpendUsd={0}
      selectedPeriodLabel="Jun 1–3"
      billingPeriodLabel="June billing cycle"
      showCurrentCycleComparison={false}
      limit={{ workspaceId: 'workspace', amount: 100, state: 'explicit', currentCycleAgentSpendUsd: 0, currentCycleRemainingUsd: 100, currentCyclePercentUsed: 0 }}
    />);
    expect(markup).toContain('My Agent usage');
    expect(markup.match(/Jun 1–3/g)).toHaveLength(1);
    expect(markup).toContain('$0.00');
    expect(markup).not.toContain('Personal spend and monthly limit');
    expect(markup).not.toContain('remaining this billing period');
    expect(markup).not.toContain('unavailable');
  });

  it('preserves zero team spend and hides nonmatching annual comparisons and qualifications', () => {
    const markup = renderToStaticMarkup(<TeamBudgetPanel
      team={team}
      tracking={tracking}
      loading={false}
      error={false}
      onRetry={() => undefined}
      search=""
      selectedPeriodLabel="Jun 1–3"
      comparisonsMatchBudgetWindow={false}
    />);
    expect(markup).toContain('$0.00');
    expect(markup).toContain('Jun 1–3');
    expect(markup).not.toContain('Wrong API label');
    expect(markup).not.toContain('remaining in this budget period');
    expect(markup).not.toContain('Internal qualification');
    expect(markup).not.toContain('no budget');
  });

  it('keeps errors distinct from empty or zero spend and offers Retry', () => {
    const markup = renderToStaticMarkup(<TeamBudgetPanel
      team={team}
      tracking={null}
      loading={false}
      error
      onRetry={() => undefined}
      search=""
      selectedPeriodLabel="Jun 1–3"
      comparisonsMatchBudgetWindow={false}
    />);
    expect(markup).toContain('Team budget unavailable');
    expect(markup).toContain('Retry');
    expect(markup).not.toContain('$0.00');
  });
});