import { useCallback, useEffect, useState } from 'react';
import type {
  AuthUser,
  AuthAuthorization,
  AuthAuthorizationRole,
  AuthCapabilities,
  AuthUserEnvelope,
} from '@workspace/api-client-react';

export type { AuthUser, AuthAuthorization, AuthAuthorizationRole, AuthCapabilities };

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
  /** A valid session exists (user present), regardless of authorization. */
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
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

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [auth, setAuth] = useState<AuthAuthorization | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/user', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<AuthUserEnvelope>;
      })
      .then((data) => {
        if (!cancelled) {
          setUser(data.user ?? null);
          setAuth(data.auth ?? null);
          setCapabilities(data.capabilities ?? null);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setAuth(null);
          setCapabilities(null);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const clear = () => {
      setUser(null);
      setAuth(null);
      setCapabilities(null);
      setIsLoading(false);
    };
    authCacheClearListeners.add(clear);
    return () => {
      authCacheClearListeners.delete(clear);
    };
  }, []);

  const login = useCallback(() => {
    const base = getBasePath();
    window.location.href = `/api/login?returnTo=${encodeURIComponent(base)}`;
  }, []);

  const logout = useCallback(() => {
    const base = getBasePath();
    window.location.href = `/api/logout?returnTo=${encodeURIComponent(base)}`;
  }, []);

  return {
    user,
    auth,
    capabilities,
    isLoading,
    isAuthenticated: !!user,
    login,
    logout,
  };
}
