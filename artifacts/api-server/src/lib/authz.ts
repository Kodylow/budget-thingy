import { appAdminsTable, db, teamLimitTargetsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

import {
  getDirectory,
  buildCanonicalEffectiveTeams,
  type EnterpriseGroup,
} from "./enterprise";
import { logger } from "./logger";

export type AuthzRole = "account" | "workspace_admin" | "team_admin" | "member";
export type Capability =
  | "canManageAccess"
  | "canEditAllocations"
  | "canPreviewRoles"
  | "canWriteGroupLimits";

export interface Authorization {
  /** Highest role, retained as a convenient display value. */
  role: AuthzRole;
  /** Every role held by this identity. Scopes are always the union of these roles. */
  roles: AuthzRole[];
  userId: string;
  workspaceIds: string[];
  teamNames: string[];
  groupIds: string[];
  userIds: string[];
  isTrueAccountAdmin: boolean;
  capabilities: {
    canManageAccess: boolean;
    canEditAllocations: boolean;
    canPreviewRoles: boolean;
    canWriteGroupLimits: boolean;
    canWriteUserLimitsIn: string[];
  };
  isPreview?: boolean;
}

export type AuthorizationScope =
  | { kind: "all" }
  | {
      groupIds: Set<string>;
      workspaceIds: Set<string>;
      teamNames: Set<string>;
      userIds: Set<string>;
    };

export type AuthorizationResolver = (userId: string) => Promise<Authorization | null>;
export type AppAdminLookup = (userId: string) => Promise<boolean>;

export class AuthorizationUnavailableError extends Error {
  readonly status = 503;

  constructor(
    public readonly source: "directory" | "app_admin" | "authorization",
    options?: { cause?: unknown },
  ) {
    super("Authorization is temporarily unavailable", options);
    this.name = "AuthorizationUnavailableError";
  }
}

export function asAuthorizationUnavailable(
  error: unknown,
  source: AuthorizationUnavailableError["source"],
): AuthorizationUnavailableError {
  return error instanceof AuthorizationUnavailableError
    ? error
    : new AuthorizationUnavailableError(source, { cause: error });
}

let injectedResolver: AuthorizationResolver | null = null;
let injectedAppAdminLookup: AppAdminLookup | null = null;

export function setAuthorizationResolver(fn: AuthorizationResolver | null): void {
  injectedResolver = fn;
}

export function setAppAdminLookup(fn: AppAdminLookup | null): void {
  injectedAppAdminLookup = fn;
}

export function resolveCurrentAuthorization(userId: string): Promise<Authorization | null> {
  return (injectedResolver ?? resolveAuthorization)(userId);
}

export async function isPersistedAppAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: appAdminsTable.userId })
    .from(appAdminsTable)
    .where(and(
      eq(appAdminsTable.userId, userId),
      isNull(appAdminsTable.revokedAt),
    ))
    .limit(1);
  return !!row;
}

export const BOOTSTRAP_ACCOUNT_ADMIN_EMAIL = "kody.low@repl.it";

async function isPersistedBootstrapAccountAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      email: appAdminsTable.email,
      createdBy: appAdminsTable.createdBy,
      revokedAt: appAdminsTable.revokedAt,
    })
    .from(appAdminsTable)
    .where(eq(appAdminsTable.userId, userId))
    .limit(1);
  return row?.createdBy === null &&
    row.revokedAt === null &&
    normalizeEmail(row.email) === BOOTSTRAP_ACCOUNT_ADMIN_EMAIL;
}

export async function revokeAppAdmin(
  userId: string,
  revokedBy: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(appAdminsTable)
    .where(eq(appAdminsTable.userId, userId))
    .limit(1);
  if (!row || row.revokedAt !== null) return false;

  const isBootstrapIdentity =
    row.createdBy === null &&
    normalizeEmail(row.email) === BOOTSTRAP_ACCOUNT_ADMIN_EMAIL;
  if (isBootstrapIdentity) {
    await db
      .update(appAdminsTable)
      .set({ revokedAt: new Date(), revokedBy })
      .where(eq(appAdminsTable.userId, userId));
  } else {
    await db
      .delete(appAdminsTable)
      .where(eq(appAdminsTable.userId, userId));
  }
  return true;
}

