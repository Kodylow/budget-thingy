import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectDetail from './project-detail';

const getProject = vi.fn();
let search = 'viewScope=managed&workspaceId=workspace-1&returnTo=%2Fspend%3Ftab%3Dprojects';

vi.mock('wouter', () => ({
  useParams: () => ({ workspaceId: 'workspace-1', projectId: 'project-1' }),
  useSearch: () => search,
  useLocation: () => ['/workspaces/workspace-1/projects/project-1', vi.fn()],
}));
vi.mock('@/components/range-context', () => ({
  useRange: () => ({ rangeType: 'mtd', startDate: '', endDate: '' }),
}));
vi.mock('@workspace/api-client-react', () => ({
  useGetWorkspaceProject: (...args: unknown[]) => getProject(...args),
  getGetWorkspaceProjectQueryKey: vi.fn(() => ['project']),
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
    getProject.mockReturnValue({ data: response, isError: false });
    search = 'viewScope=managed&workspaceId=workspace-1&returnTo=%2Fspend%3Ftab%3Dprojects';
  });

  it('scopes the query, links the actual owner, and never links an unsafe deployment URL', () => {
    const html = renderToStaticMarkup(<ProjectDetail />);
    expect(getProject.mock.calls[0][2]).toMatchObject({ viewScope: 'managed', workspaceId: 'workspace-1' });
    expect(html).toContain('Actual Owner');
    expect(html).toContain('/users/owner%2Fone');
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
    getProject.mockReturnValue({ data: response, isError: true });
    const html = renderToStaticMarkup(<ProjectDetail />);
    expect(html).toContain('Production project');
    expect(html).not.toContain('Project details are unavailable');
  });

  it('uses the qualified route workspace over a conflicting query facet', () => {
    search = 'viewScope=my&workspaceId=other-workspace';
    renderToStaticMarkup(<ProjectDetail />);
    expect(getProject.mock.calls[0][2]).toMatchObject({ viewScope: 'my', workspaceId: 'workspace-1' });
  });

  it('sanitizes an external return destination', () => {
    search = 'returnTo=https%3A%2F%2Fevil.example';
    expect(renderToStaticMarkup(<ProjectDetail />)).toContain('Back');
  });
});