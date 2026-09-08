// @vitest-environment happy-dom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './home';
import { trajectoryChartData } from './home-components/budget-trajectory';

vi.stubGlobal('React', React);

const mocks = vi.hoisted(() => ({
  range: { rangeType: 'custom', startDate: '2026-04-03', endDate: '2026-04-19' } as {
    rangeType: 'custom' | 'mtd' | 'ytd' | 'billing' | 'full-term';
    startDate?: string;
    endDate?: string;
  },
  dashboard: vi.fn(),
  comparison: vi.fn(),
  teamBudgets: vi.fn(),
  teamReport: vi.fn(),
  membership: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('wouter', () => ({
  Link: ({ children, href }: any) => <a href={href}>{children}</a>,
  useLocation: () => ['/', vi.fn()],
  useSearch: () => window.location.search,
}));

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    user: { id: 'member-1' },
    authorizationKey: 'authorization-member-1',
    isAccountAdmin: false,
    capabilities: { canViewAccountUsage: false },
    preview: null,
    availability: 'authorized',
  }),
}));

vi.mock('@/components/range-context', () => ({
  useRange: () => mocks.range,
}));

vi.mock('@/components/range-filter', () => ({
  RangeFilter: ({ selectedLabel, allowedSelections }: { selectedLabel: string; allowedSelections?: string[] }) => (
    <output aria-label="Selected range">{selectedLabel} · Full term · {allowedSelections?.join(',')}</output>
  ),
}));

vi.mock('@/components/admin-data-quality', () => ({
  AdminDataQualityNote: ({ title, children }: any) => <aside aria-label={title}>{children}</aside>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) => <article {...props}>{children}</article>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardDescription: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  CardHeader: ({ children, ...props }: any) => <header {...props}>{children}</header>,
  CardTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <>{children}</>,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: (props: any) => <span aria-label="Loading" {...props} />,
}));

vi.mock('./home-components/membership-context', () => ({
  resolvePersonalWorkspace: (context: any, requested: string | null) => {
    const workspace = context?.workspaces?.find(
      (item: any) => item.workspaceId === (requested || context.defaultWorkspaceId),
    ) ?? null;
    return { status: workspace ? 'resolved' : 'choose', workspace };
  },
  searchAfterEffectiveIdentityChange: (search: string) => search,
  MembershipContextSummary: ({ workspace }: any) => (
    <p aria-label="Membership context">{workspace.workspaceName}</p>
  ),
}));

vi.mock('./home-components/budget-panels', () => ({
  PersonalBudgetPanel: (props: any) => (
    <section aria-label="Personal budget">
      <output aria-label="Personal selected period">{props.selectedPeriodLabel}</output>
      <output aria-label="Personal selected spend">{String(props.selectedAgentSpendUsd)}</output>
      <output aria-label="Personal monthly limit">{String(props.limit?.amount)}</output>
    </section>
  ),
  TeamBudgetPanel: ({ team, tracking, selectedPeriodLabel, wholeBudgetMode, error, onRetry }: any) => (
    <section aria-label={`${team.teamName} team budget`}>
      <output aria-label="Team selected period">{selectedPeriodLabel}</output>
      <output aria-label="Team selected spend">{String(tracking?.spendUsd)}</output>
      <output aria-label="Team tracked allocation">{String(tracking?.allocationUsd)}</output>
      <output aria-label="Team budget kind">{String(tracking?.budgetKind)}</output>
      <output aria-label="Team workspace scope">{tracking?.scopeComplete && wholeBudgetMode ? `Full team · ${tracking.workspaceCount} workspaces` : 'Partial tracking'}</output>
      {error && <button onClick={onRetry}>Retry team report</button>}
    </section>
  ),
}));

vi.mock('./home-components/budget-trajectory', async () => {
  const actual = await vi.importActual<typeof import('./home-components/budget-trajectory')>('./home-components/budget-trajectory');
  return {
    ...actual,
    BudgetTrajectory: ({ teamName }: any) => <div aria-label={`${teamName} trajectory`} />,
  };
});

vi.mock('./home-components/spend-story-chart', () => ({
  SpendStoryChart: ({ scope }: any) => <div aria-label={`${scope} spend story`} />,
}));

vi.mock('./dashboard-chart', () => ({
  default: () => <div aria-label="Selected-period trend chart" />,
}));

