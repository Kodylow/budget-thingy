import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AuthUser,
  AuthAuthorization,
  AuthAuthorizationRole,
  AuthCapabilities,
} from '@workspace/api-client-react';
import {
  AuthRequestCancelledError,
  loadAuthorization,
} from './auth-request';

export type { AuthUser, AuthAuthorization, AuthAuthorizationRole, AuthCapabilities };
export type AuthAvailability =
  | 'loading'
  | 'authorized'
  | 'signed-out'
  | 'denied'
  | 'invalid-preview'
  | 'unavailable';

interface AuthState {
  /** Base identity for the signed-in user, or null when signed out. */
  user: AuthUser | null;
  /**
   * Resolved Enterprise authorization, or null when the user is signed out or
   * is neither an account admin nor an enabled workspace admin (access denied).
   */
  auth: AuthAuthorization | null;
  /** Server-derived capabilities like email testing access. */
  capabilities: AuthCapabilities | null;
  isLoading: boolean;
  availability: AuthAvailability;
  isUnavailable: boolean;
  /** A valid session exists (user present), regardless of authorization. */
  isAuthenticated: boolean;
  logout: () => void;
  retryAuthorization: () => void;
  /** Recheck access without discarding the current snapshot while it is pending. */
  revalidateAuthorization: () => Promise<void>;
}

type AuthCacheEvent = 'signed-out' | 'explicit-sign-in';
type AuthCacheClearListener = (event: AuthCacheEvent) => void;
const authCacheClearListeners = new Set<AuthCacheClearListener>();

function signedOutLatchKey(): string | null {
  try {
    return `budget-monitor:auth-signed-out:${window.location.origin}`;
  } catch {
    return null;
  }
}

function hasSignedOutLatch(): boolean {
  const key = signedOutLatchKey();
  if (!key) return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function setSignedOutLatch(): void {
  const key = signedOutLatchKey();
  if (!key) return;
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // The in-memory guard still protects this tab when storage is blocked.
  }
}

/** Clears the fail-closed latch immediately before an explicit login attempt. */
export function beginExplicitSignIn(): void {
  const key = signedOutLatchKey();
  if (key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // The in-memory notification below also recovers hooks when storage is blocked.
    }
  }
  authCacheClearListeners.forEach((listener) => listener('explicit-sign-in'));
}

/**
 * Clears this document's protected auth snapshot without changing the durable
 * logout intent. This is used before a 401 login redirect: the callback's fresh
 * document must be allowed to verify the newly established server session.
 */
export function clearAuthCache(): void {
  authCacheClearListeners.forEach((listener) => listener('signed-out'));
}

function getBasePath() {
  return import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';
}

function bestEffortInvalidateServerSession(): void {
  const base = getBasePath();
  void fetch(`/api/logout?returnTo=${encodeURIComponent(base)}`, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'manual',
    keepalive: true,
  }).catch(() => {
    // The client is already fail-closed. An unavailable server cannot confirm
    // cookie invalidation, and must not strand the browser on a 5xx logout page.
  });
}

