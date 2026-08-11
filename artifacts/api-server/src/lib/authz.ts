import { getDirectory, type EnterpriseGroup } from "./enterprise";

/**
 * Injectable authorization resolver used by both the auth route and the
 * `requireAuth` middleware. Production uses {@link resolveAuthorization}
 * against the real Enterprise directory; tests may inject a representative
 * fixture resolver via {@link setAuthorizationResolver}. The default is always
 * the real resolver, so production behavior is never weakened.
 */
export type AuthorizationResolver = (
  userId: string,
) => Promise<Authorization | null>;

let injectedResolver: AuthorizationResolver | null = null;

/** Override the shared authorization resolver (test-only). */
export function setAuthorizationResolver(fn: AuthorizationResolver | null): void {
  injectedResolver = fn;
}

/** Resolve authorization through the injected resolver, or the real one. */
export function resolveCurrentAuthorization(
  userId: string,
): Promise<Authorization | null> {
  return (injectedResolver ?? resolveAuthorization)(userId);
}

/**
 * Resolved Enterprise authorization for a signed-in user.
 *
 * - `account_admin`: full account-wide access. `workspaceIds` is empty and MUST
 *   be ignored — an account admin can see every workspace/group.
 * - `workspace_admin`: read-only access limited to the union of workspaces the
 *   member is an *enabled admin* of. `workspaceIds` is that union.
 *
 * When the user cannot be matched to an enabled account admin or enabled
 * workspace admin, resolution fails closed and returns `null` (access denied).
 */
export type AuthzRole = "account_admin" | "workspace_admin";

export interface Authorization {
  role: AuthzRole;
  /** Only meaningful for workspace_admin; the union of admin workspaces. */
  workspaceIds: string[];
}

/** A workspace role counts as admin only for these values. */
const ADMIN_ROLES = new Set(["admin", "owner", "account_admin"]);

function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.has(role.trim().toLowerCase());
}

/**
 * Resolve the Enterprise authorization for the given stable Replit user ID.
 *
 * Fail-closed rules:
 * - Unknown user (not in the directory) -> null.
 * - Account admins get account-wide access.
 * - Otherwise the union of workspaces where the member's role is admin AND the
 *   membership is not disabled. If that union is empty -> null.
 */
export async function resolveAuthorization(
  userId: string,
): Promise<Authorization | null> {
  const dir = await getDirectory();
  const member = dir.members.get(userId);
  if (!member) return null;

  if (member.isAccountAdmin) {
    return { role: "account_admin", workspaceIds: [] };
  }

  const workspaceIds: string[] = [];
  for (const [workspaceId, ws] of member.workspaces) {
    if (ws.isDisabled) continue;
    if (isAdminRole(ws.role)) workspaceIds.push(workspaceId);
  }

  if (workspaceIds.length === 0) return null;
  return { role: "workspace_admin", workspaceIds: [...new Set(workspaceIds)] };
}

/** Whether the authorization can see the given workspace. */
export function canSeeWorkspace(authz: Authorization, workspaceId: string): boolean {
  if (authz.role === "account_admin") return true;
  return authz.workspaceIds.includes(workspaceId);
}

/** Whether the authorization can see the given group (by its workspace). */
export function canSeeGroup(authz: Authorization, group: EnterpriseGroup): boolean {
  return canSeeWorkspace(authz, group.workspaceId);
}

/**
 * Filter a list of groups to only those visible under the authorization.
 * Account admins get every group; workspace admins get only in-scope groups.
 */
export function scopeGroups<T extends EnterpriseGroup>(
  authz: Authorization,
  groups: T[],
): T[] {
  if (authz.role === "account_admin") return groups;
  const allowed = new Set(authz.workspaceIds);
  return groups.filter((g) => allowed.has(g.workspaceId));
}

export function isAccountAdmin(authz: Authorization | null | undefined): boolean {
  return authz?.role === "account_admin";
}
