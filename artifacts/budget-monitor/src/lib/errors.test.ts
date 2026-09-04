import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

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