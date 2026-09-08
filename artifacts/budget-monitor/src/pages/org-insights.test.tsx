// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrgInsights from './org-insights';

const chartFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/render-diagnostics', () => ({ reportRenderFailure: vi.fn() }));

vi.mock('wouter', () => ({
  useLocation: () => ['/org-insights', vi.fn()],
  useSearch: () => '',
  Link: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock('@/components/auth-context', () => ({
  useAuthContext: vi.fn(),
}));

vi.mock('@workspace/api-client-react', () => ({
  getGetOrgBudgetOverviewQueryKey: () => ['/api/org-insights'],
  useGetOrgBudgetOverview: vi.fn(),
}));

vi.mock('./org-insights-components', () => ({
  InsightCard: ({ title, value, subtitle, testId }: any) => <div data-testid="insight-card"><span data-testid={testId}>{title}: {value}{subtitle && ` — ${subtitle}`}</span></div>,
  OrgBudgetChart: () => {
    if (chartFailure.enabled) throw new TypeError('chart fixture render exception');
    return <div data-testid="org-budget-chart" />;
  },
  OrgTeamsTable: () => <div data-testid="org-teams-table" />,
}));

vi.mock('@/components/admin-data-quality', () => ({
  AdminDataQualityNote: ({ title, children }: any) => (
    <div data-testid="admin-data-quality-note">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  ),
}));

import { useAuthContext } from '@/components/auth-context';
import { useGetOrgBudgetOverview } from '@workspace/api-client-react';
import { reportRenderFailure } from '@/lib/render-diagnostics';

afterEach(() => { chartFailure.enabled = false; vi.restoreAllMocks(); });

describe('OrgInsights', () => {
  it('contains a genuine chart exception, keeps navigation/cards/table, and recovers with local retry', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (useAuthContext as any).mockReturnValue({ authorizationKey: 'account:a', capabilities: { canViewAccountUsage: true } });
    const refetch = vi.fn(async () => ({ isError: false }));
    (useGetOrgBudgetOverview as any).mockReturnValue({
      refetch, data: {
        periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: true,
        summary: { accountSpendUsd: 75, teamAllocationUsd: 400, remainingUsd: 325, teamsOverBudget: 0, fundedTeamCount: 1, resolvedTeamCount: 1, unresolvedTeamCount: 0 },
        teams: [], accountPoints: [],
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const navigate = vi.fn();
    chartFailure.enabled = true;
    try {
      await act(async () => root.render(<><nav><button onClick={navigate}>Navigation</button></nav><OrgInsights /></>));
      expect(container.querySelector('[data-testid="org-chart-unavailable"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="org-card-account-spend"]')?.textContent).toContain('$75.00');
      expect(container.querySelector('[data-testid="org-teams-table"]')).not.toBeNull();
      await act(async () => container.querySelector('nav button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(navigate).toHaveBeenCalledOnce();
      expect(reportRenderFailure).toHaveBeenCalledWith(expect.any(TypeError), expect.any(Object), 'org-budget-chart');
      const retry = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry chart')!;
      // A repeated rendering error stays local; there is no automatic retry loop.
      await act(async () => retry().click());
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="org-chart-unavailable"]')).not.toBeNull();
      // Failed refetch does not clear the boundary or pretend it recovered.
      refetch.mockResolvedValueOnce({ isError: true });
      await act(async () => retry().click());
      expect(container.textContent).toContain('Chart refresh failed.');
      expect(container.querySelector('[data-testid="org-teams-table"]')).not.toBeNull();
      chartFailure.enabled = false;
      await act(async () => retry().click());
      expect(container.querySelector('[data-testid="org-chart-unavailable"]')).toBeNull();
      expect(container.querySelector('[data-testid="org-budget-chart"]')).not.toBeNull();
      expect(refetch).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it('renders forbidden view if canViewAccountUsage is false', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: false },
      role: 'member',
    });
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Access Denied');
    expect(html).toContain('Organization insights are only available to account administrators.');
  });

  it('renders loading state when data is fetching', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      authorizationKey: 'account:a',
      role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: true,
      data: undefined,
    });

    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('animate-pulse');
  });

  it('renders error state when data fetch fails', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      authorizationKey: 'account:a',
      role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      data: undefined,
    });

    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Failed to load organization budget overview');
    expect(html).toContain('Retry');
  });

  it('keeps an initial reporting transition in the loading layout without an error', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true }, authorizationKey: 'account:a',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false, isError: true, data: undefined,
      error: { status: 503, data: { code: 'REPORTING_USAGE_REFRESHING' } },
    });
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('org-summary-loading');
    expect(html).not.toContain('org-insights-error');
    expect(html).not.toContain('Updating');
  });
  
  it('renders budget overview content when data is available', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      authorizationKey: 'account:a',
      role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      data: {
        periodStart: '2026-05-20',
        periodEnd: '2027-05-20',
        asOf: '2026-06-15',
        complete: true,
        qualification: null,
        summary: {
          accountSpendUsd: 15000,
          teamAllocationUsd: 100000,
          remainingUsd: 85000,
          teamsOverBudget: 1,
          unassignedSpendUsd: 0,
          fundedTeamCount: 2,
          resolvedTeamCount: 2,
          unresolvedTeamCount: 0,
        },
        accountPoints: [],
        teams: [],
      },
    });
    
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Organization Budget Overview');
    expect(html).toContain('Funding Period: 2026-05-20 to 2027-05-20');
    expect(html).toContain('data-testid="insight-card"');
    expect(html).toContain('data-testid="org-budget-chart"');
    expect(html).toContain('data-testid="org-teams-table"');
  });

  it('keeps missing summaries unavailable and coverage explanations in Data quality', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      authorizationKey: 'account:a',
      role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        periodStart: '2026-05-20',
        periodEnd: '2027-05-20',
        complete: false,
        qualification: 'Data is delayed due to upstream sync.',
        summary: {
          accountSpendUsd: null,
          teamAllocationUsd: null,
          remainingUsd: null,
          teamsOverBudget: null,
          unassignedSpendUsd: null,
          fundedTeamCount: 2,
          resolvedTeamCount: 0,
          unresolvedTeamCount: 2,
        },
        accountPoints: [],
        teams: [],
      },
    });

    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).not.toContain('Partial data');
    expect(html).not.toContain('org-balance-basis');
    expect(html).toContain('Remaining Team Budgets (Known): Unavailable');
    expect(html).toContain('Teams Over Budget (Known): Unavailable');
    expect(html.match(/0 of 2 funded teams; 2 unresolved\./g)).toHaveLength(2);
    expect(html).toContain('Budget overview data quality');
    expect(html).toContain('Balances use available recorded spend, not verified complete usage. Missing inputs remain unavailable.');
    expect(html).toContain('Data is delayed due to upstream sync.');
  });

  it('shows recorded numeric summaries with one shared basis label, without requiring verification', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true }, authorizationKey: 'account:a', role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      data: {
        periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: false,
        qualification: 'Missing historical rosters use current membership.',
        summary: {
          accountSpendUsd: 1609.81, teamAllocationUsd: 13115.74,
          remainingUsd: 11505.93, teamsOverBudget: 0, unassignedSpendUsd: 0,
          fundedTeamCount: 1, resolvedTeamCount: 1, unresolvedTeamCount: 0,
        },
        accountPoints: [],
        teams: [{ complete: false, remainingUsd: 11505.93 }],
      },
    });
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Remaining Team Budgets: $11,505.93');
    expect(html).toContain('Teams Over Budget: 0');
    expect(html.match(/Balances based on recorded spend/g)).toHaveLength(1);
    expect(html).not.toContain('Partial data');
    expect(html).toContain('Budget overview data quality');
    expect(html).toContain('Balances use available recorded spend, not verified complete usage. Missing inputs remain unavailable.');
    expect(html).toContain('Missing historical rosters use current membership.');
  });

  it('shows unassigned spend once when unassigned is positive', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      authorizationKey: 'account:a',
      role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      data: {
        periodStart: '2026-05-20',
        periodEnd: '2027-05-20',
        complete: true,
        summary: {
          accountSpendUsd: 15000,
          teamAllocationUsd: 10000,
          remainingUsd: 0,
          teamsOverBudget: 0,
          unassignedSpendUsd: 5000,
          fundedTeamCount: 1,
          resolvedTeamCount: 1,
          unresolvedTeamCount: 0,
        },
        accountPoints: [],
        teams: [],
      },
    });
    
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html.match(/data-testid="insight-card"/g)).toHaveLength(5);
    expect(html).not.toContain('Reconciliation Note');
  });

  it('labels calculable funded-team subtotals as known when some funded teams are unresolved', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true }, authorizationKey: 'account:a', role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      data: {
        periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: false,
        qualification: 'Two funded teams are awaiting usage resolution.',
        summary: {
          accountSpendUsd: 1609.81, teamAllocationUsd: 13115.74,
          remainingUsd: 4100.25, teamsOverBudget: 2, unassignedSpendUsd: 0,
          fundedTeamCount: 5, resolvedTeamCount: 3, unresolvedTeamCount: 2,
        },
        accountPoints: [],
        teams: [{ complete: false, remainingUsd: 4100.25 }],
      },
    });

    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Remaining Team Budgets (Known): $4,100.25');
    expect(html).toContain('Teams Over Budget (Known): 2');
    expect(html.match(/3 of 5 funded teams; 2 unresolved\./g)).toHaveLength(2);
    expect(html.match(/Balances based on recorded spend/g)).toHaveLength(1);
  });

  it('keeps the latest committed same-scope values through a transient 503 refresh', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true }, authorizationKey: 'account:a',
    });
    const committed = {
      periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: true,
      qualification: null,
      summary: {
        accountSpendUsd: 75, teamAllocationUsd: 400, remainingUsd: 325,
        teamsOverBudget: 0, unassignedSpendUsd: 0,
        fundedTeamCount: 1, resolvedTeamCount: 1, unresolvedTeamCount: 0,
      },
      accountPoints: [], teams: [],
    };
    const refetch = vi.fn(async () => ({ isError: true, error: new Error('503') }));
    let queryState = {
      data: committed, isLoading: false, isFetching: false, isError: false, refetch,
      error: null as null | { status: number },
    };
    (useGetOrgBudgetOverview as any).mockImplementation(() => queryState);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<OrgInsights />));
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="refresh-org-insights"]')?.click();
      });
      expect(refetch).toHaveBeenCalledOnce();
      queryState = { ...queryState, isFetching: true };
      await act(async () => root.render(<OrgInsights />));
      expect(container.querySelector('[data-testid="org-card-remaining"]')?.textContent).toContain('$325.00');
      expect(container.textContent).not.toContain('Updating');
      expect(container.querySelector('[data-testid="refresh-org-insights"]')?.textContent).toBe('Refresh');
      expect(container.querySelector('[data-testid="org-insights-error"]')).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      queryState = { ...queryState, isFetching: false, isError: true, error: { status: 503 } };
      await act(async () => root.render(<OrgInsights />));
      expect(container.querySelector('[data-testid="org-card-remaining"]')?.textContent).toContain('$325.00');
      expect(container.querySelector('[data-testid="org-insights-error"]')).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).not.toMatch(/Updating|Refresh failed|Showing saved/);
      queryState = {
        ...queryState, isError: false, error: null,
        data: { ...committed, summary: { ...committed.summary, remainingUsd: 300 } },
      };
      await act(async () => root.render(<OrgInsights />));
      expect(container.querySelector('[data-testid="org-card-remaining"]')?.textContent).toContain('$300.00');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('changes query keys and does not display committed data across identity or scope changes', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let authorizationKey = 'user-a:account-scope';
    (useAuthContext as any).mockImplementation(() => ({
      capabilities: { canViewAccountUsage: true }, authorizationKey,
    }));
    (useGetOrgBudgetOverview as any).mockImplementation((options: any) => (
      options.query.queryKey.at(-1) === 'user-a:account-scope'
        ? {
            isLoading: false,
            data: {
              periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: true,
              qualification: null,
              summary: {
                accountSpendUsd: 75, teamAllocationUsd: 400, remainingUsd: 325,
                teamsOverBudget: 0, unassignedSpendUsd: 0,
                fundedTeamCount: 1, resolvedTeamCount: 1, unresolvedTeamCount: 0,
              },
              accountPoints: [], teams: [],
            },
          }
        : { isLoading: true, data: undefined }
    ));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<OrgInsights />));
      expect(container.textContent).toContain('$325.00');
      authorizationKey = 'user-b:team-scope';
      await act(async () => root.render(<OrgInsights />));
      expect(container.textContent).not.toContain('$325.00');
      expect(container.innerHTML).toContain('animate-pulse');
      expect(useGetOrgBudgetOverview).toHaveBeenLastCalledWith({
        query: { queryKey: ['/api/org-insights', 'user-b:team-scope'] },
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('closes an open unassigned detail and removes its financial data when the authorization key changes', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let authorizationKey = 'user-a:account-scope';
    (useAuthContext as any).mockImplementation(() => ({
      capabilities: { canViewAccountUsage: true }, authorizationKey,
    }));
    (useGetOrgBudgetOverview as any).mockImplementation((options: any) => (
      options.query.queryKey.at(-1) === 'user-a:account-scope'
        ? {
            isLoading: false,
            isFetching: false,
            isError: false,
            data: {
              periodStart: '2026-05-20', periodEnd: '2027-05-20', asOf: '2026-09-08',
              complete: true, qualification: null,
              summary: {
                accountSpendUsd: 975, teamAllocationUsd: 400, remainingUsd: 325,
                teamsOverBudget: 0, unassignedSpendUsd: 91.23,
                fundedTeamCount: 1, resolvedTeamCount: 1, unresolvedTeamCount: 0,
              },
              unassignedDetail: {
                observation: 'complete',
                workspaces: [{
                  workspaceId: 'old-secret-workspace',
                  workspaceName: 'Old Financial Workspace',
                  spendUsd: 91.23,
                  rows: [{
                    id: 'old-detail',
                    groupName: 'Old Financial Group',
                    source: 'unmapped_group',
                    spendUsd: 91.23,
                  }],
                }],
              },
              accountPoints: [], teams: [],
            },
          }
        : { isLoading: true, data: undefined }
    ));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<OrgInsights />));
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Inspect Unassigned Spend"]',
      )!;
      await act(async () => trigger.click());
      expect(document.body.textContent).toContain('Old Financial Workspace');
      expect(document.body.textContent).toContain('$91.23');

      authorizationKey = 'user-b:team-scope';
      await act(async () => root.render(<OrgInsights />));
      expect(document.querySelector('[data-testid="org-unassigned-dialog"]')).toBeNull();
      expect(document.body.textContent).not.toContain('Old Financial Workspace');
      expect(document.body.textContent).not.toContain('Old Financial Group');
      expect(document.body.textContent).not.toContain('$91.23');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it.each([401, 403, 404])('hides retained overview and unassigned details after a %s response', status => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      authorizationKey: 'account:revoked',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      isFetching: false,
      isError: true,
      error: { status },
      data: {
        periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: true,
        summary: {
          accountSpendUsd: 999, teamAllocationUsd: 400, remainingUsd: 325,
          teamsOverBudget: 0, unassignedSpendUsd: 88.76,
          fundedTeamCount: 1, resolvedTeamCount: 1, unresolvedTeamCount: 0,
        },
        unassignedDetail: {
          observation: 'complete',
          workspaces: [{
            workspaceId: 'retained-secret',
            workspaceName: 'Retained Financial Workspace',
            spendUsd: 88.76,
            rows: [{
              id: 'retained-row',
              groupName: 'Retained Financial Group',
              source: 'unmapped_group',
              spendUsd: 88.76,
            }],
          }],
        },
        accountPoints: [], teams: [],
      },
    });

    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Failed to load organization budget overview.');
    expect(html).not.toContain('Retained Financial Workspace');
    expect(html).not.toContain('Retained Financial Group');
    expect(html).not.toContain('$88.76');
    expect(html).not.toContain('$999.00');
  });
});
