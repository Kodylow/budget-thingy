import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  useAuth as useReplitAuth,
  type AuthUser,
  type AuthAuthorization,
  type AuthAuthorizationRole,
} from '@workspace/replit-auth-web';

export type { AuthUser, AuthAuthorization, AuthAuthorizationRole };

/** UI-facing role, including the derived `denied` state (auth === null). */
export type ResolvedRole = AuthAuthorizationRole | 'denied';

interface AuthContextValue {
  user: AuthUser | null;
  auth: AuthAuthorization | null;
  isLoading: boolean;
  /** Signed in with a valid session (regardless of authorization). */
  isAuthenticated: boolean;
  /** Resolved role, or null when signed out / unknown. */
  role: ResolvedRole | null;
  /** Full account-wide access. */
  isAccountAdmin: boolean;
  /** Managed account-wide operational access without settings/access management. */
  isAccountEditor: boolean;
  /** Read-only access scoped to one or more workspaces. */
  isWorkspaceAdmin: boolean;
  /** Signed in but neither an account admin nor an enabled workspace admin. */
  isDenied: boolean;
  /** Whether the user may perform mutations / see editing controls. */
  canWrite: boolean;
  /** Workspace IDs this user administers (empty for account admins / denied). */
  workspaceIds: string[];
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user, auth, isLoading, isAuthenticated, login, logout } = useReplitAuth();

  const value = useMemo<AuthContextValue>(() => {
    // `auth === null` while signed in means access-denied.
    const isAccountAdmin = auth?.role === 'account_admin';
    const isAccountEditor = auth?.role === 'account_editor';
    const isWorkspaceAdmin = auth?.role === 'workspace_admin';
    const isDenied = isAuthenticated && auth == null;
    const role: ResolvedRole | null = !isAuthenticated
      ? null
      : (auth?.role ?? 'denied');

    return {
      user,
      auth,
      isLoading,
      isAuthenticated,
      role,
      isAccountAdmin,
      isAccountEditor,
      isWorkspaceAdmin,
      isDenied,
      // Account editors can operate allocated pools and checks, but only true
      // account admins can manage settings and editor access.
      canWrite: isAccountAdmin || isAccountEditor,
      workspaceIds: auth?.workspaceIds ?? [],
      login,
      logout,
    };
  }, [user, auth, isLoading, isAuthenticated, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within an <AuthProvider>');
  }
  return ctx;
}

/**
 * Convenience hook for role-gating controls. Returns `true` only for account
 * account admins and managed account editors for operational mutations.
 */
export function useCanWrite(): boolean {
  return useAuthContext().canWrite;
}
