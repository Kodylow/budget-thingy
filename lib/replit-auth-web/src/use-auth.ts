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
import { logAuthDebug } from './auth-debug';

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

export interface UseAuthOptions {
  enabled?: boolean;
  developmentUserId?: string | null;
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
  logAuthDebug('sign-in.begin', { signedOutLatch: hasSignedOutLatch(), listeners: authCacheClearListeners.size });
  const key = signedOutLatchKey();
  if (key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      logAuthDebug('storage.unavailable', { operation: 'clear-sign-out-latch' });
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
  logAuthDebug('auth-cache.clear', { listeners: authCacheClearListeners.size });
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

export function useAuth(
  previewAs: string | null = null,
  options: UseAuthOptions = {},
): AuthState {
  const enabled = options.enabled ?? true;
  const developmentUserId = options.developmentUserId || null;
  const [initialSignedOutLatch] = useState(hasSignedOutLatch);
  const blockedOnMount = !developmentUserId && initialSignedOutLatch;
  const [user, setUser] = useState<AuthUser | null>(null);
  const [auth, setAuth] = useState<AuthAuthorization | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [isLoading, setIsLoading] = useState(enabled && !blockedOnMount);
  const [availability, setAvailability] = useState<AuthAvailability>(
    enabled && blockedOnMount ? 'signed-out' : 'loading',
  );
  const [loadedPreviewAs, setLoadedPreviewAs] = useState<string | null>(
    blockedOnMount ? previewAs : null,
  );
  const [loadedDevelopmentUserId, setLoadedDevelopmentUserId] = useState<string | null>(
    blockedOnMount ? developmentUserId : null,
  );
  const realSignedOutRef = useRef(initialSignedOutLatch);
  const selectedScopeRef = useRef({ previewAs, developmentUserId, enabled });
  selectedScopeRef.current = { previewAs, developmentUserId, enabled };
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
    developmentUserId: string | null;
    promise: Promise<void>;
  } | null>(null);
  const hasUser = Boolean(user);
  const hasAuthorization = Boolean(auth);

  useEffect(() => {
    logAuthDebug('hook.mount', { blockedOnMount });
    const onPageHide = (event: PageTransitionEvent) => logAuthDebug('document.pagehide', { persisted: event.persisted });
    window.addEventListener('pagehide', onPageHide);
    return () => {
      logAuthDebug('hook.unmount');
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [blockedOnMount]);

  useEffect(() => {
    logAuthDebug('state.change', {
      availability, isLoading, hasUser, hasAuthorization,
      previewSelected: Boolean(previewAs), previewResolved: loadedPreviewAs === previewAs,
    });
  }, [availability, isLoading, hasUser, hasAuthorization, previewAs, loadedPreviewAs]);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const scheduleRecovery = useCallback(() => {
    clearRecoveryTimer();
    if (!enabled || (!developmentUserId && realSignedOutRef.current) || recoveryAttemptsRef.current >= 2) {
      logAuthDebug('recovery.skipped', { signedOut: realSignedOutRef.current, attempts: recoveryAttemptsRef.current });
      return;
    }
    const attempt = recoveryAttemptsRef.current++;
    logAuthDebug('recovery.scheduled', { attempt: attempt + 1, delayMs: 1_500 * 2 ** attempt });
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      if (
        selectedScopeRef.current.enabled
        && (selectedScopeRef.current.developmentUserId || !realSignedOutRef.current)
        && availabilityRef.current === 'unavailable'
      ) {
        logAuthDebug('recovery.run', { attempt: attempt + 1 });
        void requestAuthorizationRef.current(true);
      }
    }, 1_500 * 2 ** attempt);
  }, [clearRecoveryTimer, developmentUserId, enabled]);

  const requestAuthorization = useCallback((background = false): Promise<void> => {
    if (!enabled) {
      logAuthDebug('authorization.skipped', { reason: 'disabled', background });
      return Promise.resolve();
    }
    if (!developmentUserId && realSignedOutRef.current) {
      logAuthDebug('authorization.skipped', { reason: 'signed-out-latch', background });
      return Promise.resolve();
    }
    const pending = requestRef.current;
    if (
      background
      && pending
      && !pending.controller.signal.aborted
      && pending.previewAs === previewAs
      && pending.developmentUserId === developmentUserId
    ) {
      logAuthDebug('authorization.coalesced');
      return pending.promise;
    }
    logAuthDebug('authorization.start', { background, replacingPending: Boolean(pending), previewSelected: Boolean(previewAs) });
    pending?.controller.abort();
    const controller = new AbortController();
    const isCurrentRequest = () => {
      const selected = selectedScopeRef.current;
      return !controller.signal.aborted
        && selected.enabled
        && selected.previewAs === previewAs
        && selected.developmentUserId === developmentUserId;
    };
    if (!background) {
      setIsLoading(true);
      availabilityRef.current = 'loading';
      setAvailability('loading');
      setUser(null);
      setAuth(null);
      setCapabilities(null);
      setLoadedPreviewAs(null);
      setLoadedDevelopmentUserId(null);
    }

    const promise = loadAuthorization({
      previewAs,
      developmentUserId,
      signal: controller.signal,
    }).then((result) => {
      if (!isCurrentRequest()) {
        logAuthDebug('authorization.stale-result');
        return;
      }
      logAuthDebug('authorization.result', { availability: result.availability, background });
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
      logAuthDebug('authorization.failure', { cancelled: controller.signal.aborted || error instanceof AuthRequestCancelledError });
      if (isCurrentRequest() && !(error instanceof AuthRequestCancelledError)) {
        availabilityRef.current = 'unavailable';
        setAvailability('unavailable');
        setUser(null);
        setAuth(null);
        setCapabilities(null);
        scheduleRecovery();
      }
    }).finally(() => {
      if (isCurrentRequest()) {
        if (requestRef.current?.controller === controller) requestRef.current = null;
        setLoadedPreviewAs(previewAs);
        setLoadedDevelopmentUserId(developmentUserId);
        setIsLoading(false);
      }
    });
    requestRef.current = { controller, previewAs, developmentUserId, promise };
    return promise;
  }, [clearRecoveryTimer, developmentUserId, enabled, previewAs, scheduleRecovery]);
  requestAuthorizationRef.current = requestAuthorization;

  useEffect(() => {
    if (!enabled) {
      requestRef.current?.controller.abort();
      requestRef.current = null;
      clearRecoveryTimer();
      setUser(null);
      setAuth(null);
      setCapabilities(null);
      setIsLoading(true);
      availabilityRef.current = 'loading';
      setAvailability('loading');
      setLoadedPreviewAs(null);
      setLoadedDevelopmentUserId(null);
    } else if (!developmentUserId && realSignedOutRef.current) {
      // Clearing a selected preview during sign-out must not start a new fetch.
      setUser(null);
      setAuth(null);
      setCapabilities(null);
      setIsLoading(false);
      availabilityRef.current = 'signed-out';
      setAvailability('signed-out');
      setLoadedPreviewAs(previewAs);
      setLoadedDevelopmentUserId(developmentUserId);
    } else {
      void requestAuthorization();
    }
    return () => {
      logAuthDebug('authorization.effect-cleanup', { pending: Boolean(requestRef.current) });
      requestRef.current?.controller.abort();
      clearRecoveryTimer();
    };
  }, [clearRecoveryTimer, developmentUserId, enabled, previewAs, requestAuthorization]);

  useEffect(() => {
    const handleAuthCacheEvent = (event: AuthCacheEvent) => {
      if (developmentUserId) return;
      logAuthDebug('auth-cache.event', { reason: event });
      requestRef.current?.controller.abort();
      requestRef.current = null;
      clearRecoveryTimer();
      recoveryAttemptsRef.current = 0;
      realSignedOutRef.current = event === 'signed-out';
      if (event === 'signed-out') {
        availabilityRef.current = 'signed-out';
        setUser(null);
        setAuth(null);
        setCapabilities(null);
        setIsLoading(false);
        setAvailability('signed-out');
        setLoadedPreviewAs(previewAs);
        setLoadedDevelopmentUserId(developmentUserId);
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
  }, [clearRecoveryTimer, developmentUserId, previewAs]);

  useEffect(() => {
    const recoverIfUnavailable = (event: Event) => {
      const selected = selectedScopeRef.current;
      if (
        !selected.enabled
        || (!selected.developmentUserId && realSignedOutRef.current)
        || availabilityRef.current !== 'unavailable'
      ) return;
      logAuthDebug('recovery.browser-event', { reason: event.type === 'focus' ? 'focus' : 'online' });
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
    logAuthDebug('recovery.manual', { signedOut: realSignedOutRef.current });
    if (!enabled) return;
    if (!developmentUserId && realSignedOutRef.current) {
      beginExplicitSignIn();
      return;
    }
    recoveryAttemptsRef.current = 0;
    clearRecoveryTimer();
    void requestAuthorization();
  }, [clearRecoveryTimer, developmentUserId, enabled, requestAuthorization]);
  const revalidateAuthorization = useCallback(
    () => requestAuthorization(true),
    [requestAuthorization],
  );

  const logout = useCallback(() => {
    if (developmentUserId) {
      logAuthDebug('sign-out.skipped', { reason: 'development-view-as' });
      return;
    }
    logAuthDebug('sign-out.begin');
    // Invalidate pending work immediately; server-cookie removal is best effort
    // and never navigates the user onto a failing API response.
    setSignedOutLatch();
    clearAuthCache();
    bestEffortInvalidateServerSession();
  }, [developmentUserId]);

  const scopeResolved = enabled
    && loadedPreviewAs === previewAs
    && loadedDevelopmentUserId === developmentUserId;
  const visibleUser = scopeResolved ? user : null;
  const visibleAuth = scopeResolved ? auth : null;
  const visibleCapabilities = scopeResolved ? capabilities : null;
  const visibleAvailability: AuthAvailability = scopeResolved ? availability : 'loading';

  return {
    user: visibleUser,
    auth: visibleAuth,
    capabilities: visibleCapabilities,
    isLoading: !scopeResolved || isLoading,
    availability: visibleAvailability,
    isUnavailable: visibleAvailability === 'unavailable',
    isAuthenticated: visibleAvailability === 'authorized' || visibleAvailability === 'denied',
    logout,
    retryAuthorization,
    revalidateAuthorization,
  };
}
