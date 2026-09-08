import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@workspace/api-client-react';
import Dashboard from './dashboard';

vi.stubGlobal('React', React);

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  refetch: vi.fn(),
  adminNotes: [] as Array<{ title?: string; children: React.ReactNode }>,
}));

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => mocks.auth(),
}));

vi.mock('@/components/range-context', () => ({
  useRange: () => ({ rangeType: 'billing', startDate: undefined, endDate: undefined }),
}));

vi.mock('@workspace/api-client-react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@workspace/api-client-react')>(),
  useGetDashboard: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock('wouter', () => ({
  useLocation: () => ['/', vi.fn()],
  useSearch: () => '',
}));

vi.mock('@/components/range-filter', () => ({
  RangeFilter: ({ selectedLabel }: { selectedLabel: string }) => <span>{selectedLabel}</span>,
}));

vi.mock('@/components/admin-data-quality', () => ({
  AdminDataQualityNote: ({ title, children }: { title?: string; children: React.ReactNode }) => {
    mocks.adminNotes.push({ title, children });
    return null;
  },
}));

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children, variant: _variant, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: (props: any) => <span {...props} />,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <>{children}</>,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children }: any) => <span>{children}</span>,
  SelectTrigger: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));

vi.mock('@/lib/client-performance', () => ({
  markDashboardMilestone: vi.fn(() => 'mark'),
  reportDashboardMilestonePainted: vi.fn(() => vi.fn()),
}));

const capabilities = {
  canViewAccountUsage: false,
};

const baseData: DashboardResponse = {
  scope: {
    viewScope: 'managed',
    label: 'My teams',
    workspaceIds: ['workspace-1'],
    groupIds: ['group-1'],
    isPersonal: false,
  },
  period: {
    start: '2026-09-01T00:00:00.000Z',
    endExclusive: '2026-10-01T00:00:00.000Z',
    timezone: 'UTC',
    label: 'Sep 1–30, 2026',
  },
  cardVariant: 'budget_health',
  cards: [
    {
      key: 'allocated_budget',
      label: 'Allocated funding',
      value: 5000,
      unit: 'usd',
      qualification: 'Funding applies only to canonical groups.',
    },
    {
      key: 'allocation_remaining',
      label: 'Funding remaining',
      value: null,
      unit: 'usd',
      qualification: null,
    },
    {
      key: 'eligible_spend',
      label: 'Recognized spend',
      value: 1234.5,
      unit: 'usd',
      qualification: 'Known eligible charges only.',
    },
  ],
  trend: {
    granularity: 'day',
    mode: 'period',
    buckets: [],
  },
  breakdown: [],
  accounting: {
    eligibleSpendUsd: 1234.5,
    grossSpendUsd: 1300,
    internalExcludedUsd: 65.5,
    unbudgetedUsd: 0,
    unattributedUsd: 0,
    reconciliationUsd: 0,
    agentSpendUsd: 1000,
    otherServicesUsd: 234.5,
  },
  metadata: {
    generationId: 'generation-1',
    costBasis: 'allocation_eligible_committed',
    status: 'complete',
    dataAsOf: '2026-09-30T12:30:00.000Z',
    directoryDataAsOf: null,
    stale: false,
    coverage: {
      ratio: 1,
      requestedDays: 30,
      missingDays: [],
      failedWorkspaceDays: [],
    },
    qualifications: [],
    limitObservation: {
      status: 'complete',
      observedAt: null,
      lastSuccessfulAt: null,
      lastAttemptAt: null,
      refreshStartedAt: null,
      generation: null,
      error: null,
    },
  },
  staleSpend: {
    spendUsd: 0,
    projectCount: 0,
    availability: 'complete',
    coverage: { requestedDays: 30, requestedWorkspaceDays: 30, presentWorkspaceDays: 30, failedWorkspaceDays: [], missingWorkspaceDays: [], presentAccountDays: 30, missingAccountDays: [], ratio: 1.0 },
    evaluatedAt: '2026-09-15T00:00:00Z',
    staleCutoff: '2026-08-16T00:00:00Z',
    monthStart: '2026-09-01T00:00:00Z',
    monthEndExclusive: '2026-10-01T00:00:00Z',
    drillThrough: null,
  },
  projection: null as unknown as DashboardResponse['projection'],
};

function render(data: DashboardResponse | undefined = baseData, state: Partial<Record<'isLoading' | 'isError' | 'isFetching', boolean>> = {}) {
  mocks.query.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
    ...state,
  });
  return renderToStaticMarkup(<Dashboard />);
}

function expectRemovedOverviewSections(html: string) {
  [
    'Top budget groups by spend',
    'Understand what drove spend',
    'Explore Spend',
    'What needs my attention?',
    'Reconciliation details',
    'Data details',
    'dashboard-data-quality',
  ].forEach((text) => expect(html).not.toContain(text));
}

