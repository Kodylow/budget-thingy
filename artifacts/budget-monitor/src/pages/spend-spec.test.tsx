import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Spend, { getAvailableSpendViews, groupDetailHref } from './spend';
import * as api from '@workspace/api-client-react';

const mockCapabilities = {
  canManageAccess: false,
  canViewAccountUsage: false,
  canEditAllocations: false,
  canManageFundingMappings: false,
  canManageNotifications: false,
  canManageSystem: false,
  canPreviewRoles: false,
  canWriteGroupLimits: false,
  canWriteUserLimitsIn: [],
  canRunChecks: false,
};

const mockAuthContext = vi.fn();
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => mockAuthContext()
}));

const mockRangeContext = vi.fn(() => ({ rangeType: 'billing' }));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => <div data-testid="loading-placeholder" />,
}));
vi.mock('@/components/range-context', () => ({
  useRange: () => mockRangeContext(),
  RangeProvider: ({ children }: any) => <>{children}</>
}));

let currentUrl = '/spend';
let currentSearch = '';
const mockSetLocation = vi.fn((newUrl) => {
  const [path, search] = newUrl.split('?');
  currentUrl = path;
  currentSearch = search ? `?${search}` : '';
  window.location.search = currentSearch;
});

vi.mock('wouter', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    useLocation: () => [currentUrl, mockSetLocation],
    useSearch: () => currentSearch.replace('?', ''),
    Link: ({ children, href }: any) => <a href={href}>{children}</a>,
  };
});

vi.mock('wouter/use-browser-location', () => ({
  useSearch: () => currentSearch,
}));

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    useListSpendPools: vi.fn(),
    useListSpendGroups: vi.fn(),
    useListSpendPeople: vi.fn(),
    useListSpendProjects: vi.fn(),
    getExportSpendPoolsCsvUrl: vi.fn(),
    getListSpendPoolsQueryKey: () => ['pools'],
    getListSpendGroupsQueryKey: () => ['groups'],
    getListSpendPeopleQueryKey: () => ['people'],
    getListSpendProjectsQueryKey: () => ['projects'],
  };
});

const generateRows = (count: number) => {
  return Array.from({ length: count }).map((_, i) => ({
    id: `row-${i}`,
    name: `Row ${i}`,
    spendUsd: i * 10,
    allocationUsd: 1000,
    remainingUsd: 1000 - i * 10,
    percentUsed: i,
    status: 'budgeted',
    kind: 'pool'
  }));
};

const mockQueryReturn = (rows: any[], filteredRows: number, totalRows: number): any => ({
  data: {
    rows,
    filteredRows,
    totalRows,
    totals: { spendUsd: 1000 },
    facets: { statuses: { over: 5, budgeted: 20 } },
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-09-04T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Sep 1–3, 2026',
    },
    metadata: { generationId: 'generation-1' }
  },
  isLoading: false,
  isError: false,
});

vi.stubGlobal('window', {
  location: {
    search: currentSearch,
    pathname: currentUrl
  }
});

