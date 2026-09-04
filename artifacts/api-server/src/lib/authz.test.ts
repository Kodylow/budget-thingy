import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appAdminsTable, db } from "@workspace/db";
import { inArray } from "drizzle-orm";

import {
  BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
  canSeeGroup,
  canSeeWorkspace,
  isPersistedAppAdmin,
  maybeBootstrapAppAdmin,
  normalizeEmail,
  revokeAppAdmin,
  resolveAuthorization,
  resolvePreviewAuthorization,
  scopeFor,
  scopeGroups,
  type Authorization,
  type AuthzRole,
} from "./authz";
import { __setDirectoryCacheForTests } from "./enterprise";
import { requireTrueAccountAdmin } from "../middlewares/requireAuth";

function authz(
  roles: AuthzRole[],
  values: Partial<Pick<Authorization, "workspaceIds" | "teamNames" | "groupIds" | "userIds">> = {},
): Authorization {
  const account = roles.includes("account");
  return {
    role: roles[0]!,
    roles,
    userId: "user",
    workspaceIds: values.workspaceIds ?? [],
    teamNames: values.teamNames ?? [],
    groupIds: values.groupIds ?? [],
    userIds: values.userIds ?? ["user"],
    isTrueAccountAdmin: account,
    capabilities: {
      canManageAccess: account,
      canEditAllocations: account,
      canPreviewRoles: false,
      canWriteGroupLimits: account,
      canWriteUserLimitsIn: values.workspaceIds ?? [],
    },
  };
}

describe("authorization scopes", () => {
  it("returns all for account access", () => {
    expect(scopeFor(authz(["account"]))).toEqual({ kind: "all" });
  });

  it("preserves the union of scoped identifiers", () => {
    const scope = scopeFor(authz(
      ["workspace_admin", "team_admin"],
      {
        workspaceIds: ["growth"],
        teamNames: ["Growth MDU"],
        groupIds: ["growth-members", "legacy-growth-members"],
        userIds: ["one", "two"],
      },
    ));
    expect(scope).toEqual({
      workspaceIds: new Set(["growth"]),
      teamNames: new Set(["Growth MDU"]),
      groupIds: new Set(["growth-members", "legacy-growth-members"]),
      userIds: new Set(["one", "two"]),
    });
  });

  it("filters groups by explicit group scope, not workspace inference", () => {
    const groups = [
      { id: "visible", workspaceId: "growth", name: "Visible", type: "custom" },
      { id: "hidden", workspaceId: "growth", name: "Hidden", type: "custom" },
    ];
    const authorization = authz(["member"], { groupIds: ["visible"] });
    expect(scopeGroups(authorization, groups).map((group) => group.id)).toEqual(["visible"]);
    expect(canSeeGroup(authorization, groups[0]!)).toBe(true);
    expect(canSeeGroup(authorization, groups[1]!)).toBe(false);
    expect(canSeeWorkspace(authorization, "growth")).toBe(false);
  });

  it("normalizes bootstrap email matching", () => {
    expect(normalizeEmail("  Admin@Example.COM ")).toBe("admin@example.com");
  });
});

const BOOTSTRAP_USER_ID = "authz-bootstrap-kody";
const OTHER_USER_ID = "authz-bootstrap-other";
const WORKSPACE_IDS = ["authz-bootstrap-workspace-a", "authz-bootstrap-workspace-b"];

