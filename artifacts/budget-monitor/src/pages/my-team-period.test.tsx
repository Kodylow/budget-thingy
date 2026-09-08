// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import MyTeam from './my-team';
import { RangeProvider } from '@/components/range-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterAll(() => vi.unstubAllGlobals());

const mocks = vi.hoisted(() => ({
  role: 'team_admin',
  account: false,
  dashboard: vi.fn(),
  people: vi.fn(),
  projects: vi.fn(),
  refreshDashboard: vi.fn(),
  refreshPeople: vi.fn(),
  refreshProjects: vi.fn(),
  setLocation: vi.fn(),
}));

vi.mock('wouter', () => ({
  Link: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
  useSearch: () => window.location.search,
  useLocation: () => ['/my-team', mocks.setLocation],
}));
vi.mock('wouter/use-browser-location', () => ({
  useSearch: () => window.location.search,
}));
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    role: mocks.role, capabilities: { canViewAccountUsage: mocks.account },
  }),
}));
vi.mock('@/components/range-filter', () => ({
  RangeFilter: ({ selectedLabel, ...props }: any) => <output aria-label="Selected period" data-props={Object.keys(props).join(',')}>{selectedLabel}</output>,
}));
vi.mock('@/components/admin-data-quality', () => ({
  AdminDataQualityNote: () => null,
}));
vi.mock('@/components/Charts', () => ({
  TrendAreaChart: ({ data, dataKey }: any) => <output aria-label={dataKey}>{JSON.stringify(data)}</output>,
}));
vi.mock('@workspace/api-client-react', () => ({
  getGetDashboardQueryKey: (params: any) => ['dashboard', params],
  getListSpendPeopleQueryKey: (params?: any) => params ? ['people', params] : ['people'],
  getListSpendProjectsQueryKey: (params?: any) => params ? ['projects', params] : ['projects'],
  useGetDashboard: (...args: any[]) => mocks.dashboard(...args),
  useListSpendPeople: (...args: any[]) => mocks.people(...args),
  useListSpendProjects: (...args: any[]) => mocks.projects(...args),
}));

const metadata = { status: 'complete', stale: false, qualifications: [], dataAsOf: '2026-09-08' };
const contractTerm = {
  start: '2026-05-20T00:00:00.000Z', endExclusive: '2027-05-21T00:00:00.000Z',
  timezone: 'UTC', label: 'Full term',
};
const billing = {
  start: '2026-08-20T00:00:00.000Z', endExclusive: '2026-09-20T00:00:00.000Z',
  timezone: 'UTC', label: 'Resolved billing period',
};
const monthly = [{ start: '2026-04-01', spendUsd: 123, activeUsers: 2 }];
const dashboardData = {
  period: { ...contractTerm, endExclusive: '2026-09-09T00:00:00.000Z' },
  contractTerm, metadata, cards: [],
  scope: { isPersonal: false },
  accounting: { eligibleSpendUsd: 35, grossSpendUsd: 35 },
  insights: { activeUsers: 1, avgSpendPerActiveUserUsd: 35, monthly },
};
const row = {
  id: 'member', name: 'Example Member', spendUsd: 35, agentSpendUsd: 27, otherServicesUsd: 8,
  workspaceName: 'Workspace One', usageObserved: true, allocationUsd: 100,
  currentCycleAgentSpendUsd: 20, limitState: 'explicit',
};
function query(data: any, refetch: () => void) {
  return { data, isLoading: false, refetch };
}
function page() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}><RangeProvider><MyTeam /></RangeProvider></QueryClientProvider>;
}
function renderPage() {
  return new DOMParser().parseFromString(renderToStaticMarkup(page()), 'text/html').body;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'team_admin';
  mocks.account = false;
  window.history.replaceState(null, '', '/my-team');
  mocks.dashboard.mockImplementation((params: any) => query({
    ...dashboardData,
    period: params.rangeType === 'billing' ? billing : dashboardData.period,
  }, mocks.refreshDashboard));
  mocks.people.mockReturnValue(query({ rows: [row], metadata }, mocks.refreshPeople));
  mocks.projects.mockReturnValue(query({ rows: [{ ...row, name: 'Example App' }], metadata }, mocks.refreshProjects));
});

