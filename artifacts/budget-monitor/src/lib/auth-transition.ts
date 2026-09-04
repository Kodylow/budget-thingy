import type {
  AuthAuthorization,
  AuthCapabilities,
  AuthUser,
} from '@workspace/replit-auth-web';
import type { AuthAvailability } from '@workspace/replit-auth-web';

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

export function protectedAuthorizationFingerprint(input: {
  availability: AuthAvailability;
  user: AuthUser | null;
  auth: AuthAuthorization | null;
  capabilities: AuthCapabilities | null;
  preview: string | null;
}): string {
  const { availability, user, auth, capabilities, preview } = input;
  return JSON.stringify({
    availability,
    userId: user?.id ?? null,
    preview,
    authorization: auth ? {
      role: auth.role,
      roles: sorted(auth.roles),
      workspaceIds: sorted(auth.workspaceIds),
      teamNames: sorted(auth.teamNames),
      groupIds: sorted(auth.groupIds),
      userIds: sorted(auth.userIds),
      isPreview: auth.isPreview,
      viewScope: auth.viewScope ?? null,
      previewReadOnly: auth.previewReadOnly ?? false,
    } : null,
    capabilities: capabilities ? {
      ...capabilities,
      canWriteUserLimitsIn: sorted(capabilities.canWriteUserLimitsIn),
    } : null,
  });
}