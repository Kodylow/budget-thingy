import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appAdminsTable, db } from "@workspace/db";
import { inArray } from "drizzle-orm";

import {
  BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
  buildAuthorization,
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
      canViewAccountUsage: account,
      canManageAccess: account,
      canEditAllocations: account,
      canManageNotifications: account,
      canManageSystem: account,
      canPreviewRoles: false,
      canWriteGroupLimits: account,
      canRunChecks: account,
      canSendTestEmail: account,
      canWriteUserLimitsIn: values.workspaceIds ?? [],
    },
  };
}

describe("authorization scopes", () => {
  it.each([
    {
      persona: "true account admin",
      input: { roles: ["account"] as AuthzRole[], isTrueAccountAdmin: true },
      expected: [true, true, true, true, true, true, true, true],
    },
    {
      persona: "persisted budget editor",
      input: { roles: ["account"] as AuthzRole[], isTrueAccountAdmin: false },
      expected: [true, true, false, false, false, false, false, false],
    },
    {
      persona: "workspace admin",
      input: { roles: ["workspace_admin"] as AuthzRole[], workspaceIds: ["a"] },
      expected: [false, false, false, false, false, false, false, false],
    },
    {
      persona: "family admin",
      input: { roles: ["team_admin"] as AuthzRole[] },
      expected: [false, false, false, false, false, false, false, false],
    },
    {
      persona: "ordinary member",
      input: { roles: ["member"] as AuthzRole[] },
      expected: [false, false, false, false, false, false, false, false],
    },
  ])("applies the independent capability matrix for $persona", ({ input, expected }) => {
    const resolved = buildAuthorization({ userId: "user", ...input });
    expect([
      resolved.capabilities.canViewAccountUsage,
      resolved.capabilities.canEditAllocations,
      resolved.capabilities.canManageAccess,
      resolved.capabilities.canManageNotifications,
      resolved.capabilities.canManageSystem,
      resolved.capabilities.canWriteGroupLimits,
      resolved.capabilities.canRunChecks,
      resolved.capabilities.canSendTestEmail,
    ]).toEqual(expected);
    expect(resolved.capabilities.canWriteUserLimitsIn).toEqual(
      input.roles.includes("workspace_admin") ? ["a"] : [],
    );
  });

  it("keeps editor and workspace-admin grants additive and workspace-qualified", () => {
    const resolved = buildAuthorization({
      userId: "user",
      roles: ["account", "workspace_admin"],
      workspaceIds: ["managed-a"],
      allWorkspaceIds: ["managed-a", "member-b"],
    });
    expect(resolved.capabilities.canEditAllocations).toBe(true);
    expect(resolved.capabilities.canManageAccess).toBe(false);
    expect(resolved.capabilities.canWriteGroupLimits).toBe(false);
    expect(resolved.capabilities.canWriteUserLimitsIn).toEqual(["managed-a"]);
  });

  it("removes every mutation capability from preview authorization", () => {
    const preview = buildAuthorization({
      userId: "user",
      roles: ["account", "workspace_admin"],
      workspaceIds: ["a"],
      allWorkspaceIds: ["a"],
      isTrueAccountAdmin: true,
      canPreviewRoles: true,
      isPreview: true,
    });
    expect(preview.capabilities).toMatchObject({
      canManageAccess: false,
      canEditAllocations: false,
      canManageNotifications: false,
      canManageSystem: false,
      canWriteGroupLimits: false,
      canWriteUserLimitsIn: [],
      canRunChecks: false,
      canPreviewRoles: false,
      canSendTestEmail: false,
    });
  });

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
      managedGroupIds: new Set(["growth-members", "legacy-growth-members"]),
      groupUserIds: new Map(),
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

  it("keeps same-named family and mixed workspace scopes workspace-qualified", async () => {
    const workspaceA = WORKSPACE_IDS[0]!;
    const workspaceB = WORKSPACE_IDS[1]!;
    const adminA = "authz-finance-a-admin";
    const memberA = "authz-finance-a-member";
    const adminB = "authz-finance-b-admin";
    const memberB = "authz-finance-b-member";
    const coworker = "authz-cross-workspace-coworker";
    __setDirectoryCacheForTests({
      workspaces: new Map([
        [workspaceA, { id: workspaceA, name: "A", slug: "a", memberCount: 2 }],
        [workspaceB, { id: workspaceB, name: "B", slug: "b", memberCount: 2 }],
      ]),
      groups: [
        { id: adminA, workspaceId: workspaceA, name: "Finance - Admin", type: "custom" },
        { id: memberA, workspaceId: workspaceA, name: "Finance - Member", type: "custom" },
        { id: adminB, workspaceId: workspaceB, name: "Finance - Admin", type: "custom" },
        { id: memberB, workspaceId: workspaceB, name: "Finance - Member", type: "custom" },
      ],
      groupMembers: new Map([
        [adminA, [OTHER_USER_ID]],
        [memberA, [OTHER_USER_ID, coworker]],
        [adminB, []],
        [memberB, [OTHER_USER_ID, coworker]],
      ]),
      members: new Map([
        [OTHER_USER_ID, {
          ...directoryMember(OTHER_USER_ID),
          workspaces: new Map([
            [workspaceA, { role: "admin", isDisabled: false }],
            [workspaceB, { role: "member", isDisabled: false }],
          ]),
        }],
        [coworker, {
          ...directoryMember(coworker),
          workspaces: new Map([
            [workspaceA, { role: "member", isDisabled: false }],
            [workspaceB, { role: "member", isDisabled: false }],
          ]),
        }],
      ]),
    });

    const resolved = (await resolveAuthorization(OTHER_USER_ID))!;
    expect(resolved.workspaceIds).toEqual([workspaceA]);
    expect(resolved.groupUserIds?.[memberA]).toEqual([OTHER_USER_ID, coworker].sort());
    expect(resolved.groupUserIds?.[memberB]).toEqual([OTHER_USER_ID]);
    expect(resolved.managedGroupIds).toContain(memberA);
    expect(resolved.managedGroupIds).not.toContain(memberB);
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
          canManageAccess: false,
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
          canManageAccess: false,
          canEditAllocations: true,
          canPreviewRoles: false,
          canWriteGroupLimits: false,
          canWriteUserLimitsIn: [],
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
        canWriteUserLimitsIn: [],
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

    await expect(resolvePreviewAuthorization(real, "not-a-preview"))
      .rejects.toThrow("Preview target is invalid");
    await expect(
      resolvePreviewAuthorization(real, `workspace_admin:missing-workspace`),
    ).rejects.toThrow("Preview target is invalid");
  });
});