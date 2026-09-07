import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAuthorization, logAuthDebug } from '@workspace/replit-auth-web';

afterEach(() => vi.restoreAllMocks());

describe('safe auth diagnostics', () => {
  it('labels consecutive events without breaking when the console throws', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logAuthDebug('login.click', { target: '_top' });
    logAuthDebug('authorization.start', { background: false });
    const first = JSON.parse(info.mock.calls[0][1]);
    const second = JSON.parse(info.mock.calls[1][1]);
    expect(first).toMatchObject({ event: 'login.click', target: '_top' });
    expect(second.sequence).toBe(first.sequence + 1);
    expect(second.documentId).toBe(first.documentId);
    info.mockImplementation(() => { throw new Error('Console unavailable'); });
    expect(() => logAuthDebug('login.click')).not.toThrow();
  });

  it('traces retries and identity presence without recording identity or preview values', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        user: { id: 'sensitive-user', email: 'private@example.invalid' },
        auth: { authorizationRevision: 'sensitive-revision' },
        capabilities: {},
      }));
    const result = await loadAuthorization({
      previewAs: 'member:sensitive-preview',
      signal: new AbortController().signal,
      fetcher,
      sleep: async () => {},
    });
    expect(result.availability).toBe('authorized');
    const events = info.mock.calls.map(call => JSON.parse(call[1]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'request.start', attempt: 1, previewSelected: true }),
      expect.objectContaining({ event: 'request.response', status: 503 }),
      expect.objectContaining({ event: 'request.retry', delayMs: 250 }),
      expect.objectContaining({ event: 'request.identity', hasUser: true, hasAuthorization: true }),
    ]));
    expect(new Set(events.map(event => event.request)).size).toBe(1);
    const output = JSON.stringify(info.mock.calls);
    for (const secret of ['sensitive-user', 'private@example.invalid', 'sensitive-revision', 'sensitive-preview']) {
      expect(output).not.toContain(secret);
    }
  });

  it('does not log thrown error details', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await loadAuthorization({
      previewAs: null,
      signal: new AbortController().signal,
      fetcher: vi.fn().mockRejectedValue(new Error('secret-token-in-error')),
      maxAttempts: 1,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret-token-in-error');
    expect(JSON.parse(info.mock.calls.at(-1)![1])).toMatchObject({
      event: 'request.failure', reason: 'network-or-response-parse',
    });
  });
});