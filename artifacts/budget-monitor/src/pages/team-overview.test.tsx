// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamOverview from './team-overview';
import { RangeProvider } from '@/components/range-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetBudgetTeamReport } from '@workspace/api-client-react';

vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterAll(() => vi.unstubAllGlobals());

vi.mock('@workspace/api-client-react', async () => {
  const actual = await vi.importActual('@workspace/api-client-react');
  return {
    ...actual as any,
    useGetBudgetTeamReport: vi.fn(),
  };
});

vi.mock('wouter', () => ({
  Link: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
  useLocation: () => [window.location.pathname, vi.fn()],
  useSearch: () => window.location.search,
  useParams: () => ({ poolId: 'pool:team:Test' }),
}));

vi.mock('wouter/use-browser-location', () => ({
  useBrowserLocation: () => [window.location.pathname, vi.fn()],
  useSearch: () => window.location.search,
}));

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    role: 'account',
    capabilities: { canViewAccountUsage: true },
    authorizationKey: 'key',
  })
}));

function page() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}><RangeProvider><TeamOverview /></RangeProvider></QueryClientProvider>;
}

function renderPage() {
  return new DOMParser().parseFromString(renderToStaticMarkup(page()), 'text/html').body;
}

describe('TeamOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ranks the default ten people by spend with stable identity tie-breaking', () => {
    window.history.replaceState(null, '', '/teams/pool%3Ateam%3ATest');
    const members = Array.from({ length: 12 }, (_, index) => ({
      userId: `user-${String(index).padStart(2, '0')}`,
      workspaceId: 'workspace',
      name: `Person ${index}`,
      spendUsd: index >= 10 ? 20 : index,
      agentSpendUsd: 0,
    }));
    vi.mocked(useGetBudgetTeamReport).mockReturnValue({
      isLoading: false,
      data: {
        name: 'Test Team',
        period: { start: '2026-09-01', endExclusive: '2026-10-01', label: 'September' },
        headline: { spendUsd: 85, isComplete: true },
        members,
        metadata: { qualifications: [], status: 'complete' },
        overview: { insights: { monthly: [] }, projects: [], projectAttributionComplete: true },
      },
    } as any);
    const links = [...renderPage().querySelectorAll('a[href^="/users/"]')];
    expect(links).toHaveLength(10);
    expect(links.slice(0, 3).map(link => link.textContent))
      .toEqual(['Person 10', 'Person 11', 'Person 9']);
    expect(links.map(link => link.textContent)).not.toContain('Person 0');
    expect(members[0].userId).toBe('user-00');
  });

  it('renders loading state initially', () => {
    window.history.replaceState(null, '', '/teams/pool:team:Test');
    vi.mocked(useGetBudgetTeamReport).mockReturnValue({ isLoading: true, data: undefined } as any);
    const body = renderPage();
    expect(body.textContent).toContain('Team overview');
  });

  it('renders forbidden state on 403', () => {
    window.history.replaceState(null, '', '/teams/pool:team:Test');
    vi.mocked(useGetBudgetTeamReport).mockReturnValue({
      isError: true,
      error: { response: { status: 403 } },
    } as any);
    const body = renderPage();
    expect(body.textContent).toContain('403 · Access denied or not found');
  });

  it('renders report data with budget and overview and decodes poolId properly', () => {
    window.history.replaceState(null, '', '/teams/pool:team:R%2FD');
    vi.mocked(useGetBudgetTeamReport).mockReturnValue({
      isLoading: false,
      data: {
        name: 'R/D Team',
        period: { start: '2025-01-01T00:00:00Z', endExclusive: '2025-02-01T00:00:00Z', label: 'Jan 2025', rangeType: 'billing' },
        headline: { spendUsd: 1500, isComplete: true },
        budgetTracking: {
          allocationUsd: 10000,
          spendUsd: 2000,
          remainingUsd: 8000,
          percentUsed: 20,
          periodLabel: 'Annual 2025',
          points: [],
          comparisonsMatchBudgetWindow: true,
        },
        overview: {
          insights: { activeUsers: 15, avgSpendPerActiveUserUsd: 100, monthly: [] },
          projects: [
            { id: 'project:ws1:proj1', projectId: 'proj1', name: 'App 1', workspaceId: 'ws1', spendUsd: 500 }
          ],
          projectAttributionComplete: true,
        },
        members: [
          { userId: 'u1', name: 'Alice', spendUsd: 200, agentSpendUsd: 50, limitUsd: 100 }
        ],
        metadata: { qualifications: [], status: 'complete' }
      }
    } as any);
    
    const body = renderPage();
    expect(body.textContent).toContain('R/D Team');
    expect(body.textContent).toContain('$10,000.00'); // Note: formatUsd produces standard USD format
    expect(body.textContent).toContain('$2,000');
    expect(body.textContent).toContain('$8,000');
    expect(body.textContent).toContain('$1,500');
    expect(body.textContent).toContain('Alice');
    expect(body.textContent).toContain('App 1');
    expect(body.querySelector('a[href^="/workspaces/ws1/projects/proj1?"]')).not.toBeNull();
  });
});
