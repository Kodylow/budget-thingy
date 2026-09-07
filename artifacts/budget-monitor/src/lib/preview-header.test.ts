import { afterEach, expect, it, vi } from 'vitest';
import { getCurrentAuthUser, setPreviewAsGetter } from '@workspace/api-client-react';
import { previewScopedQueryHash } from './preview-query-cache';

afterEach(() => {
  setPreviewAsGetter(null);
  vi.unstubAllGlobals();
});

it('adds exactly one preview header to a generated API request', async () => {
  setPreviewAsGetter(() => 'team_admin:Growth MDU');
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('x-preview-as')).toBe('team_admin:Growth MDU');
    expect([...headers.keys()].filter((key) => key === 'x-preview-as')).toHaveLength(1);
    return new Response(JSON.stringify({
      user: null,
      auth: null,
      capabilities: {
        canManageAccess: false,
        canEditAllocations: false,
        canPreviewRoles: false,
        canWriteGroupLimits: false,
        canWriteUserLimitsIn: [],
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  await getCurrentAuthUser();

  expect(fetchMock).toHaveBeenCalledOnce();
});

it('removes a caller-provided preview header when preview is reset', async () => {
  setPreviewAsGetter(() => null);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has('x-preview-as')).toBe(false);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  await getCurrentAuthUser({ headers: { 'X-Preview-As': 'member:stale-user' } });

  expect(fetchMock).toHaveBeenCalledOnce();
});

it('partitions identical generated query keys by preview identity', () => {
  const queryKey = ['/api/groups', { rangeType: 'billing' }] as const;
  setPreviewAsGetter(() => null);
  const realHash = previewScopedQueryHash(queryKey);
  setPreviewAsGetter(() => 'member:user-1');
  const firstMemberHash = previewScopedQueryHash(queryKey);
  setPreviewAsGetter(() => 'member:user-2');
  const secondMemberHash = previewScopedQueryHash(queryKey);

  expect(new Set([realHash, firstMemberHash, secondMemberHash])).toHaveLength(3);
});