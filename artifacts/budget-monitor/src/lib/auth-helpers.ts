import type { AuthAuthorizationRole, AuthCapabilities } from '@workspace/replit-auth-web';
import type { ResolvedRole } from '../components/auth-context';

export function checkIsDenied(
  isAuthenticated: boolean,
  auth: any | null,
  isUnavailable = false,
): boolean {
  return isAuthenticated && auth == null && !isUnavailable;
}

export function checkRealIsAccountAdmin(realRole: ResolvedRole | null): boolean {
  return realRole === 'account';
}

export function checkCanTestEmail(capabilities: AuthCapabilities | null | undefined): boolean {
  return capabilities?.canManageAccess === true;
}

export function checkCanPreviewRoles(capabilities: AuthCapabilities | null | undefined): boolean {
  return capabilities?.canPreviewRoles === true;
}

export function checkCanAccessSettings(
  isAccountAdmin: boolean,
  realIsAccountAdmin: boolean,
  canTestEmail: boolean
): boolean {
  return isAccountAdmin || realIsAccountAdmin || canTestEmail;
}
