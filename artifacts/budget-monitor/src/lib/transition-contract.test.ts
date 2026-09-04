import { readFile } from 'node:fs/promises';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

describe('protected query transition contract', () => {
  it('retains one coherent generation only while refreshing the exact same key', async () => {
    const first = deferred<{ period: string; value: number }>();
    const refresh = deferred<{ period: string; value: number }>();
    const changedRange = deferred<{ period: string; value: number }>();
    const query = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => refresh.promise)
      .mockImplementationOnce(() => changedRange.promise);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = new QueryObserver(client, {
      queryKey: ['dashboard', 'billing'],
      queryFn: query,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    expect(observer.getCurrentResult().data).toBeUndefined();
    first.resolve({ period: 'Billing cycle', value: 10 });
    await first.promise;
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.value).toBe(10));

    void observer.refetch();
    expect(observer.getCurrentResult()).toMatchObject({
      data: { period: 'Billing cycle', value: 10 },
      isFetching: true,
    });
    refresh.resolve({ period: 'Billing cycle', value: 11 });
    await refresh.promise;
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.value).toBe(11));

    observer.setOptions({
      queryKey: ['dashboard', 'custom:2026-09-01:2026-09-03'],
      queryFn: query,
    });
    expect(observer.getCurrentResult().data).toBeUndefined();
    changedRange.resolve({ period: 'Sep 1–3', value: 3 });
    await changedRange.promise;
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.period).toBe('Sep 1–3'));

    unsubscribe();
    client.clear();
  });

  it('keeps successful content after a background refresh failure', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = new QueryObserver(client, {
      queryKey: ['spend', 'managed'],
      queryFn: vi.fn().mockResolvedValueOnce({ rows: ['safe'] }).mockRejectedValueOnce(new Error('503')),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ rows: ['safe'] }));
    await observer.refetch().catch(() => undefined);
    expect(observer.getCurrentResult()).toMatchObject({
      data: { rows: ['safe'] },
      isError: true,
    });
    unsubscribe();
    client.clear();
  });

  it('clears before preview publication and remounts component state at auth boundaries', async () => {
    const [authSource, appSource, dashboardSource, spendSource, fetchSource] = await Promise.all([
      readFile(new URL('../components/auth-context.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../pages/dashboard.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../pages/spend.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../../../lib/api-client-react/src/custom-fetch.ts', import.meta.url), 'utf8'),
    ]);

    expect(authSource).toMatch(
      /void queryClient\.cancelQueries\(\);\s+queryClient\.clear\(\);\s+setPreviewState\(next\)/,
    );
    expect(authSource).toContain("useLayoutEffect(() => {\n    if (availability === 'authorized') return;");
    expect(authSource).toContain("previous && previous !== authorizationFingerprint");
    expect(appSource).toContain('<Router key={authorizationKey} />');
    expect(appSource).toContain('setForbiddenHandler(() => {');
    expect(fetchSource).toContain('response.status === 403');
    expect(fetchSource).toContain('_forbiddenHandler?.()');
    expect(dashboardSource).not.toContain('prevData');
    expect(spendSource).toContain('status-spend-updating');
  });

  it('preserves bounded refresh and focus behavior', async () => {
    const appSource = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(appSource).toContain('refetchInterval: DATA_REFRESH_INTERVAL_MS');
    expect(appSource).toContain('refetchOnWindowFocus: false');
  });
});