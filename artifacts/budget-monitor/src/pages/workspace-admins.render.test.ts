import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
}));

vi.mock('@workspace/api-client-react', () => ({
  useListWorkspaceAdmins: () => hookState,
}));

import WorkspaceAdmins from './workspace-admins';

function renderPage(): string {
  return renderToStaticMarkup(createElement(WorkspaceAdmins));
}

describe('Team Admins page states', () => {
  beforeEach(() => {
    hookState.data = undefined;
    hookState.isLoading = false;
    hookState.isError = false;
  });

  it('renders a stable loading state', () => {
    hookState.isLoading = true;
    expect(renderPage()).toContain('data-testid="workspace-admins-loading"');
  });

  it('renders a stable request-failure state', () => {
    hookState.isError = true;
    expect(renderPage()).toContain('data-testid="workspace-admins-error"');
    expect(renderPage()).toContain('Failed to load team admin data');
  });

  it('renders a clear empty state for an empty directory', () => {
    hookState.data = [];
    const html = renderPage();
    expect(html).toContain('data-testid="page-workspace-admins"');
    expect(html).toContain('data-testid="workspace-admins-empty"');
    expect(html).toContain('No team admin families found');
  });

  it('renders complete and partially populated directory records without throwing', () => {
    hookState.data = [
      {
        workspaceId: 'workspace-1',
        workspaceName: 'Growth',
        familyKey: 'growth',
        familyName: 'Growth',
        teamName: 'Platform',
        isLegacy: false,
        admins: [{ userId: 'user-1', username: 'complete', name: 'Complete Admin', email: 'admin@example.test' }],
      },
      {
        workspaceId: null,
        workspaceName: null,
        familyKey: undefined,
        familyName: undefined,
        admins: [{ userId: null, username: null, name: null, email: null }],
      },
    ];

    const html = renderPage();
    expect(html).toContain('Complete Admin');
    expect(html).toContain('Unknown workspace');
    expect(html).toContain('Unnamed family');
    expect(html).toContain('Unknown');
  });

  it('treats a malformed success payload as an empty directory', () => {
    hookState.data = { unexpected: true };
    const html = renderPage();
    expect(html).toContain('data-testid="workspace-admins-empty"');
  });
});