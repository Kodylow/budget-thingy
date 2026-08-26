import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  useAuth as useReplitAuth,
  type AuthUser,
  type AuthAuthorization,
  type AuthAuthorizationRole,
} from '@workspace/replit-auth-web';
import {
  canUseRbacPreview,
  isAccountWideView,
  sanitizePreview,
  type PreviewSelection,
} from '@/lib/rbac-view';

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
  /** The immutable role returned by the server for this session. */
  realRole: ResolvedRole | null;
  preview: PreviewSelection | null;
  canPreviewRbac: boolean;
  setPreview: (preview: PreviewSelection | null) => void;
  resetPreview: () => void;
  isPreviewing: boolean;
  isAccountWide: boolean;
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
const PREVIEW_STORAGE_PREFIX = 'budget-monitor:rbac-preview:';

function readStoredPreview(
  userId: string | undefined,
  role: AuthAuthorizationRole | undefined,
): PreviewSelection | null {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${PREVIEW_STORAGE_PREFIX}${userId}`);
    return sanitizePreview(role, raw ? JSON.parse(raw) as PreviewSelection : null);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user, auth, isLoading, isAuthenticated, login, logout } = useReplitAuth();
  const [requestedPreview, setRequestedPreview] = useState<{
    userId: string;
    value: PreviewSelection | null;
  } | null>(null);
  const requestedForCurrentUser =
    requestedPreview && requestedPreview.userId === user?.id
      ? requestedPreview.value
      : readStoredPreview(user?.id, auth?.role);
  const preview = sanitizePreview(auth?.role, requestedForCurrentUser);

  useEffect(() => {
    if (!user?.id || canUseRbacPreview(auth?.role)) return;
    window.sessionStorage.removeItem(`${PREVIEW_STORAGE_PREFIX}${user.id}`);
  }, [user?.id, auth?.role]);

  const setPreview = useCallback((next: PreviewSelection | null) => {
    if (!user?.id) return;
    const safe = sanitizePreview(auth?.role, next);
    setRequestedPreview({ userId: user.id, value: safe });
    if (safe) {
      window.sessionStorage.setItem(`${PREVIEW_STORAGE_PREFIX}${user.id}`, JSON.stringify(safe));
    } else {
      window.sessionStorage.removeItem(`${PREVIEW_STORAGE_PREFIX}${user.id}`);
    }
  }, [auth?.role, user?.id]);
  const resetPreview = useCallback(() => {
    if (!user?.id) return;
    setRequestedPreview({ userId: user.id, value: null });
    window.sessionStorage.removeItem(`${PREVIEW_STORAGE_PREFIX}${user.id}`);
  }, [user?.id]);

  const value = useMemo<AuthContextValue>(() => {
    // `auth === null` while signed in means access-denied.
    const realRole: ResolvedRole | null = !isAuthenticated ? null : (auth?.role ?? 'denied');
    const role: ResolvedRole | null = preview?.role ?? realRole;
    const isAccountAdmin = role === 'account_admin' || role === 'account_delegate';
    const isAccountEditor = role === 'account_editor';
    const isWorkspaceAdmin = role === 'workspace_admin';
    const isDenied = isAuthenticated && auth == null;

    return {
      user,
      auth,
      isLoading,
      isAuthenticated,
      role,
      realRole,
      preview,
      canPreviewRbac: canUseRbacPreview(auth?.role),
      setPreview,
      resetPreview,
      isPreviewing: preview !== null,
      isAccountWide: isAccountWideView(role),
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
  }, [user, auth, isLoading, isAuthenticated, login, logout, preview, setPreview, resetPreview]);

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