describe('Overview financial briefing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminNotes.length = 0;
    mocks.auth.mockReturnValue({
      role: 'team_admin',
      authorizationKey: 'authorization-1',
      auth: { viewScope: 'managed' },
      capabilities,
    });
  });

  it('shows only Spend, Budget and Remaining in the summary without the former bottom sections', () => {
    const html = render();
    const summary = html.slice(html.indexOf('<section aria-labelledby="spend-headline"'), html.indexOf('</section>'));
    const headlineAt = summary.indexOf('>Spend<');

    expect(headlineAt).toBeGreaterThan(-1);
    expect(summary.indexOf('>Budget<')).toBeGreaterThan(headlineAt);
    expect(summary).toContain('$1,234.50');
    expect(summary).toContain('>Remaining<');
    expect(summary).toContain('Unknown');
    expect(summary).not.toContain('Known eligible charges only.');
    expect(summary).not.toContain('Funding applies only to canonical groups.');
    expect(summary).not.toContain(baseData.period.label);
    expect(summary).not.toContain('Data as of');
    expect(html).not.toContain('Known eligible charges only.');
    expect(html).not.toContain('Funding applies only to canonical groups.');
    expect(mocks.adminNotes.map((note) => note.children)).toEqual(expect.arrayContaining([
      'Known eligible charges only.',
      'Funding applies only to canonical groups.',
    ]));
    expect(html).not.toContain('aria-label="Explore allocated funding in Spend"');
    expect(html).not.toContain('>Retry<');
    expectRemovedOverviewSections(html);
  });

  it('keeps the spend headline clickable for normal Spend navigation and retains actual trend', () => {
    const html = render();

    expect(html).toContain('Reporting period');
    expect(html).toContain('Actual reporting-period trend');
    expect(html).toContain('At-current-rate outlook');
    expect(html.indexOf('>Spend<')).toBeLessThan(html.indexOf('At-current-rate outlook'));
    expect(html).toContain('data-testid="card-dashboard-eligible_spend"');
    expect(html).toContain('aria-label="Explore spend in Spend"');
    expect(html).not.toContain('Chart options');
    expectRemovedOverviewSections(html);
  });

  it.each([
    {
      name: 'cached',
      data: { ...baseData, metadata: { ...baseData.metadata, stale: true } },
      state: {},
      badge: 'Cached',
      hasRetry: false,
    },
    {
      name: 'partial',
      data: { ...baseData, metadata: { ...baseData.metadata, status: 'partial' as const } },
      state: {},
      badge: 'Partial',
      hasRetry: false,
    },
  ])('keeps the $name evidence badge at the top', ({ data, state, badge, hasRetry }) => {
    const html = render(data, state);

    expect(html).toContain(badge);
    expect(html).toContain('>Spend<');
    expect(html.includes('>Retry<')).toBe(hasRetry);
    expect(html).not.toContain('>Refresh<');
    expectRemovedOverviewSections(html);
  });

  it('keeps cached values without a local refresh-failure badge', () => {
    const html = render(baseData, { isError: true });
    expect(html).toContain('>Spend<');
    expect(html).not.toContain('Refresh failed');
    expect(html).not.toContain('>Retry<');
  });

  it('uses canonical accounting when a variant omits a spend card', () => {
    const html = render({
      ...baseData,
      cards: baseData.cards.filter((card) => card.key !== 'eligible_spend'),
      metadata: { ...baseData.metadata, dataAsOf: null },
    });

    expect(html).toContain('$1,234.50');
    expect(html).toContain('card-dashboard-spend');
    expect(html).not.toContain('No summary for');
    expect(html).not.toContain('aria-label="Explore allocated funding in Spend"');
    expect(html).toContain('Actual reporting-period trend');
    expectRemovedOverviewSections(html);
  });

  it('renders empty and loading states without presenting a spend amount', () => {
    const emptyHtml = render({
      ...baseData,
      cards: [],
      metadata: { ...baseData.metadata, status: 'empty', dataAsOf: null },
    });
    mocks.query.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: false,
      refetch: mocks.refetch,
    });
    const loadingHtml = renderToStaticMarkup(<Dashboard />);

    expect(emptyHtml).toContain('No summary for');
    expect(emptyHtml).toContain('Actual reporting-period trend');
    expect(emptyHtml).toContain('>Retry<');
    expectRemovedOverviewSections(emptyHtml);
    expect(loadingHtml).toContain('aria-label="Loading Overview"');
    expect(loadingHtml).not.toContain('Recognized spend');
  });

  it.each(['account', 'workspace_admin', 'team_admin', 'member'] as const)(
    'renders the briefing for the supported %s role',
    (role) => {
      mocks.auth.mockReturnValue({
        role,
        authorizationKey: `authorization-${role}`,
        auth: { viewScope: role === 'member' ? 'my' : 'managed' },
        capabilities,
      });

      const html = render({
        ...baseData,
        scope: {
          ...baseData.scope,
          viewScope: role === 'member' ? 'my' : 'managed',
          isPersonal: role === 'member',
        },
      });

      expect(html).toContain('>Overview<');
      expect(html).toContain('>Spend<');
      expect(html).toContain('Actual reporting-period trend');
      expect(html).toContain('aria-label="Explore spend in Spend"');
      expectRemovedOverviewSections(html);
      expect(html.includes('data-testid="select-dashboard-scope"')).toBe(role !== 'member');
    },
  );

  it('does not display empty snapshot rollup zeros as observed spend or remaining funding', () => {
    const html = render({
      ...baseData,
      cards: baseData.cards.map(card => ({ ...card, value: 0 })),
      metadata: { ...baseData.metadata, status: 'empty', dataAsOf: null },
    });
    expect(html).toContain('No summary for');
    expect(html).toContain('>Retry<');
    expect(html).not.toContain('card-dashboard-eligible_spend');
    expect(html).not.toContain('card-dashboard-allocation_remaining');
    expect(html).toContain('card-dashboard-allocated_budget');
    expectRemovedOverviewSections(html);
  });

  it('leaves cached values visible without a local refresh notice', () => {
    const html = render({ ...baseData, cards: [] }, { isError: true });
    expect(html).not.toContain('Refresh failed');
    expect(html).not.toContain('>Retry<');
    expect(html).toContain('$1,234.50');
    expect(html).toContain('Outlook unavailable');
    expectRemovedOverviewSections(html);
  });
});