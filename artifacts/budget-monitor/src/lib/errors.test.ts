import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

vi.mock('../components/ui/toast', () => ({ ToastAction: () => null }));
vi.mock('../hooks/use-toast', () => ({ toast: vi.fn() }));

import { toast } from '../hooks/use-toast';
import {
  describeError,
  getUsageHealthWarning,
  shouldRetryRequest,
  subscribeApiErrorToasts,
  updateNoticeState,
} from './errors';

beforeEach(() => {
  vi.mocked(toast).mockReset();
});

describe('describeError', () => {
  it('classifies authorization errors without exposing server messages', () => {
    expect(describeError({
      status: 403,
      url: '/api/settings',
      message: 'sensitive upstream detail',
    })).toEqual({
      kind: 'permission',
      title: 'Access denied',
      detail: 'You do not have permission to complete this request.',
    });
  });

  it('classifies fetch failures as network errors', () => {
    expect(describeError(new TypeError('Failed to fetch')).kind).toBe('network');
  });
});

describe('shouldRetryRequest', () => {
  it.each([401, 403, 404])('never retries HTTP %s', (status) => {
    expect(shouldRetryRequest(0, { status })).toBe(false);
  });

  it('retries server and network failures only once', () => {
    expect(shouldRetryRequest(0, { status: 503 })).toBe(true);
    expect(shouldRetryRequest(1, { status: 503 })).toBe(false);
    expect(shouldRetryRequest(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryRequest(1, new TypeError('Failed to fetch'))).toBe(false);
  });

  it('does not retry other client errors', () => {
    expect(shouldRetryRequest(0, { status: 400 })).toBe(false);
  });
});

describe('getUsageHealthWarning', () => {
  it('suppresses warnings for complete or fully covered partial responses', () => {
    expect(getUsageHealthWarning({
      usageHealth: { status: 'complete', coverage: { ratio: 1 } },
    })).toBeNull();
    expect(getUsageHealthWarning({
      usageHealth: { status: 'partial', coverage: { ratio: 1 } },
    })).toBeNull();
  });

  it('reports meaningful partial and stale responses, even when stale coverage is full', () => {
    expect(getUsageHealthWarning({
      usageHealth: { status: 'partial', coverage: { ratio: 0.8 } },
    })).toBe('partial');
    expect(getUsageHealthWarning({
      usageHealth: { status: 'stale', coverage: { ratio: 1 } },
    })).toBe('stale');
  });
});

describe('subscribeApiErrorToasts', () => {
  it('notifies once for full-coverage stale data and dismisses on recovery', () => {
    const dismiss = vi.fn();
    vi.mocked(toast).mockReturnValue({
      id: 'usage-health',
      dismiss,
      update: vi.fn(),
    });
    const queryClient = new QueryClient();
    const unsubscribe = subscribeApiErrorToasts(queryClient);

    queryClient.setQueryData(['dashboard'], {
      usageHealth: { status: 'stale', coverage: { ratio: 1 } },
    });
    queryClient.setQueryData(['dashboard'], {
      usageHealth: { status: 'stale', coverage: { ratio: 1 } },
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Usage data may be out of date',
    }));

    queryClient.setQueryData(['dashboard'], {
      usageHealth: { status: 'complete', coverage: { ratio: 1 } },
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('shows one partial-data warning across simultaneous queries and waits for full recovery', () => {
    const dismiss = vi.fn();
    vi.mocked(toast).mockReturnValue({
      id: 'usage-health',
      dismiss,
      update: vi.fn(),
    });
    const queryClient = new QueryClient();
    const unsubscribe = subscribeApiErrorToasts(queryClient);

    queryClient.setQueryData(['dashboard', 'groups'], {
      usageHealth: { status: 'partial', coverage: { ratio: 0.8 } },
    });
    queryClient.setQueryData(['dashboard', 'summary'], {
      usageHealth: { status: 'stale', coverage: { ratio: 1 } },
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Some usage data is still updating',
    }));

    queryClient.setQueryData(['dashboard', 'groups'], {
      usageHealth: { status: 'complete', coverage: { ratio: 1 } },
    });
    expect(dismiss).not.toHaveBeenCalled();

    queryClient.setQueryData(['dashboard', 'summary'], {
      usageHealth: { status: 'complete', coverage: { ratio: 1 } },
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps request failures destructive and retryable', async () => {
    vi.mocked(toast).mockReturnValue({
      id: 'request-error',
      dismiss: vi.fn(),
      update: vi.fn(),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const unsubscribe = subscribeApiErrorToasts(queryClient);

    await expect(queryClient.fetchQuery({
      queryKey: ['/api/toast-only-regression'],
      queryFn: () => Promise.reject({ status: 503 }),
    })).rejects.toEqual({ status: 503 });

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Service unavailable',
      variant: 'destructive',
      action: expect.anything(),
    }));
    unsubscribe();
  });

  it('shows one cached-refresh notice, keeps known zero, and retries the failed query', async () => {
    const dismiss = vi.fn();
    vi.mocked(toast).mockReturnValue({ id: 'cached-error', dismiss, update: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ['/api/cached-refresh-regression'];
    const saved = { spendUsd: 0 };
    client.setQueryData(queryKey, saved);
    let fails = true;
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: async () => {
        if (fails) throw { status: 503 };
        return { spendUsd: 12 };
      },
      staleTime: Infinity,
    });
    const stopObserver = observer.subscribe(() => {});
    const stopToasts = subscribeApiErrorToasts(client);

    await observer.refetch();
    await observer.refetch();
    expect(toast).toHaveBeenCalledTimes(1);
    const notice = vi.mocked(toast).mock.calls[0][0];
    expect(notice).toMatchObject({
      title: 'Couldn’t refresh data.',
      description: 'Showing saved values.',
      variant: 'destructive',
    });
    expect(client.getQueryData(queryKey)).toEqual(saved);

    fails = false;
    const recovered = new Promise<void>((resolve) => {
      const stop = observer.subscribe((result) => {
        if (result.data?.spendUsd === 12) { stop(); resolve(); }
      });
    });
    (notice.action!.props as { onClick: () => void }).onClick();
    await recovered;
    expect(dismiss).toHaveBeenCalledTimes(1);
    stopToasts();
    stopObserver();
    client.clear();
  });

  it('replaces the same query’s health notice when its refresh fails', async () => {
    const dismiss = vi.fn();
    vi.mocked(toast).mockReturnValue({ id: 'notice', dismiss, update: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stop = subscribeApiErrorToasts(client);
    const queryKey = ['/api/stale-refresh-regression'];
    client.setQueryData(queryKey, { usageHealth: { status: 'stale' } });
    await expect(client.fetchQuery({
      queryKey,
      queryFn: async () => { throw new TypeError('Failed to fetch'); },
    })).rejects.toThrow();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Couldn’t refresh data.',
      action: expect.anything(),
    }));
    stop();
    client.clear();
  });
});

describe('updateNoticeState', () => {
  it('deduplicates repeated failures until a successful recovery clears them', () => {
    const active = new Set<string>();
    expect(updateNoticeState(active, 'dashboard', true)).toBe('activated');
    expect(updateNoticeState(active, 'dashboard', true)).toBe('unchanged');
    expect(updateNoticeState(active, 'dashboard', false)).toBe('cleared');
    expect(updateNoticeState(active, 'dashboard', false)).toBe('unchanged');
    expect(updateNoticeState(active, 'dashboard', true)).toBe('activated');
  });
});