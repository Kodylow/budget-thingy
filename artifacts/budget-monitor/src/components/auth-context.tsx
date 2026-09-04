import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setPreviewAsGetter } from '@workspace/api-client-react';
import {
  useAuth as useReplitAuth,
  type AuthUser,
  type AuthAuthorization,
  type AuthAuthorizationRole,
  type AuthCapabilities,
} from '@workspace/replit-auth-web';

export type { AuthUser, AuthAuthorization, AuthAuthorizationRole, AuthCapabilities };

/** UI-facing role, including the derived `denied` state (auth === null). */
export type ResolvedRole = AuthAuthorizationRole | 'denied';
export type PreviewSelection =
  | `workspace_admin:${string}`
  | `team_admin:${string}`
  | `member:${string}`;

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
  /** Whether the real signed-in identity is an account user. */
  realIsAccountAdmin: boolean;
  capabilities: AuthCapabilities;
  canTestEmail: boolean;
  preview: PreviewSelection | null;
  canPreviewRbac: boolean;
  setPreview: (preview: PreviewSelection | null) => void;
  resetPreview: () => void;
  isPreviewing: boolean;
  isAccountWide: boolean;
  /** Full account-wide access. */
  isAccountAdmin: boolean;
  isTeamAdmin: boolean;
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
  const queryClient = useQueryClient();
  const [preview, setPreviewState] = useState<PreviewSelection | null>(null);
  const previewRef = useRef<PreviewSelection | null>(null);
  const previewTransitionRef = useRef(0);
  previewRef.current = preview;
  setPreviewAsGetter(() => previewRef.current);
  const { user, auth, capabilities, isLoading, isAuthenticated, login, logout } = useReplitAuth(preview);
  const realAuthRef = useRef<AuthAuthorization | null>(null);
  if (!preview && auth && !auth.isPreview) realAuthRef.current = auth;
  const realRole = realAuthRef.current?.role ?? auth?.role ?? null;
  const canPreviewRbac = realRole === 'account';

  const setPreview = useCallback((next: PreviewSelection | null) => {
    if (!canPreviewRbac) return;
    const transition = ++previewTransitionRef.current;
    void queryClient.cancelQueries().then(() => {
      if (transition !== previewTransitionRef.current) return;
      queryClient.clear();
      setPreviewState(next);
    });
  }, [canPreviewRbac, queryClient]);
  const resetPreview = useCallback(() => {
    const transition = ++previewTransitionRef.current;
    void queryClient.cancelQueries().then(() => {
      if (transition !== previewTransitionRef.current) return;
      queryClient.clear();
      setPreviewState(null);
    });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    // `auth === null` while signed in means access-denied.
    const role: ResolvedRole | null = !isAuthenticated ? null : (auth?.role ?? 'denied');
    const resolvedRealRole: ResolvedRole | null = !isAuthenticated ? null : (realRole ?? 'denied');
    const effectiveCapabilities: AuthCapabilities = capabilities ?? {
      canManageAccess: false,
      canEditAllocations: false,
      canWriteGroupLimits: false,
      canWriteUserLimitsIn: [],
    };
    const isAccountAdmin = role === 'account';
    const isWorkspaceAdmin = role === 'workspace_admin';
    const isTeamAdmin = role === 'team_admin';
    const isDenied = isAuthenticated && auth == null;
    const realIsAccountAdmin = resolvedRealRole === 'account';

    return {
      user,
      auth,
      isLoading,
      isAuthenticated,
      role,
      realRole: resolvedRealRole,
      realIsAccountAdmin,
      capabilities: effectiveCapabilities,
      canTestEmail: effectiveCapabilities.canManageAccess,
      preview,
      canPreviewRbac,
      setPreview,
      resetPreview,
      isPreviewing: preview !== null,
      isAccountWide: isAccountAdmin,
      isAccountAdmin,
      isTeamAdmin,
      isWorkspaceAdmin,
      isDenied,
      canWrite: effectiveCapabilities.canEditAllocations,
      workspaceIds: auth?.workspaceIds ?? [],
      login,
      logout,
    };
  }, [user, auth, capabilities, isLoading, isAuthenticated, login, logout, preview, realRole, canPreviewRbac, setPreview, resetPreview]);

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
