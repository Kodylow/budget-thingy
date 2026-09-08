import type { Request } from "express";

import { getDirectory, type EnterpriseMember } from "./enterprise";
import type { Authorization } from "./authz";

export const DEV_VIEW_AS_HEADER = "X-Dev-View-As";

/**
 * This is deliberately a server boundary rather than a client convention.
 * Replit deployments set REPLIT_DEPLOYMENT; NODE_ENV is also pinned to
 * production in the artifact build/run configuration.
 */
export function isDevViewEnabled(): boolean {
  return process.env.NODE_ENV === "development" &&
    !process.env.REPLIT_DEPLOYMENT &&
    !process.env.REPLIT_DEPLOYMENT_ID &&
    process.env.DEV_VIEW_AS !== "0";
}

export function isEligibleDevViewMember(member: EnterpriseMember): boolean {
  return !member.isInternalReplitUser &&
    [...member.workspaces.values()].some((membership) => !membership.isDisabled);
}

export async function getDevViewUsers() {
  const directory = await getDirectory();
  return [...directory.members.values()]
    .filter(isEligibleDevViewMember)
    .map((member) => ({
      userId: member.userId,
      name: member.name ?? null,
      username: member.username ?? null,
      email: member.email ?? null,
    }))
    .sort((left, right) =>
      (left.name ?? left.username).localeCompare(
        right.name ?? right.username,
        undefined,
        { sensitivity: "base" },
      ) || left.userId.localeCompare(right.userId)
    );
}

export async function resolveDevViewMember(req: Request): Promise<EnterpriseMember> {
  const selectedUserId = req.header(DEV_VIEW_AS_HEADER);
  if (!selectedUserId) {
    throw new InvalidDevViewSelectionError("A development view-as user is required");
  }

  const directory = await getDirectory();
  const member = directory.members.get(selectedUserId);
  if (!member || !isEligibleDevViewMember(member)) {
    throw new InvalidDevViewSelectionError(
      "Development view-as user is invalid or no longer available",
    );
  }
  return member;
}

/** Preserve canonical scopes while removing every mutation/preview authority. */
export function devViewReadOnly(authz: Authorization): Authorization {
  return {
    ...authz,
    capabilities: {
      ...authz.capabilities,
      canManageAccess: false,
      canEditAllocations: false,
      canManageFundingMappings: false,
      canManageNotifications: false,
      canManageSystem: false,
      canPreviewRoles: false,
      canWriteGroupLimits: false,
      canRunChecks: false,
      canSendTestEmail: false,
      canWriteUserLimitsIn: [],
    },
    // This is an actual canonical user authorization, not a forced-role
    // preview. The markers only communicate simulated/read-only semantics.
    isPreview: true,
    previewReadOnly: true,
  };
}

export class InvalidDevViewSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDevViewSelectionError";
  }
}