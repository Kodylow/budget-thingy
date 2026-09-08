// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSessionActions } from './account-session-actions';
import { beginExplicitSignIn, getLoginUrl, navigateToLogin } from '@workspace/replit-auth-web';

const logout = vi.fn();
const exit = vi.fn();
let selectedId: string | null = null;
let embedded = false;

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    logout,
    developmentView: { selectedId, exit },
  }),
}));

vi.mock('@workspace/replit-auth-web', async importOriginal => ({
  ...await importOriginal<typeof import('@workspace/replit-auth-web')>(),
  beginExplicitSignIn: vi.fn(),
  navigateToLogin: vi.fn(() => '_self'),
  isEmbeddedPreview: () => embedded,
  logAuthDebug: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  selectedId = null;
  embedded = false;
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('AccountSessionActions', () => {
  it('logs out only in the real session view', async () => {
    await act(async () => root.render(createElement(AccountSessionActions)));
    expect(container.querySelector('[data-testid="button-login-yourself"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-logout"]')?.click());
    expect(logout).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits a selected development preview without invoking logout', async () => {
    selectedId = 'preview-user';
    await act(async () => root.render(createElement(AccountSessionActions)));
    expect(container.querySelector('[data-testid="button-logout"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-exit-development-preview"]')?.click());
    expect(exit).toHaveBeenCalledOnce();
    expect(logout).not.toHaveBeenCalled();
  });

  it.each([
    { inPreview: false, target: '_self' },
    { inPreview: true, target: '_blank' },
  ])('keeps a native sign-in href and exits before sign-in with embedded=$inPreview', async ({ inPreview, target }) => {
    const order: string[] = [];
    selectedId = 'preview-user';
    embedded = inPreview;
    exit.mockImplementation(() => order.push('exit'));
    vi.mocked(beginExplicitSignIn).mockImplementation(() => order.push('begin'));
    vi.mocked(navigateToLogin).mockImplementation(() => {
      order.push('navigate');
      return inPreview ? '_blank' : '_self';
    });
    window.history.replaceState({}, '', '/spend?tab=members');
    await act(async () => root.render(createElement(AccountSessionActions)));

    const signIn = container.querySelector<HTMLAnchorElement>('[data-testid="button-login-yourself"]');
    const href = getLoginUrl('/spend?tab=members');
    expect(signIn?.tagName).toBe('A');
    expect(signIn?.getAttribute('href')).toBe(href);
    expect(signIn?.getAttribute('target')).toBe(target);
    await act(async () => signIn?.click());
    expect(order).toEqual(['exit', 'begin', 'navigate']);
    expect(navigateToLogin).toHaveBeenCalledWith('/spend?tab=members');
    expect(signIn?.getAttribute('href')).toBe(href);
    expect(logout).not.toHaveBeenCalled();
  });
});