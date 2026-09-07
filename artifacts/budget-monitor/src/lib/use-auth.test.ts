// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginExplicitSignIn, clearAuthCache, useAuth } from '@workspace/replit-auth-web';

function envelope(revision = 'revision-1', isPreview = false) {
  return {
    user: { id: 'hook-user', email: null, firstName: null, lastName: null, profileImageUrl: null },
    auth: {
      authorizationRevision: revision, role: 'member', roles: ['member'],
      workspaceIds: [], teamNames: [], groupIds: [], userIds: ['hook-user'], isPreview,
    },
    capabilities: {
      canManageAccess: false, canEditAllocations: false, canPreviewRoles: true,
      canWriteGroupLimits: false, canWriteUserLimitsIn: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let state: ReturnType<typeof useAuth>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

function Probe({ preview = null }: { preview?: string | null }) {
  state = useAuth(preview);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(envelope()));
  vi.stubGlobal('fetch', fetcher);
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authorization hook lifecycle', () => {
  it.each(['logout', 'cache-clear'] as const)(
    '%s aborts a deferred refresh and cannot republish auth, even when preview resets',
    async (invalidate) => {
      await act(async () => root.render(createElement(Probe, { preview: 'member:one' })));
      expect(state.availability).toBe('authorized');
      const pending = deferred<Response>();
      let signal!: AbortSignal;
      fetcher.mockImplementationOnce(async (_url, options) => {
        signal = options!.signal!;
        return pending.promise;
      });
      let refresh!: Promise<void>;
      await act(async () => { refresh = state.revalidateAuthorization(); });
      expect(state.isLoading).toBe(false);
      expect(state.auth?.authorizationRevision).toBe('revision-1');
      await act(async () => {
        if (invalidate === 'logout') state.logout();
        else clearAuthCache();
      });
      expect(signal.aborted).toBe(true);
      expect(state.availability).toBe('signed-out');
      if (invalidate === 'logout') {
        expect(fetcher.mock.calls.some(([url, options]) => (
          String(url).startsWith('/api/logout?returnTo=') && options?.method === 'POST'
        ))).toBe(true);
      }

      // AuthProvider clears the preview during logout/identity cleanup.
      await act(async () => root.render(createElement(Probe, { preview: null })));
      await act(async () => {
        pending.resolve(Response.json(envelope('stale-revision')));
        await refresh;
      });
      const expectedCalls = invalidate === 'logout' ? 3 : 2;
      expect(fetcher).toHaveBeenCalledTimes(expectedCalls);
      expect(state).toMatchObject({
        user: null, auth: null, capabilities: null,
        availability: 'signed-out', isLoading: false, isAuthenticated: false,
      });
      await act(async () => { await state.revalidateAuthorization(); });
      expect(fetcher).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it('coalesces background checks without a loading transition', async () => {
    await act(async () => root.render(createElement(Probe)));
    const original = state.auth;
    const pending = deferred<Response>();
    fetcher.mockImplementationOnce(() => pending.promise);
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = state.revalidateAuthorization();
      expect(state.revalidateAuthorization()).toBe(refresh);
    });
    expect(state.isLoading).toBe(false);
    expect(state.auth).toBe(original);
    await act(async () => {
      pending.resolve(Response.json(envelope()));
      await refresh;
    });
    expect(state.availability).toBe('authorized');
    expect(state.auth).toEqual(original);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cannot publish an older preview after the selected preview changes', async () => {
    await act(async () => root.render(createElement(Probe, { preview: 'member:one' })));
    const pending = deferred<Response>();
    let signal!: AbortSignal;
    fetcher.mockImplementationOnce(async (_url, options) => {
      signal = options!.signal!;
      return pending.promise;
    });
    let refresh!: Promise<void>;
    await act(async () => { refresh = state.revalidateAuthorization(); });
    fetcher.mockImplementationOnce(async () => Response.json(envelope('preview-two', true)));
    await act(async () => root.render(createElement(Probe, { preview: 'member:two' })));
    expect(signal.aborted).toBe(true);
    expect(state.auth?.authorizationRevision).toBe('preview-two');
    await act(async () => {
      pending.resolve(Response.json(envelope('stale-preview', true)));
      await refresh;
    });
    expect(state.auth?.authorizationRevision).toBe('preview-two');
    expect(state.isLoading).toBe(false);
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('X-Preview-As')).toBe('member:two');
  });

  it('clears the retained snapshot when background auth returns an authorization denial', async () => {
    await act(async () => root.render(createElement(Probe)));
    fetcher.mockImplementation(async () => new Response(null, { status: 403 }));
    await act(async () => { await state.revalidateAuthorization(); });
    expect(state).toMatchObject({
      availability: 'denied', user: null, auth: null, capabilities: null, isLoading: false,
    });
  });

  it.each([
    ['503', () => new Response(null, { status: 503 })],
    ['network failure', () => Promise.reject(new Error('connection lost'))],
  ] as const)('clears protected state after a terminal %s without logging out', async (_label, failure) => {
    await act(async () => root.render(createElement(Probe)));
    fetcher.mockImplementation(failure);

    await act(async () => { await state.revalidateAuthorization(); });

    expect(state).toMatchObject({
      availability: 'unavailable',
      user: null,
      auth: null,
      capabilities: null,
      isLoading: false,
      isAuthenticated: false,
    });
    expect(fetcher.mock.calls.some(([url, options]) => (
      String(url).startsWith('/api/logout?returnTo=')
      && options?.method === 'POST'
    ))).toBe(false);
    expect(localStorage.getItem(`budget-monitor:auth-signed-out:${window.location.origin}`)).toBeNull();

    fetcher.mockImplementation(async () => Response.json(envelope('reload-recovery')));
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    await vi.waitFor(() => expect(state.availability).toBe('authorized'));
    expect(state.auth?.authorizationRevision).toBe('reload-recovery');
  });

  it('recovers an unavailable check on focus without restoring stale scopes', async () => {
    await act(async () => root.render(createElement(Probe)));
    fetcher.mockImplementation(async () => new Response(null, { status: 503 }));
    await act(async () => { await state.revalidateAuthorization(); });
    expect(state.availability).toBe('unavailable');
    expect(state.auth).toBeNull();

    fetcher.mockImplementation(async () => Response.json(envelope('focus-recovery')));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await vi.waitFor(() => expect(state.availability).toBe('authorized'));
    expect(state.auth?.authorizationRevision).toBe('focus-recovery');
  });

  it('does not let repeated focus events re-arm the bounded automatic retry budget', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(createElement(Probe)));
    fetcher.mockImplementation(async () => new Response(null, { status: 400 }));
    await act(async () => { await state.revalidateAuthorization(); });
    expect(state.availability).toBe('unavailable');

    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => window.dispatchEvent(new Event('focus')));
    const callsAfterFocusChecks = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(fetcher).toHaveBeenCalledTimes(callsAfterFocusChecks);
    expect(state.availability).toBe('unavailable');
  });

  it('keeps deliberate logout latched across remount and focus', async () => {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => state.logout());
    expect(localStorage.getItem(`budget-monitor:auth-signed-out:${window.location.origin}`)).toBe('1');

    const callsAfterLogout = fetcher.mock.calls.length;
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(state.availability).toBe('signed-out');
    expect(fetcher).toHaveBeenCalledTimes(callsAfterLogout);
  });

  it('allows a fresh healthy callback mount after a 401 cache clear', async () => {
    await act(async () => root.render(createElement(Probe, { preview: 'member:one' })));
    await act(async () => clearAuthCache());
    expect(state.availability).toBe('signed-out');
    expect(localStorage.getItem(`budget-monitor:auth-signed-out:${window.location.origin}`)).toBeNull();

    fetcher.mockImplementation(async () => Response.json(envelope('login-callback')));
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    await vi.waitFor(() => expect(state.availability).toBe('authorized'));
    expect(state.auth?.authorizationRevision).toBe('login-callback');
  });

  it('explicit sign-in clears an old latch and wakes the currently mounted hook', async () => {
    localStorage.setItem(`budget-monitor:auth-signed-out:${window.location.origin}`, '1');
    await act(async () => root.render(createElement(Probe)));
    expect(state.availability).toBe('signed-out');
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockImplementation(async () => Response.json(envelope('explicit-login')));
    await act(async () => beginExplicitSignIn());
    await vi.waitFor(() => expect(state.availability).toBe('authorized'));
    expect(state.auth?.authorizationRevision).toBe('explicit-login');
    expect(localStorage.getItem(`budget-monitor:auth-signed-out:${window.location.origin}`)).toBeNull();
  });

  it('does not treat a loading preview transition as terminal sign-out', async () => {
    await act(async () => root.render(createElement(Probe)));
    const pending = deferred<Response>();
    fetcher.mockImplementationOnce(() => pending.promise);

    await act(async () => root.render(createElement(Probe, { preview: 'member:two' })));
    expect(state.availability).toBe('loading');

    await act(async () => {
      pending.resolve(Response.json(envelope('preview-loaded', true)));
      await pending.promise;
    });
    await vi.waitFor(() => expect(state.availability).toBe('authorized'));
    expect(state.auth?.authorizationRevision).toBe('preview-loaded');
  });
});