vi.mock('@workspace/api-client-react', () => ({
  getGetMyMembershipContextQueryKey: () => ['membership-context'],
  getGetDashboardQueryKey: (params: any) => ['dashboard', params],
  getGetBillingCycleComparisonQueryKey: (params: any) => ['billing-comparison', params],
  getGetTeamsBudgetsQueryKey: (params: any) => ['team-budgets', params],
  getGetBudgetTeamReportQueryKey: (poolId: string, params: any) => ['team-report', poolId, params],
  useGetMyMembershipContext: (...args: any[]) => mocks.membership(...args),
  useGetDashboard: (...args: any[]) => mocks.dashboard(...args),
  useGetBillingCycleComparison: (...args: any[]) => mocks.comparison(...args),
  useGetTeamsBudgets: (...args: any[]) => mocks.teamBudgets(...args),
  useGetBudgetTeamReport: (...args: any[]) => mocks.teamReport(...args),
}));

const workspace = {
  workspaceId: 'workspace-1',
  workspaceName: 'Workspace One',
  budgetTeams: [{ poolId: 'pool-1', teamName: 'Platform' }],
};

const dashboardData = {
  period: { label: 'Apr 3–19, 2026' },
  personalSpendByWorkspace: [{
    workspaceId: 'workspace-1',
    agentSpendUsd: 47.25,
  }],
  personalLimits: [{
    workspaceId: 'workspace-1',
    amount: 900,
    state: 'explicit',
    currentCycleAgentSpendUsd: 810,
  }],
  insights: { activeDays: 4, activeProjects: 73 },
  trend: { granularity: 'day', mode: 'period', buckets: [{ date: '2026-04-03', spendUsd: 1 }] },
  metadata: { qualifications: [], dataAsOf: null },
};

const selectedTracking = {
  budgetKind: 'annual' as const,
  workspaceCount: 1,
  periodStart: '2026-04-03',
  periodEnd: '2026-04-19',
  periodLabel: 'Apr 3–19, 2026',
  allocationUsd: 2000,
  spendUsd: 321,
  remainingUsd: 1679,
  percentUsed: 16.05,
  scopeComplete: true,
  usageComplete: true,
  benchmarkEligible: true,
  qualification: null,
  comparisonsMatchBudgetWindow: true,
  asOf: '2026-04-19',
  points: [{ date: '2026-04-03', spendUsd: 0 }],
};

function query(data: any, overrides: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    refetch: mocks.refetch,
    ...overrides,
  };
}

function renderHome() {
  return new DOMParser().parseFromString(renderToStaticMarkup(<Home />), 'text/html').body;
}

function calledQueryOptions(mock: ReturnType<typeof vi.fn>) {
  const call = mock.mock.calls.at(-1)!;
  return call[call.length - 1].query;
}

