import { createHash } from "node:crypto";
import { appAdminsTable, db } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

import {
  getDirectory,
  buildCanonicalAccountDirectory,
  buildCanonicalEffectiveTeams,
  type EnterpriseGroup,
} from "./enterprise";
import {
  getConfigurationSnapshot,
  type ConfigurationSnapshot,
} from "./configuration-snapshot";
import { logger } from "./logger";

export type AuthzRole = "account" | "workspace_admin" | "team_admin" | "member";
export type Capability =
  | "canViewAccountUsage"
  | "canManageAccess"
  | "canEditAllocations"
  | "canManageNotifications"
  | "canManageSystem"
  | "canPreviewRoles"
  | "canWriteGroupLimits"
  | "canRunChecks"
  | "canSendTestEmail";

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
  /** Groups for which the caller has managerial, rather than self-only, scope. */
  managedGroupIds?: string[];
  /** Qualified visibility used to avoid cross-group Cartesian expansion. */
  groupUserIds?: Record<string, string[]>;
  isTrueAccountAdmin: boolean;
  capabilities: {
    canViewAccountUsage: boolean;
    canManageAccess: boolean;
    canEditAllocations: boolean;
    canManageNotifications: boolean;
    canManageSystem: boolean;
    canPreviewRoles: boolean;
    canWriteGroupLimits: boolean;
    canRunChecks: boolean;
    canSendTestEmail: boolean;
    canWriteUserLimitsIn: string[];
  };
  isPreview?: boolean;
}

function canonicalAuthorizationValue(value: unknown): unknown {
  if (value === undefined) return { $authorizationUndefined: true };
  if (Array.isArray(value)) {
    return value
      .map(canonicalAuthorizationValue)
      .sort((left, right) => {
        const leftJson = JSON.stringify(left);
        const rightJson = JSON.stringify(right);
        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
      });
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalAuthorizationValue(child)]),
    );
  }
  return value;
}

function revisionAuthorization(authz: Authorization) {
  const scope = scopeFor(authz);
  return {
    role: authz.role,
    roles: authz.roles,
    userId: authz.userId,
    workspaceIds: authz.workspaceIds,
    teamNames: authz.teamNames,
    groupIds: authz.groupIds,
    userIds: authz.userIds,
    // Keep explicit-empty distinct from the legacy/default form. The effective
    // scope below additionally records what enforcement actually uses.
    managedGroupIds: authz.managedGroupIds,
    groupUserIds: authz.groupUserIds,
    isTrueAccountAdmin: authz.isTrueAccountAdmin,
    capabilities: authz.capabilities,
    isPreview: authz.isPreview,
    effectiveScope: "kind" in scope
      ? scope
      : {
          groupIds: [...scope.groupIds],
          workspaceIds: [...scope.workspaceIds],
          teamNames: [...scope.teamNames],
          userIds: [...scope.userIds],
          managedGroupIds: [...scope.managedGroupIds],
          groupUserIds: Object.fromEntries(
            [...scope.groupUserIds].map(([groupId, ids]) => [
              groupId,
              [...ids],
            ]),
          ),
        },
  };
}

/**
 * Opaque fingerprint of every authorization input that can affect the
 * authenticated response or server enforcement.
 */
export function authorizationRevision(
  effective: Authorization,
  real: Authorization = effective,
): string {
  const payload = {
    version: 1,
    effective: revisionAuthorization(effective),
    // Preview responses retain the real identity's preview capability. Include
    // its complete authorization so changes cannot leave a stale preview view.
    previewAuthority: effective.isPreview === true
      ? revisionAuthorization(real)
      : null,
  };
  const canonical = JSON.stringify(canonicalAuthorizationValue(payload));
  return createHash("sha256").update(canonical).digest("hex");
}

export type AuthorizationScope =
  | { kind: "all" }
  | {
      groupIds: Set<string>;
      workspaceIds: Set<string>;
      teamNames: Set<string>;
      userIds: Set<string>;
      managedGroupIds: Set<string>;
      groupUserIds: ReadonlyMap<string, ReadonlySet<string>>;
    };

export type AuthorizationResolver = (
  userId: string,
  configuration?: ConfigurationSnapshot,
) => Promise<Authorization | null>;
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

export function resolveCurrentAuthorization(
  userId: string,
  configuration?: ConfigurationSnapshot,
): Promise<Authorization | null> {
  return (injectedResolver ?? resolveAuthorization)(userId, configuration);
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getBootstrapAccountAdminEmail(): string | null {
  const configured = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!configured) return null;
  const normalized = normalizeEmail(configured);
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

const SEED_ADMIN_EMAIL_PREFIX = "seed-admin:";

/** Configured seed app-admin user IDs from `APP_ADMIN_USER_IDS` (comma-separated). */
export function getSeedAppAdminUserIds(): string[] {
  const configured = process.env.APP_ADMIN_USER_IDS ?? "";
  return [...new Set(
    configured
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^[A-Za-z0-9_-]+$/.test(value)),
  )];
}

