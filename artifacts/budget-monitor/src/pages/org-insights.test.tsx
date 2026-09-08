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
  useGetOrgBudgetOverview: vi.fn(),
}));

vi.mock('./org-insights-components', () => ({
  InsightCard: ({ title, value, testId }: any) => <div data-testid="insight-card"><span data-testid={testId}>{title}: {value}</span></div>,
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
    (useAuthContext as any).mockReturnValue({ capabilities: { canViewAccountUsage: true } });
    const refetch = vi.fn(async () => ({ isError: false }));
    (useGetOrgBudgetOverview as any).mockReturnValue({
      refetch, data: {
        periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: true,
        summary: { accountSpendUsd: 75, teamAllocationUsd: 400, remainingUsd: 325, teamsOverBudget: 0 },
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
  
  it('renders budget overview content when data is available', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
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
        },
        accountPoints: [],
        teams: [],
      },
    });

    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).not.toContain('Partial data');
    expect(html).not.toContain('org-balance-basis');
    expect(html).toContain('Remaining Team Budgets: Unavailable');
    expect(html).toContain('Teams Over Budget: Unavailable');
    expect(html).toContain('Budget overview data quality');
    expect(html).toContain('Data is delayed due to upstream sync.');
  });

  it('shows recorded numeric summaries with one shared basis label, without requiring verification', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true }, role: 'account',
    });
    (useGetOrgBudgetOverview as any).mockReturnValue({
      isLoading: false,
      data: {
        periodStart: '2026-05-20', periodEnd: '2027-05-20', complete: false,
        qualification: 'Missing historical rosters use current membership.',
        summary: {
          accountSpendUsd: 1609.81, teamAllocationUsd: 13115.74,
          remainingUsd: 11505.93, teamsOverBudget: 0, unassignedSpendUsd: 0,
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
  });

  it('shows unassigned spend once when unassigned is positive', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
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
        },
        accountPoints: [],
        teams: [],
      },
    });
    
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html.match(/data-testid="insight-card"/g)).toHaveLength(5);
    expect(html).not.toContain('Reconciliation Note');
  });
});
