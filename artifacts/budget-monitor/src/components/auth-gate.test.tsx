// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './auth-gate';

const retryAuthorization = vi.fn();
let availability = 'signed-out';
let embedded = false;

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    isLoading: false,
    isAuthenticated: false,
    isDenied: false,
    user: null,
    logout: vi.fn(),
    isPreviewing: false,
    resetPreview: vi.fn(),
    availability,
    retryAuthorization,
  }),
}));

vi.mock('@workspace/replit-auth-web', () => ({
  beginExplicitSignIn: vi.fn(),
  getLoginUrl: () => '/api/login?returnTo=%2F',
  isEmbeddedPreview: () => embedded,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  availability = 'signed-out';
  embedded = false;
  retryAuthorization.mockClear();
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
});