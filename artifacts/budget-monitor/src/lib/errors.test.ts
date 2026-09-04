import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/ui/toast', () => ({ ToastAction: () => null }));
vi.mock('../hooks/use-toast', () => ({ toast: vi.fn() }));

import { describeError, shouldRetryRequest } from './errors';

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