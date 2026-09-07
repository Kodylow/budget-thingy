import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import UserProjects from './user-projects';

const listProjects = vi.fn();
vi.mock('wouter', () => ({
  useParams: () => ({ userId: 'user-1' }),
  useSearch: () => 'page=2&viewScope=managed&workspaceId=workspace-1&returnTo=%2Fspend%3Ftab%3Dpeople',
  useLocation: () => ['/users/user-1', vi.fn()],
}));
vi.mock('@/components/range-context', () => ({
  useRange: () => ({ rangeType: 'mtd', startDate: '', endDate: '' }),
}));
vi.mock('@workspace/api-client-react', () => ({
  useListUserOwnedProjects: (...args: unknown[]) => listProjects(...args),
  getListUserOwnedProjectsQueryKey: vi.fn(() => ['user-projects']),
}));

describe('UserProjects', () => {
  it('passes sensitive scope and workspace context and renders paging controls', () => {
    listProjects.mockReturnValue({
      isError: false,
      data: {
        user: { userId: 'user-1', name: 'Owner', username: null, email: null },
        projects: {
          rows: [{
            id: 'project:workspace-1:p1', projectId: 'p1', kind: 'project', name: 'Project',
            workspaceId: 'workspace-1', workspaceName: 'Workspace', ownerId: 'user-1', ownerName: 'Owner',
            createdAt: null, updatedAt: null, metadataAvailability: 'complete', hasDeployment: null,
            deploymentAvailability: 'unavailable', deployments: [], usageObserved: false, spendUsd: 0,
            agentSpendUsd: 0, otherServicesUsd: 0, staleButSpending: false,
          }],
          page: 2, pageSize: 25, totalRows: 60, filteredRows: 60,
          totals: { spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0 },
          metadata: { status: 'partial', stale: true, dataAsOf: null, qualifications: [] },
        },
      },
    });
    const html = renderToStaticMarkup(<UserProjects />);
    expect(listProjects.mock.calls[0][1]).toMatchObject({
      page: 2, pageSize: 25, viewScope: 'managed', workspaceId: 'workspace-1',
    });
    expect(html).toContain('Page 2 of 3');
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(html).toContain('Deployment unknown');
    expect(html).toContain('Project data freshness unknown');
    expect(html).toContain('returnTo=%2Fusers%2Fuser-1');
  });
});