import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

vi.mock('../components/ui/toast', () => ({ ToastAction: () => null }));
vi.mock('../hooks/use-toast', () => ({ toast: vi.fn() }));

import { toast } from '../hooks/use-toast';
import {
  describeError,
  isBlockingQueryError,
  getUsageHealthWarning,
  isReportingUsageRefreshing,
  requestRetryDelay,
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

  it('recognizes only the typed 503 reporting refresh response', () => {
    expect(isReportingUsageRefreshing({
      status: 503,
      data: { code: 'REPORTING_USAGE_REFRESHING' },
    })).toBe(true);
    expect(isReportingUsageRefreshing({
      status: 500,
      data: { code: 'REPORTING_USAGE_REFRESHING' },
    })).toBe(false);
    expect(isReportingUsageRefreshing({
      status: 503,
      data: { code: 'SOMETHING_ELSE' },
    })).toBe(false);
    expect(isReportingUsageRefreshing({ status: 503 })).toBe(false);
  });

  it('bounds typed reporting refresh retries at 30 attempts', () => {
    const refreshing = {
      status: 503,
      data: { code: 'REPORTING_USAGE_REFRESHING' },
    };
    expect(shouldRetryRequest(0, refreshing)).toBe(true);
    expect(shouldRetryRequest(29, refreshing)).toBe(true);
    expect(shouldRetryRequest(30, refreshing)).toBe(false);
  });

  it.each([401, 403, 404])('never retries HTTP %s even with the refresh code', (status) => {
    expect(shouldRetryRequest(0, {
      status,
      data: { code: 'REPORTING_USAGE_REFRESHING' },
    })).toBe(false);
  });
});

describe('requestRetryDelay', () => {
  const refreshing = (retryAfter?: string) => ({
    status: 503,
    data: { code: 'REPORTING_USAGE_REFRESHING' },
    headers: new Headers(retryAfter == null ? undefined : { 'Retry-After': retryAfter }),
  });

  it('uses and clamps a valid Retry-After seconds hint', () => {
    expect(requestRetryDelay(0, refreshing('0.25'))).toBe(1_000);
    expect(requestRetryDelay(0, refreshing('3'))).toBe(3_000);
    expect(requestRetryDelay(0, refreshing('20'))).toBe(5_000);
  });

  it('uses two seconds for absent, invalid, or non-positive refresh hints', () => {
    expect(requestRetryDelay(0, refreshing())).toBe(2_000);
    expect(requestRetryDelay(0, refreshing('soon'))).toBe(2_000);
    expect(requestRetryDelay(0, refreshing('0'))).toBe(2_000);
    expect(requestRetryDelay(0, refreshing('-1'))).toBe(2_000);
  });

  it('keeps all other errors at one second', () => {
    expect(requestRetryDelay(0, { status: 503, headers: new Headers({ 'Retry-After': '5' }) })).toBe(1_000);
    expect(requestRetryDelay(0, new TypeError('Failed to fetch'))).toBe(1_000);
  });

  it('recovers through real TanStack retries without entering a final error state', async () => {
    let calls = 0;
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: shouldRetryRequest,
          retryDelay: 0,
        },
      },
    });

    await expect(client.fetchQuery({
      queryKey: ['reporting-refresh-recovery'],
      queryFn: async () => {
        calls += 1;
        if (calls <= 2) {
          throw {
            status: 503,
            data: { code: 'REPORTING_USAGE_REFRESHING' },
          };
        }
        return { spendUsd: 42 };
      },
    })).resolves.toEqual({ spendUsd: 42 });

    expect(calls).toBe(3);
    expect(client.getQueryState(['reporting-refresh-recovery'])).toMatchObject({
      status: 'success',
      error: null,
      data: { spendUsd: 42 },
    });
    client.clear();
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
  it('keeps full-coverage stale data and recovery quiet', () => {
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

    expect(toast).not.toHaveBeenCalled();

    queryClient.setQueryData(['dashboard'], {
      usageHealth: { status: 'complete', coverage: { ratio: 1 } },
    });
    expect(dismiss).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('keeps simultaneous partial-data reads quiet through recovery', () => {
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

    expect(toast).not.toHaveBeenCalled();

    queryClient.setQueryData(['dashboard', 'groups'], {
      usageHealth: { status: 'complete', coverage: { ratio: 1 } },
    });
    expect(dismiss).not.toHaveBeenCalled();

    queryClient.setQueryData(['dashboard', 'summary'], {
      usageHealth: { status: 'complete', coverage: { ratio: 1 } },
    });
    expect(dismiss).not.toHaveBeenCalled();
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

  it('silently keeps known zero through repeated refetch failures and recovers', async () => {
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
    expect(toast).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKey)).toEqual(saved);

    fails = false;
    await observer.refetch();
    expect(client.getQueryData(queryKey)).toEqual({ spendUsd: 12 });
    expect(toast).not.toHaveBeenCalled();
    stopToasts();
    stopObserver();
    client.clear();
  });

  it('does not announce a network failure while cached data remains available', async () => {
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
    expect(toast).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    stop();
    client.clear();
  });

  it('keeps an initial typed reporting transition quiet even after retries exhaust', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stop = subscribeApiErrorToasts(client);
    const error = { status: 503, data: { code: 'REPORTING_USAGE_REFRESHING' } };
    await expect(client.fetchQuery({
      queryKey: ['/api/initial-refresh'],
      queryFn: async () => { throw error; },
    })).rejects.toEqual(error);
    expect(toast).not.toHaveBeenCalled();
    expect(client.getQueryData(['/api/initial-refresh'])).toBeUndefined();
    stop();
    client.clear();
  });

  it.each([403, 404, 400])('keeps HTTP %s actionable even with cached data', async status => {
    vi.mocked(toast).mockReturnValue({ id: 'blocking', dismiss: vi.fn(), update: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = [`/api/blocking-${status}`];
    client.setQueryData(key, { spendUsd: 42 });
    const stop = subscribeApiErrorToasts(client);
    await expect(client.fetchQuery({
      queryKey: key, queryFn: async () => { throw { status }; },
    })).rejects.toEqual({ status });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive', action: expect.anything(),
    }));
    stop();
    client.clear();
  });

  it('does not suppress a failed mutation carrying the reporting refresh code', async () => {
    vi.mocked(toast).mockReturnValue({ id: 'write', dismiss: vi.fn(), update: vi.fn() });
    const client = new QueryClient();
    const stop = subscribeApiErrorToasts(client);
    const error = { status: 503, data: { code: 'REPORTING_USAGE_REFRESHING' } };
    const mutation = client.getMutationCache().build(client, {
      mutationKey: ['save-must-not-be-silent'],
      mutationFn: async () => { throw error; },
      retry: false,
    });
    await expect(mutation.execute(undefined)).rejects.toEqual(error);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Service unavailable', variant: 'destructive',
    }));
    stop();
    client.clear();
  });
});

describe('isBlockingQueryError', () => {
  it.each([401, 403, 404, 400])('rejects cached presentation for HTTP %s', status => {
    expect(isBlockingQueryError({ status })).toBe(true);
  });
  it('allows same-query cached presentation for transient failures only', () => {
    expect(isBlockingQueryError(undefined)).toBe(false);
    expect(isBlockingQueryError({ status: 503 })).toBe(false);
    expect(isBlockingQueryError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isBlockingQueryError(new Error('Invalid response'))).toBe(true);
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