describe('Home selected-period regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/?workspaceId=workspace-1');
    mocks.range = { rangeType: 'custom', startDate: '2026-04-03', endDate: '2026-04-19' };
    mocks.membership.mockReturnValue(query({
      defaultWorkspaceId: 'workspace-1',
      workspaces: [workspace],
      qualification: null,
    }));
    mocks.dashboard.mockReturnValue(query(dashboardData));
    mocks.comparison.mockReturnValue(query({
      hasTeams: true,
      cycles: [{
        key: 'current',
        label: 'Selected comparison',
        startDate: '2026-04-03',
        endDate: '2026-04-19',
        points: [{ date: '2026-04-03', personalSpendUsd: 0, teamSpendUsd: 0 }],
      }],
    }));
    mocks.teamBudgets.mockReturnValue(query({
      budgets: [{
        poolId: 'pool-1',
        teamName: 'Platform',
        allocationUsd: 10_000,
        spendUsd: 8_888,
      }],
    }));
    mocks.teamReport.mockReturnValue(query({ budgetTracking: selectedTracking }));
  });

  it.each(['custom', 'mtd', 'ytd'] as const)('normalizes a legacy Home %s range before issuing requests', (legacyRange) => {
    mocks.range = legacyRange === 'custom'
      ? { rangeType: legacyRange, startDate: '2026-04-03', endDate: '2026-04-19' }
      : { rangeType: legacyRange };
    renderHome();

    expect(mocks.dashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rangeType: 'full-term',
        startDate: undefined,
        endDate: undefined,
      }),
      expect.anything(),
    );
    expect(mocks.comparison.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      rangeType: 'full-term',
      startDate: undefined,
      endDate: undefined,
    }));
    expect(mocks.teamReport.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      rangeType: 'full-term',
      startDate: undefined,
      endDate: undefined,
      includeBudgetTracking: true,
      trackingRange: 'budget',
    }));
    for (const request of [mocks.dashboard, mocks.comparison, mocks.teamReport]) {
      expect(calledQueryOptions(request).queryKey).toEqual(expect.arrayContaining([
        'authorization-member-1',
      ]));
      expect(JSON.stringify(calledQueryOptions(request).queryKey)).not.toContain('2026-04-03');
      expect(JSON.stringify(calledQueryOptions(request).queryKey)).not.toContain('2026-04-19');
    }
  });

  it('offers only full-term and billing-period choices on Home', () => {
    const range = renderHome().querySelector('[aria-label="Selected range"]')?.textContent;
    expect(range).toContain('Full term');
    expect(range).toContain('full-term,billing');
    expect(range).not.toContain('mtd');
    expect(range).not.toContain('custom');
  });

  it('requests the canonical annual budget window and keeps its benchmark visible with partial usage', () => {
    mocks.range = { rangeType: 'full-term' };
    mocks.teamReport.mockReturnValue(query({
      budgetTracking: {
        ...selectedTracking,
        periodStart: '2026-05-20',
        periodEnd: '2027-05-20',
        periodLabel: 'May 20, 2026–May 20, 2027',
        allocationUsd: 9368.38,
        spendUsd: 4321,
        remainingUsd: null,
        percentUsed: null,
        usageComplete: false,
        benchmarkEligible: true,
        points: [{ date: '2026-06-01', spendUsd: null }],
      },
    }));

    const body = renderHome();

    expect(mocks.teamReport.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      trackingRange: 'budget',
      scope: 'own',
      workspaceId: 'workspace-1',
    }));
    expect(body.querySelector('[aria-label="Team tracked allocation"]')?.textContent).toBe('9368.38');
    expect(body.querySelector('[aria-label="Platform trajectory"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="Team workspace scope"]')?.textContent).toBe('Full team · 1 workspaces');
  });

  it('requests billing tracking and uses its monthly Agent values rather than the annual team amount', () => {
    mocks.range = { rangeType: 'billing' };
    mocks.teamReport.mockReturnValue(query({
      budgetTracking: {
        ...selectedTracking,
        budgetKind: 'monthly_agent',
        periodStart: '2026-04-20',
        periodEnd: '2026-05-19',
        periodLabel: 'Apr 20–May 19, 2026',
        allocationUsd: 750,
        spendUsd: 125,
        remainingUsd: 625,
        percentUsed: 16.67,
      },
    }));

    const body = renderHome();

    expect(mocks.teamReport.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      trackingRange: 'billing',
      scope: 'own',
      workspaceId: 'workspace-1',
    }));
    expect(body.querySelector('[aria-label="Team budget kind"]')?.textContent).toBe('monthly_agent');
    expect(body.querySelector('[aria-label="Team tracked allocation"]')?.textContent).toBe('750');
    expect(body.querySelector('[aria-label="Team tracked allocation"]')?.textContent).not.toBe('10000');
    expect(body.querySelector('[aria-label="Team selected spend"]')?.textContent).toBe('125');
  });

  it('does not claim full-team scope when whole-budget tracking is partial', () => {
    mocks.range = { rangeType: 'full-term' };
    mocks.teamReport.mockReturnValue(query({
      budgetTracking: { ...selectedTracking, workspaceCount: 2, scopeComplete: false },
    }));

    const body = renderHome();
    expect(body.querySelector('[aria-label="Team workspace scope"]')?.textContent).toBe('Partial tracking');
    expect(body.textContent).not.toContain('Full team · 2 workspaces');
  });

  it('extends eligible annual and monthly benchmark domains through their full budget periods', () => {
    const annual = trajectoryChartData({
      ...selectedTracking,
      comparisonsMatchBudgetWindow: true,
      periodStart: '2026-05-20',
      periodEnd: '2027-05-20',
      reportingStart: '2026-05-20',
      reportingEnd: '2026-09-08',
      asOf: '2026-09-08',
       allocationUsd: 9368.38,
      points: [
        { date: '2026-05-20', spendUsd: 10 },
        { date: '2026-09-08', spendUsd: 3000 },
      ],
    });
    expect(annual.at(-1)).toEqual(expect.objectContaining({
      date: '2027-05-20',
      actual: null,
       benchmark: 9368.38,
    }));

    const monthly = trajectoryChartData({
      ...selectedTracking,
      budgetKind: 'monthly_agent',
      comparisonsMatchBudgetWindow: true,
      periodStart: '2026-08-20',
      periodEnd: '2026-09-19',
      reportingStart: '2026-08-20',
      reportingEnd: '2026-09-08',
      asOf: '2026-09-08',
      allocationUsd: 750,
      points: [{ date: '2026-09-08', spendUsd: 125 }],
    });
    expect(monthly.at(-1)).toEqual(expect.objectContaining({
      date: '2026-09-19',
      actual: null,
      benchmark: 750,
    }));

    const selected = trajectoryChartData({
      ...selectedTracking,
      comparisonsMatchBudgetWindow: false,
      periodStart: '2026-05-20',
      periodEnd: '2027-05-20',
      reportingStart: '2026-08-01',
      reportingEnd: '2026-09-08',
      points: [{ date: '2026-09-08', spendUsd: 125 }],
    });
    expect(selected.map((point) => point.date)).toEqual(['2026-08-01', '2026-09-08']);
    expect(selected.every((point) => point.benchmark == null)).toBe(true);
  });

  it('labels main panels from the dashboard and uses selected-period spend rather than limit or annual lookup values', () => {
    const body = renderHome();

    expect(body.querySelector('[aria-label="Personal selected period"]')?.textContent).toBe('Apr 3–19, 2026');
    expect(body.querySelector('[aria-label="Personal selected spend"]')?.textContent).toBe('47.25');
    expect(body.querySelector('[aria-label="Personal selected spend"]')?.textContent).not.toBe('900');
    expect(body.querySelector('[aria-label="Team selected period"]')?.textContent).toBe('Apr 3–19, 2026');
    expect(body.querySelector('[aria-label="Team selected spend"]')?.textContent).toBe('321');
    expect(body.querySelector('[aria-label="Team selected spend"]')?.textContent).not.toBe('8888');
  });

  it('hides sections that have no teams, comparison points, activity, or trend observations', () => {
    mocks.membership.mockReturnValue(query({
      defaultWorkspaceId: 'workspace-1',
      workspaces: [{ ...workspace, budgetTeams: [] }],
    }));
    mocks.teamBudgets.mockReturnValue(query({ budgets: [] }));
    mocks.comparison.mockReturnValue(query({ hasTeams: false, cycles: [] }));
    mocks.dashboard.mockReturnValue(query({
      ...dashboardData,
      insights: { activeDays: null },
      trend: { ...dashboardData.trend, buckets: [] },
    }));

    const body = renderHome();
    expect(body.querySelector('[aria-label$="team budget"]')).toBeNull();
    expect(body.querySelector('[aria-label$="spend story"]')).toBeNull();
    expect(body.querySelector('[aria-label="Selected-period trend chart"]')).toBeNull();
    expect(body.textContent).not.toContain('Activity');
  });

  it('keeps observed zero values visible', () => {
    mocks.dashboard.mockReturnValue(query({
      ...dashboardData,
      personalSpendByWorkspace: [{ workspaceId: 'workspace-1', agentSpendUsd: 0 }],
      insights: { activeDays: 0 },
      trend: { ...dashboardData.trend, buckets: [{ date: '2026-04-03', spendUsd: 0 }] },
    }));

    const body = renderHome();
    expect(body.querySelector('[aria-label="Personal selected spend"]')?.textContent).toBe('0');
    expect(body.querySelector('[aria-label="personal spend story"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="Selected-period trend chart"]')).not.toBeNull();
    expect(body.textContent).toContain('0 active days');
  });

  it('retains retry actions for dashboard, team lookup, comparison, and team-report errors', () => {
    mocks.dashboard.mockReturnValue(query(dashboardData, { isError: true }));
    mocks.teamBudgets.mockReturnValue(query({
      budgets: [{ poolId: 'pool-1', teamName: 'Platform' }],
    }, { isError: true }));
    mocks.comparison.mockReturnValue(query(undefined, { isError: true }));
    mocks.teamReport.mockReturnValue(query(undefined, { isError: true }));

    const buttons = [...renderHome().querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons.filter((text) => text?.includes('Retry')).length).toBeGreaterThanOrEqual(3);
    expect(buttons).toContain('Retry team report');
  });

  it('does not substitute selected-period active-project analytics for missing current project inventory', () => {
    mocks.dashboard.mockReturnValue(query({
      ...dashboardData,
      personalProjectCatalog: undefined,
      insights: { ...dashboardData.insights, activeProjects: 73 },
    }));

    const body = renderHome();
    expect(body.textContent).not.toContain('73 active projects');
    expect(body.textContent).not.toContain('Current project inventory: 73');
  });
});
