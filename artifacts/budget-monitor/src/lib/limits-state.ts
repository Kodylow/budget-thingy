import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthContext } from '@/components/auth-context';
import {
  getGetLimitOperationQueryKey,
  LimitOperation,
} from '@workspace/api-client-react';

const STORAGE_KEY_WS = 'budget-monitor-last-limits-ws';
const STORAGE_KEY_OPS = (userId: string, wsId: string) => `budget-monitor-limits-ops-${userId}-${wsId}`;

interface LimitOperationQueryLike {
  state: {
    data?: LimitOperation;
  };
}

export function getLimitOperationPollingInterval(
  query: LimitOperationQueryLike,
): number | false {
  const state = query.state.data?.state;
  return state === 'queued' || state === 'running' ? 2_000 : false;
}

export function activeLimitOperationQueryOptions(operationId: string | null) {
  return {
    query: {
      enabled: Boolean(operationId),
      queryKey: getGetLimitOperationQueryKey(operationId ?? ''),
      refetchInterval: getLimitOperationPollingInterval,
    },
  };
}

export function resolveLimitsStateWorkspaceId(
  currentWorkspaceId: string | null,
  availableWorkspaces: string[],
): string | null {
  if (currentWorkspaceId && availableWorkspaces.includes(currentWorkspaceId)) {
    return currentWorkspaceId;
  }
  return availableWorkspaces.length === 1 ? availableWorkspaces[0] : null;
}

export function useLimitsState() {
  const { capabilities, user } = useAuthContext();
  const userId = user?.id || 'anon';
  const availableWorkspaces = capabilities.canWriteUserLimitsIn || [];

  const [workspaceId, setWorkspaceIdRaw] = useState<string | null>(
    () => resolveLimitsStateWorkspaceId(null, availableWorkspaces),
  );
  const previousUserIdRef = useRef(userId);
  const workspaceScopeKey = availableWorkspaces.join('\0');

  const [activeOperations, setActiveOperations] = useState<string[]>(() => {
    if (!workspaceId) return [];
    try {
      const stored = localStorage.getItem(STORAGE_KEY_OPS(userId, workspaceId));
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [activeOperationId, setActiveOperationIdRaw] = useState<string | null>(null);

  const setWorkspaceId = useCallback((id: string | null) => {
    setWorkspaceIdRaw(id);
    setActiveOperationIdRaw(null);
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY_WS, id);
        const stored = localStorage.getItem(STORAGE_KEY_OPS(userId, id));
        setActiveOperations(stored ? JSON.parse(stored) : []);
      } else {
        localStorage.removeItem(STORAGE_KEY_WS);
        setActiveOperations([]);
      }
    } catch {}
  }, [userId]);

  useEffect(() => {
    const userChanged = previousUserIdRef.current !== userId;
    previousUserIdRef.current = userId;
    const nextWorkspaceId = resolveLimitsStateWorkspaceId(
      userChanged ? null : workspaceId,
      availableWorkspaces,
    );
    if (userChanged || nextWorkspaceId !== workspaceId) {
      setWorkspaceId(nextWorkspaceId);
    }
  }, [availableWorkspaces, setWorkspaceId, userId, workspaceId, workspaceScopeKey]);

  const addOperation = useCallback((opId: string) => {
    if (!workspaceId) return;
    setActiveOperations(prev => {
      if (prev.includes(opId)) return prev;
      const next = [...prev, opId];
      try { localStorage.setItem(STORAGE_KEY_OPS(userId, workspaceId), JSON.stringify(next)); } catch {}
      return next;
    });
  }, [userId, workspaceId]);

  const removeOperation = useCallback((opId: string) => {
    if (!workspaceId) return;
    setActiveOperations(prev => {
      const next = prev.filter(id => id !== opId);
      try { localStorage.setItem(STORAGE_KEY_OPS(userId, workspaceId), JSON.stringify(next)); } catch {}
      return next;
    });
  }, [userId, workspaceId]);

  return {
    workspaceId,
    setWorkspaceId,
    activeOperations,
    addOperation,
    removeOperation,
    activeOperationId,
    setActiveOperationId: setActiveOperationIdRaw,
    availableWorkspaces,
  };
}