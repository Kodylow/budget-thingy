import { useCallback, useEffect, useState } from 'react';
import type {
  AuthUser,
  AuthAuthorization,
  AuthAuthorizationRole,
  AuthCapabilities,
  AuthUserEnvelope,
} from '@workspace/api-client-react';
import {
  AuthRequestCancelledError,
  loadAuthorization,
  nextAuthorizationRequestVersion,
} from './auth-request';

export type { AuthUser, AuthAuthorization, AuthAuthorizationRole, AuthCapabilities };
export type AuthAvailability =
  | 'loading'
  | 'authorized'
  | 'signed-out'
  | 'denied'
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
  login: () => void;
  logout: () => void;
  retryAuthorization: () => void;
}

type AuthCacheClearListener = () => void;
const authCacheClearListeners = new Set<AuthCacheClearListener>();

/** Clears the in-memory browser auth snapshot without making a server call. */
export function clearAuthCache(): void {
  authCacheClearListeners.forEach((listener) => listener());
}

function getBasePath() {
  return import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';
}

export function useAuth(previewAs: string | null = null): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [auth, setAuth] = useState<AuthAuthorization | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [availability, setAvailability] = useState<AuthAvailability>('loading');
  const [loadedPreviewAs, setLoadedPreviewAs] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setIsLoading(true);
    setAvailability('loading');
    setUser(null);
    setAuth(null);
    setCapabilities(null);
    setLoadedPreviewAs(null);

    void loadAuthorization({
      previewAs,
      signal: controller.signal,
    }).then((result) => {
      if (cancelled) return;
      setAvailability(result.availability);
      setUser(result.envelope?.user ?? null);
      setAuth(result.envelope?.auth ?? null);
      setCapabilities(result.envelope?.capabilities ?? null);
    }).catch((error) => {
      if (!cancelled && !(error instanceof AuthRequestCancelledError)) {
        setAvailability('unavailable');
      }
    }).finally(() => {
      if (!cancelled) {
        setLoadedPreviewAs(previewAs);
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [previewAs, requestVersion]);

  useEffect(() => {
    const clear = () => {
      setUser(null);
      setAuth(null);
      setCapabilities(null);
      setIsLoading(false);
      setAvailability('signed-out');
      setLoadedPreviewAs(previewAs);
    };
    authCacheClearListeners.add(clear);
    return () => {
      authCacheClearListeners.delete(clear);
    };
  }, [previewAs]);

  const retryAuthorization = useCallback(() => {
    setRequestVersion(nextAuthorizationRequestVersion);
  }, []);

  const login = useCallback(() => {
    const base = getBasePath();
    window.location.href = `/api/login?returnTo=${encodeURIComponent(base)}`;
  }, []);

  const logout = useCallback(() => {
    const base = getBasePath();
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `/api/logout?returnTo=${encodeURIComponent(base)}`;
    document.body.appendChild(form);
    form.submit();
  }, []);

  return {
    user,
    auth,
    capabilities,
    isLoading: isLoading || loadedPreviewAs !== previewAs,
    availability,
    isUnavailable: availability === 'unavailable',
    isAuthenticated: availability === 'authorized' || availability === 'denied',
    login,
    logout,
    retryAuthorization,
  };
}
