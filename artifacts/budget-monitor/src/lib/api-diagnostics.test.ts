import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearApiDiagnostics,
  customFetch,
  getApiDiagnostics,
  parseDataUnavailableHeader,
  sanitizeDiagnosticUrl,
  subscribeApiDiagnostics,
} from '@workspace/api-client-react';

afterEach(() => {
  clearApiDiagnostics();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('API diagnostics', () => {
  it('validates and bounds unavailable response headers', () => {
    expect(parseDataUnavailableHeader(JSON.stringify({
      count: 2,
      sites: [{ path: 'body.rows[].spendUsd', reason: 'missing_value', count: 2 }],
      truncated: false,
    }))).toEqual({
      count: 2,
      sites: [{ path: 'body.rows[].spendUsd', reason: 'missing_value', count: 2 }],
      truncated: false,
    });
    expect(parseDataUnavailableHeader('{bad json')).toBeUndefined();
    expect(parseDataUnavailableHeader(JSON.stringify({
      count: 1,
      sites: [{ path: 'body.private-name', reason: 'made_up', count: 1 }],
      truncated: false,
    }))).toBeUndefined();
    expect(parseDataUnavailableHeader(' '.repeat(3_501))).toBeUndefined();
  });

  it('records unavailable 200 responses as safe issues and tolerates console failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('console unavailable'); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-unavailable',
        'x-data-unavailable': JSON.stringify({
          count: 1,
          sites: [{ path: 'body.rows[].allocationUsd', reason: 'missing_allocation', count: 1 }],
          truncated: false,
        }),
      },
    })));

    await expect(customFetch('/api/spend', { responseType: 'json' })).resolves.toEqual({ ok: true });
    expect(getApiDiagnostics()[0]).toMatchObject({
      category: 'success',
      requestId: 'req-unavailable',
      dataState: {
        unavailable: {
          count: 1,
          sites: [{ path: 'body.rows[].allocationUsd', reason: 'missing_allocation', count: 1 }],
        },
      },
    });
  });

  it('does not mistake a legitimate no-limit state for unavailable data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      metadata: { status: 'complete', dataAvailable: true },
      rows: [{ noLimit: true, limitObservationStatus: 'not_applicable' }],
    }), { headers: { 'content-type': 'application/json' } })));

    await customFetch('/api/limits', { responseType: 'json' });
    expect(getApiDiagnostics()[0]?.dataState?.unavailable).toBeUndefined();
  });

  it('keeps only approved scoping parameters and redacts identity paths', () => {
    expect(sanitizeDiagnosticUrl(
      'https://example.test/api/users/person%40example.com?token=secret&role=admin&start=2026-01-01',
    )).toBe('/api/users/[redacted]?role=admin&start=2026-01-01');
    expect(sanitizeDiagnosticUrl(
      '/api/spend?startDate=2026-02-28&endDate=2026-02-29&start=2026-13-01',
    )).toBe('/api/spend?startDate=2026-02-28');
  });

  it('redacts opaque IDs and human-readable names while retaining endpoint names', () => {
    expect(sanitizeDiagnosticUrl(
      '/api/reporting/teams/pool%3Ateam%3AProduct%20%2F%20R%26D',
    )).toBe('/api/reporting/teams/[redacted]');
    expect(sanitizeDiagnosticUrl('/api/groups/Customer%20Success/projects'))
      .toBe('/api/groups/[redacted]/projects');
    expect(sanitizeDiagnosticUrl('/groups/Customer%20Success'))
      .toBe('/groups/[redacted]');
    expect(sanitizeDiagnosticUrl(
      '/api/workspaces/private-workspace/projects/private-project-slug',
    )).toBe('/api/workspaces/[redacted]/projects/[redacted]');
  });

  it('records an HTTP failure and propagates the same error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'private payload' }),
      { status: 503, headers: { 'content-type': 'application/json', 'x-request-id': 'req-503' } },
    )));

    const promise = customFetch('/api/spend?token=secret', { responseType: 'json' });
    await expect(promise).rejects.toMatchObject({ status: 503 });
    expect(getApiDiagnostics()[0]).toMatchObject({
      endpoint: '/api/spend',
      status: 503,
      requestId: 'req-503',
      category: 'http',
    });
  });

  it('records and propagates network failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const networkError = new TypeError('offline');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

    await expect(customFetch('/api/dashboard')).rejects.toBe(networkError);
    expect(getApiDiagnostics()[0]).toMatchObject({
      status: null,
      category: 'network',
    });
  });

  it('does not let a throwing subscriber replace a network failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unsubscribe = subscribeApiDiagnostics(() => {
      throw new Error('subscriber failure');
    });
    const networkError = new TypeError('offline');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

    await expect(customFetch('/api/dashboard')).rejects.toBe(networkError);
    expect(getApiDiagnostics()[0]?.category).toBe('network');
    unsubscribe();
  });

  it('bounds volatile success history to 25 entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(null, { status: 204 }),
    )));

    await Promise.all(Array.from({ length: 30 }, (_, index) => customFetch(`/api/health?drop=${index}`)));
    expect(getApiDiagnostics()).toHaveLength(25);
    expect(getApiDiagnostics().every((entry) => entry.category === 'success')).toBe(true);
  });

  it('records only whitelisted response state and never financial or identity values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      metadata: {
        status: 'partial',
        stale: true,
        dataAvailable: false,
        qualifications: ['Sensitive free text'],
      },
      rows: [
        {
          name: 'Finance Leadership',
          spendUsd: 987654.321,
          limitObservationStatus: 'unavailable',
        },
        {
          email: 'private@example.com',
          allocationUsd: 123456.789,
          limitObservationStatus: 'complete',
        },
      ],
      cards: [
        { key: 'eligible_spend', value: 987654.321 },
        { key: 'not_a_real_card', value: 'Sensitive free text' },
      ],
      totals: { spendUsd: 987654.321 },
    }), { headers: { 'content-type': 'application/json' } })));

    await customFetch('/api/spend', { responseType: 'json' });

    expect(getApiDiagnostics()[0]?.dataState).toEqual({
      metadataStatus: 'partial',
      stale: true,
      dataAvailable: false,
      rowCount: 2,
      dashboardCardKeys: ['eligible_spend'],
      limitObservationStateCounts: { unavailable: 1, complete: 1 },
      unavailable: {
        count: 2,
        sites: [
          { path: 'metadata.dataAvailable', reason: 'explicit_unavailable', count: 1 },
          { path: 'rows[].limitObservationStatus', reason: 'limit_observation_unavailable', count: 1 },
        ],
        truncated: false,
      },
    });
    const serialized = JSON.stringify(getApiDiagnostics());
    expect(serialized).not.toContain('987654.321');
    expect(serialized).not.toContain('123456.789');
    expect(serialized).not.toContain('Sensitive free text');
    expect(serialized).not.toContain('Finance Leadership');
    expect(serialized).not.toContain('private@example.com');
    expect(serialized).not.toContain('private-project-slug');
  });
});