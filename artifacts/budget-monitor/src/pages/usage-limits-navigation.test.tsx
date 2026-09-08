import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LimitsPage from './limits';

const fixture = vi.hoisted(() => ({
  search: '',
  capabilities: { canWriteGroupLimits: true, canViewAccountUsage: true, canWriteUserLimitsIn: ['ws-sample'] },
  preview: false,
  previewReadOnly: false,
  groupMounts: 0,
}));
vi.mock('wouter', () => ({
  useSearch: () => fixture.search,
  useLocation: () => ['/limits', vi.fn()],
  Link: ({ href, children }: any) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    capabilities: fixture.capabilities,
    auth: { previewReadOnly: fixture.previewReadOnly },
    isPreviewing: fixture.preview,
  }),
}));
vi.mock('@/components/group-limits-view', () => ({
  GroupLimitsView: () => {
    fixture.groupMounts++;
    return <section>Shared Members target editor</section>;
  },
}));
vi.mock('@/lib/limits-state', () => ({
  activeLimitOperationQueryOptions: vi.fn(),
  useLimitsState: () => ({
    workspaceId: null, setWorkspaceId: vi.fn(),
    activeOperations: [], addOperation: vi.fn(), removeOperation: vi.fn(),
    activeOperationId: null, setActiveOperationId: vi.fn(),
    availableWorkspaces: fixture.capabilities.canWriteUserLimitsIn,
  }),
}));
vi.mock('@workspace/api-client-react', async original => ({
  ...await original<object>(),
  useListVisibleWorkspaces: () => ({ data: [{ workspaceId: 'ws-sample', workspaceName: 'Sample Workspace' }] }),
}));

beforeEach(() => {
  fixture.search = '';
  fixture.capabilities = { canWriteGroupLimits: true, canViewAccountUsage: true, canWriteUserLimitsIn: ['ws-sample'] };
  fixture.preview = false;
  fixture.previewReadOnly = false;
  fixture.groupMounts = 0;
});
const render = () => renderToStaticMarkup(<LimitsPage />);

describe('Usage Limits navigation and capability boundaries', () => {
  it('lands account group-limit editors on groups without requiring individual workspaces', () => {
    fixture.capabilities.canWriteUserLimitsIn = [];
    const html = render();
    expect(html).toContain('Usage Limits');
    expect(html).toContain('Shared Members target editor');
    expect(html).toContain('View Budget allocations');
  });
  it.each(['view=individual', 'workspaceId=ws-sample', 'workspaceId=ws-sample&groupId=members-id', 'groupIds=members-id'])(
    'preserves individual entry and existing deep links: %s', search => {
      fixture.search = search;
      expect(render()).toContain('Search workspaces');
      expect(fixture.groupMounts).toBe(0);
    },
  );
  it.each(['workspace admin', 'account delegate'])('never mounts account-only group queries for %s without capability', () => {
    fixture.capabilities.canWriteGroupLimits = false;
    fixture.search = 'view=groups';
    const html = render();
    expect(html).toContain('Individual limits');
    expect(html).not.toContain('Shared Members target editor');
    expect(fixture.groupMounts).toBe(0);
  });
  it('does not grant team admins access without an individual workspace capability', () => {
    fixture.capabilities.canWriteGroupLimits = false;
    fixture.capabilities.canWriteUserLimitsIn = [];
    expect(render()).toContain('No authorized workspaces');
    expect(fixture.groupMounts).toBe(0);
  });
  it.each(['preview', 'previewReadOnly'] as const)('does not mount group editing in %s', flag => {
    fixture[flag] = true;
    expect(render()).toContain('Read-only');
    expect(fixture.groupMounts).toBe(0);
  });
});