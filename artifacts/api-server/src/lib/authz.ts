import {
  db,
  editorAllowlistTable,
  editorBootstrapStateTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import { getDirectory, type EnterpriseGroup } from "./enterprise";
import { logger } from "./logger";

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
 * Injectable lookup for the managed editor allowlist. Returns `true` when the
 * given stable Replit user ID is a persisted account-wide editor. Production
 * uses {@link isPersistedEditor} (a real DB query); tests inject an in-memory
 * fixture via {@link setEditorAllowlistLookup} so pure authorization tests do
 * not require a database. The default always queries the real table.
 */
export type PersistedEditorRole = "account_editor" | "account_delegate";
export type EditorAllowlistLookup = (
  userId: string,
) => Promise<boolean | PersistedEditorRole>;

let injectedEditorLookup: EditorAllowlistLookup | null = null;

/** Override the editor-allowlist lookup (test-only). */
export function setEditorAllowlistLookup(
  fn: EditorAllowlistLookup | null,
): void {
  injectedEditorLookup = fn;
}

/**
 * Whether the given stable Replit user ID is present in the persisted editor
 * allowlist. This is the production default for {@link EditorAllowlistLookup}.
 */
export async function getPersistedEditorRole(
  userId: string,
): Promise<PersistedEditorRole | null> {
  const [row] = await db
    .select({
      userId: editorAllowlistTable.userId,
      email: editorAllowlistTable.email,
    })
    .from(editorAllowlistTable)
    .where(eq(editorAllowlistTable.userId, userId))
    .limit(1);
  if (!row) return null;

  const [bootstrap] = await db
    .select({
      userId: editorBootstrapStateTable.userId,
      email: editorBootstrapStateTable.email,
      revokedAt: editorBootstrapStateTable.revokedAt,
    })
    .from(editorBootstrapStateTable)
    .where(eq(editorBootstrapStateTable.userId, userId))
    .limit(1);
  return bootstrap &&
    bootstrap.revokedAt === null &&
    normalizeEmail(bootstrap.email) === BOOTSTRAP_EDITOR_EMAIL
    ? "account_delegate"
    : "account_editor";
}

export async function isPersistedEditor(userId: string): Promise<boolean> {
  return (await getPersistedEditorRole(userId)) !== null;
}

async function lookupEditor(userId: string): Promise<PersistedEditorRole | null> {
  if (!injectedEditorLookup) return getPersistedEditorRole(userId);
  const result = await injectedEditorLookup(userId);
  if (result === true) return "account_editor";
  if (result === false) return null;
  return result;
}

/**
 * Resolved authorization for a signed-in user.
 *
 * - `account_admin`: full account-wide access derived from the Enterprise
 *   directory. `workspaceIds` is empty and MUST be ignored — an account admin
 *   can see every workspace/group.
 * - `account_delegate`: full application-admin parity granted only to the
 *   verified designated bootstrap identity and persisted by stable user ID.
 * - `account_editor`: full account-wide operational access granted by the managed app
 *   allowlist (keyed by stable Replit identity), independent of the member's
 *   Enterprise role. `workspaceIds` is empty and MUST be ignored.
 * - `workspace_admin`: read-only access limited to the union of workspaces the
 *   member is an *enabled admin* of. `workspaceIds` is that union.
 *
 * When the user is neither an account admin, a persisted editor, nor an enabled
 * workspace admin, resolution fails closed and returns `null` (access denied).
 */
export type AuthzRole =
  | "account_admin"
  | "account_delegate"
  | "account_editor"
  | "workspace_admin";

export interface Authorization {
  role: AuthzRole;
  /** Only meaningful for workspace_admin; the union of admin workspaces. */
  workspaceIds: string[];
}

/** A workspace role counts as admin only for these values. */
const ADMIN_ROLES = new Set(["admin", "owner", "account_admin"]);

export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.has(role.trim().toLowerCase());
}

/**
 * The designated bootstrap editor. This account is granted account-wide editor
 * access on first verified sign-in so the allowlist is never empty. It is only
 * ever matched on a verified, exact-normalized email.
 */
export const BOOTSTRAP_EDITOR_EMAIL = "kody.low@repl.it";

/** Normalize an email for exact comparison (trim + lowercase). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Resolve the authorization for the given stable Replit user ID.
 *
 * Precedence (fail-closed):
 * 1. True Enterprise account admins get account-wide `account_admin` access.
 * 2. Persisted editors get account-wide `account_editor` access even if they
 *    are ordinary members or absent from the Enterprise directory.
 * 3. Otherwise the union of workspaces where the member's role is admin AND the
 *    membership is not disabled -> `workspace_admin`. Empty union -> null.
 * 4. Unknown / unresolved identity -> null.
 */