/** Placeholder email that marks a row as seeded from `APP_ADMIN_USER_IDS`. */
export function seedAppAdminEmail(userId: string): string {
  return `${SEED_ADMIN_EMAIL_PREFIX}${userId}`;
}

/**
 * Insert configured seed IDs into the allowlist when no row exists for them.
 * Existing rows (including revoked ones) are left untouched so that an
 * explicit revocation by a true account admin survives restarts.
 */
export async function seedAppAdmins(): Promise<string[]> {
  const userIds = getSeedAppAdminUserIds();
  if (userIds.length === 0) return [];
  const inserted = await db
    .insert(appAdminsTable)
    .values(userIds.map((userId) => ({
      userId,
      email: seedAppAdminEmail(userId),
      createdBy: null,
    })))
    .onConflictDoNothing({ target: appAdminsTable.userId })
    .returning({ userId: appAdminsTable.userId });
  return inserted.map((row) => row.userId);
}

async function isPersistedBootstrapAccountAdmin(userId: string): Promise<boolean> {
  const bootstrapEmail = getBootstrapAccountAdminEmail();
  const isSeed = getSeedAppAdminUserIds().includes(userId);
  if (!bootstrapEmail && !isSeed) return false;
  const [row] = await db
    .select({
      email: appAdminsTable.email,
      createdBy: appAdminsTable.createdBy,
      revokedAt: appAdminsTable.revokedAt,
    })
    .from(appAdminsTable)
    .where(eq(appAdminsTable.userId, userId))
    .limit(1);
  if (!row || row.createdBy !== null || row.revokedAt !== null) return false;
  if (isSeed && row.email === seedAppAdminEmail(userId)) return true;
  return bootstrapEmail !== null && normalizeEmail(row.email) === bootstrapEmail;
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

  const isBootstrapIdentity = row.createdBy === null;
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

export function buildAuthorization(input: {
  userId: string;
  roles: AuthzRole[];
  workspaceIds?: Iterable<string>;
  teamNames?: Iterable<string>;
  groupIds?: Iterable<string>;
  userIds?: Iterable<string>;
  managedGroupIds?: Iterable<string>;
  groupUserIds?: ReadonlyMap<string, Iterable<string>>;
  allWorkspaceIds?: Iterable<string>;
  isTrueAccountAdmin?: boolean;
  canPreviewRoles?: boolean;
  isPreview?: boolean;
}): Authorization {
  const roles = unique(input.roles) as AuthzRole[];
  const account = roles.includes("account");
  const workspaceIds = unique(input.workspaceIds ?? []);
  const trueAdmin = input.isTrueAccountAdmin === true;
  const preview = input.isPreview === true;
  const accountWideViewer = account;
  const mutationAllowed = !preview;
  return {
    role: highestRole(roles),
    roles,
    userId: input.userId,
    workspaceIds,
    teamNames: unique(input.teamNames ?? []),
    groupIds: unique(input.groupIds ?? []),
    userIds: unique(input.userIds ?? []),
    managedGroupIds: unique(input.managedGroupIds ?? []),
    groupUserIds: input.groupUserIds
      ? Object.fromEntries([...input.groupUserIds].map(([groupId, ids]) => [
          groupId,
          unique(ids),
        ]))
      : undefined,
    isTrueAccountAdmin: trueAdmin,
    capabilities: {
      canViewAccountUsage: accountWideViewer,
      canManageAccess: mutationAllowed && trueAdmin,
      canEditAllocations: mutationAllowed && account,
      canManageNotifications: mutationAllowed && trueAdmin,
      canManageSystem: mutationAllowed && trueAdmin,
      canPreviewRoles: !preview && input.canPreviewRoles === true,
      canWriteGroupLimits: mutationAllowed && trueAdmin,
      canRunChecks: mutationAllowed && trueAdmin,
      canSendTestEmail: mutationAllowed && trueAdmin,
      canWriteUserLimitsIn: !mutationAllowed
        ? []
        : trueAdmin
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
  configuration?: ConfigurationSnapshot,
): Promise<Authorization | null> {
  const dir = await getDirectory().catch((error) => {
    throw asAuthorizationUnavailable(error, "directory");
  });
  const snapshot = configuration ?? await getConfigurationSnapshot().catch(
    (error) => {
      throw asAuthorizationUnavailable(error, "authorization");
    },
  );
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

  const account = buildCanonicalAccountDirectory({
    workspaces: dir.workspaces,
    groups: dir.groups,
    groupMembers: dir.groupMembers,
    members: dir.members,
    mappings: snapshot.familyTeamMappings,
  });
  const targets = snapshot.teamLimitTargets;
  const families = [...account.familiesById.values()];
  const effectiveTeams = buildCanonicalEffectiveTeams(account, targets);
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
  const managedGroupIds = new Set<string>();
  const groupUserIds = new Map<string, Set<string>>();

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
    const family = account.familiesById.get(familyId);
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
      const activeInFamilyWorkspace =
        member.workspaces.get(family.workspaceId)?.isDisabled === false;
      if (effectiveTeam && activeInFamilyWorkspace && admins?.members.has(userId)) {
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
    const roleGroup = account.roleGroupsById.get(group.id);
    const teamVisible =
      !!roleGroup && adminFamilyIds.has(roleGroup.familyId);
    const selfVisible =
      (!forceRole || forceRole === "member") &&
      member?.workspaces.get(group.workspaceId)?.isDisabled === false &&
      (dir.groupMembers.get(group.id) ?? []).includes(userId);
    const visible =
      workspaceIds.has(group.workspaceId) ||
      teamVisible ||
      selfVisible;
    if (visible) {
      groupIds.add(group.id);
      const qualifiedUsers = groupUserIds.get(group.id) ?? new Set<string>();
      if (workspaceIds.has(group.workspaceId) || teamVisible) {
        managedGroupIds.add(group.id);
        for (const id of dir.groupMembers.get(group.id) ?? []) {
          userIds.add(id);
          qualifiedUsers.add(id);
        }
      } else if (selfVisible) {
        qualifiedUsers.add(userId);
      }
      groupUserIds.set(group.id, qualifiedUsers);
    }
  }

  return buildAuthorization({
    userId,
    roles,
    workspaceIds,
    teamNames,
    groupIds,
    userIds,
    managedGroupIds,
    groupUserIds,
    allWorkspaceIds,
    isTrueAccountAdmin: trueAdmin,
    canPreviewRoles: isBootstrapAccountAdmin,
    isPreview: !!forceRole,
  });
}

export async function resolveAuthorization(
  userId: string,
  configuration?: ConfigurationSnapshot,
): Promise<Authorization | null> {
  const authz = await resolveFromDirectory(
    userId, undefined, undefined, configuration);
  if (!authz) {
    logger.warn({ userId }, "authorization denied: user is not an active directory member");
  }
  return authz;
}

export async function resolvePreviewAuthorization(
  real: Authorization,
  header: unknown,
  configuration?: ConfigurationSnapshot,
): Promise<Authorization> {
  if (!real.capabilities.canPreviewRoles || header == null) return real;
  if (typeof header !== "string") throw new InvalidPreviewError();
  const separator = header.indexOf(":");
  if (separator < 1) throw new InvalidPreviewError();
  const role = header.slice(0, separator);
  const value = header.slice(separator + 1).trim();
  if (!value || !["workspace_admin", "team_admin", "member"].includes(role)) {
    throw new InvalidPreviewError();
  }
  if (role === "member") {
    const preview = await resolveFromDirectory(
      value, "member", value, configuration);
    if (!preview) throw new InvalidPreviewError();
    return preview;
  }
  const preview = await resolveFromDirectory(
    real.userId,
    role as "workspace_admin" | "team_admin",
    value,
    configuration,
  );
  if (!preview) throw new InvalidPreviewError();
  return preview;
}

export class InvalidPreviewError extends Error {
  constructor() {
    super("Preview target is invalid or no longer available");
    this.name = "InvalidPreviewError";
  }
}

export function scopeFor(authz: Authorization): AuthorizationScope {
  if (authz.roles.includes("account")) return { kind: "all" };
  return {
    groupIds: new Set(authz.groupIds),
    workspaceIds: new Set(authz.workspaceIds),
    teamNames: new Set(authz.teamNames),
    userIds: new Set(authz.userIds),
    managedGroupIds: new Set(authz.managedGroupIds ?? (
      authz.roles.some((role) => role === "workspace_admin" || role === "team_admin")
        ? authz.groupIds
        : []
    )),
    groupUserIds: new Map(
      Object.entries(authz.groupUserIds ?? {}).map(([groupId, ids]) => [
        groupId,
        new Set(ids),
      ]),
    ),
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
  if (typeof claims.sub === "string" && getSeedAppAdminUserIds().includes(claims.sub)) {
    await seedAppAdmins();
  }
  const bootstrapEmail = getBootstrapAccountAdminEmail();
  if (!bootstrapEmail) return false;
  if (claims.email_verified !== true) return false;
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return false;
  if (normalizeEmail(claims.email) !== bootstrapEmail) return false;

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
    (row) => normalizeEmail(row.email) === bootstrapEmail,
  );
  if (
    designatedRows.some((row) => row.userId !== claims.sub) ||
    designatedRows.some((row) => row.revokedAt !== null)
  ) {
    return false;
  }

  await db.insert(appAdminsTable).values({
    userId: claims.sub,
    email: bootstrapEmail,
    createdBy: null,
  }).onConflictDoNothing();
  return isPersistedBootstrapAccountAdmin(claims.sub);
}