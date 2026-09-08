// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipContextSummary, resolvePersonalWorkspace, searchAfterEffectiveIdentityChange, type PersonalMembershipContext } from './membership-context';

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const context: PersonalMembershipContext = {
  defaultWorkspaceId: 'lift',
  qualification: null,
  workspaces: [
    { workspaceId: 'comcast', workspaceName: 'Comcast', isPreferred: false, budgetTeams: [], unmappedGroups: [] },
    {
      workspaceId: 'lift',
      workspaceName: 'LIFT Labs',
      isPreferred: true,
      budgetTeams: [
        { poolId: 'pool:lift', teamName: 'Innovation', groups: [{ groupId: 'g1', groupName: 'Builders' }] },
      ],
      unmappedGroups: [{ groupId: 'g2', groupName: 'Member' }],
    },
  ],
};

describe('personal membership context', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render(workspace = context.workspaces[1], isAccountAdmin = false) {
    act(() => root.render(
      <MembershipContextSummary
        workspace={workspace}
        defaultWorkspace={context.workspaces[1]}
        qualification="Internal qualification"
        isAccountAdmin={isAccountAdmin}
        canViewAccountUsage={isAccountAdmin}
      />,
    ));
  }

  it('uses the configured default instead of the legacy first workspace', () => {
    expect(resolvePersonalWorkspace(context, null).workspace?.workspaceId).toBe('lift');
  });

  it('preserves a valid explicit historical workspace selection', () => {
    expect(resolvePersonalWorkspace(context, 'comcast').workspace?.workspaceId).toBe('comcast');
  });

  it('replaces an obsolete selection with the eligible default', () => {
    expect(resolvePersonalWorkspace(context, 'missing').workspace?.workspaceId).toBe('lift');
    expect(resolvePersonalWorkspace({ ...context, workspaces: [context.workspaces[1]] }, 'comcast').workspace?.workspaceId).toBe('lift');
  });

  it('uses only returned candidates and distinguishes empty from unresolved membership', () => {
    expect(resolvePersonalWorkspace({ ...context, defaultWorkspaceId: null }, null).workspace).toBe(context.workspaces[0]);
    expect(resolvePersonalWorkspace({ ...context, workspaces: [] }, 'comcast')).toEqual({ workspace: null, status: 'empty' });
    expect(resolvePersonalWorkspace(undefined, 'comcast')).toEqual({ workspace: null, status: 'loading' });
  });

  it('strips the previous person workspace when the effective identity changes', () => {
    expect(searchAfterEffectiveIdentityChange(
      '?workspaceId=comcast&rangeType=custom&startDate=2026-06-01&endDate=2026-06-30',
      'denise',
      'katie',
    )).toBe('?rangeType=custom&startDate=2026-06-01&endDate=2026-06-30');
  });

  it('preserves an explicit workspace for the same identity reload or deep link', () => {
    const search = '?workspaceId=comcast&rangeType=full-term';
    expect(searchAfterEffectiveIdentityChange(search, 'denise', 'denise')).toBe(search);
    expect(searchAfterEffectiveIdentityChange(search, null, 'denise')).toBe(search);
  });

  it('opens an accessible dialog containing only actual membership data', () => {
    render();
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    expect(trigger.textContent).toBe('Your membership context');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.body.textContent).not.toContain('Innovation');

    act(() => trigger.click());

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Innovation');
    expect(document.body.textContent).toContain('LIFT Labs');
    expect(document.body.textContent).toContain('Builders');
    expect(document.body.textContent).toContain('Other access groups');
    expect(document.body.textContent).toContain('Member');
    expect(document.body.textContent).not.toContain('Internal qualification');
    expect(document.body.textContent).not.toContain('Not assigned');
  });

  it('shows the authorized Org Insights link and no filler for an empty workspace', () => {
    render(context.workspaces[0], true);
    act(() => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(document.body.textContent).toContain('Comcast');
    expect(document.body.textContent).toContain('Default workspace');
    expect(document.body.textContent).toContain('LIFT Labs');
    expect(document.querySelector<HTMLAnchorElement>('a[href="/org-insights"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('No groups');
    expect(document.body.textContent).not.toContain('Not assigned');
  });
});