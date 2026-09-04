import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Spend from './spend';
import * as api from '@workspace/api-client-react';

const mockCapabilities = {
  canManageAccess: false,
  canViewAccountUsage: false,
  canEditAllocations: false,
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
    metadata: {}
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

  it('family/workspace/member tab matrices match', () => {
    // 1. Family manager (team_admin) gets pools, groups, people, projects
    mockAuthContext.mockReturnValue({
      role: 'team_admin', isAccountAdmin: false, isWorkspaceAdmin: false, isTeamAdmin: true,
      capabilities: mockCapabilities, auth: { viewScope: 'managed' }
    });
    vi.mocked(api.useListSpendPools).mockReturnValue(mockQueryReturn([], 0, 0));
    vi.mocked(api.useListSpendGroups).mockReturnValue(mockQueryReturn([], 0, 0));
    vi.mocked(api.useListSpendPeople).mockReturnValue(mockQueryReturn([], 0, 0));
    vi.mocked(api.useListSpendProjects).mockReturnValue(mockQueryReturn([], 0, 0));
    
    let html = renderComponent();
    expect(html).toContain('Budget pools');
    expect(html).toContain('Groups');
    expect(html).toContain('People');
    expect(html).toContain('Projects');

    // 2. Member gets people, projects only
    mockAuthContext.mockReturnValue({
      role: 'member', isAccountAdmin: false, isWorkspaceAdmin: false, isTeamAdmin: false,
      capabilities: mockCapabilities, auth: { viewScope: 'self' }
    });
    html = renderComponent();
    expect(html).not.toContain('Budget pools');
    expect(html).not.toContain('Groups');
    expect(html).toContain('People');
    expect(html).toContain('Projects');
  });

  it('hidden tabs never query and active tab queries properly', () => {
    const poolsSpy = vi.mocked(api.useListSpendPools).mockReturnValue(mockQueryReturn([], 0, 0));
    const groupsSpy = vi.mocked(api.useListSpendGroups).mockReturnValue(mockQueryReturn([], 0, 0));
    
    renderComponent();
    
    // Default tab for team_admin is 'pools'.
    // The pools query should be enabled=true, others enabled=false
    expect(poolsSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ query: expect.objectContaining({ enabled: true }) }));
    expect(groupsSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ query: expect.objectContaining({ enabled: false }) }));
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
    expect(html).toContain('Showing 26–50 of 50 results');
  });
});