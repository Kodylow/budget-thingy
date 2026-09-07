import { createContext, useContext } from 'react';
import type {
  AuthAuthorization,
  AuthAuthorizationRole,
  AuthAvailability,
  AuthCapabilities,
  AuthUser,
} from '@workspace/replit-auth-web';

/** UI-facing role, including the derived `denied` state (auth === null). */
export type ResolvedRole = AuthAuthorizationRole | 'denied';
export type PreviewSelection =
  | `workspace_admin:${string}`
  | `team_admin:${string}`
  | `member:${string}`;

export interface AuthContextValue {
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
  logout: () => void;
  retryAuthorization: () => void;
  revalidateAuthorization: () => Promise<void>;
  /** Changes whenever protected component/query state must not be retained. */
  authorizationKey: string;
}

/**
 * Defined outside AuthProvider's Fast Refresh boundary so an update cannot
 * leave providers and consumers holding different context identities.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within an <AuthProvider>');
  }
  return context;
}

export function useCanWrite(): boolean {
  return useAuthContext().canWrite;
}