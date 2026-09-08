// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthContext, type AuthContextValue } from './auth-context-definition';
import {
  AdminDataQualityNote,
  AdminDataQualityProvider,
  AdminDataQualityTrigger,
} from './admin-data-quality';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';

const adminAuth = {
  authorizationKey: 'admin',
  isAccountAdmin: true,
  isWorkspaceAdmin: false,
  isTeamAdmin: false,
} as AuthContextValue;
const memberAuth = {
  ...adminAuth,
  authorizationKey: 'member',
  isAccountAdmin: false,
} as AuthContextValue;

describe('admin data quality', () => {
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
    container.remove();
    document.body.innerHTML = '';
  });

  function render(auth: AuthContextValue, showNote = true) {
    act(() => root.render(
      <AuthContext.Provider value={auth}>
        <AdminDataQualityProvider>
          <AdminDataQualityTrigger />
          {showNote && (
            <AdminDataQualityNote title="Coverage">
              Includes only fully qualified usage.
            </AdminDataQualityNote>
          )}
        </AdminDataQualityProvider>
      </AuthContext.Provider>,
    ));
  }

  it('keeps qualifiers out of the normal page and portals them into one admin dialog', () => {
    render(adminAuth);
    expect(document.body.textContent).not.toContain('fully qualified');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="button-data-quality"]')?.click());

    expect(document.querySelectorAll('[data-testid="dialog-data-quality"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Includes only fully qualified usage.');
  });

  it('removes the trigger and open notes immediately when effective access becomes member', () => {
    render(adminAuth);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="button-data-quality"]')?.click());
    expect(document.body.textContent).toContain('fully qualified');

    render(memberAuth);

    expect(document.querySelector('[data-testid="button-data-quality"]')).toBeNull();
    expect(document.querySelector('[data-testid="dialog-data-quality"]')).toBeNull();
    expect(document.body.textContent).not.toContain('fully qualified');
  });

  it('does not expose notes to an account admin previewing effective member access', () => {
    render({ ...memberAuth, authorizationKey: 'admin:preview-member', realIsAccountAdmin: true } as AuthContextValue);
    expect(document.querySelector('[data-testid="button-data-quality"]')).toBeNull();
    expect(document.body.textContent).not.toContain('fully qualified');
  });

  it('does not retain notes after page unmount and lets Radix close with Escape', async () => {
    render(adminAuth);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="button-data-quality"]')!;
    act(() => {
      trigger.focus();
      trigger.click();
    });

    render(adminAuth, false);
    expect(document.body.textContent).not.toContain('fully qualified');
    expect(document.querySelector('[data-testid="data-quality-notes"]')?.textContent).toBe('');

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.querySelector('[data-testid="dialog-data-quality"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens independently inside a Radix Sheet and Escape leaves the Sheet open', async () => {
    act(() => root.render(
      <AuthContext.Provider value={adminAuth}>
        <AdminDataQualityProvider>
          <Sheet open>
            <SheetContent aria-describedby={undefined}>
              <SheetTitle>Navigation</SheetTitle>
              <AdminDataQualityTrigger />
            </SheetContent>
          </Sheet>
          <AdminDataQualityNote>Nested panel note.</AdminDataQualityNote>
        </AdminDataQualityProvider>
      </AuthContext.Provider>,
    ));
    const sheet = document.querySelector('[data-sheet-side]');
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="button-data-quality"]')!;

    act(() => {
      trigger.focus();
      trigger.click();
    });
    expect(document.querySelector('[data-testid="dialog-data-quality"]')).not.toBeNull();
    expect(sheet?.getAttribute('data-state')).toBe('open');

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(document.querySelector('[data-testid="dialog-data-quality"]')).toBeNull();
    expect(sheet?.getAttribute('data-state')).toBe('open');
    expect(document.activeElement).toBe(trigger);
  });
});