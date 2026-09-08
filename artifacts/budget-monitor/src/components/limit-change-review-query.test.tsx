/** @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LimitChangeOperation } from '@workspace/api-client-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitChangeReview } from './limit-change-review';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

const target = (targetId: string, state: 'failed' | 'verified') => ({
  workspaceId: 'workspace-a',
  type: 'workspace_user_limit' as const,
  targetId,
  userId: targetId,
  groupId: null,
  memberName: null,
  memberEmail: null,
  oldAmountUsd: 10,
  newAmountUsd: 20,
  state,
  attempts: 1,
  errorStage: null,
  errorCode: state === 'failed' ? 'upstream_error' : null,
  errorMessage: state === 'failed' ? 'Failed once' : null,
  upstreamRequestId: null,
  queuedAt: null,
  applyingAt: null,
  verifiedAt: state === 'verified' ? '2026-09-10T00:02:00Z' : null,
  failedAt: state === 'failed' ? '2026-09-10T00:02:00Z' : null,
  history: [],
});

const partial: LimitChangeOperation = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: null,
  kind: 'change',
  state: 'completed',
  amountUsd: null,
  localPolicyCount: 0,
  reviewFingerprint: 'f'.repeat(64),
  actorUserId: 'fixture',
  preparedAt: '2026-09-10T00:00:00Z',
  committedAt: '2026-09-10T00:01:00Z',
  completedAt: '2026-09-10T00:02:00Z',
  counts: { total: 2, queued: 0, applying: 0, verified: 1, failed: 1, verificationPending: 0 },
  targets: [target('user-failed', 'failed'), target('user-verified', 'verified')],
};
const complete: LimitChangeOperation = {
  ...partial,
  completedAt: '2026-09-10T00:03:00Z',
  counts: { total: 2, queued: 0, applying: 0, verified: 2, failed: 0, verificationPending: 0 },
  targets: [target('user-failed', 'verified'), target('user-verified', 'verified')],
};

describe('LimitChangeReview generated hook cache transition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('replaces a fetched partial operation with the complete retry response', async () => {
    const onOperation = vi.fn();
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = request.method === 'POST' ? await request.clone().json() : undefined;
      requests.push({ method: request.method, url: request.url, body });
      return new Response(JSON.stringify(request.method === 'POST' ? complete : partial), {
        status: request.method === 'POST' ? 202 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LimitChangeReview operationId={partial.id} preparedOperation={partial} readOnly={false} onOperation={onOperation} onClose={vi.fn()} />
        </QueryClientProvider>,
      );
      while (queryClient.isFetching() > 0) await new Promise(resolve => setTimeout(resolve, 1));
    });
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="button-retry-limit-targets"]');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(requests.filter(request => request.method === 'GET')).toHaveLength(1);
    expect(requests.find(request => request.method === 'POST')?.body).toEqual(expect.objectContaining({
      targets: [{ workspaceId: 'workspace-a', type: 'workspace_user_limit', targetId: 'user-failed' }],
    }));
    expect(onOperation).toHaveBeenLastCalledWith(complete);
    expect(container.textContent).not.toContain('Failed');
    expect(container.querySelector('[data-testid="button-retry-limit-targets"]')).toBeNull();
    expect(queryClient.getQueryData([`/api/limits/changes/${partial.id}`])).toEqual(complete);
  });
});