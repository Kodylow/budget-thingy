// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDevelopmentUserId } from '@workspace/api-client-react';
import { useDevelopmentView } from './use-development-view';

const users = [
  { userId: 'one', name: 'One', username: 'first', email: null },
  { userId: 'two', name: 'Two', username: 'second', email: null },
];
const key = 'budget-monitor:development-view-user';
let root: Root;
let state: ReturnType<typeof useDevelopmentView>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const clear = vi.fn();

function Probe() {
  state = useDevelopmentView(clear);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  clear.mockClear();
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ enabled: true, users }));
  vi.stubGlobal('fetch', fetcher);
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('development directory bootstrap', () => {
  it('chooses an eligible random identity once and retains it through remount', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    await act(async () => root.render(createElement(Probe)));
    expect(state.selectedId).toBe('two');
    expect(getDevelopmentUserId()).toBe('two');
    expect(sessionStorage.getItem(key)).toBe('two');
    expect(fetcher.mock.calls[0][1]?.credentials).toBe('same-origin');
    await act(async () => root.unmount());
    vi.spyOn(Math, 'random').mockReturnValue(0);
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    expect(state.selectedId).toBe('two');
  });

  it('sets the request identity and clears protected caches synchronously on selection', async () => {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      state.select('two');
      expect(getDevelopmentUserId()).toBe('two');
      expect(clear).toHaveBeenCalledOnce();
    });
    expect(state.selectedId).toBe('two');
  });

  it('retains a valid choice through an unavailable directory and retry', async () => {
    sessionStorage.setItem(key, 'two');
    await act(async () => root.render(createElement(Probe)));
    fetcher.mockResolvedValueOnce(Response.json({ enabled: true, error: 'Unavailable' }, { status: 503 }));
    await act(async () => state.retry());
    expect(state).toMatchObject({ enabled: true, ready: false, selectedId: 'two', loading: false });
    expect(state.error).toContain('unavailable');
    await act(async () => state.retry());
    expect(state).toMatchObject({ ready: true, error: null, selectedId: 'two' });
  });

  it('does not replace unknown retained IDs or fabricate people for an empty directory', async () => {
    sessionStorage.setItem(key, 'removed');
    await act(async () => root.render(createElement(Probe)));
    expect(state.selectedId).toBe('removed');
    fetcher.mockResolvedValueOnce(Response.json({ enabled: true, users: [] }));
    await act(async () => state.retry());
    expect(state.users).toEqual([]);
    expect(state.selectedId).toBe('removed');
    expect(state.error).toContain('No enabled users');
  });

  it('does not use a saved development selection when the server disables the mode', async () => {
    sessionStorage.setItem(key, 'two');
    fetcher.mockResolvedValueOnce(Response.json({ enabled: false }));
    await act(async () => root.render(createElement(Probe)));
    expect(state).toMatchObject({ enabled: false, ready: true, selectedId: null });
    expect(getDevelopmentUserId()).toBeNull();
    expect(sessionStorage.getItem(key)).toBe('two');
  });
});