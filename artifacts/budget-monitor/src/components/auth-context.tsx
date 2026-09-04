import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setPreviewAsGetter } from '@workspace/api-client-react';
import {
  useAuth as useReplitAuth,
  type AuthUser,
  type AuthAuthorization,
  type AuthAuthorizationRole,
  type AuthCapabilities,
  type AuthAvailability,
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
  availability: AuthAvailability;
  isUnavailable: boolean;
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
  retryAuthorization: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [preview, setPreviewState] = useState<PreviewSelection | null>(null);
  const previewRef = useRef<PreviewSelection | null>(null);
  const previewTransitionRef = useRef(0);
  previewRef.current = preview;
  setPreviewAsGetter(() => previewRef.current);
  const {
    user,
    auth,
    capabilities,
    isLoading,
    availability,
    isUnavailable,
    isAuthenticated,
    login,
    logout,
    retryAuthorization,
  } = useReplitAuth(preview);
  const realAuthRef = useRef<{ userId: string; auth: AuthAuthorization } | null>(null);
  if (user && !preview && auth && !auth.isPreview) {
    realAuthRef.current = { userId: user.id, auth };
  }
  const cachedRealEntry = realAuthRef.current;
  const cachedRealAuth = cachedRealEntry && cachedRealEntry.userId === user?.id
    ? cachedRealEntry.auth
    : null;
  const realRole = cachedRealAuth?.role ?? auth?.role ?? null;
  const canPreviewRbac = capabilities?.canPreviewRoles === true;

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
  const logoutAndClearPreview = useCallback(() => {
    ++previewTransitionRef.current;
    previewRef.current = null;
    realAuthRef.current = null;
    setPreviewState(null);
    queryClient.clear();
    logout();
  }, [logout, queryClient]);
  const identityRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const identity = user?.id ?? null;
    if (identityRef.current !== undefined && identityRef.current !== identity) {
      ++previewTransitionRef.current;
      previewRef.current = null;
      realAuthRef.current = null;
      setPreviewState(null);
      queryClient.clear();
    }
    identityRef.current = identity;
  }, [queryClient, user?.id]);
  useEffect(() => {
    if (availability === 'authorized') return;
    void queryClient.cancelQueries().then(() => queryClient.clear());
  }, [availability, queryClient]);
  useEffect(() => {
    if (!isLoading && preview && !canPreviewRbac) resetPreview();
  }, [canPreviewRbac, isLoading, preview, resetPreview]);

  const value = useMemo<AuthContextValue>(() => {
    // `auth === null` while signed in means access-denied.
    const role: ResolvedRole | null = !isAuthenticated ? null : (auth?.role ?? 'denied');
    const resolvedRealRole: ResolvedRole | null = !isAuthenticated ? null : (realRole ?? 'denied');
    const effectiveCapabilities: AuthCapabilities = capabilities ?? {
      canManageAccess: false,
      canViewAccountUsage: false,
      canEditAllocations: false,
      canManageNotifications: false,
      canManageSystem: false,
      canPreviewRoles: false,
      canWriteGroupLimits: false,
      canWriteUserLimitsIn: [],
      canRunChecks: false,
      canSendTestEmail: false,
    };
    const isAccountAdmin = role === 'account';
    const isWorkspaceAdmin = role === 'workspace_admin';
    const isTeamAdmin = role === 'team_admin';
    const isDenied = isAuthenticated && auth == null;
    const realIsAccountAdmin = resolvedRealRole === 'account';
    const previewReadOnly = auth?.previewReadOnly === true;
    const canWrite = !previewReadOnly && (effectiveCapabilities.canEditAllocations || effectiveCapabilities.canWriteGroupLimits || effectiveCapabilities.canWriteUserLimitsIn.length > 0);

    return {
      user,
      auth,
      isLoading,
      availability,
      isUnavailable,
      isAuthenticated,
      role,
      realRole: resolvedRealRole,
      realIsAccountAdmin,
      capabilities: effectiveCapabilities,
      canTestEmail: effectiveCapabilities.canSendTestEmail ?? false,
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
      canWrite,
      workspaceIds: auth?.workspaceIds ?? [],
      login,
      logout: logoutAndClearPreview,
      retryAuthorization,
    };
  }, [user, auth, capabilities, isLoading, availability, isUnavailable, isAuthenticated, login, logoutAndClearPreview, retryAuthorization, preview, realRole, canPreviewRbac, setPreview, resetPreview]);

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
