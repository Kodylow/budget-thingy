import { describe, expect, it } from "vitest";
import type { ConfigurationSnapshot } from "./configuration-snapshot";
import type {
  DirectoryCache,
  EnterpriseGroup,
  EnterpriseMember,
  EnterpriseWorkspace,
} from "./enterprise";
import { LEGACY_WORKSPACE_ID } from "./enterprise";
import {
  buildMembershipContext,
  buildOwnReportMembershipContext,
} from "./membership-context";

function fixture(input: {
  workspaceIds: string[];
  groups: EnterpriseGroup[];
  memberships: Record<string, { role?: string | null; disabled?: boolean }>;
  groupMembers: Record<string, string[]>;
  targets: {
    workspaceId: string;
    groupId: string;
    groupName: string;
    teamName: string;
    assignmentSource?: "unconfirmed" | "automatic" | "manual";
  }[];
  hiddenTeams?: string[];
  overrides?: {
    workspaceId: string;
    groupId: string;
    teamName: string | null;
  }[];
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
      {
        role: ("role" in value ? value.role : "member") as string,
        isDisabled: value.disabled ?? false,
      },
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
  const teamNames = [...new Set([
    ...input.targets.map((target) => target.teamName),
    ...(input.overrides ?? [])
      .map((override) => override.teamName)
      .filter((teamName): teamName is string => teamName !== null),
  ])];
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
    fundingGroupOverrides: (input.overrides ?? []).map((override) => ({
      ...override,
      updatedAt: new Date(0),
    })),
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
  it("uses one snapshot for exact assignment/unmap despite stale directory account", () => {
    const groups = [
      {
        id: "admin",
        workspaceId: "workspace",
        name: "AZ-Replit - Finance - Admin",
        type: "custom",
      },
      {
        id: "member",
        workspaceId: "workspace",
        name: "AZ-Replit - Finance - Member",
        type: "custom",
      },
    ];
    const data = fixture({
      workspaceIds: ["workspace"],
      groups,
      memberships: { workspace: { role: "member" } },
      groupMembers: {
        admin: ["effective-user"],
        member: ["effective-user"],
      },
      targets: [{
        workspaceId: "workspace",
        groupId: "member",
        groupName: groups[1]!.name,
        teamName: "Finance",
      }],
      overrides: [
        { workspaceId: "workspace", groupId: "admin", teamName: "DXP" },
        { workspaceId: "workspace", groupId: "member", teamName: null },
      ],
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.workspaces[0]?.budgetTeams).toEqual([
      expect.objectContaining({
        teamName: "DXP",
        groups: [expect.objectContaining({ groupId: "admin" })],
      }),
    ]);
    expect(result.workspaces[0]?.unmappedGroups).toEqual([
      expect.objectContaining({ groupId: "member" }),
    ]);
  });

  it("prefers the sole configured current target and retains eligible workspaces", () => {
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
      .toEqual([
        "current-lift",
        LEGACY_WORKSPACE_ID,
        ...genericAdmins.map((group) => group.workspaceId).sort(),
      ]);
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

  it("chooses deterministically when distinct configured targets really apply", () => {
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
    expect(result.defaultWorkspaceId).toBe("one");
    expect(result.qualification).toBeNull();
    expect(result.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["one", "two"]);
    expect(result.workspaces.filter((workspace) => workspace.isPreferred))
      .toHaveLength(1);
  });

  it.each(["owner", "account_admin"])("defaults an active %s membership but excludes a disabled one", (role) => {
    const data = fixture({
      workspaceIds: ["active", "disabled"],
      groups: [],
      memberships: {
        active: { role },
        disabled: { role, disabled: true },
      },
      groupMembers: {},
      targets: [],
    });
    const result = buildMembershipContext("effective-user", data.directory, data.configuration);
    expect(result.defaultWorkspaceId).toBe("active");
    expect(result.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["active"]);

    data.directory.members.get("effective-user")!.workspaces.get("active")!.isDisabled = true;
    const disabled = buildMembershipContext("effective-user", data.directory, data.configuration);
    expect(disabled.defaultWorkspaceId).toBeNull();
    expect(disabled.workspaces).toEqual([]);
  });

  it("excludes viewer-only Comcast and selects a member workspace", () => {
    const data = fixture({
      workspaceIds: ["comcast", "elsewhere"],
      groups: [],
      memberships: {
        comcast: { role: "viewer" },
        elsewhere: { role: "member" },
      },
      groupMembers: {},
      targets: [],
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.defaultWorkspaceId).toBe("elsewhere");
    expect(result.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["elsewhere"]);
  });

  it("retains viewer and unknown mapped affiliations only for legacy own reports", () => {
    const groups = [
      {
        id: "viewer-group",
        workspaceId: "viewer-workspace",
        name: "AZ-Replit - Viewer Team - Member",
        type: "custom",
      },
      {
        id: "unknown-group",
        workspaceId: "unknown-workspace",
        name: "AZ-Replit - Unknown Team - Member",
        type: "custom",
      },
    ];
    const data = fixture({
      workspaceIds: ["viewer-workspace", "unknown-workspace"],
      groups,
      memberships: {
        "viewer-workspace": { role: "viewer" },
        "unknown-workspace": { role: "future_role" },
      },
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

    const home = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    const ownReport = buildOwnReportMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );

    expect(home.workspaces).toEqual([]);
    expect(ownReport.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: "unknown-workspace",
        budgetTeams: [expect.objectContaining({ teamName: "unknown-workspace" })],
      }),
      expect.objectContaining({
        workspaceId: "viewer-workspace",
        budgetTeams: [expect.objectContaining({ teamName: "viewer-workspace" })],
      }),
    ]);
  });

  it("keeps genuine non-viewer Comcast membership eligible", () => {
    const data = fixture({
      workspaceIds: ["comcast", "z-other"],
      groups: [],
      memberships: {
        comcast: { role: "admin" },
        "z-other": { role: "member" },
      },
      groupMembers: {},
      targets: [],
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.defaultWorkspaceId).toBe("comcast");
    expect(result.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["comcast", "z-other"]);
  });

  it("does not let a funded viewer hide an unfunded eligible workspace", () => {
    const viewerGroup = {
      id: "viewer-funded",
      workspaceId: "funded-viewer",
      name: "AZ-Replit - Finance - Member",
      type: "custom",
    };
    const data = fixture({
      workspaceIds: ["funded-viewer", "unfunded-member"],
      groups: [viewerGroup],
      memberships: {
        "funded-viewer": { role: "viewer" },
        "unfunded-member": { role: "member" },
      },
      groupMembers: { [viewerGroup.id]: ["effective-user"] },
      targets: [{
        workspaceId: viewerGroup.workspaceId,
        groupId: viewerGroup.id,
        groupName: viewerGroup.name,
        teamName: "Finance",
      }],
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.defaultWorkspaceId).toBe("unfunded-member");
    expect(result.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["unfunded-member"]);
  });

  it("uses workspace name then id for target and fallback ties regardless of insertion", () => {
    const build = (workspaceIds: string[], withTargets: boolean) => {
      const groups = workspaceIds.map((id) => ({
        id: `${id}-group`,
        workspaceId: id,
        name: `AZ-Replit - ${id} - Member`,
        type: "custom",
      }));
      const data = fixture({
        workspaceIds,
        groups,
        memberships: Object.fromEntries(workspaceIds.map((id) => [id, {}])),
        groupMembers: Object.fromEntries(
          groups.map((group) => [group.id, ["effective-user"]]),
        ),
        targets: withTargets
          ? groups.map((group) => ({
            workspaceId: group.workspaceId,
            groupId: group.id,
            groupName: group.name,
            teamName: group.workspaceId,
          }))
          : [],
      });
      data.directory.workspaces.get("a")!.name = "Same";
      data.directory.workspaces.get("b")!.name = "Same";
      return buildMembershipContext(
        "effective-user",
        data.directory,
        data.configuration,
      );
    };

    for (const withTargets of [false, true]) {
      expect(build(["b", "a"], withTargets).defaultWorkspaceId).toBe("a");
      expect(build(["a", "b"], withTargets).defaultWorkspaceId).toBe("a");
    }
  });

  it("filters disabled, removed, missing, and unknown roles before selection", () => {
    const data = fixture({
      workspaceIds: ["eligible", "disabled", "missing-role", "unknown-role"],
      groups: [],
      memberships: {
        eligible: { role: "guest" },
        disabled: { role: "admin", disabled: true },
        removed: { role: "admin" },
        "missing-role": { role: null },
        "unknown-role": { role: "billing_admin" },
      },
      groupMembers: {},
      targets: [],
    });

    const result = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    expect(result.defaultWorkspaceId).toBe("eligible");
    expect(result.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["eligible"]);
    expect(result.qualification).toContain("missing or unrecognized roles");
  });

  it("returns truthful empty qualifications for all-viewer and unknown-only users", () => {
    const viewers = fixture({
      workspaceIds: ["one", "two"],
      groups: [],
      memberships: {
        one: { role: "viewer" },
        two: { role: "VIEWER" },
      },
      groupMembers: {},
      targets: [],
    });
    const unknown = fixture({
      workspaceIds: ["one"],
      groups: [],
      memberships: { one: { role: undefined } },
      groupMembers: {},
      targets: [],
    });

    const viewerResult = buildMembershipContext(
      "effective-user",
      viewers.directory,
      viewers.configuration,
    );
    expect(viewerResult.defaultWorkspaceId).toBeNull();
    expect(viewerResult.workspaces).toEqual([]);
    expect(viewerResult.qualification)
      .toBe("No eligible non-viewer workspace memberships.");

    const unknownResult = buildMembershipContext(
      "effective-user",
      unknown.directory,
      unknown.configuration,
    );
    expect(unknownResult.defaultWorkspaceId).toBeNull();
    expect(unknownResult.workspaces).toEqual([]);
    expect(unknownResult.qualification).toContain("missing or unrecognized");
  });

  it("selects memberships and groups for the requested effective user only", () => {
    const effectiveGroup = {
      id: "effective-group",
      workspaceId: "effective-workspace",
      name: "AZ-Replit - Effective - Member",
      type: "custom",
    };
    const otherGroup = {
      id: "other-group",
      workspaceId: "other-workspace",
      name: "AZ-Replit - Other - Member",
      type: "custom",
    };
    const data = fixture({
      workspaceIds: ["effective-workspace", "other-workspace"],
      groups: [effectiveGroup, otherGroup],
      memberships: { "effective-workspace": { role: "member" } },
      groupMembers: {
        [effectiveGroup.id]: ["effective-user"],
        [otherGroup.id]: ["other-user"],
      },
      targets: [effectiveGroup, otherGroup].map((group) => ({
        workspaceId: group.workspaceId,
        groupId: group.id,
        groupName: group.name,
        teamName: group.workspaceId,
      })),
    });
    data.directory.members.set("other-user", {
      userId: "other-user",
      username: "other",
      email: "other@example.com",
      isInternalReplitUser: false,
      name: null,
      isAccountAdmin: false,
      workspaces: new Map([
        ["other-workspace", { role: "member", isDisabled: false }],
      ]),
    });

    const effective = buildMembershipContext(
      "effective-user",
      data.directory,
      data.configuration,
    );
    const other = buildMembershipContext(
      "other-user",
      data.directory,
      data.configuration,
    );
    expect(effective.defaultWorkspaceId).toBe("effective-workspace");
    expect(effective.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["effective-workspace"]);
    expect(other.defaultWorkspaceId).toBe("other-workspace");
    expect(other.workspaces.map((workspace) => workspace.workspaceId))
      .toEqual(["other-workspace"]);
  });
});