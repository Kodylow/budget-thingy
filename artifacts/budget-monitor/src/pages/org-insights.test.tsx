import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import OrgInsights from './org-insights';

vi.mock('wouter', () => ({
  useLocation: () => ['/org-insights', vi.fn()],
  useSearch: () => '',
  Link: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock('@/components/auth-context', () => ({
  useAuthContext: vi.fn(),
}));

vi.mock('@/components/range-context', () => ({
  useRange: () => ({ rangeType: 'month_to_date', startDate: '', endDate: '' }),
}));

vi.mock('@workspace/api-client-react', () => ({
  useGetDashboard: vi.fn(),
  useListSpendPeople: vi.fn(),
  getListSpendPeopleQueryKey: vi.fn(),
}));

vi.mock('./org-insights-components', () => ({
  InsightCard: () => <div data-testid="insight-card" />,
  MonthlySpendChart: () => <div data-testid="monthly-chart" />,
  TopSpendersList: () => <div data-testid="top-spenders" />,
  CategoryCards: () => <div data-testid="category-cards" />,
}));
vi.mock('./org-insights-table', () => ({
  OrgInsightsPeopleTable: () => <div data-testid="people-table" />
}));
vi.mock('@/components/range-filter', () => ({
  RangeFilter: () => <div data-testid="range-filter" />
}));

import { useAuthContext } from '@/components/auth-context';
import { useGetDashboard, useListSpendPeople } from '@workspace/api-client-react';

describe('OrgInsights', () => {
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
    (useGetDashboard as any).mockReturnValue({
      isLoading: true,
      data: undefined,
    });
    (useListSpendPeople as any).mockReturnValue({ isLoading: true });
    
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('animate-pulse');
  });
  
  it('renders dashboard content when data is available', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      role: 'account',
    });
    (useGetDashboard as any).mockReturnValue({
      isLoading: false,
      data: {
        scope: { label: 'Org', isPersonal: false },
        period: { label: 'August 2026', start: '2026-08-01', endExclusive: '2026-09-01' },
        metadata: { status: 'complete', stale: false, dataAsOf: '2026-08-31T00:00:00.000Z', qualifications: [], coverage: { ratio: 1 } },
        accounting: { eligibleSpendUsd: 132981.77, grossSpendUsd: 132981.77 },
        projection: { projectedTotalUsd: 160267.72 },
        insights: {}
      },
    });
    (useListSpendPeople as any).mockReturnValue({ isLoading: false });
    
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Org Insights');
    expect(html).toContain('data-testid="insight-card"');
    expect(html).toContain('data-testid="monthly-chart"');
    expect(html).toContain('data-testid="people-table"');
  });

  it('keeps a concise partial indicator while hiding qualifications from the page', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      role: 'account',
    });
    (useGetDashboard as any).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        scope: { label: 'Org', isPersonal: false },
        period: { label: 'August 2026', start: '2026-08-01', endExclusive: '2026-09-01' },
        metadata: {
          status: 'partial',
          stale: false,
          dataAsOf: '2026-08-31T00:00:00.000Z',
          qualifications: ['Internal activity is excluded from attributed totals.'],
          coverage: { ratio: 0.8 },
        },
        accounting: { eligibleSpendUsd: 100, grossSpendUsd: 100 },
        projection: null,
        insights: {},
      },
    });

    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Partial data');
    expect(html).not.toContain('Internal activity is excluded from attributed totals.');
  });
});

  it('renders projection card link to overview properly', () => {
    (useAuthContext as any).mockReturnValue({
      capabilities: { canViewAccountUsage: true },
      role: 'account',
    });
    (useGetDashboard as any).mockReturnValue({
      isLoading: false,
      data: {
        scope: { label: 'Org', isPersonal: false },
        period: { label: 'August 2026', start: '2026-08-01', endExclusive: '2026-09-01' },
        metadata: { status: 'complete', stale: false, dataAsOf: '2026-08-31T00:00:00.000Z', qualifications: [], coverage: { ratio: 1 } },
        accounting: { eligibleSpendUsd: 132981.77, grossSpendUsd: 132981.77 },
        projection: { projectedTotalUsd: 160267.72, projectedKnownTotalUsd: 160267.72, dataThrough: '2026-08-27T00:00:00.000Z' },
        insights: {}
      },
    });
    (useListSpendPeople as any).mockReturnValue({ isLoading: false });
    
    const html = renderToStaticMarkup(<OrgInsights />);
    expect(html).toContain('Forecast details');
    expect(html).toContain('href="/overview?viewScope=all_authorized"');
  });