async function lookupAppAdmin(userId: string): Promise<boolean> {
  return injectedAppAdminLookup
    ? injectedAppAdminLookup(userId)
    : isPersistedAppAdmin(userId);
}

const ADMIN_ROLES = new Set(["admin", "owner", "account_admin"]);

export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.has(role.trim().toLowerCase());
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function highestRole(roles: AuthzRole[]): AuthzRole {
  return (["account", "workspace_admin", "team_admin", "member"] as const)
    .find((role) => roles.includes(role)) ?? "member";
}

function buildAuthorization(input: {
  userId: string;
  roles: AuthzRole[];
  workspaceIds?: Iterable<string>;
  teamNames?: Iterable<string>;
  groupIds?: Iterable<string>;
  userIds?: Iterable<string>;
  allWorkspaceIds?: Iterable<string>;
  isTrueAccountAdmin?: boolean;
  canPreviewRoles?: boolean;
  isPreview?: boolean;
}): Authorization {
  const roles = unique(input.roles) as AuthzRole[];
  const account = roles.includes("account");
  const workspaceIds = unique(input.workspaceIds ?? []);
  return {
    role: highestRole(roles),
    roles,
    userId: input.userId,
    workspaceIds,
    teamNames: unique(input.teamNames ?? []),
    groupIds: unique(input.groupIds ?? []),
    userIds: unique(input.userIds ?? []),
    isTrueAccountAdmin: input.isTrueAccountAdmin === true,
    capabilities: {
      canManageAccess: account,
      canEditAllocations: account,
      canPreviewRoles: input.canPreviewRoles === true,
      canWriteGroupLimits: input.isTrueAccountAdmin === true,
      canWriteUserLimitsIn: account
        ? unique(input.allWorkspaceIds ?? [])
        : roles.includes("workspace_admin")
          ? workspaceIds
          : [],
    },
    isPreview: input.isPreview,
  };
}

