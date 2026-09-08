import { describe, expect, it } from "vitest";
import type { ConfigurationSnapshot } from "./configuration-snapshot";
import type {
  DirectoryCache,
  EnterpriseGroup,
  EnterpriseMember,
  EnterpriseWorkspace,
} from "./enterprise";
import { LEGACY_WORKSPACE_ID } from "./enterprise";
import { buildMembershipContext } from "./membership-context";

function fixture(input: {
  workspaceIds: string[];
  groups: EnterpriseGroup[];
  memberships: Record<string, { role?: string; disabled?: boolean }>;
  groupMembers: Record<string, string[]>;
  targets: {
    workspaceId: string;
    groupId: string;
    groupName: string;
    teamName: string;
    assignmentSource?: "unconfirmed" | "automatic" | "manual";
  }[];
  hiddenTeams?: string[];
}): { directory: DirectoryCache; configuration: ConfigurationSnapshot } {
  const workspaces = new Map<string, EnterpriseWorkspace>(
    input.workspaceIds.map((id) => [id, {
      id,
      name: `Workspace ${id}`,
      slug: id,
      memberCount: 1,
    }]),
  );
  const member: EnterpriseMember = {
    userId: "effective-user",
    username: "effective",
    email: "effective@example.com",
    isInternalReplitUser: false,
    name: null,
    isAccountAdmin: true,
    workspaces: new Map(Object.entries(input.memberships).map(([id, value]) => [
      id,
      { role: value.role ?? "member", isDisabled: value.disabled ?? false },
    ])),
  };
  const familyTeamMappings = input.groups.map((group) => {
    const familyName = group.name
      .replace(/^AZ-Replit - /, "")
      .replace(/ - (Admin|Member)$/, "");
    return {
      workspaceId: group.workspaceId,
      familyKey: familyName.toLowerCase(),
      familyName,
      teamName: input.targets.find((target) =>
        target.groupName.includes(familyName))?.teamName ?? null,
      isLegacy: group.workspaceId === LEGACY_WORKSPACE_ID,
    };
  });
  const teamNames = [...new Set(input.targets.map((target) => target.teamName))];
  const configuration = {
    revision: "1",
    groupBudgets: [],
    teamLimitTargets: input.targets.map((target) => ({
      ...target,
      assignmentSource: target.assignmentSource ?? "automatic" as const,
      monthlyLimitUsd: null,
      isEnabled: true,
    })),
    teamBudgets: teamNames.map((teamName) => ({
      teamName,
      originalAmountUsd: 1,
      amountUsd: 1,
      monthlyLimitUsd: null,
      monthlyLimitSource: "derived" as const,
      isHidden: input.hiddenTeams?.includes(teamName) ?? false,
      updatedAt: new Date(0),
    })),
    teamBudgetAdjustments: [],
    familyTeamMappings,
  } satisfies ConfigurationSnapshot;
  return {
    directory: {
      fetchedAt: 1,
      workspaces,
      groups: input.groups,
      allGroups: input.groups,
      groupMembers: new Map(Object.entries(input.groupMembers)),
      members: new Map([[member.userId, member]]),
      internalUserIds: new Set(),
      budgets: {
        groupLimits: new Map(),
        userLimits: new Map(),
        workspaceDefaults: new Map(),
        observation: {
          status: "complete",
          observedAt: 1,
          lastSuccessfulAt: 1,
          lastAttemptAt: 1,
          refreshStartedAt: null,
          generation: "test",
          error: null,
        },
      },
      account: {} as DirectoryCache["account"],
    },
    configuration,
  };
}

describe("buildMembershipContext", () => {
  it("prefers the sole configured current target and drops role-only workspaces", () => {
    const liftMember = {
      id: "lift-member",
      workspaceId: "current-lift",
      name: "AZ-Replit - LIFT - Member",
      type: "custom",
    };
    const liftAdmin = {
      id: "lift-admin",
      workspaceId: LEGACY_WORKSPACE_ID,
      name: "AZ-Replit - LIFT - Admin",
      type: "custom",
    };
    const liftCurrentAdmin = {
      id: "lift-current-admin",
      workspaceId: "current-lift",
      name: "AZ-Replit - LIFT - Admin",
      type: "custom",
    };
    const genericAdmins = Array.from({ length: 20 }, (_, index) => ({
      id: `generic-${index}`,
      workspaceId: `admin-${index}`,
      name: "AZ-Replit - PREPROD-Admins",
      type: "custom",
    }));
    const data = fixture({
      workspaceIds: [
        LEGACY_WORKSPACE_ID,
        "current-lift",
        ...genericAdmins.map((g) => g.workspaceId),
      ],
      groups: [liftMember, liftAdmin, liftCurrentAdmin, ...genericAdmins],
      memberships: Object.fromEntries(
        [LEGACY_WORKSPACE_ID, "current-lift", ...genericAdmins.map((g) => g.workspaceId)]
          .map((id) => [id, { role: "admin" }]),
      ),
      groupMembers: Object.fromEntries(
        [liftMember, liftAdmin, liftCurrentAdmin, ...genericAdmins]
          .map((group) => [
            group.id,
            group.id === liftMember.id ? [] : ["effective-user"],
          ]),
      ),
      targets: [
        {
          workspaceId: "current-lift",
          groupId: liftMember.id,
          groupName: liftMember.name,
          teamName: "LIFT",
          assignmentSource: "automatic",
        },
        {
          workspaceId: genericAdmins[0]!.workspaceId,
          groupId: genericAdmins[0]!.id,
          groupName: genericAdmins[0]!.name,
          teamName: "PREPROD",
          assignmentSource: "automatic",
        },
      ],
      hiddenTeams: ["PREPROD"],
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.defaultWorkspaceId).toBe("current-lift");
    expect(result.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["current-lift", LEGACY_WORKSPACE_ID]);
    expect(result.workspaces.flatMap((workspace) => workspace.budgetTeams)
      .map((team) => team.teamName)).toEqual(["LIFT", "LIFT"]);
  });

  it("does not let hidden teams or inactive memberships create affiliations", () => {
    const group = {
      id: "hidden-member",
      workspaceId: "hidden",
      name: "AZ-Replit - Hidden - Member",
      type: "custom",
    };
    const data = fixture({
      workspaceIds: ["hidden", "ordinary"],
      groups: [group],
      memberships: {
        hidden: { disabled: true },
        ordinary: {},
      },
      groupMembers: { [group.id]: ["effective-user"] },
      targets: [{
        workspaceId: "hidden",
        groupId: group.id,
        groupName: group.name,
        teamName: "Hidden",
      }],
      hiddenTeams: ["Hidden"],
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.defaultWorkspaceId).toBe("ordinary");
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.budgetTeams).toEqual([]);
  });

  it("requires a choice when distinct configured targets really apply", () => {
    const groups = ["one", "two"].map((id) => ({
      id: `${id}-member`,
      workspaceId: id,
      name: `AZ-Replit - ${id} - Member`,
      type: "custom",
    }));
    const data = fixture({
      workspaceIds: ["one", "two"],
      groups,
      memberships: { one: {}, two: {} },
      groupMembers: Object.fromEntries(
        groups.map((group) => [group.id, ["effective-user"]]),
      ),
      targets: groups.map((group) => ({
        workspaceId: group.workspaceId,
        groupId: group.id,
        groupName: group.name,
        teamName: group.workspaceId,
      })),
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.defaultWorkspaceId).toBeNull();
    expect(result.qualification).toBe("Choose a workspace.");
    expect(result.workspaces.every((workspace) => !workspace.isPreferred)).toBe(true);
  });
});