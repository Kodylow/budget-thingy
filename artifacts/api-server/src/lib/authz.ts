import { appAdminsTable, db, teamLimitTargetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  getDirectory,
  isCustomGroup,
  type EnterpriseGroup,
} from "./enterprise";
import { logger } from "./logger";

export type AuthzRole = "account" | "workspace_admin" | "team_admin" | "member";
export type Capability =
  | "canManageAccess"
  | "canEditAllocations"
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
    .where(eq(appAdminsTable.userId, userId))
    .limit(1);
  return !!row;
}

async function lookupAppAdmin(userId: string): Promise<boolean> {
  return injectedAppAdminLookup
    ? injectedAppAdminLookup(userId)
    : isPersistedAppAdmin(userId);
}

const ADMIN_ROLES = new Set(["admin", "owner", "account_admin"]);
const TEAM_ADMIN_SUFFIX = /\s*-\s*admins?\s*$/i;
const TEAM_MEMBER_SUFFIX = /\s*-\s*members?\s*$/i;

export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.has(role.trim().toLowerCase());
}

function familyName(name: string): string {
  return name.replace(TEAM_ADMIN_SUFFIX, "").replace(TEAM_MEMBER_SUFFIX, "").trim();
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
  const dir = await getDirectory();
  const member = dir.members.get(userId);
  if (!member && !forceRole) return null;

  const targets = await db.select().from(teamLimitTargetsTable);
  if (
    (forceRole === "workspace_admin" && !dir.workspaces.has(forceValue!)) ||
    (forceRole === "team_admin" &&
      !targets.some((target) => target.teamName === forceValue)) ||
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

  const isAllowlisted = !forceRole && member ? await lookupAppAdmin(userId) : false;
  const trueAdmin = !forceRole && member?.isAccountAdmin === true;
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

  const adminFamilies = new Set<string>();
  if (forceRole === "team_admin") {
    teamNames.add(forceValue!);
    roles.push("team_admin");
  } else if (!forceRole && member) {
    for (const group of dir.groups) {
      if (
        isCustomGroup(group) &&
        TEAM_ADMIN_SUFFIX.test(group.name) &&
        (dir.groupMembers.get(group.id) ?? []).includes(userId)
      ) {
        adminFamilies.add(familyName(group.name).toLowerCase());
      }
    }
    for (const target of targets) {
      if (
        adminFamilies.has(target.teamName.toLowerCase()) ||
        adminFamilies.has(familyName(target.groupName).toLowerCase())
      ) {
        teamNames.add(target.teamName);
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
    const targetTeams = targets
      .filter((target) =>
        (target.workspaceId === group.workspaceId && target.groupId === group.id) ||
        (familyName(target.groupName).toLowerCase() === familyName(group.name).toLowerCase())
      )
      .map((target) => target.teamName);
    const teamVisible =
      targetTeams.some((team) => teamNames.has(team)) &&
      (TEAM_MEMBER_SUFFIX.test(group.name) ||
        targets.some((target) => target.groupId === group.id));
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
  if (!real.roles.includes("account") || typeof header !== "string") return real;
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
  const configured = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!configured || claims.email_verified !== true) return false;
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return false;
  if (normalizeEmail(claims.email) !== normalizeEmail(configured)) return false;
  await db.insert(appAdminsTable).values({
    userId: claims.sub,
    email: claims.email,
    createdBy: null,
  }).onConflictDoNothing({ target: appAdminsTable.userId });
  return true;
}