async function resolveFromDirectory(
  userId: string,
  forceRole?: Exclude<AuthzRole, "account">,
  forceValue?: string,
): Promise<Authorization | null> {
  const dir = await getDirectory().catch((error) => {
    throw asAuthorizationUnavailable(error, "directory");
  });
  const member = dir.members.get(userId);
  const isAllowlisted = !forceRole
    ? await lookupAppAdmin(userId).catch((error) => {
        throw asAuthorizationUnavailable(error, "app_admin");
      })
    : false;
  const isBootstrapAccountAdmin = !forceRole && isAllowlisted
    ? await isPersistedBootstrapAccountAdmin(userId).catch((error) => {
        throw asAuthorizationUnavailable(error, "app_admin");
      })
    : false;
  if (!member && !forceRole && !isAllowlisted) return null;

  const targets = await db.select().from(teamLimitTargetsTable);
  const families = [...dir.account.familiesById.values()];
  const effectiveTeams = buildCanonicalEffectiveTeams(dir.account, targets);
  const forcedTeamFamilies = forceRole === "team_admin"
    ? families.filter((family) =>
        !family.isLegacy &&
        effectiveTeams.byFamilyId.get(family.id) === forceValue &&
        (family.name.toLowerCase() === forceValue!.toLowerCase() ||
          family.key === forceValue!.toLowerCase())
      )
    : [];
  if (forceRole === "team_admin" && forcedTeamFamilies.length === 0) {
    const sameTeam = families.filter((family) =>
      !family.isLegacy && effectiveTeams.byFamilyId.get(family.id) === forceValue
    );
    if (sameTeam.length === 1) forcedTeamFamilies.push(sameTeam[0]!);
  }
  if (
    (forceRole === "workspace_admin" && !dir.workspaces.has(forceValue!)) ||
    (forceRole === "team_admin" && forcedTeamFamilies.length !== 1) ||
    (forceRole === "member" &&
      (!member ||
        ![...member.workspaces.values()].some((membership) => !membership.isDisabled)))
  ) {
    return null;
  }
  const allWorkspaceIds = dir.workspaces.keys();
  const roles: AuthzRole[] = [];
  const workspaceIds = new Set<string>();
  const teamNames = new Set<string>();
  const groupIds = new Set<string>();
  const userIds = new Set<string>([userId]);

  const trueAdmin = !forceRole &&
    (member?.isAccountAdmin === true || isBootstrapAccountAdmin);
  const isActiveMember = member
    ? [...member.workspaces.values()].some((membership) => !membership.isDisabled)
    : false;
  if (!forceRole && !trueAdmin && !isAllowlisted && !isActiveMember) return null;
  if (trueAdmin || isAllowlisted) roles.push("account");

  if (forceRole === "workspace_admin") {
    workspaceIds.add(forceValue!);
    roles.push("workspace_admin");
  } else if (!forceRole && member) {
    for (const [workspaceId, membership] of member.workspaces) {
      if (!membership.isDisabled && isAdminRole(membership.role)) {
        workspaceIds.add(workspaceId);
      }
    }
    if (workspaceIds.size) roles.push("workspace_admin");
  }

  const adminFamilyIds = new Set<string>();
  const includeLegacySibling = (familyId: string): void => {
    const family = dir.account.familiesById.get(familyId);
    if (!family || family.isLegacy) return;
    const siblingTeams = new Set(
      families
        .filter((candidate) => !candidate.isLegacy && candidate.key === family.key)
        .flatMap((candidate) => {
          const team = effectiveTeams.byFamilyId.get(candidate.id);
          return team ? [team] : [];
        }),
    );
    if (siblingTeams.size !== 1) return;
    const team = effectiveTeams.byFamilyId.get(family.id);
    for (const legacy of families) {
      if (
        legacy.isLegacy &&
        legacy.key === family.key &&
        effectiveTeams.byFamilyId.get(legacy.id) === team
      ) {
        adminFamilyIds.add(legacy.id);
      }
    }
  };
  if (forceRole === "team_admin") {
    for (const family of forcedTeamFamilies) {
      const effectiveTeam = effectiveTeams.byFamilyId.get(family.id)!;
      adminFamilyIds.add(family.id);
      includeLegacySibling(family.id);
      teamNames.add(effectiveTeam);
    }
    roles.push("team_admin");
  } else if (!forceRole && member) {
    for (const family of families) {
      const admins = family.roleGroups.get("admin");
      const effectiveTeam = effectiveTeams.byFamilyId.get(family.id);
      if (effectiveTeam && admins?.members.has(userId)) {
        adminFamilyIds.add(family.id);
        includeLegacySibling(family.id);
        teamNames.add(effectiveTeam);
      }
    }
    if (teamNames.size) roles.push("team_admin");
  }

  if (forceRole === "member") roles.push("member");
  if (!roles.length && member) {
    const active = [...member.workspaces.values()].some((membership) => !membership.isDisabled);
    if (!active) return null;
    roles.push("member");
  }

  for (const group of dir.groups) {
    const roleGroup = dir.account.roleGroupsById.get(group.id);
    const teamVisible =
      !!roleGroup && adminFamilyIds.has(roleGroup.familyId);
    const selfVisible =
      (!forceRole || forceRole === "member") &&
      (dir.groupMembers.get(group.id) ?? []).includes(userId);
    const visible =
      workspaceIds.has(group.workspaceId) ||
      teamVisible ||
      selfVisible;
    if (visible) {
      groupIds.add(group.id);
      if (workspaceIds.has(group.workspaceId) || teamVisible) {
        for (const id of dir.groupMembers.get(group.id) ?? []) userIds.add(id);
      }
    }
  }

  return buildAuthorization({
    userId,
    roles,
    workspaceIds,
    teamNames,
    groupIds,
    userIds,
    allWorkspaceIds,
    isTrueAccountAdmin: trueAdmin,
    canPreviewRoles: isBootstrapAccountAdmin,
    isPreview: !!forceRole,
  });
}

