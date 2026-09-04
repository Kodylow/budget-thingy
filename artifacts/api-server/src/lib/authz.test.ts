import { describe, expect, it } from "vitest";

import {
  canSeeGroup,
  canSeeWorkspace,
  normalizeEmail,
  scopeFor,
  scopeGroups,
  type Authorization,
  type AuthzRole,
} from "./authz";

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