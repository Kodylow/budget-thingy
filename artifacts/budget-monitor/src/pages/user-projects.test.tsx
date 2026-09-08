import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import UserProjects from './user-projects';

const listProjects = vi.fn();
const listProjectsKey = vi.fn((..._args: unknown[]) => ['user-projects']);
let rawSearch = '?page=2&viewScope=managed&workspaceId=workspace-1&poolId=pool%3Ateam%3AR%252FD&returnTo=%2Fteams%2Fpool%253Ateam%253AR%25252FD';
vi.mock('wouter', () => ({
  useParams: () => ({ userId: 'user-1' }),
  useLocation: () => ['/users/user-1', vi.fn()],
}));
vi.mock('wouter/use-browser-location', () => ({
  useSearch: () => rawSearch,
}));
vi.mock('@/components/range-context', () => ({
  useRange: () => ({ rangeType: 'mtd', startDate: '', endDate: '' }),
}));
vi.mock('@workspace/api-client-react', () => ({
  useListUserOwnedProjects: (...args: unknown[]) => listProjects(...args),
  getListUserOwnedProjectsQueryKey: (...args: unknown[]) => listProjectsKey(args[0], args[1]),
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
      poolId: 'pool:team:R%2FD',
    });
    expect(listProjectsKey.mock.calls[0][1]).toMatchObject({
      poolId: 'pool:team:R%2FD',
    });
    expect(html).toContain('Page 2 of 3');
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(html).toContain('Deployment unknown');
    expect(html).not.toContain('Project usage partial');
    expect(html).not.toContain('Selected-period usage partial');
    expect(html).toContain('freshness unknown');
    expect(html).toContain('returnTo=%2Fusers%2Fuser-1');
    expect(html).toContain('poolId=pool%3Ateam%3AR%252FD');
  });

  it('keeps cached projects visible when a refresh fails', () => {
    listProjects.mockReturnValue({
      isError: true,
      data: {
        user: { userId: 'user-1', name: 'Owner', username: null, email: null },
        projects: {
          rows: [],
          page: 2, pageSize: 25, totalRows: 0, filteredRows: 0,
          totals: { spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0 },
          metadata: { status: 'complete', stale: false, dataAsOf: null, qualifications: [] },
        },
      },
    });
    const html = renderToStaticMarkup(<UserProjects />);
    expect(html).toContain('Owner');
    expect(html).not.toContain('Owned projects are unavailable');
  });

  it('keeps personal scope in the generated request and nested project link', () => {
    rawSearch = '?viewScope=my&returnTo=%2Fworkspaces%2Fworkspace-1%2Fprojects%2Fp1';
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
          page: 1, pageSize: 25, totalRows: 1, filteredRows: 1,
          totals: { spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0 },
          metadata: { status: 'complete', stale: false, dataAsOf: null, qualifications: [] },
        },
      },
    });
    const html = renderToStaticMarkup(<UserProjects />);
    expect(listProjects.mock.calls.at(-1)?.[1]).toMatchObject({ viewScope: 'my' });
    expect(listProjectsKey.mock.calls.at(-1)?.[1]).toMatchObject({ viewScope: 'my' });
    expect(html).toContain('/workspaces/workspace-1/projects/p1');
    expect(html).toContain('viewScope=my');
  });
});