export async function resolveAuthorization(
  userId: string,
): Promise<Authorization | null> {
  const dir = await getDirectory();
  const member = dir.members.get(userId);

  // (1) True Enterprise account admins always take precedence.
  if (member?.isAccountAdmin) {
    return { role: "account_admin", workspaceIds: [] };
  }

  // (2) Persisted app editors get account-wide access regardless of their
  // Enterprise role (including ordinary members and non-directory users).
  const persistedRole = await lookupEditor(userId);
  if (persistedRole) {
    return { role: persistedRole, workspaceIds: [] };
  }

  // (3)/(4) All others fall back to Enterprise-derived workspace scope.
  if (!member) {
    logger.warn(
      {
        userId,
        foundInDirectory: false,
        isAccountAdmin: false,
        workspaceMembershipCount: 0,
        adminWorkspaceCount: 0,
        disabledWorkspaceCount: 0,
      },
      "resolveAuthorization: user not found in Enterprise directory — access denied",
    );
    return null;
  }

  const workspaceIds: string[] = [];
  let adminWorkspaceCount = 0;
  let disabledWorkspaceCount = 0;
  for (const [workspaceId, ws] of member.workspaces) {
    if (ws.isDisabled) { disabledWorkspaceCount++; continue; }
    if (isAdminRole(ws.role)) { adminWorkspaceCount++; workspaceIds.push(workspaceId); }
  }

  if (workspaceIds.length === 0) {
    logger.warn(
      {
        userId,
        foundInDirectory: true,
        isAccountAdmin: member.isAccountAdmin,
        workspaceMembershipCount: member.workspaces.size,
        adminWorkspaceCount,
        disabledWorkspaceCount,
      },
      "resolveAuthorization: user has no enabled admin workspace memberships — access denied",
    );
    return null;
  }
  return { role: "workspace_admin", workspaceIds: [...new Set(workspaceIds)] };
}

/** Whether the authorization can see the given workspace. */
export function canSeeWorkspace(authz: Authorization, workspaceId: string): boolean {
  if (isAccountWide(authz)) return true;
  return authz.workspaceIds.includes(workspaceId);
}

/** Whether the authorization can see the given group (by its workspace). */
export function canSeeGroup(authz: Authorization, group: EnterpriseGroup): boolean {
  return canSeeWorkspace(authz, group.workspaceId);
}

/**
 * Filter a list of groups to only those visible under the authorization.
 * Account-wide roles get every group; workspace admins get only in-scope groups.
 */
export function scopeGroups<T extends EnterpriseGroup>(
  authz: Authorization,
  groups: T[],
): T[] {
  if (isAccountWide(authz)) return groups;
  const allowed = new Set(authz.workspaceIds);
  return groups.filter((g) => allowed.has(g.workspaceId));
}

/** Whether the authorization is a true Enterprise account admin. */
export function isAccountAdmin(authz: Authorization | null | undefined): boolean {
  return authz?.role === "account_admin";
}

/** Whether the role may manage all application settings and access. */
export function isApplicationAdmin(
  authz: Authorization | null | undefined,
): boolean {
  return authz?.role === "account_admin" || authz?.role === "account_delegate";
}

/** Whether the authorization is a managed account-wide app editor. */
export function isAccountEditor(authz: Authorization | null | undefined): boolean {
  return authz?.role === "account_editor";
}

/**
 * Whether the authorization has account-wide visibility (either a true account
 * admin or a persisted editor). Account-wide roles see every workspace/group.
 */
export function isAccountWide(authz: Authorization | null | undefined): boolean {
  return (
    authz?.role === "account_admin" ||
    authz?.role === "account_delegate" ||
    authz?.role === "account_editor"
  );
}

/**
 * Bootstrap the designated editor into the persisted allowlist from verified
 * OIDC claims. This is a no-op unless the claims present a *verified* email
 * that exactly matches the designated bootstrap editor. The row is keyed by the
 * stable `sub` claim so the editor keeps access across email/name changes.
 *
 * Returns `true` when the identity remains actively allowlisted after the
 * one-time bootstrap, and `false` when claims do not qualify or an admin has
 * since removed that identity.
 */
export async function maybeBootstrapEditor(claims: {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}): Promise<boolean> {
  if (claims.email_verified !== true) return false;
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") {
    return false;
  }
  if (normalizeEmail(claims.email) !== BOOTSTRAP_EDITOR_EMAIL) return false;

  const userId = claims.sub;
  const email = claims.email;
  return db.transaction(async (tx) => {
    const [consumed] = await tx
      .insert(editorBootstrapStateTable)
      .values({ userId, email, completedBy: null })
      .onConflictDoNothing({ target: editorBootstrapStateTable.userId })
      .returning({ userId: editorBootstrapStateTable.userId });

    if (consumed) {
      await tx
        .insert(editorAllowlistTable)
        .values({ userId, email, createdBy: null })
        .onConflictDoNothing({ target: editorAllowlistTable.userId });
    }

    const [active] = await tx
      .select({ userId: editorAllowlistTable.userId })
      .from(editorAllowlistTable)
      .where(eq(editorAllowlistTable.userId, userId))
      .limit(1);
    return !!active;
  });
}
