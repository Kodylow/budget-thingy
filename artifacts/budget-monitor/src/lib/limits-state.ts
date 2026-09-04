import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthContext } from '@/components/auth-context';
import { 
  getGetLimitOperationQueryKey,
  LimitOperationPrepareInput, 
  LimitOperationCommitInput, 
  LimitOperationRetryInput,
  LimitOperation,
} from '@workspace/api-client-react';

const STORAGE_KEY_WS = 'budget-monitor-last-limits-ws';
const STORAGE_KEY_OP = (wsId: string) => `budget-monitor-limits-op-${wsId}`;

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

export function useLimitsState() {
  const { capabilities } = useAuthContext();
  const availableWorkspaces = capabilities.canWriteUserLimitsIn || [];
  
  const [workspaceId, setWorkspaceIdRaw] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_WS);
      if (stored && availableWorkspaces.includes(stored)) return stored;
    } catch {}
    return availableWorkspaces.length === 1 ? availableWorkspaces[0] : null;
  });

  const [activeOperationId, setActiveOperationIdRaw] = useState<string | null>(() => {
    if (!workspaceId) return null;
    try {
      return localStorage.getItem(STORAGE_KEY_OP(workspaceId)) || null;
    } catch {
      return null;
    }
  });

  const setWorkspaceId = useCallback((id: string | null) => {
    setWorkspaceIdRaw(id);
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY_WS, id);
        const op = localStorage.getItem(STORAGE_KEY_OP(id));
        setActiveOperationIdRaw(op || null);
      } else {
        localStorage.removeItem(STORAGE_KEY_WS);
        setActiveOperationIdRaw(null);
      }
    } catch {}
  }, []);

  const setActiveOperationId = useCallback((opId: string | null) => {
    setActiveOperationIdRaw(opId);
    if (!workspaceId) return;
    try {
      if (opId) {
        localStorage.setItem(STORAGE_KEY_OP(workspaceId), opId);
      } else {
        localStorage.removeItem(STORAGE_KEY_OP(workspaceId));
      }
    } catch {}
  }, [workspaceId]);

  return {
    workspaceId,
    setWorkspaceId,
    activeOperationId,
    setActiveOperationId,
    availableWorkspaces,
  };
}
