import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPreviewAsGetter } from '@workspace/api-client-react';
import { downloadAuthenticatedBlob } from './download';

afterEach(() => {
  setPreviewAsGetter(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadAuthenticatedBlob', () => {
  it('uses authenticated transport and preserves preview identity', async () => {
    setPreviewAsGetter(() => 'member:user-7');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('include');
      expect(new Headers(init?.headers).get('x-preview-as')).toBe('member:user-7');
      return new Response(new Blob(['a,b\n1,2']), { headers: { 'content-type': 'text/csv' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    class TestURL extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal('URL', TestURL);
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    });

    await downloadAuthenticatedBlob('/api/export.csv?workspaceId=ws-1', { filename: 'export.csv' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('rejects failed responses instead of downloading an error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ error: 'Export unavailable' }, { status: 503 }),
    ));
    await expect(downloadAuthenticatedBlob('/api/export.csv', { filename: 'export.csv' }))
      .rejects.toThrow('Export unavailable');
  });
});