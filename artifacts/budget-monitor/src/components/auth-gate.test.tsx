// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './auth-gate';
import { beginExplicitSignIn, getLoginUrl } from '@workspace/replit-auth-web';

const retryAuthorization = vi.fn();
const logout = vi.fn();
const resetPreview = vi.fn();
let availability = 'signed-out';
let embedded = false;
let isLoading = false;
let isAuthenticated = false;
let isDenied = false;

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    isLoading,
    isAuthenticated,
    isDenied,
    user: null,
    logout,
    isPreviewing: false,
    resetPreview,
    availability,
    retryAuthorization,
  }),
}));

vi.mock('@/pages/dashboard', () => ({}));
vi.mock('@/pages/dashboard-chart', () => ({}));
vi.mock('@workspace/replit-auth-web', async importOriginal => ({
  ...await importOriginal<typeof import('@workspace/replit-auth-web')>(),
  beginExplicitSignIn: vi.fn(),
  isEmbeddedPreview: () => embedded,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  availability = 'signed-out';
  embedded = false;
  isLoading = false;
  isAuthenticated = false;
  isDenied = false;
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('AuthGate sign-in shell', () => {
  it.each([
    { inPreview: false, target: '_self' },
    { inPreview: true, target: '_top' },
  ])('uses the current browser tab with preview=$inPreview', async ({ inPreview, target }) => {
    embedded = inPreview;
    await act(async () => root.render(
      createElement(AuthGate, null, createElement('div', null, 'protected')),
    ));
    const login = container.querySelector<HTMLAnchorElement>('[data-testid="button-login"]');
    expect(login?.textContent?.trim()).toBe('Log in');
    expect(login?.getAttribute('href')).toBe('/api/login?returnTo=%2F');
    expect(login?.getAttribute('target')).toBe(target);
    expect(container.textContent).not.toContain('protected');
    expect(beginExplicitSignIn).not.toHaveBeenCalled();
    login?.addEventListener('click', event => event.preventDefault());
    await act(async () => login?.click());
    expect(beginExplicitSignIn).toHaveBeenCalledOnce();
  });

  it('preserves the complete current path and query in the login return target', async () => {
    window.history.replaceState({}, '', '/spend?tab=members&search=team%20one');
    await act(async () => root.render(createElement(AuthGate, null, 'protected')));
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      getLoginUrl('/spend?tab=members&search=team%20one'),
    );
  });

  it('keeps the normal login shell for an unavailable check and offers reconnect', async () => {
    availability = 'unavailable';
    await act(async () => root.render(
      createElement(AuthGate, null, createElement('div', null, 'protected')),
    ));

    expect(container.querySelector('[data-testid="auth-signed-out"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="button-login"]')?.textContent).toContain('Log in');
    const reconnect = container.querySelector<HTMLButtonElement>('[data-testid="button-reconnect"]');
    expect(reconnect).not.toBeNull();
    expect(container.textContent).not.toContain('protected');
    await act(async () => reconnect?.click());
    expect(retryAuthorization).toHaveBeenCalledOnce();
  });

  it('does not show reconnect during ordinary signed-out state', async () => {
    await act(async () => root.render(
      createElement(AuthGate, null, createElement('div', null, 'protected')),
    ));
    expect(container.querySelector('[data-testid="button-login"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="button-reconnect"]')).toBeNull();
  });

  it.each([
    ['loading', 'auth-loading'],
    ['invalid-preview', 'auth-invalid-preview'],
    ['denied', 'auth-denied'],
  ])('keeps the %s branch separate and protected content unmounted', async (state, testId) => {
    availability = state;
    isLoading = state === 'loading';
    isAuthenticated = state === 'denied';
    isDenied = state === 'denied';
    await act(async () => root.render(createElement(AuthGate, null, 'protected')));
    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    expect(container.querySelector('[data-testid="auth-signed-out"]')).toBeNull();
    expect(container.textContent).not.toContain('protected');
    if (state === 'invalid-preview') {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-reset-invalid-preview"]')?.click());
      expect(resetPreview).toHaveBeenCalledOnce();
    }
    if (state === 'denied') {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-logout-denied"]')?.click());
      expect(logout).toHaveBeenCalledOnce();
    }
  });

  it('renders only the protected children after successful authorization', async () => {
    availability = 'authorized';
    isAuthenticated = true;
    await act(async () => root.render(createElement(AuthGate, null, 'protected')));
    expect(container.textContent).toBe('protected');
    expect(container.querySelector('[data-testid="auth-signed-out"]')).toBeNull();
  });
});