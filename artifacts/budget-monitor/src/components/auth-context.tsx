import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clearApiDiagnostics, setPreviewAsGetter } from '@workspace/api-client-react';
import {
  useAuth as useReplitAuth,
  logAuthDebug,
  type AuthUser,
  type AuthAuthorization,
  type AuthAuthorizationRole,
  type AuthCapabilities,
} from '@workspace/replit-auth-web';
import { protectedAuthorizationFingerprint } from '@/lib/auth-transition';
import {
  AuthContext,
  type AuthContextValue,
  type PreviewSelection,
  type ResolvedRole,
} from './auth-context-definition';

export type { AuthUser, AuthAuthorization, AuthAuthorizationRole, AuthCapabilities };
export type { AuthContextValue, PreviewSelection, ResolvedRole } from './auth-context-definition';
export { useAuthContext, useCanWrite } from './auth-context-definition';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [preview, setPreviewState] = useState<PreviewSelection | null>(null);
  const previewRef = useRef<PreviewSelection | null>(null);
  const previewTransitionRef = useRef(0);
  useLayoutEffect(() => {
    setPreviewAsGetter(() => previewRef.current);
    return () => setPreviewAsGetter(null);
  }, []);
  const {
    user,
    auth,
    capabilities,
    isLoading,
    availability,
    isUnavailable,
    isAuthenticated,
    logout,
    retryAuthorization,
    revalidateAuthorization,
  } = useReplitAuth(preview);
  const authorizationFingerprint = protectedAuthorizationFingerprint({
    availability,
    user,
    preview,
    auth,
    capabilities,
  });
  const [lastRealEntry, setLastRealEntry] = useState<{ userId: string; auth: AuthAuthorization } | null>(null);
  const userId = user?.id;
  const currentRealAuth = userId && !preview && auth && !auth.isPreview ? auth : null;
  useLayoutEffect(() => {
    if (!userId || !currentRealAuth) return;
    setLastRealEntry(previous => (
      previous?.userId === userId && previous.auth === currentRealAuth
        ? previous
        : { userId, auth: currentRealAuth }
    ));
  }, [currentRealAuth, userId]);
  const cachedRealAuth = currentRealAuth
    ?? (lastRealEntry && lastRealEntry.userId === userId ? lastRealEntry.auth : null);
  const realRole = cachedRealAuth?.role ?? auth?.role ?? null;
  const canPreviewRbac = capabilities?.canPreviewRoles === true;

  const setPreview = useCallback((next: PreviewSelection | null) => {
    if (!canPreviewRbac) return;
    logAuthDebug('protected-cache.clear', { reason: 'preview-change', previewSelected: Boolean(next) });
    ++previewTransitionRef.current;
    previewRef.current = next;
    void queryClient.cancelQueries();
    queryClient.clear();
    clearApiDiagnostics();
    setPreviewState(next);
  }, [canPreviewRbac, queryClient]);
  const resetPreview = useCallback(() => {
    logAuthDebug('protected-cache.clear', { reason: 'preview-reset' });
    ++previewTransitionRef.current;
    previewRef.current = null;
    void queryClient.cancelQueries();
    queryClient.clear();
    clearApiDiagnostics();
    setPreviewState(null);
  }, [queryClient]);
  const logoutAndClearPreview = useCallback(() => {
    logAuthDebug('protected-cache.clear', { reason: 'logout' });
    ++previewTransitionRef.current;
    previewRef.current = null;
    setLastRealEntry(null);
    setPreviewState(null);
    queryClient.clear();
    clearApiDiagnostics();
    logout();
  }, [logout, queryClient]);
  const identityRef = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (
      availability === 'loading' ||
      availability === 'unavailable' ||
      availability === 'invalid-preview'
    ) {
      return;
    }
    const identity = user?.id ?? null;
    if (identityRef.current !== undefined && identityRef.current !== identity) {
      logAuthDebug('protected-cache.clear', { reason: 'identity-change' });
      ++previewTransitionRef.current;
      previewRef.current = null;
      setLastRealEntry(null);
      setPreviewState(null);
      queryClient.clear();
      clearApiDiagnostics();
    }
    identityRef.current = identity;
  }, [availability, queryClient, user?.id]);
  useLayoutEffect(() => {
    if (availability === 'authorized') return;
    logAuthDebug('protected-cache.clear', { reason: 'not-authorized', availability });
    void queryClient.cancelQueries();
    queryClient.clear();
    clearApiDiagnostics();
  }, [availability, queryClient]);
  const authorizedFingerprintRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (availability !== 'authorized') {
      authorizedFingerprintRef.current = null;
      return;
    }
    const previous = authorizedFingerprintRef.current;
    authorizedFingerprintRef.current = authorizationFingerprint;
    if (previous && previous !== authorizationFingerprint) {
      logAuthDebug('protected-cache.clear', { reason: 'authorization-change' });
      void queryClient.cancelQueries();
      queryClient.clear();
      clearApiDiagnostics();
    }
  }, [authorizationFingerprint, availability, queryClient]);
  useEffect(() => {
    if (
      !isLoading &&
      availability === 'authorized' &&
      auth?.isPreview === true &&
      preview &&
      !canPreviewRbac
    ) {
      resetPreview();
    }
  }, [auth?.isPreview, availability, canPreviewRbac, isLoading, preview, resetPreview]);

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
      logout: logoutAndClearPreview,
      retryAuthorization,
      revalidateAuthorization,
      authorizationKey: authorizationFingerprint,
    };
  }, [user, auth, capabilities, isLoading, availability, isUnavailable, isAuthenticated, logoutAndClearPreview, retryAuthorization, revalidateAuthorization, preview, realRole, canPreviewRbac, setPreview, resetPreview, authorizationFingerprint]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
