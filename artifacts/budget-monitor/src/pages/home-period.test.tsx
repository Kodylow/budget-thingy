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
  RangeFilter: ({ selectedLabel, ...props }: { selectedLabel: string }) => (
    <output aria-label="Selected range" data-props={Object.keys(props).join(',')}>{selectedLabel} · Full term · Billing period</output>
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
}));

vi.mock('./home-components/budget-trajectory', async () => {
  const actual = await vi.importActual<typeof import('./home-components/budget-trajectory')>('./home-components/budget-trajectory');
  return {
    ...actual,
    BudgetTrajectory: ({ teamName, tracking, loading, refreshingUsage, error, onRetry }: any) => (
      <section aria-label={`${teamName} trajectory`}>
        {loading && <output aria-label="Loading budget trajectory" />}
        <output aria-label="Refreshing usage">{String(refreshingUsage)}</output>
        <output aria-label="Trajectory period">{tracking?.periodLabel}</output>
        <output aria-label="Trajectory spend">{String(tracking?.spendUsd)}</output>
        <output aria-label="Trajectory allocation">{String(tracking?.allocationUsd)}</output>
        <output aria-label="Trajectory budget kind">{String(tracking?.budgetKind)}</output>
        <output aria-label="Trajectory workspace scope">
          {tracking?.scopeComplete ? `Full team · ${tracking.workspaceCount} workspaces` : 'Partial tracking'}
        </output>
        {error && <button onClick={onRetry}>Retry budget trajectory</button>}
      </section>
    ),
  };
});

