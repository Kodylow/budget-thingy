import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import MyProjects from './my-projects';

vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

const mocks = vi.hoisted(() => ({
  role: 'account',
  projects: vi.fn(),
  projectsKey: vi.fn((..._args: unknown[]) => ['projects']),
}));

vi.mock('wouter', () => ({
  Link: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
  useLocation: () => ['/my-projects', vi.fn()],
  useSearch: () => 'search=Alpha',
}));
vi.mock('@/components/range-context', () => ({
  useRange: () => ({ rangeType: 'full-term', startDate: undefined, endDate: undefined }),
}));
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({ role: mocks.role, authorizationKey: 'auth-scope-1' }),
}));
vi.mock('@/components/range-filter', () => ({ RangeFilter: () => null }));
vi.mock('@/components/admin-data-quality', () => ({ AdminDataQualityNote: () => null }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@workspace/api-client-react', () => ({
  getExportSpendProjectsTableCsvUrl: vi.fn(),
  getListSpendProjectsQueryKey: (...args: unknown[]) => mocks.projectsKey(args[0]),
  useListSpendProjects: (...args: unknown[]) => mocks.projects(...args),
}));

const project = {
  id: 'project:workspace-1:project-1',
  projectId: 'project-1',
  kind: 'project',
  name: 'Alpha',
  workspaceId: 'workspace-1',
  workspaceName: 'Workspace',
  ownerId: 'owner-1',
  ownerName: 'Owner',
  spendUsd: 10,
  agentSpendUsd: 8,
  otherServicesUsd: 2,
  usageObserved: true,
  hasDeployment: false,
  deploymentAvailability: 'complete',
  staleButSpending: false,
  updatedAt: null,
};

describe.each(['account', 'team_admin'])('My Projects fixed personal scope for %s viewers', role => {
  it('uses personal generated request params without adding scope to its return URL', () => {
    mocks.role = role;
    mocks.projects.mockReturnValue({
      data: {
        rows: [project],
        filteredRows: 1,
        totals: { spendUsd: 10, agentSpendUsd: 8, otherServicesUsd: 2 },
        facets: { workspaces: [] },
        metadata: { status: 'complete', stale: false, qualifications: [], dataAsOf: null },
      },
      isError: false,
      isFetching: false,
    });

    const html = renderToStaticMarkup(<MyProjects />);
    expect(mocks.projects.mock.calls.at(-1)?.[0]).toMatchObject({ viewScope: 'my' });
    expect(mocks.projectsKey.mock.calls.at(-1)?.[0]).toMatchObject({ viewScope: 'my' });
    expect(html).toContain('viewScope=my');
    expect(html).toContain('returnTo=%2Fmy-projects%3Fsearch%3DAlpha');
    expect(html).not.toContain('returnTo=%2Fmy-projects%3Fsearch%3DAlpha%26viewScope%3Dmy');
  });
});

describe('My Projects refresh states', () => {
  it('keeps cached rows quiet for a server refresh failure', () => {
    mocks.projects.mockReturnValue({
      data: {
        rows: [project], filteredRows: 1,
        totals: { spendUsd: 10, agentSpendUsd: 8, otherServicesUsd: 2 },
        facets: { workspaces: [] },
        metadata: { status: 'complete', stale: false, qualifications: [], dataAsOf: null },
      },
      isError: true,
      isFetching: false,
      error: { status: 500 },
    });
    const html = renderToStaticMarkup(<MyProjects />);
    expect(html).toContain('Alpha');
    expect(html).not.toContain('Updating projects');
    expect(html).not.toContain('My projects are unavailable');
  });

  it('hides cached rows for a blocking error', () => {
    mocks.projects.mockReturnValue({
      data: {
        rows: [project], filteredRows: 1,
        totals: { spendUsd: 10, agentSpendUsd: 8, otherServicesUsd: 2 },
        facets: { workspaces: [] },
        metadata: { status: 'complete', stale: false, qualifications: [], dataAsOf: null },
      },
      isError: true,
      error: { status: 403 },
    });
    const html = renderToStaticMarkup(<MyProjects />);
    expect(html).toContain('My projects are unavailable');
    expect(html).not.toContain('>Alpha<');
  });

  it('renders loading for an initial typed reporting refresh', () => {
    const refreshing = { status: 503, data: { code: 'REPORTING_USAGE_REFRESHING' } };
    mocks.projects.mockReturnValue({ data: undefined, isError: true, error: refreshing, failureReason: refreshing });
    const html = renderToStaticMarkup(<MyProjects />);
    expect(html).toContain('Loading my projects');
    expect(html).not.toContain('My projects are unavailable');
  });
});