export async function resolveAuthorization(userId: string): Promise<Authorization | null> {
  const authz = await resolveFromDirectory(userId);
  if (!authz) {
    logger.warn({ userId }, "authorization denied: user is not an active directory member");
  }
  return authz;
}

export async function resolvePreviewAuthorization(
  real: Authorization,
  header: unknown,
): Promise<Authorization> {
  if (!real.capabilities.canPreviewRoles || typeof header !== "string") return real;
  const separator = header.indexOf(":");
  if (separator < 1) return real;
  const role = header.slice(0, separator);
  const value = header.slice(separator + 1).trim();
  if (!value || !["workspace_admin", "team_admin", "member"].includes(role)) return real;
  if (role === "member") {
    const preview = await resolveFromDirectory(value, "member", value);
    return preview ?? real;
  }
  const preview = await resolveFromDirectory(
    real.userId,
    role as "workspace_admin" | "team_admin",
    value,
  );
  return preview ?? real;
}

export function scopeFor(authz: Authorization): AuthorizationScope {
  if (authz.roles.includes("account")) return { kind: "all" };
  return {
    groupIds: new Set(authz.groupIds),
    workspaceIds: new Set(authz.workspaceIds),
    teamNames: new Set(authz.teamNames),
    userIds: new Set(authz.userIds),
  };
}

export function hasRole(authz: Authorization | null | undefined, role: AuthzRole): boolean {
  return authz?.roles.includes(role) === true;
}

export function hasCapability(
  authz: Authorization | null | undefined,
  capability: Capability,
): boolean {
  return authz?.capabilities[capability] === true;
}

export function canSeeWorkspace(authz: Authorization, workspaceId: string): boolean {
  const scope = scopeFor(authz);
  return "kind" in scope || scope.workspaceIds.has(workspaceId);
}

export function canSeeGroup(authz: Authorization, group: EnterpriseGroup): boolean {
  const scope = scopeFor(authz);
  return "kind" in scope || scope.groupIds.has(group.id);
}

export function scopeGroups<T extends EnterpriseGroup>(authz: Authorization, groups: T[]): T[] {
  const scope = scopeFor(authz);
  return "kind" in scope ? groups : groups.filter((group) => scope.groupIds.has(group.id));
}

export function isAccountWide(authz: Authorization | null | undefined): boolean {
  return hasRole(authz, "account");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function maybeBootstrapAppAdmin(claims: {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}): Promise<boolean> {
  if (claims.email_verified !== true) return false;
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return false;
  if (normalizeEmail(claims.email) !== BOOTSTRAP_ACCOUNT_ADMIN_EMAIL) return false;

  const bootstrapRows = await db
    .select({
      userId: appAdminsTable.userId,
      email: appAdminsTable.email,
      createdBy: appAdminsTable.createdBy,
      revokedAt: appAdminsTable.revokedAt,
    })
    .from(appAdminsTable)
    .where(isNull(appAdminsTable.createdBy));
  const designatedRows = bootstrapRows.filter(
    (row) => normalizeEmail(row.email) === BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
  );
  if (
    designatedRows.some((row) => row.userId !== claims.sub) ||
    designatedRows.some((row) => row.revokedAt !== null)
  ) {
    return false;
  }

  await db.insert(appAdminsTable).values({
    userId: claims.sub,
    email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
    createdBy: null,
  }).onConflictDoNothing();
  return isPersistedBootstrapAccountAdmin(claims.sub);
}