vi.mock('./home-components/spend-story-chart', () => ({
  SpendStoryChart: ({ cycles, scope }: any) => (
    <div
      aria-label={`${scope} spend story`}
      data-cycle-keys={cycles.map((cycle: any) => cycle.key).join(',')}
    />
  ),
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
    const filter = renderHome().querySelector('[aria-label="Selected range"]');
    const range = filter?.textContent;
    expect(range).toContain('Full term');
    expect(range).toContain('Billing period');
    expect(range).not.toContain('mtd');
    expect(range).not.toContain('custom');
    expect(filter?.getAttribute('data-props')).toBe('');
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
    expect(body.querySelector('[aria-label="Trajectory allocation"]')?.textContent).toBe('9368.38');
    expect(body.querySelector('[aria-label="Platform trajectory"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="Trajectory workspace scope"]')?.textContent).toBe('Full team · 1 workspaces');
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
    expect(body.querySelector('[aria-label="Trajectory budget kind"]')?.textContent).toBe('monthly_agent');
    expect(body.querySelector('[aria-label="Trajectory allocation"]')?.textContent).toBe('750');
    expect(body.querySelector('[aria-label="Trajectory allocation"]')?.textContent).not.toBe('10000');
    expect(body.querySelector('[aria-label="Trajectory spend"]')?.textContent).toBe('125');
  });

  it('does not claim full-team scope when whole-budget tracking is partial', () => {
    mocks.range = { rangeType: 'full-term' };
    mocks.teamReport.mockReturnValue(query({
      budgetTracking: { ...selectedTracking, workspaceCount: 2, scopeComplete: false },
    }));

    const body = renderHome();
    expect(body.querySelector('[aria-label="Trajectory workspace scope"]')?.textContent).toBe('Partial tracking');
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

  it('labels the personal panel and trajectory from canonical data rather than unrelated budget lookup values', () => {
    const body = renderHome();

    expect(body.querySelector('[aria-label="Personal selected period"]')?.textContent).toBe('Full term');
    expect(body.querySelector('[aria-label="Personal selected spend"]')?.textContent).toBe('47.25');
    expect(body.querySelector('[aria-label="Personal selected spend"]')?.textContent).not.toBe('900');
    expect(body.querySelector('[aria-label="Trajectory period"]')?.textContent).toBe('Apr 3–19, 2026');
    expect(body.querySelector('[aria-label="Trajectory spend"]')?.textContent).toBe('321');
    expect(body.querySelector('[aria-label="Trajectory spend"]')?.textContent).not.toBe('8888');
  });

  it('places My spend once beside the personal panel and before the full-width trajectory', () => {
    const body = renderHome();
    const personalPanel = body.querySelector('[aria-label="Personal budget"]');
    const personalStory = body.querySelector('[aria-label="personal spend story"]');
    const trajectory = body.querySelector('[aria-label="Platform trajectory"]');

    expect(body.querySelectorAll('[aria-label="personal spend story"]')).toHaveLength(1);
    expect(body.textContent?.match(/My spend/g)).toHaveLength(1);
    expect(personalPanel).not.toBeNull();
    expect(personalStory).not.toBeNull();
    expect(trajectory).not.toBeNull();
    expect(personalPanel?.compareDocumentPosition(personalStory!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(personalStory?.compareDocumentPosition(trajectory!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(trajectory?.parentElement?.className).toContain('lg:col-span-2');
    expect(body.querySelector('[aria-label$="team budget"]')).toBeNull();
  });

  it('passes only the current cycle to My spend for full-term', () => {
    mocks.range = { rangeType: 'full-term' };
    mocks.comparison.mockReturnValue(query({
      hasTeams: true,
      cycles: [
        { key: 'current', label: 'Full term', points: [{ personalSpendUsd: 5 }] },
        { key: 'previous', label: 'Previous', points: [{ personalSpendUsd: 4 }] },
        { key: 'twoAgo', label: 'Two ago', points: [{ personalSpendUsd: 3 }] },
      ],
    }));

    const story = renderHome().querySelector('[aria-label="personal spend story"]');
    expect(story?.getAttribute('data-cycle-keys')).toBe('current');
  });

  it('passes all known comparison cycles to My spend for billing', () => {
    mocks.range = { rangeType: 'billing' };
    mocks.comparison.mockReturnValue(query({
      hasTeams: true,
      cycles: [
        { key: 'current', label: 'Current', points: [{ personalSpendUsd: 0 }] },
        { key: 'previous', label: 'Previous', points: [{ personalSpendUsd: 4 }] },
        { key: 'twoAgo', label: 'Two ago', points: [{ personalSpendUsd: 3 }] },
      ],
    }));

    const story = renderHome().querySelector('[aria-label="personal spend story"]');
    expect(story?.getAttribute('data-cycle-keys')).toBe('current,previous,twoAgo');
  });

  it('hides full-term My spend when current is empty even if a prior cycle is known', () => {
    mocks.range = { rangeType: 'full-term' };
    mocks.comparison.mockReturnValue(query({
      hasTeams: true,
      cycles: [
        { key: 'current', label: 'Full term', points: [{ personalSpendUsd: null }] },
        { key: 'previous', label: 'Previous', points: [{ personalSpendUsd: 4 }] },
      ],
    }));

    expect(renderHome().querySelector('[aria-label="personal spend story"]')).toBeNull();
  });

  it('removes the lower comparison, trend, and activity cards', () => {
    const body = renderHome();

    expect(body.querySelector('[aria-label="team spend story"]')).toBeNull();
    expect(body.querySelector('[aria-label="Selected-period trend chart"]')).toBeNull();
    expect(body.textContent).not.toContain('My Spend Story');
    expect(body.textContent).not.toContain('Team spend');
    expect(body.textContent).not.toContain('Selected-period trend');
    expect(body.textContent).not.toContain('Activity');
    expect(body.querySelector('#monthly-context')).toBeNull();
    expect(body.querySelector('[aria-label="Selected-period spend comparisons"]')).toBeNull();
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
    expect(body.querySelector('[aria-label$="trajectory"]')).toBeNull();
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
    expect(body.querySelector('[aria-label="Selected-period trend chart"]')).toBeNull();
    expect(body.textContent).not.toContain('active days');
  });

  it('retains local retry actions for initial personal comparison and trajectory failures', () => {
    mocks.dashboard.mockReturnValue(query(dashboardData, { isError: true }));
    mocks.teamBudgets.mockReturnValue(query({
      budgets: [{ poolId: 'pool-1', teamName: 'Platform' }],
    }, { isError: true }));
    mocks.comparison.mockReturnValue(query(undefined, { isError: true }));
    mocks.teamReport.mockReturnValue(query(undefined, { isError: true }));

    const body = renderHome();
    const buttons = [...body.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons.filter((text) => text?.includes('Retry')).length).toBe(2);
    expect(body.textContent).toContain('Spend comparison unavailable');
    expect(buttons).toContain('Retry budget trajectory');
  });

  it('keeps loading states for the personal comparison and budget trajectory', () => {
    mocks.comparison.mockReturnValue(query(undefined, { isLoading: true }));
    mocks.teamReport.mockReturnValue(query(undefined, { isLoading: true }));

    const body = renderHome();
    expect(body.querySelector('[aria-label="Loading"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="Loading budget trajectory"]')).not.toBeNull();
  });

  it('passes a typed retry failureReason through during the initial loading state', () => {
    mocks.teamReport.mockReturnValue(query(undefined, {
      isLoading: true,
      failureReason: {
        status: 503,
        data: { code: 'REPORTING_USAGE_REFRESHING' },
      },
    }));

    const body = renderHome();
    expect(body.querySelector('[aria-label="Refreshing usage"]')?.textContent).toBe('true');
    expect(body.querySelector('[aria-label="Loading budget trajectory"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="Retry budget trajectory"]')).toBeNull();
  });

  it('marks a typed retry as refreshing while preserving cached trajectory data', () => {
    mocks.teamReport.mockReturnValue(query({ budgetTracking: selectedTracking }, {
      failureReason: {
        status: 503,
        data: { code: 'REPORTING_USAGE_REFRESHING' },
      },
    }));

    const body = renderHome();
    expect(body.querySelector('[aria-label="Refreshing usage"]')?.textContent).toBe('true');
    expect(body.querySelector('[aria-label="Trajectory spend"]')?.textContent).toBe('321');
    expect(body.querySelector('[aria-label="Platform trajectory"]')).not.toBeNull();
    expect(body.textContent).not.toContain('Retry budget trajectory');
  });

  it('keeps cached values and charts without duplicating the shared refresh notice', () => {
    for (const mock of [mocks.membership, mocks.dashboard, mocks.comparison, mocks.teamBudgets, mocks.teamReport]) {
      mock.mockReturnValue({ ...mock(), isError: true });
    }
    const body = renderHome();
    expect(body.querySelector('[aria-label="Personal selected spend"]')?.textContent).toBe('47.25');
    expect(body.querySelector('[aria-label="Trajectory spend"]')?.textContent).toBe('321');
    expect(body.querySelector('[aria-label="Platform trajectory"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="personal spend story"]')).not.toBeNull();
    expect(body.textContent).not.toMatch(/refresh|unavailable|Retry/i);
  });

  it('renders every team trajectory full width without duplicating My spend', () => {
    mocks.membership.mockReturnValue(query({
      defaultWorkspaceId: 'workspace-1',
      workspaces: [{
        ...workspace,
        budgetTeams: [
          { poolId: 'pool-1', teamName: 'Platform' },
          { poolId: 'pool-2', teamName: 'Infrastructure' },
        ],
      }],
      qualification: null,
    }));
    mocks.teamBudgets.mockReturnValue(query({
      budgets: [
        { poolId: 'pool-1', teamName: 'Platform' },
        { poolId: 'pool-2', teamName: 'Infrastructure' },
      ],
    }));

    const body = renderHome();
    expect(body.querySelectorAll('[aria-label="personal spend story"]')).toHaveLength(1);
    expect(body.textContent?.match(/My spend/g)).toHaveLength(1);
    for (const teamName of ['Platform', 'Infrastructure']) {
      const trajectory = body.querySelector(`[aria-label="${teamName} trajectory"]`);
      expect(trajectory).not.toBeNull();
      expect(trajectory?.parentElement?.className).toContain('lg:col-span-2');
    }
    expect(body.querySelector('[aria-label$="team budget"]')).toBeNull();
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
