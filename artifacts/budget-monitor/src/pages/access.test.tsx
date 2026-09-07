import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import Access from './access';

const groups = vi.fn();
let canManageAccess = false;
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    isAccountAdmin: true, authorizationKey: 'sample-account',
    capabilities: { canManageAccess },
  }),
}));
vi.mock('wouter', () => ({
  useSearch: () => 'workspaceId=sample-workspace',
  Link: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ cancelQueries: vi.fn(), removeQueries: vi.fn() }),
}));
vi.mock('@workspace/api-client-react', () => ({
  useListWorkspaceGroups: (...args: unknown[]) => groups(...args),
  getListWorkspaceGroupsQueryKey: vi.fn(() => ['groups']),
  useListWorkspaceGroupMembers: vi.fn(),
  getListWorkspaceGroupMembersQueryKey: vi.fn(),
}));
beforeEach(() => {
  canManageAccess = false;
  groups.mockReset().mockReturnValue({ data: { workspaces: [] }, isError: false });
});

it('does not request directory data for an account role without the access capability', () => {
  expect(renderToStaticMarkup(<Access />)).not.toContain('Workspace groups');
  expect(groups).not.toHaveBeenCalled();
});

it('scopes directory requests for an access-management administrator', () => {
  canManageAccess = true;
  expect(renderToStaticMarkup(<Access />)).toContain('Workspace groups');
  expect(groups).toHaveBeenCalledWith(
    { workspaceId: 'sample-workspace' }, expect.anything(),
  );
});