export function useAuth(previewAs: string | null = null): AuthState {
  const [blockedOnMount] = useState(hasSignedOutLatch);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [auth, setAuth] = useState<AuthAuthorization | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [isLoading, setIsLoading] = useState(!blockedOnMount);
  const [availability, setAvailability] = useState<AuthAvailability>(
    blockedOnMount ? 'signed-out' : 'loading',
  );
  const [loadedPreviewAs, setLoadedPreviewAs] = useState<string | null>(
    blockedOnMount ? previewAs : null,
  );
  const signedOutRef = useRef(blockedOnMount);
  const availabilityRef = useRef<AuthAvailability>(
    blockedOnMount ? 'signed-out' : 'loading',
  );
  const recoveryAttemptsRef = useRef(0);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestAuthorizationRef = useRef<(background?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );
  const requestRef = useRef<{
    controller: AbortController;
    previewAs: string | null;
    promise: Promise<void>;
  } | null>(null);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const scheduleRecovery = useCallback(() => {
    clearRecoveryTimer();
    if (signedOutRef.current || recoveryAttemptsRef.current >= 2) return;
    const attempt = recoveryAttemptsRef.current++;
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      if (!signedOutRef.current && availabilityRef.current === 'unavailable') {
        void requestAuthorizationRef.current(true);
      }
    }, 1_500 * 2 ** attempt);
  }, [clearRecoveryTimer]);

  const requestAuthorization = useCallback((background = false): Promise<void> => {
    if (signedOutRef.current) return Promise.resolve();
    const pending = requestRef.current;
    if (background && pending && !pending.controller.signal.aborted && pending.previewAs === previewAs) {
      return pending.promise;
    }
    pending?.controller.abort();
    const controller = new AbortController();
    if (!background) {
      setIsLoading(true);
      availabilityRef.current = 'loading';
      setAvailability('loading');
      setUser(null);
      setAuth(null);
      setCapabilities(null);
      setLoadedPreviewAs(null);
    }

    const promise = loadAuthorization({
      previewAs,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      availabilityRef.current = result.availability;
      setAvailability(result.availability);
      // An unavailable access check proves no identity or scope. Clear every
      // protected snapshot, but do not turn a network failure into logout.
      if (result.availability === 'unavailable') {
        scheduleRecovery();
      } else {
        recoveryAttemptsRef.current = 0;
        clearRecoveryTimer();
      }
      setUser(result.envelope?.user ?? null);
      setAuth(result.envelope?.auth ?? null);
      setCapabilities(result.envelope?.capabilities ?? null);
    }).catch((error) => {
      if (!controller.signal.aborted && !(error instanceof AuthRequestCancelledError)) {
        availabilityRef.current = 'unavailable';
        setAvailability('unavailable');
        setUser(null);
        setAuth(null);
        setCapabilities(null);
        scheduleRecovery();
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        requestRef.current = null;
        setLoadedPreviewAs(previewAs);
        setIsLoading(false);
      }
    });
    requestRef.current = { controller, previewAs, promise };
    return promise;
  }, [clearRecoveryTimer, previewAs, scheduleRecovery]);
  requestAuthorizationRef.current = requestAuthorization;

  useEffect(() => {
    if (signedOutRef.current) {
      // Clearing a selected preview during sign-out must not start a new fetch.
      setLoadedPreviewAs(previewAs);
    } else {
      void requestAuthorization();
    }
    return () => {
      requestRef.current?.controller.abort();
      clearRecoveryTimer();
    };
  }, [clearRecoveryTimer, requestAuthorization]);

  useEffect(() => {
    const handleAuthCacheEvent = (event: AuthCacheEvent) => {
      requestRef.current?.controller.abort();
      requestRef.current = null;
      clearRecoveryTimer();
      recoveryAttemptsRef.current = 0;
      signedOutRef.current = event === 'signed-out';
      if (event === 'signed-out') {
        availabilityRef.current = 'signed-out';
        setUser(null);
        setAuth(null);
        setCapabilities(null);
        setIsLoading(false);
        setAvailability('signed-out');
        setLoadedPreviewAs(previewAs);
      } else {
        availabilityRef.current = 'loading';
        void requestAuthorizationRef.current();
      }
    };
    const syncSignedOut = (event: StorageEvent) => {
      if (event.key !== signedOutLatchKey()) return;
      if (event.newValue === '1') handleAuthCacheEvent('signed-out');
      else if (event.oldValue === '1' && event.newValue === null) {
        handleAuthCacheEvent('explicit-sign-in');
      }
    };
    authCacheClearListeners.add(handleAuthCacheEvent);
    window.addEventListener('storage', syncSignedOut);
    return () => {
      authCacheClearListeners.delete(handleAuthCacheEvent);
      window.removeEventListener('storage', syncSignedOut);
    };
  }, [clearRecoveryTimer, previewAs]);

  useEffect(() => {
    const recoverIfUnavailable = () => {
      if (signedOutRef.current || availabilityRef.current !== 'unavailable') return;
      clearRecoveryTimer();
      void requestAuthorizationRef.current(true);
    };
    window.addEventListener('focus', recoverIfUnavailable);
    window.addEventListener('online', recoverIfUnavailable);
    return () => {
      window.removeEventListener('focus', recoverIfUnavailable);
      window.removeEventListener('online', recoverIfUnavailable);
    };
  }, [clearRecoveryTimer]);

  const retryAuthorization = useCallback(() => {
    if (signedOutRef.current) {
      beginExplicitSignIn();
      return;
    }
    recoveryAttemptsRef.current = 0;
    clearRecoveryTimer();
    void requestAuthorization();
  }, [clearRecoveryTimer, requestAuthorization]);
  const revalidateAuthorization = useCallback(
    () => requestAuthorization(true),
    [requestAuthorization],
  );

  const logout = useCallback(() => {
    // Invalidate pending work immediately; server-cookie removal is best effort
    // and never navigates the user onto a failing API response.
    setSignedOutLatch();
    clearAuthCache();
    bestEffortInvalidateServerSession();
  }, []);

  return {
    user,
    auth,
    capabilities,
    isLoading: isLoading || loadedPreviewAs !== previewAs,
    availability,
    isUnavailable: availability === 'unavailable',
    isAuthenticated: availability === 'authorized' || availability === 'denied',
    logout,
    retryAuthorization,
    revalidateAuthorization,
  };
}