function directoryMember(userId: string) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.test`,
    name: userId,
    isAccountAdmin: false,
    isInternalReplitUser: false,
    workspaces: new Map([
      [WORKSPACE_IDS[0], { role: "admin", isDisabled: false }],
      [WORKSPACE_IDS[1], { role: "admin", isDisabled: false }],
    ]),
  };
}

describe("designated account-admin bootstrap", () => {
  beforeEach(async () => {
    await db
      .delete(appAdminsTable)
      .where(inArray(appAdminsTable.userId, [BOOTSTRAP_USER_ID, OTHER_USER_ID]));
    __setDirectoryCacheForTests({
      workspaces: new Map(WORKSPACE_IDS.map((id) => [
        id,
        { id, name: id, slug: id, memberCount: 2 },
      ])),
      groups: [],
      groupMembers: new Map(),
      members: new Map([
        [BOOTSTRAP_USER_ID, directoryMember(BOOTSTRAP_USER_ID)],
        [OTHER_USER_ID, directoryMember(OTHER_USER_ID)],
      ]),
    });
  });

  afterEach(async () => {
    __setDirectoryCacheForTests(null);
    await db
      .delete(appAdminsTable)
      .where(inArray(appAdminsTable.userId, [BOOTSTRAP_USER_ID, OTHER_USER_ID]));
  });

  it("restores the exact normalized verified identity after an empty table", async () => {
    expect(await isPersistedAppAdmin(BOOTSTRAP_USER_ID)).toBe(false);

    await expect(maybeBootstrapAppAdmin({
      sub: BOOTSTRAP_USER_ID,
      email: `  ${BOOTSTRAP_ACCOUNT_ADMIN_EMAIL.toUpperCase()}  `,
      email_verified: true,
    })).resolves.toBe(true);

    const rows = await db
      .select()
      .from(appAdminsTable)
      .where(inArray(appAdminsTable.userId, [BOOTSTRAP_USER_ID, OTHER_USER_ID]));
    expect(rows).toMatchObject([{
      userId: BOOTSTRAP_USER_ID,
      email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
      createdBy: null,
      revokedAt: null,
    }]);

    const resolved = await resolveAuthorization(BOOTSTRAP_USER_ID);
    expect(resolved).toMatchObject({
      role: "account",
      isTrueAccountAdmin: true,
      capabilities: {
        canManageAccess: true,
        canEditAllocations: true,
        canPreviewRoles: true,
        canWriteGroupLimits: true,
        canWriteUserLimitsIn: [...WORKSPACE_IDS].sort(),
      },
    });
    expect(resolved?.roles).toContain("account");
    expect(scopeFor(resolved!)).toEqual({ kind: "all" });
  });

  it.each([
    ["an unverified claim", {
      sub: BOOTSTRAP_USER_ID,
      email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
      email_verified: false,
    }],
    ["a non-matching email", {
      sub: OTHER_USER_ID,
      email: `not-${BOOTSTRAP_ACCOUNT_ADMIN_EMAIL}`,
      email_verified: true,
    }],
    ["a partial email match", {
      sub: OTHER_USER_ID,
      email: `${BOOTSTRAP_ACCOUNT_ADMIN_EMAIL}.attacker.example`,
      email_verified: true,
    }],
  ])("rejects %s", async (_label, claims) => {
    await expect(maybeBootstrapAppAdmin(claims)).resolves.toBe(false);
    expect(await isPersistedAppAdmin(String(claims.sub))).toBe(false);
  });

  it("keeps authorization attached to the persisted stable subject", async () => {
    await maybeBootstrapAppAdmin({
      sub: BOOTSTRAP_USER_ID,
      email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
      email_verified: true,
    });

    await expect(maybeBootstrapAppAdmin({
      sub: BOOTSTRAP_USER_ID,
      email: "renamed@example.test",
      email_verified: true,
    })).resolves.toBe(false);

    expect((await resolveAuthorization(BOOTSTRAP_USER_ID))?.isTrueAccountAdmin).toBe(true);
    expect((await resolveAuthorization(OTHER_USER_ID))?.role).toBe("workspace_admin");
  });

  it("atomically pins concurrent first callbacks to one stable subject", async () => {
    const results = await Promise.all([
      maybeBootstrapAppAdmin({
        sub: BOOTSTRAP_USER_ID,
        email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
        email_verified: true,
      }),
      maybeBootstrapAppAdmin({
        sub: OTHER_USER_ID,
        email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
        email_verified: true,
      }),
    ]);
    expect(results.sort()).toEqual([false, true]);

    const rows = await db
      .select()
      .from(appAdminsTable)
      .where(inArray(appAdminsTable.userId, [BOOTSTRAP_USER_ID, OTHER_USER_ID]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
      createdBy: null,
      revokedAt: null,
    });
  });

  it.each(["browser callback", "mobile token exchange"])(
    "does not restore an explicitly revoked bootstrap admin during the %s",
    async () => {
      await maybeBootstrapAppAdmin({
        sub: BOOTSTRAP_USER_ID,
        email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
        email_verified: true,
      });
      await expect(
        revokeAppAdmin(BOOTSTRAP_USER_ID, OTHER_USER_ID),
      ).resolves.toBe(true);

      await expect(maybeBootstrapAppAdmin({
        sub: BOOTSTRAP_USER_ID,
        email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
        email_verified: true,
      })).resolves.toBe(false);
      expect(await isPersistedAppAdmin(BOOTSTRAP_USER_ID)).toBe(false);
      expect((await resolveAuthorization(BOOTSTRAP_USER_ID))?.role)
        .toBe("workspace_admin");

      const [row] = await db
        .select()
        .from(appAdminsTable)
        .where(inArray(appAdminsTable.userId, [BOOTSTRAP_USER_ID]));
      expect(row).toMatchObject({
        userId: BOOTSTRAP_USER_ID,
        revokedBy: OTHER_USER_ID,
      });
      expect(row?.revokedAt).toBeInstanceOf(Date);
    },
  );

  it("keeps both authentication callback flows on the revocation-safe bootstrap", () => {
    const authRouteSource = readFileSync(
      new URL("../routes/auth.ts", import.meta.url),
      "utf8",
    );
    expect(
      authRouteSource.match(/await maybeBootstrapAppAdmin\(claimsRecord\)/g),
    ).toHaveLength(2);
  });

  it("does not grant true-admin parity to a manually managed app admin", async () => {
    await db.insert(appAdminsTable).values({
      userId: OTHER_USER_ID,
      email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
      createdBy: BOOTSTRAP_USER_ID,
    });

    await expect(maybeBootstrapAppAdmin({
      sub: OTHER_USER_ID,
      email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
      email_verified: true,
    })).resolves.toBe(false);

    const resolved = await resolveAuthorization(OTHER_USER_ID);
    expect(resolved).toMatchObject({
      role: "account",
      isTrueAccountAdmin: false,
      capabilities: {
        canManageAccess: true,
        canEditAllocations: true,
        canPreviewRoles: false,
        canWriteGroupLimits: false,
      },
    });
    expect(
      await resolvePreviewAuthorization(
        resolved!,
        `workspace_admin:${WORKSPACE_IDS[0]}`,
      ),
    ).toBe(resolved);
  });

  it("resolves an active persisted app admin without directory membership", async () => {
    const detachedUserId = "authz-detached-admin";
    await db.delete(appAdminsTable).where(inArray(appAdminsTable.userId, [detachedUserId]));
    await db.insert(appAdminsTable).values({
      userId: detachedUserId,
      email: "detached-admin@example.test",
      createdBy: BOOTSTRAP_USER_ID,
    });
    try {
      const resolved = await resolveAuthorization(detachedUserId);
      expect(resolved).toMatchObject({
        role: "account",
        roles: ["account"],
        userId: detachedUserId,
        isTrueAccountAdmin: false,
        capabilities: {
          canManageAccess: true,
          canEditAllocations: true,
          canPreviewRoles: false,
          canWriteGroupLimits: false,
          canWriteUserLimitsIn: [...WORKSPACE_IDS].sort(),
        },
      });
    } finally {
      await db.delete(appAdminsTable).where(inArray(appAdminsTable.userId, [detachedUserId]));
    }
  });

  it("retains true-admin access in real mode and supports every scoped preview target", async () => {
    await maybeBootstrapAppAdmin({
      sub: BOOTSTRAP_USER_ID,
      email: BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
      email_verified: true,
    });
    const real = (await resolveAuthorization(BOOTSTRAP_USER_ID))!;
    const next = vi.fn();
    const status = vi.fn(() => ({ json: vi.fn() }));

    requireTrueAccountAdmin(
      { authz: real } as never,
      { status } as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();

    const workspacePreview = await resolvePreviewAuthorization(
      real,
      `workspace_admin:${WORKSPACE_IDS[0]}`,
    );
    expect(workspacePreview).toMatchObject({
      role: "workspace_admin",
      isTrueAccountAdmin: false,
      isPreview: true,
      capabilities: {
        canManageAccess: false,
        canEditAllocations: false,
        canPreviewRoles: false,
        canWriteGroupLimits: false,
        canWriteUserLimitsIn: [WORKSPACE_IDS[0]],
      },
    });

    const previewNext = vi.fn();
    requireTrueAccountAdmin(
      { authz: workspacePreview } as never,
      { status } as never,
      previewNext,
    );
    expect(previewNext).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);

    const memberPreview = await resolvePreviewAuthorization(
      real,
      `member:${OTHER_USER_ID}`,
    );
    expect(memberPreview).toMatchObject({
      role: "member",
      userId: OTHER_USER_ID,
      userIds: [OTHER_USER_ID],
      isPreview: true,
      capabilities: {
        canPreviewRoles: false,
      },
    });

    await expect(resolvePreviewAuthorization(real, "not-a-preview")).resolves.toBe(real);
    await expect(
      resolvePreviewAuthorization(real, `workspace_admin:missing-workspace`),
    ).resolves.toBe(real);
  });
});