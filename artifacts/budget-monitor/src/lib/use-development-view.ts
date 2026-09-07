import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { setDevelopmentUserIdGetter, type DevViewUser } from '@workspace/api-client-react';

export type DevelopmentUser = DevViewUser;

export interface DevelopmentView {
  enabled: boolean;
  ready: boolean;
  users: DevelopmentUser[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  select: (id: string) => void;
  retry: () => void;
}

const STORAGE_KEY = 'budget-monitor:development-view-user';

function retainedSelection(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Directory discovery is server-owned; a client build flag cannot enable access. */
export function useDevelopmentView(clearProtectedState: () => void): DevelopmentView {
  const [state, setState] = useState({
    enabled: false,
    ready: !import.meta.env.DEV,
    users: [] as DevelopmentUser[],
    selectedId: null as string | null,
    loading: import.meta.env.DEV,
    error: null as string | null,
  });
  const selectionRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    setDevelopmentUserIdGetter(() => selectionRef.current);
    return () => setDevelopmentUserIdGetter(null);
  }, []);

  const select = useCallback((id: string) => {
    selectionRef.current = id;
    clearProtectedState();
    try {
      sessionStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Selection remains stable in this mounted tab when storage is blocked.
    }
    setState(current => ({ ...current, selectedId: id }));
  }, [clearProtectedState]);

  const retry = useCallback(() => {
    if (!import.meta.env.DEV) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState(current => ({ ...current, loading: true, error: null }));
    void fetch('/api/auth/dev-view', {
      // Preserve preview-proxy cookies; the server ignores app sessions in this mode.
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    }).then(async response => {
      const body = await response.json();
      if (controller.signal.aborted) return;
      if (body.enabled === false && response.ok) {
        selectionRef.current = null;
        setState({ enabled: false, ready: true, users: [], selectedId: null, loading: false, error: null });
        return;
      }
      if (body.enabled === true) {
        setState(current => ({ ...current, enabled: true }));
      }
      if (!response.ok || body.enabled !== true || !Array.isArray(body.users)) {
        throw new Error('The development directory is unavailable. Retry to reconnect.');
      }
      const users = body.users as DevelopmentUser[];
      const selectedId = selectionRef.current ?? retainedSelection()
        ?? (users.length ? users[Math.floor(Math.random() * users.length)].userId : null);
      selectionRef.current = selectedId;
      if (selectedId) {
        try { sessionStorage.setItem(STORAGE_KEY, selectedId); } catch { /* In-memory selection remains usable. */ }
      }
      setState({
        enabled: true, ready: true, users, selectedId, loading: false,
        error: users.length ? null : 'No enabled users are available in the Comcast directory.',
      });
    }).catch(() => {
      if (controller.signal.aborted) return;
      clearProtectedState();
      setState(current => ({
        ...current, ready: false, loading: false,
        error: 'The development directory is unavailable. Retry to reconnect.',
      }));
    });
  }, [clearProtectedState]);

  useEffect(() => {
    retry();
    return () => requestRef.current?.abort();
  }, [retry]);

  return { ...state, select, retry };
}