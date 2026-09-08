// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  availability: 'loading' as
    | 'loading'
    | 'authorized'
    | 'signed-out'
    | 'denied'
    | 'invalid-preview'
    | 'unavailable',
  canViewAccountUsage: false,
  email: null as string | null,
  homeMounts: 0,
  personalQueryHook: vi.fn(),
  setLocation: vi.fn(),
}));

vi.mock('@/components/auth-context', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuthContext: () => ({
    availability: fixture.availability,
    capabilities: {
      canViewAccountUsage: fixture.canViewAccountUsage,
    },
    user: fixture.email ? { email: fixture.email } : null,
  }),
}));

vi.mock('wouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wouter')>();
  return {
    ...actual,
    useLocation: () => ['/', fixture.setLocation] as const,
  };
});

vi.mock('@/pages/home', () => ({
  default: function PersonalHomeFixture() {
    fixture.homeMounts += 1;
    fixture.personalQueryHook();
    return <div data-testid="personal-home-fixture">Personal Home</div>;
  },
}));

import { RootRoute } from './App';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function renderRootRoute() {
  await act(async () => {
    root.render(<RootRoute />);
  });
}

beforeEach(() => {
  fixture.availability = 'loading';
  fixture.canViewAccountUsage = false;
  fixture.email = null;
  fixture.homeMounts = 0;
  fixture.personalQueryHook.mockReset();
  fixture.setLocation.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('RootRoute runtime landing', () => {
  it.each(['kody.low@repl.it', 'another.managed.viewer@example.com'])(
    'replaces root with canonical Org Insights for effective account viewer %s without mounting Home',
    async email => {
      fixture.availability = 'authorized';
      fixture.canViewAccountUsage = true;
      fixture.email = email;

      await renderRootRoute();

      expect(fixture.setLocation).toHaveBeenCalledOnce();
      expect(fixture.setLocation).toHaveBeenCalledWith('/org-insights', { replace: true });
      expect(fixture.homeMounts).toBe(0);
      expect(fixture.personalQueryHook).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="personal-home-fixture"]')).toBeNull();
    },
  );

  it.each([
    ['scoped member', null],
    ['team preview', 'previewed.team.member@example.com'],
  ])('mounts personal Home for an authorized %s with effective account capability false', async (_label, email) => {
    fixture.availability = 'authorized';
    fixture.canViewAccountUsage = false;
    fixture.email = email;

    await renderRootRoute();

    expect(fixture.setLocation).not.toHaveBeenCalled();
    expect(fixture.homeMounts).toBe(1);
    expect(fixture.personalQueryHook).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="personal-home-fixture"]')).not.toBeNull();
  });

  it.each(['loading', 'unavailable', 'denied', 'invalid-preview'] as const)(
    'mounts neither data landing while authorization is %s, even if stale capability is true',
    async availability => {
      fixture.availability = availability;
      fixture.canViewAccountUsage = true;

      await renderRootRoute();

      expect(fixture.setLocation).not.toHaveBeenCalled();
      expect(fixture.homeMounts).toBe(0);
      expect(fixture.personalQueryHook).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="personal-home-fixture"]')).toBeNull();
      expect(container.querySelector('[aria-label="Loading page"]')).not.toBeNull();
    },
  );
});