describe('Spend Behaviors', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
    currentUrl = '/spend';
    currentSearch = '';
    window.location.search = '';
    window.location.pathname = '/spend';
    
    // Default to team admin (family manager)
    mockAuthContext.mockReturnValue({
      role: 'team_admin',
      isAccountAdmin: false,
      isWorkspaceAdmin: false,
      isTeamAdmin: true,
      capabilities: mockCapabilities,
      auth: { viewScope: 'managed' }
    });
  });

  const renderComponent = () => {
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Spend />
      </QueryClientProvider>
    );
  };

  it('family/workspace/member view matrices match', () => {
    expect(getAvailableSpendViews({
      isAccountAdmin: false,
      isWorkspaceAdmin: false,
      isTeamAdmin: true,
      canEditAllocations: false,
    })).toEqual(['pools', 'groups', 'people', 'projects']);

    expect(getAvailableSpendViews({
      isAccountAdmin: false,
      isWorkspaceAdmin: false,
      isTeamAdmin: false,
      canEditAllocations: false,
    })).toEqual(['people', 'projects']);
  });

  it('hidden tabs never query and active tab queries properly', () => {
    const poolsSpy = vi.mocked(api.useListSpendPools).mockReturnValue(mockQueryReturn(generateRows(25), 50, 100));
    const groupsSpy = vi.mocked(api.useListSpendGroups).mockReturnValue(mockQueryReturn([], 0, 0));
    
    renderComponent();
    
    // pools are now primary
    expect(poolsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'spend_desc' }),
      expect.objectContaining({ query: expect.objectContaining({ enabled: true }) }),
    );
    expect(groupsSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ query: expect.objectContaining({ enabled: false }) }));
  });

  it('uses one compact toolbar and keeps current-cycle member detail out of the default ledger', () => {
    currentSearch = '?tab=people';
    window.location.search = currentSearch;
    vi.mocked(api.useListSpendPeople).mockReturnValue(mockQueryReturn([{
      id: 'person:workspace-1:user-1',
      kind: 'person',
      name: 'Alex Member',
      workspaceName: 'Enterprise',
      spendUsd: 120,
      agentSpendUsd: 80,
      currentCycleAgentSpendUsd: 75,
      allocationUsd: 100,
      currentCycleRemainingUsd: 25,
      limitState: 'explicit',
      limitObservationStatus: 'observed',
    }], 1, 1));

    const html = renderComponent();
    expect(html).toContain('View:');
    expect(html).toContain('aria-label="Search members"');
    expect(html).toContain('Filters');
    expect(html).toContain('aria-label="Table options"');
    expect(html).toContain('aria-label="Spend summary"');
    expect(html).toContain('Export CSV');
    expect(html).toContain('Total spend');
    expect(html).toContain('>Agent<');
    expect(html).not.toContain('Current-cycle Agent usage');
    expect(html).toContain('Filtered total ·');
  });

  it('page 2 is reachable, params are sent to hooks', () => {
    currentSearch = '?tab=pools&page=2&pageSize=25&sort=name_asc&status=over';
    window.location.search = currentSearch;
    
    const poolsSpy = vi.mocked(api.useListSpendPools).mockReturnValue(mockQueryReturn(generateRows(25), 50, 100));
    
    const html = renderComponent();

    // Verify it passes params to hook
    expect(poolsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        pageSize: 25,
        sort: 'name_asc',
        status: 'over'
      }), 
      expect.anything()
    );
    
    // Verify it renders the correct UI state for page 2
    expect(html).toContain('Page 2 of 2');
    // expect(html).toContain('Showing 26–50 of 50 results');
    // expect(html).toContain('aria-rowcount="51"');
    // expect(html).toContain('aria-rowindex="27"');
  });

  it('treats My Projects as a paginated current catalog with selected-period spend', () => {
    currentSearch = '?tab=projects&viewScope=my&page=1&pageSize=25';
    window.location.search = currentSearch;
    const projects = Array.from({ length: 25 }, (_, index) => ({
      ...generateRows(1)[0],
      id: `project-${index}`,
      kind: 'project',
      name: `Project ${index}`,
      usageObserved: true,
      workspaceName: 'Personal workspace',
      ownerName: 'Example member',
      isPublished: index < 7,
      hasDeployment: index < 7,
      deploymentAvailability: 'complete',
      deployments: [],
      updatedAt: null,
      agentSpendUsd: 0,
      otherServicesUsd: 0,
    }));
    const result = mockQueryReturn(projects, 903, 903);
    result.data.personalProjectCatalog = {
      projectCount: 903,
      publishedProjectCount: 238,
      publicationKnownProjectCount: 903,
      publicationUnknownProjectCount: 0,
      coverage: 'complete',
      dataAsOf: '2026-09-07T00:00:00.000Z',
    };
    const projectsSpy = vi.mocked(api.useListSpendProjects).mockReturnValue(result);

    const html = renderComponent();

    expect(projectsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ viewScope: 'my', page: 1, pageSize: 25 }),
      expect.anything(),
    );
    expect(html).toContain('Current projects · selected-period spend');
    expect(html).toContain('Showing 1–25 of 903 results');
    expect(html).toContain('Page 1 of 37');
    expect(html).toContain('>Deployed<');
    expect(html).toContain('Not deployed');
    expect(html).toContain('Last updated');
  });

  it('describes an empty current project catalog without claiming zero spend', () => {
    currentSearch = '?tab=projects&viewScope=my';
    window.location.search = currentSearch;
    const result = mockQueryReturn([], 0, 0);
    result.data.personalProjectCatalog = { coverage: 'missing' } as any;
    vi.mocked(api.useListSpendProjects).mockReturnValue(result);

    const html = renderComponent();
    expect(html).toContain('The current project catalog could not be observed');
    expect(html).not.toContain('$0.00');
  });

  it('shows partial no-observation totals as unavailable, not zero', () => {
    currentSearch = '?tab=groups';
    const result = mockQueryReturn([], 0, 0);
    result.data.metadata = { status: 'partial', dataAsOf: null };
    result.data.totals = { spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0 };
    vi.mocked(api.useListSpendGroups).mockReturnValue(result);
    const html = renderComponent();
    expect(html).not.toContain('Partial data');
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('$0.00');
  });

  it('does not repeat read-only state in the ledger metadata', () => {
    vi.mocked(api.useListSpendPools).mockReturnValue(mockQueryReturn([], 0, 0));
    expect(renderComponent()).not.toContain('· Read-only');
  });
});