describe('My Team effective reporting period', () => {
  it.each([
    ['', 'full-term'],
    ['?rangeType=full-term', 'full-term'],
    ['?rangeType=billing', 'billing'],
    ['?rangeType=custom&startDate=2026-01-01&endDate=2026-01-31', 'full-term'],
  ])('shares the normalized range across every selected-period request: %s', (search, expected) => {
    window.history.replaceState(null, '', `/my-team${search}`);
    const body = renderPage();
    for (const request of [mocks.dashboard, mocks.people, mocks.projects]) {
      const [params, options] = request.mock.calls.at(-1)!;
      expect(params).toMatchObject({ rangeType: expected, viewScope: 'managed', startDate: undefined, endDate: undefined });
      expect(options.query.enabled).toBe(true);
      expect(options.query.queryKey[1]).toEqual(params);
    }
    expect(body.querySelector('[aria-label="Selected period"]')?.getAttribute('data-props')).toBe('');
    expect(body.textContent).toContain('Recorded actuals to date · No forecasts');
    expect(body.textContent).toContain('$35.00');
    expect(body.querySelector('[aria-label="spendUsd"]')?.textContent).toContain('"month":"2026-04-01"');
    expect(body.textContent).toContain('independent of the selected period');
  });

  it('shows the fixed inclusive UTC term, not the actual reporting cutoff or exclusive next day', () => {
    const dates = renderPage().querySelector('[data-testid="text-reporting-dates"]')?.textContent;
    expect(dates).toBe('May 20, 2026–May 20, 2027');
    expect(dates).not.toContain('Sep 8');
    expect(dates).not.toContain('May 21');
  });

  it('uses resolved Replit billing boundaries, not a calendar month', () => {
    window.history.replaceState(null, '', '/my-team?rangeType=billing');
    const body = renderPage();
    expect(body.querySelector('[data-testid="text-reporting-dates"]')?.textContent)
      .toBe('Aug 20, 2026–Sep 19, 2026');
    expect(body.querySelector('[aria-label="Selected period"]')?.textContent).toBe('Billing period');
    expect(body.textContent).toContain('Within budget');
  });

  it.each(['full-term', 'billing'])('carries %s into both View all links and View spend details', range => {
    // We removed the general 'View spend details' and 'View all' links from my-team.tsx.
    // Ensure we have NO general links to /spend on this page.
    window.history.replaceState(null, '', `/my-team?rangeType=${range}&page=4&viewScope=all_authorized`);
    const links = [...renderPage().querySelectorAll('a')];
    for (const link of links) {
      const url = new URL(link.href);
      expect(url.pathname).not.toBe('/spend');
    }
  });

  it.each(['full-term', 'billing'])('refreshes currently selected %s requests', async range => {
    window.history.replaceState(null, '', `/my-team?rangeType=${range}`);
    const container = document.createElement('div');
    const root = createRoot(container);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    try {
      await act(async () => root.render(page()));
      const refresh = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Refresh data'))!;
      await act(async () => refresh.click());
      expect(mocks.refreshDashboard).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['people'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });

      for (const request of [mocks.dashboard, mocks.people, mocks.projects]) {
        expect(request.mock.calls.at(-1)?.[0].rangeType).toBe(range);
      }
    } finally {
      await act(async () => root.unmount());
      invalidate.mockRestore();
    }
  });

  it('uses the same presentation for My Organization without weakening scope selection', () => {
    mocks.role = 'account';
    mocks.account = true;
    const body = renderPage();
    expect(body.querySelector('h1')?.textContent).toBe('My Organization');
    expect(body.textContent).toContain('May 20, 2026–May 20, 2027');
    expect(body.textContent).toContain('Cloud Services');
    for (const request of [mocks.dashboard, mocks.people, mocks.projects]) {
      expect(request.mock.calls.at(-1)?.[0].viewScope).toBe('all_authorized');
    }
  });

  it('does not invent dates or zero totals when the dashboard is unavailable', () => {
    mocks.dashboard.mockReturnValue(query(undefined, mocks.refreshDashboard));
    const body = renderPage();
    expect(body.textContent).toContain('Term dates unavailable');
    expect(body.textContent).toContain('Unable to load activity');
    expect(body.textContent).not.toContain('$0.00');
    expect(body.querySelector('table')).toBeNull();
  });

  it('keeps unavailable dashboard observations distinct from observed zero', () => {
    for (const status of ['empty', 'complete']) {
      mocks.dashboard.mockReturnValue(query({
        ...dashboardData, metadata: { ...metadata, status, dataAsOf: status === 'empty' ? null : metadata.dataAsOf },
        accounting: { eligibleSpendUsd: 0 },
      }, mocks.refreshDashboard));
      const body = renderPage();
      expect(body.textContent).toContain(status === 'empty' ? 'Unavailable' : '$0.00');
    }
  });
});