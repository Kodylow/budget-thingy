import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectDetail from './project-detail';

const getProject = vi.fn();
const getProjectKey = vi.fn((..._args: unknown[]) => ['project']);
let search = '?viewScope=managed&workspaceId=workspace-1&poolId=pool%3Ateam%3AR%252FD&returnTo=%2Fteams%2Fpool%253Ateam%253AR%25252FD';

vi.mock('wouter', () => ({
  useParams: () => ({ workspaceId: 'workspace-1', projectId: 'project-1' }),
  useLocation: () => ['/workspaces/workspace-1/projects/project-1', vi.fn()],
}));
vi.mock('wouter/use-browser-location', () => ({
  useSearch: () => search,
}));
vi.mock('@/components/range-context', () => ({
  useRange: () => ({ rangeType: 'mtd', startDate: '', endDate: '' }),
}));
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({ authorizationKey: 'auth-scope-1' }),
}));
vi.mock('@workspace/api-client-react', () => ({
  useGetWorkspaceProject: (...args: unknown[]) => getProject(...args),
  getGetWorkspaceProjectQueryKey: (...args: unknown[]) => getProjectKey(args[0], args[1], args[2]),
}));

const response = {
  scope: { label: 'Managed' },
  period: { label: 'August' },
  metadata: { status: 'complete', stale: false, dataAsOf: null, qualifications: [] },
  project: {
    id: 'project:workspace-1:project-1', projectId: 'project-1', kind: 'project',
    name: 'Production project', workspaceId: 'workspace-1', workspaceName: 'Workspace',
    ownerId: 'owner/one', ownerName: 'Actual Owner', createdAt: '2026-08-01T00:00:00Z',
    updatedAt: null, metadataAvailability: 'complete', hasDeployment: true,
    deploymentAvailability: 'complete', usageObserved: false, spendUsd: 0, agentSpendUsd: 0,
    otherServicesUsd: 0, currentMonthSpendUsd: null, currentMonthUsageAvailability: 'unavailable',
    staleButSpending: false, deployments: [{ id: 'd1', url: 'javascript:alert(1)', status: null, privacy: null, createdAt: null, updatedAt: null }],
  },
};

describe('ProjectDetail correctness states', () => {
  beforeEach(() => {
    getProject.mockReset();
    getProjectKey.mockClear();
    getProject.mockReturnValue({ data: response, isError: false });
    search = '?viewScope=managed&workspaceId=workspace-1&poolId=pool%3Ateam%3AR%252FD&returnTo=%2Fteams%2Fpool%253Ateam%253AR%25252FD';
  });

  it('scopes the query, links the actual owner, and never links an unsafe deployment URL', () => {
    const html = renderToStaticMarkup(<ProjectDetail />);
    expect(getProject.mock.calls[0][2]).toMatchObject({
      viewScope: 'managed',
      poolId: 'pool:team:R%2FD',
    });
    expect(getProjectKey.mock.calls[0][2]).toMatchObject({
      poolId: 'pool:team:R%2FD',
    });
    expect(html).toContain('Actual Owner');
    expect(html).toContain('/users/owner%2Fone');
    expect(html).toContain('poolId=pool%3Ateam%3AR%252FD');
    expect(html).toContain('javascript:alert(1)');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('Created:');
    expect(html).toContain('Unavailable');
    expect(html).toContain('freshness unknown');
  });

  it('distinguishes unavailable deployment observation from an observed empty list', () => {
    getProject.mockReturnValue({
      data: { ...response, project: { ...response.project, hasDeployment: null, deploymentAvailability: 'unavailable', deployments: [] } },
      isError: false,
    });
    expect(renderToStaticMarkup(<ProjectDetail />)).toContain('Deployment observation unavailable');
  });

  it('keeps cached project details visible when a refresh fails', () => {
    getProject.mockReturnValue({ data: response, isError: true, error: { status: 503 } });
    const html = renderToStaticMarkup(<ProjectDetail />);
    expect(html).toContain('Production project');
    expect(html).not.toContain('Project details are unavailable');
  });

  it('hides cached project identity and dates after a blocking access failure', () => {
    getProject.mockReturnValue({ data: response, isError: true, error: { status: 403 } });
    const html = renderToStaticMarkup(<ProjectDetail />);
    expect(html).toContain('Project details are unavailable');
    expect(html).not.toContain('Production project');
    expect(html).not.toContain('2026-08-01');
  });

  it('renders loading rather than an error for an initial reporting refresh', () => {
    const refreshing = { status: 503, data: { code: 'REPORTING_USAGE_REFRESHING' } };
    getProject.mockReturnValue({ data: undefined, isError: true, error: refreshing, failureReason: refreshing });
    const html = renderToStaticMarkup(<ProjectDetail />);
    expect(html).toContain('Loading project details');
    expect(html).not.toContain('Project details are unavailable');
  });

  it('uses the qualified route workspace over a conflicting query facet', () => {
    search = '?viewScope=my&workspaceId=other-workspace';
    renderToStaticMarkup(<ProjectDetail />);
    expect(getProject.mock.calls[0][2]).toMatchObject({ viewScope: 'my' });
    expect(getProject.mock.calls[0][0]).toBe('workspace-1');
  });

  it('keeps fixed personal scope in the generated request and nested owner link', () => {
    search = '?viewScope=my&returnTo=%2Fmy-projects%3Fsearch%3DAlpha';
    const html = renderToStaticMarkup(<ProjectDetail />);
    expect(getProject.mock.calls.at(-1)?.[2]).toMatchObject({ viewScope: 'my' });
    expect(getProjectKey.mock.calls.at(-1)?.[2]).toMatchObject({ viewScope: 'my' });
    expect(html).toContain('/users/owner%2Fone');
    expect(html).toContain('viewScope=my');
    expect(html).toContain('returnTo=%2Fworkspaces%2Fworkspace-1%2Fprojects%2Fproject-1');
  });

  it('sanitizes an external return destination', () => {
    search = '?returnTo=https%3A%2F%2Fevil.example';
    expect(renderToStaticMarkup(<ProjectDetail />)).toContain('Back');
  });
});