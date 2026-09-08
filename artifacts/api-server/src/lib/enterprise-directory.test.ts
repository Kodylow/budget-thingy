import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  db,
  familyTeamMappingsTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { applyFamilyMappingBackfill } from "@workspace/db/seed-teams";

import {
  __setDirectoryCacheForTests,
  buildCanonicalAccountDirectory,
  buildCanonicalEffectiveTeams,
  buildCanonicalGroupMergePlan,
  getProjectInfo,
  isInternalReplitEmail,
  persistCanonicalFamilyFinancialRows,
  parseDirectoryGroupName,
  refreshProjectMetadata,
  refreshProjectMetadataSlice,
  type EnterpriseMember,
} from "./enterprise";
import {
  resolveAuthorization,
  resolvePreviewAuthorization,
  type Authorization,
} from "./authz";
import type { ConfigurationSnapshot } from "./configuration-snapshot";
import { readProjectMetadata } from "../routes/monitor.shared";

describe("canonical enterprise directory", () => {
  it("normalizes internal Replit email classification", () => {
    expect(isInternalReplitEmail("  Person@REPL.IT ")).toBe(true);
    expect(isInternalReplitEmail("person@replit.com")).toBe(false);
    expect(isInternalReplitEmail("person@repl.it.example")).toBe(false);
  });

  it("parses every supported role and unsuffixed families", () => {
    expect(parseDirectoryGroupName("AZ-Replit - Finance - Admin")).toMatchObject({
      familyKey: "finance", familyName: "Finance", role: "admin",
    });
    expect(parseDirectoryGroupName("Finance - Admins").role).toBe("admin");
    expect(parseDirectoryGroupName("Finance - Member").role).toBe("member");
    expect(parseDirectoryGroupName("Finance - Members").role).toBe("member");
    expect(parseDirectoryGroupName("Finance - Viewer").role).toBe("viewer");
    expect(parseDirectoryGroupName("Finance - Viewers").role).toBe("viewer");
    expect(parseDirectoryGroupName("Finance - Guest").role).toBe("guest");
    expect(parseDirectoryGroupName("Finance - Guests").role).toBe("guest");
    expect(parseDirectoryGroupName("  Growth   MDU  ")).toEqual({
      familyKey: "growth mdu", familyName: "Growth MDU", role: "unsuffixed",
    });
  });

  it("builds stable family joins and maps legacy siblings to the nonlegacy team", () => {
    const groups = [
      { id: "admin", workspaceId: "current", name: "AZ-Replit - Growth Strategy & Operations - Admin", type: "custom" },
      { id: "member", workspaceId: "current", name: "AZ-Replit - Growth Strategy & Operations - Members", type: "custom" },
      { id: "legacy", workspaceId: "1awqan", name: "Growth Strategy & Operations - Viewer", type: "custom" },
    ];
    const account = buildCanonicalAccountDirectory({
      workspaces: new Map(),
      groups,
      groupMembers: new Map(),
      members: new Map(),
    });
    const current = account.familiesById.get("current:growth strategy & operations")!;
    const legacy = account.familiesById.get("1awqan:growth strategy & operations")!;
    expect(current.teamName).toBe("DXP");
    expect(legacy.teamName).toBe("DXP");
    expect(current.roleGroups.get("member")?.id).toBe("member");
    expect(account.roleGroupsById.get("legacy")?.familyId).toBe(legacy.id);
  });

  it("keeps exact assignments workspace-qualified and inherits to legacy only when unambiguous", () => {
    const groups = [
      { id: "one-member", workspaceId: "one", name: "Shared Family - Member", type: "custom" },
      { id: "two-member", workspaceId: "two", name: "Shared Family - Members", type: "custom" },
      { id: "legacy-viewer", workspaceId: "1awqan", name: "Shared Family - Viewer", type: "custom" },
    ];
    const account = buildCanonicalAccountDirectory({
      workspaces: new Map(),
      groups,
      groupMembers: new Map(),
      members: new Map(),
      mappings: [{
        workspaceId: "1awqan",
        familyKey: "shared family",
        familyName: "Shared Family",
        teamName: "Stale Legacy Team",
        isLegacy: true,
      }],
    });
    let effective = buildCanonicalEffectiveTeams(account, [
      { workspaceId: "one", groupId: "one-member", teamName: "One Finance", assignmentSource: "manual" },
      { workspaceId: "two", groupId: "two-member", teamName: "Two Finance", assignmentSource: "manual" },
    ]);
    expect(effective.byRoleGroupId.get("one-member")).toBe("One Finance");
    expect(effective.byRoleGroupId.get("two-member")).toBe("Two Finance");
    expect(effective.byRoleGroupId.get("legacy-viewer")).toBeNull();

    effective = buildCanonicalEffectiveTeams(account, [
      { workspaceId: "one", groupId: "one-member", teamName: "Shared Team", assignmentSource: "manual" },
      { workspaceId: "two", groupId: "two-member", teamName: "Shared Team", assignmentSource: "manual" },
    ]);
    expect(effective.byRoleGroupId.get("legacy-viewer")).toBe("Shared Team");
  });

  it("hydrates a unique unnamed legacy sibling team and rejects stale ambiguous mapping", () => {
    const groups = [
      { id: "one", workspaceId: "one", name: "Shared Family - Member", type: "custom" },
      { id: "two", workspaceId: "two", name: "Shared Family - Member", type: "custom" },
      { id: "legacy", workspaceId: "1awqan", name: "Shared Family - Members", type: "custom" },
    ];
    const ambiguous = buildCanonicalAccountDirectory({
      workspaces: new Map(),
      groups,
      groupMembers: new Map(),
      members: new Map(),
      mappings: [
        { workspaceId: "one", familyKey: "shared family", familyName: "Shared Family", teamName: "Team One", isLegacy: false },
        { workspaceId: "two", familyKey: "shared family", familyName: "Shared Family", teamName: "Team Two", isLegacy: false },
        { workspaceId: "1awqan", familyKey: "shared family", familyName: "Shared Family", teamName: "Stale Team", isLegacy: true },
      ],
    });
    expect(ambiguous.familiesById.get("1awqan:shared family")?.teamName).toBeNull();

    const unique = buildCanonicalAccountDirectory({
      workspaces: new Map(),
      groups: groups.filter((group) => group.workspaceId !== "two"),
      groupMembers: new Map(),
      members: new Map(),
      mappings: [
        { workspaceId: "one", familyKey: "shared family", familyName: "Shared Family", teamName: "Team One", isLegacy: false },
        { workspaceId: "1awqan", familyKey: "shared family", familyName: "Shared Family", teamName: "Stale Team", isLegacy: true },
      ],
    });
    expect(unique.familiesById.get("1awqan:shared family")?.teamName).toBe("Team One");
  });

  it("leaves newly discovered unknown families unmapped while approved overrides share", () => {
    const account = buildCanonicalAccountDirectory({
      workspaces: new Map(),
      groups: [
        { id: "one-shared", workspaceId: "one", name: "Shared Family - Member", type: "custom" },
        { id: "two-shared", workspaceId: "two", name: "Shared Family - Members", type: "custom" },
        { id: "one-finance", workspaceId: "one", name: "Finance - Member", type: "custom" },
        { id: "two-finance", workspaceId: "two", name: "Finance - Members", type: "custom" },
      ],
      groupMembers: new Map(),
      members: new Map(),
    });
    expect(account.familiesById.get("one:shared family")?.teamName)
      .toBeNull();
    expect(account.familiesById.get("two:shared family")?.teamName)
      .toBeNull();
    expect(account.familiesById.get("one:finance")?.teamName).toBe("Finance");
    expect(account.familiesById.get("two:finance")?.teamName).toBe("Finance");
    const effective = buildCanonicalEffectiveTeams(account, [
      {
        workspaceId: "one",
        groupId: "one-shared",
        teamName: "Shared Family",
        assignmentSource: "automatic",
      },
      {
        workspaceId: "two",
        groupId: "two-shared",
        teamName: "Shared Family",
        assignmentSource: "automatic",
      },
    ]);
    expect(effective.byRoleGroupId.get("one-shared")).toBeNull();
    expect(effective.byRoleGroupId.get("two-shared")).toBeNull();
  });

  it("does not create funding teams or targets for newly unknown families", async () => {
    const workspaceIds = ["__financial_identity_one__", "__financial_identity_two__"];
    const groupIds = ["__financial_identity_group_one__", "__financial_identity_group_two__"];
    const teamNames = workspaceIds.map((workspaceId) =>
      `Financial Identity Family [${workspaceId}]`
    );
    await db.delete(teamLimitTargetsTable)
      .where(inArray(teamLimitTargetsTable.groupId, groupIds));
    await db.delete(teamBudgetsTable)
      .where(inArray(teamBudgetsTable.teamName, teamNames));
    try {
      const account = buildCanonicalAccountDirectory({
        workspaces: new Map(),
        groups: [
          { id: groupIds[0]!, workspaceId: workspaceIds[0]!, name: "Financial Identity Family - Member", type: "custom" },
          { id: groupIds[1]!, workspaceId: workspaceIds[1]!, name: "Financial Identity Family - Members", type: "custom" },
        ],
        groupMembers: new Map(),
        members: new Map(),
      });
      await persistCanonicalFamilyFinancialRows(account);
      const targets = await db.select().from(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      const budgets = await db.select().from(teamBudgetsTable)
        .where(inArray(teamBudgetsTable.teamName, teamNames));
      expect(targets).toEqual([]);
      expect(budgets).toEqual([]);
    } finally {
      await db.delete(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      await db.delete(teamBudgetsTable)
        .where(inArray(teamBudgetsTable.teamName, teamNames));
    }
  });

  it("applies overrides only to the exact workspace/group and preserves explicit unmap", () => {
    const account = buildCanonicalAccountDirectory({
      workspaces: new Map(),
      groups: [
        { id: "admin", workspaceId: "one", name: "Finance - Admin", type: "custom" },
        { id: "member", workspaceId: "one", name: "Finance - Member", type: "custom" },
        { id: "same-name", workspaceId: "two", name: "Finance - Admin", type: "custom" },
      ],
      groupMembers: new Map(),
      members: new Map(),
    });
    const effective = buildCanonicalEffectiveTeams(account, [], [
      { workspaceId: "one", groupId: "admin", teamName: "DXP" },
      { workspaceId: "one", groupId: "member", teamName: null },
      // Mismatched workspace must never affect a globally same group id.
      { workspaceId: "wrong", groupId: "same-name", teamName: "DXP" },
    ]);
    expect(effective.byRoleGroupId.get("admin")).toBe("DXP");
    expect(effective.byRoleGroupId.get("member")).toBeNull();
    expect(effective.byRoleGroupId.get("same-name")).toBe("Finance");
    expect(effective.byFamilyId.get("one:finance")).toBe("Finance");
  });

  it("does not merge a hidden-team group with an unmapped namesake or lose spend", () => {
    const groups = [
      { id: "mapped", workspaceId: "one", name: "Duplicate", type: "custom" },
      { id: "unmapped", workspaceId: "two", name: "Duplicate", type: "custom" },
    ];
    const effectiveFunding = new Map([["one\u0000mapped", "Hidden Finance"]]);
    const hiddenTeams = new Set(["Hidden Finance"]);
    const visibleFunding = new Map(
      [...effectiveFunding].filter(([, team]) => !hiddenTeams.has(team)),
    );
    expect(visibleFunding.size).toBe(0);
    const plan = buildCanonicalGroupMergePlan(
      groups,
      new Map(),
      effectiveFunding,
    );
    expect(plan.mergeMap.get("mapped")).toEqual(["mapped"]);
    expect(plan.mergeMap.get("unmapped")).toEqual(["unmapped"]);
    expect(plan.hiddenGroupIds.size).toBe(0);
    const spend = new Map([["mapped", 11], ["unmapped", 7]]);
    const conserved = [...plan.mergeMap.values()]
      .reduce((total, ids) =>
        total + ids.reduce((sum, id) => sum + (spend.get(id) ?? 0), 0), 0);
    expect(conserved).toBe(18);
  });

  it("backfill fails stale legacy mappings closed on ambiguity and inherits unique teams", async () => {
    const workspaceIds = [
      "__directory_backfill_one__",
      "__directory_backfill_two__",
      "__directory_backfill_legacy__",
    ];
    await db.delete(familyTeamMappingsTable)
      .where(inArray(familyTeamMappingsTable.workspaceId, workspaceIds));
    try {
      await db.insert(familyTeamMappingsTable).values([
        { workspaceId: workspaceIds[0]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", teamName: "Team One", isLegacy: false },
        { workspaceId: workspaceIds[1]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", teamName: "Team Two", isLegacy: false },
        { workspaceId: workspaceIds[2]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", teamName: "Stale Team", isLegacy: true },
      ]);
      let rows = await applyFamilyMappingBackfill([
        { workspaceId: workspaceIds[0]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", isLegacy: false },
        { workspaceId: workspaceIds[1]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", isLegacy: false },
        { workspaceId: workspaceIds[2]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", isLegacy: true },
      ]);
      expect(rows.find((row) => row.workspaceId === workspaceIds[2])?.teamName).toBeNull();

      await db.delete(familyTeamMappingsTable)
        .where(inArray(familyTeamMappingsTable.workspaceId, [workspaceIds[1]!]));
      rows = await applyFamilyMappingBackfill([
        { workspaceId: workspaceIds[0]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", isLegacy: false },
        { workspaceId: workspaceIds[2]!, familyKey: "__directory backfill shared family__", familyName: "Directory Backfill Shared Family", isLegacy: true },
      ]);
      expect(rows.find((row) => row.workspaceId === workspaceIds[2])?.teamName).toBe("Team One");
    } finally {
      await db.delete(familyTeamMappingsTable)
        .where(inArray(familyTeamMappingsTable.workspaceId, workspaceIds));
    }
  });

  it("preserves pre-provenance mappings and leaves newly unknown destinations uncreated", async () => {
    const workspaceIds = ["__auto_collision_one__", "__auto_collision_two__"];
    const groupIds = ["__auto_collision_group_one__", "__auto_collision_group_two__"];
    const familyKey = "auto collision family";
    const familyName = "Auto Collision Family";
    await db.delete(teamLimitTargetsTable)
      .where(inArray(teamLimitTargetsTable.groupId, groupIds));
    await db.delete(familyTeamMappingsTable)
      .where(inArray(familyTeamMappingsTable.workspaceId, workspaceIds));
    try {
      await db.insert(familyTeamMappingsTable).values(workspaceIds.map((workspaceId) => ({
        workspaceId,
        familyKey,
        familyName,
        teamName: familyName,
        isLegacy: false,
      })));
      await db.insert(teamLimitTargetsTable).values(workspaceIds.map((workspaceId, index) => ({
        workspaceId,
        groupId: groupIds[index]!,
        groupName: `${familyName} - Member`,
        teamName: familyName,
        assignmentSource: "unconfirmed" as const,
        monthlyLimitUsd: 17 + index,
        isEnabled: index !== 0,
      })));
      let rows = await applyFamilyMappingBackfill(workspaceIds.map((workspaceId, index) => ({
        workspaceId,
        familyKey,
        familyName,
        isLegacy: false,
        groupIds: [groupIds[index]!],
      })));
      expect(new Set(rows
        .filter((row) => workspaceIds.includes(row.workspaceId))
        .map((row) => row.teamName)))
        .toEqual(new Set([familyName]));
      const account = buildCanonicalAccountDirectory({
        workspaces: new Map(),
        groups: workspaceIds.map((workspaceId, index) => ({
          id: groupIds[index]!,
          workspaceId,
          name: `${familyName} - Member`,
          type: "custom",
        })),
        groupMembers: new Map(),
        members: new Map(),
        mappings: rows,
      });
      await persistCanonicalFamilyFinancialRows(account);
      const untouchedTargets = await db.select().from(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      expect(untouchedTargets).toEqual(expect.arrayContaining(workspaceIds.map(
        (workspaceId, index) => expect.objectContaining({
          workspaceId,
          groupId: groupIds[index],
          groupName: `${familyName} - Member`,
          teamName: familyName,
          assignmentSource: "unconfirmed",
          monthlyLimitUsd: 17 + index,
          isEnabled: index !== 0,
        }),
      )));
      const effective = buildCanonicalEffectiveTeams(account, untouchedTargets);
      expect(effective.byRoleGroupId.get(groupIds[0]!)).toBe(familyName);
      expect(effective.byRoleGroupId.get(groupIds[1]!)).toBe(familyName);

      await db.delete(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      await persistCanonicalFamilyFinancialRows(account);
      const repairedTargets = await db.select().from(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      expect(repairedTargets).toEqual([]);

      await db.delete(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      await db.insert(teamLimitTargetsTable).values(workspaceIds.map((workspaceId, index) => ({
        workspaceId,
        groupId: groupIds[index]!,
        groupName: `${familyName} - Member`,
        teamName: "Deliberately Shared",
      })));
      rows = await applyFamilyMappingBackfill(workspaceIds.map((workspaceId, index) => ({
        workspaceId,
        familyKey,
        familyName,
        isLegacy: false,
        groupIds: [groupIds[index]!],
      })));
      expect(rows.find((row) => row.workspaceId === workspaceIds[0])?.teamName)
        .toBe("Deliberately Shared");
      expect(rows.find((row) => row.workspaceId === workspaceIds[1])?.teamName)
        .toBe("Deliberately Shared");
    } finally {
      await db.delete(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      await db.delete(familyTeamMappingsTable)
        .where(inArray(familyTeamMappingsTable.workspaceId, workspaceIds));
    }
  });

  it("does not associate an unrelated same-team manual target with duplicate Finance families", async () => {
    const workspaceIds = ["__finance_guard_one__", "__finance_guard_two__"];
    const familyGroupIds = ["__finance_family_one__", "__finance_family_two__"];
    const unrelatedGroupId = "__finance_unrelated_manual__";
    await db.delete(teamLimitTargetsTable)
      .where(eq(teamLimitTargetsTable.groupId, unrelatedGroupId));
    await db.delete(familyTeamMappingsTable)
      .where(inArray(familyTeamMappingsTable.workspaceId, workspaceIds));
    try {
      await db.insert(familyTeamMappingsTable).values(workspaceIds.map((workspaceId) => ({
        workspaceId,
        familyKey: "finance",
        familyName: "Finance",
        teamName: "Finance",
        isLegacy: false,
      })));
      await db.insert(teamLimitTargetsTable).values({
        workspaceId: workspaceIds[0]!,
        groupId: unrelatedGroupId,
        groupName: "Unrelated Cost Center - Member",
        teamName: "Finance",
        assignmentSource: "manual",
      });
      await applyFamilyMappingBackfill(workspaceIds.map((workspaceId, index) => ({
        workspaceId,
        familyKey: "finance",
        familyName: "Finance",
        isLegacy: false,
        groupIds: [familyGroupIds[index]!],
      })));
      const [target] = await db.select().from(teamLimitTargetsTable)
        .where(eq(teamLimitTargetsTable.groupId, unrelatedGroupId));
      expect(target).toMatchObject({
        groupName: "Unrelated Cost Center - Member",
        teamName: "Finance",
        assignmentSource: "manual",
      });
    } finally {
      await db.delete(teamLimitTargetsTable)
        .where(eq(teamLimitTargetsTable.groupId, unrelatedGroupId));
      await db.delete(familyTeamMappingsTable)
        .where(inArray(familyTeamMappingsTable.workspaceId, workspaceIds));
    }
  });
});

describe("canonical team-admin scope", () => {
  afterEach(() => __setDirectoryCacheForTests(null));

  it("limits Growth MDU preview to that exact family and its legacy sibling", async () => {
    const groups = [
      { id: "mdu-admin", workspaceId: "current", name: "Growth MDU - Admin", type: "custom" },
      { id: "mdu-member", workspaceId: "current", name: "Growth MDU - Member", type: "custom" },
      { id: "other-member", workspaceId: "current", name: "Growth Other - Member", type: "custom" },
      { id: "legacy-mdu", workspaceId: "1awqan", name: "Growth MDU - Members", type: "custom" },
    ];
    const accountAdmin: EnterpriseMember = {
      userId: "admin",
      username: "admin",
      email: "admin@example.com",
      isInternalReplitUser: false,
      name: null,
      isAccountAdmin: true,
      workspaces: new Map([["current", { role: "admin", isDisabled: false }]]),
    };
    __setDirectoryCacheForTests({
      groups,
      members: new Map([[accountAdmin.userId, accountAdmin]]),
    });
    const real: Authorization = {
      role: "account",
      roles: ["account"],
      userId: "admin",
      workspaceIds: [],
      teamNames: [],
      groupIds: [],
      userIds: ["admin"],
      isTrueAccountAdmin: true,
      capabilities: {
        canViewAccountUsage: true,
        canManageAccess: true,
        canEditAllocations: true,
        canManageFundingMappings: true,
        canManageNotifications: true,
        canManageSystem: true,
        canPreviewRoles: true,
        canWriteGroupLimits: true,
        canRunChecks: true,
        canSendTestEmail: true,
        canWriteUserLimitsIn: [],
      },
    };
    const configuration: ConfigurationSnapshot = {
      revision: "1",
      groupBudgets: [],
      teamLimitTargets: [{
        workspaceId: "current",
        groupId: "mdu-member",
        groupName: "Growth MDU - Member",
        teamName: "Growth MDU",
        assignmentSource: "manual",
        monthlyLimitUsd: null,
        isEnabled: true,
      }],
      teamBudgets: [{
        teamName: "Growth MDU",
        originalAmountUsd: 1,
        amountUsd: 1,
        monthlyLimitUsd: null,
        monthlyLimitSource: "derived",
        isHidden: false,
        updatedAt: new Date(0),
      }],
      teamBudgetAdjustments: [],
      familyTeamMappings: [
        {
          workspaceId: "current",
          familyKey: "growth mdu",
          familyName: "Growth MDU",
          teamName: "Growth MDU",
          isLegacy: false,
        },
        {
          workspaceId: "1awqan",
          familyKey: "growth mdu",
          familyName: "Growth MDU",
          teamName: "Growth MDU",
          isLegacy: true,
        },
      ],
      fundingGroupOverrides: [],
    };
    const preview = await resolvePreviewAuthorization(
      real,
      "team_admin:Growth MDU",
      configuration,
    );
    expect(preview.groupIds).toEqual(expect.arrayContaining(["mdu-admin", "mdu-member", "legacy-mdu"]));
    expect(preview.groupIds).not.toContain("other-member");
    expect(preview.teamNames).toEqual(["Growth MDU"]);
  });

  it("does not grant an admin the same-named family in another nonlegacy workspace", async () => {
    const groups = [
      { id: "one-admin", workspaceId: "one", name: "Finance - Admin", type: "custom" },
      { id: "one-member", workspaceId: "one", name: "Finance - Member", type: "custom" },
      { id: "two-member", workspaceId: "two", name: "Finance - Members", type: "custom" },
      { id: "legacy-member", workspaceId: "1awqan", name: "Finance - Member", type: "custom" },
    ];
    const member: EnterpriseMember = {
      userId: "family-admin",
      username: "family-admin",
      email: "family-admin@example.com",
      isInternalReplitUser: false,
      name: null,
      isAccountAdmin: false,
      workspaces: new Map([["one", { role: "member", isDisabled: false }]]),
    };
    __setDirectoryCacheForTests({
      groups,
      groupMembers: new Map([["one-admin", [member.userId]]]),
      members: new Map([[member.userId, member]]),
    });
    const authorization = await resolveAuthorization(member.userId);
    expect(authorization?.groupIds).toEqual(expect.arrayContaining([
      "one-admin",
      "one-member",
      "legacy-member",
    ]));
    expect(authorization?.groupIds).not.toContain("two-member");
  });

  it("fails a forced team preview closed when two nonlegacy families are ambiguous", async () => {
    const groups = [
      { id: "one-member", workspaceId: "one", name: "Growth MDU - Member", type: "custom" },
      { id: "two-member", workspaceId: "two", name: "Growth MDU - Members", type: "custom" },
    ];
    __setDirectoryCacheForTests({ groups, members: new Map() });
    const real: Authorization = {
      role: "account",
      roles: ["account"],
      userId: "admin",
      workspaceIds: [],
      teamNames: [],
      groupIds: [],
      userIds: ["admin"],
      isTrueAccountAdmin: true,
      capabilities: {
        canViewAccountUsage: true,
        canManageAccess: true,
        canEditAllocations: true,
        canManageFundingMappings: true,
        canManageNotifications: true,
        canManageSystem: true,
        canPreviewRoles: true,
        canWriteGroupLimits: true,
        canRunChecks: true,
        canSendTestEmail: true,
        canWriteUserLimitsIn: [],
      },
    };
    await expect(resolvePreviewAuthorization(real, "team_admin:Growth MDU"))
      .rejects.toThrow("Preview target is invalid or no longer available");
  });
});

describe("Enterprise project metadata enrichment", () => {
  const workspaceIds = [
    "__project_metadata_old_failed__",
    "__project_metadata_old_success__",
    "__project_metadata_newer__",
    "__project_metadata_last_good__",
    "__project_metadata_empty_last_good__",
    "__project_metadata_deadline__",
    "__project_metadata_after_deadline__",
  ];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env["REPLIT_ENTERPRISE_API_KEY"];

  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env["REPLIT_ENTERPRISE_API_KEY"];
    else process.env["REPLIT_ENTERPRISE_API_KEY"] = originalKey;
    await db.delete(apiProjectMetadataStateTable)
      .where(inArray(apiProjectMetadataStateTable.workspaceId, workspaceIds));
    await db.delete(apiProjectMetadataTable)
      .where(inArray(apiProjectMetadataTable.workspaceId, workspaceIds));
  });

  it("retains last-good project data and does not invent missing attribution after failure", async () => {
    const workspaceId = workspaceIds[3]!;
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      return Response.json({
        data: path.endsWith("/deployments")
          ? [
              {
                id: "deployment-one",
                project: { id: "known" },
                workspace: { id: workspaceId },
                url: "https://known.example",
                deploymentPrivacy: "public",
                status: "success",
              },
              {
                id: "deployment-two",
                project: { id: "known" },
                workspace: { id: workspaceId },
                url: "javascript:alert(1)",
              },
            ]
          : [{ id: "known", title: "Known", creatorId: "creator" }],
        pagination: { hasMore: false },
      });
    };
    await refreshProjectMetadata(workspaceId, true);
    const [successfulState] = await db.select().from(apiProjectMetadataStateTable)
      .where(eq(apiProjectMetadataStateTable.workspaceId, workspaceId));

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/deployments")) {
        if (url.searchParams.has("cursor")) {
          return new Response("sensitive provider payload", { status: 500 });
        }
        return Response.json({
          data: [],
          pagination: { hasMore: true, nextCursor: "deployment-page-two" },
        });
      }
      return Response.json({
        data: [{ id: "known", title: "Changed", creatorId: "new-owner" }],
        pagination: { hasMore: false },
      });
    };
    const error = await refreshProjectMetadata(workspaceId, true).catch((caught) => caught);
    expect(error).toMatchObject({ message: "Enterprise API /deployments failed (500)" });
    expect(error.message).not.toContain("sensitive provider payload");

    expect(getProjectInfo(workspaceId, "known")).toEqual({
      title: "Known",
      creatorId: "creator",
      createdAt: null,
      updatedAt: null,
      hasDeployment: true,
      deployments: [
        expect.objectContaining({
          id: "deployment-one",
          url: "https://known.example/",
        }),
        expect.objectContaining({
          id: "deployment-two",
          url: null,
          privacy: null,
          status: null,
        }),
      ],
      deploymentsObservedAt: expect.any(String),
      fetchedAt: expect.any(String),
    });
    expect(getProjectInfo(workspaceId, "missing")).toBeUndefined();
    const [state] = await db.select().from(apiProjectMetadataStateTable)
      .where(eq(apiProjectMetadataStateTable.workspaceId, workspaceId));
    expect(state).toMatchObject({
      status: "failed",
      deploymentStatusObserved: true,
    });
    expect(state?.lastSuccessfulAt).toEqual(successfulState?.completedAt);
    expect(state!.completedAt.getTime()).toBeGreaterThanOrEqual(
      successfulState!.completedAt.getTime(),
    );
    const rows = await db.select().from(apiProjectMetadataTable)
      .where(eq(apiProjectMetadataTable.workspaceId, workspaceId));
    expect(rows).toEqual([
      expect.objectContaining({
        projectId: "known",
        title: "Known",
        creatorId: "creator",
        hasDeployment: true,
        deployments: expect.arrayContaining([
          expect.objectContaining({ id: "deployment-one" }),
          expect.objectContaining({ id: "deployment-two" }),
        ]),
      }),
    ]);
  });

  it("refreshes all expected workspaces from one account-wide pair", async () => {
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    const now = Date.now();
    await db.insert(apiProjectMetadataStateTable).values([
      {
        workspaceId: workspaceIds[0]!,
        status: "failed",
        errorMessage: "old failure",
        startedAt: new Date(now - 60 * 60_000),
        completedAt: new Date(now - 60 * 60_000),
      },
      {
        workspaceId: workspaceIds[1]!,
        status: "success",
        errorMessage: null,
        startedAt: new Date(now - 45 * 60_000),
        completedAt: new Date(now - 45 * 60_000),
      },
      {
        workspaceId: workspaceIds[2]!,
        status: "success",
        errorMessage: null,
        startedAt: new Date(now - 30 * 60_000),
        completedAt: new Date(now - 30 * 60_000),
      },
    ]);
    const fetched: string[] = [];
    globalThis.fetch = async (input) => {
      fetched.push(new URL(String(input)).searchParams.get("workspaceId")!);
      return new Response(JSON.stringify({
        data: [],
        pagination: { hasMore: false },
      }), { status: 200 });
    };

    const counters = await refreshProjectMetadataSlice([
      workspaceIds[2]!,
      workspaceIds[1]!,
      workspaceIds[0]!,
    ]);

    expect(fetched).toEqual([
      null,
      null,
      workspaceIds[2]!,
      workspaceIds[1]!,
      workspaceIds[0]!,
    ]);
    expect(counters).toEqual({
      considered: 3,
      attempted: 3,
      succeeded: 3,
      failed: 0,
      deferred: 0,
      requests: 5,
      remaining: 0,
    });
  });

  it("rejects a conflicting project UUID before replacing last-good rows", async () => {
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    const workspaceId = workspaceIds[0]!;
    const otherWorkspaceId = workspaceIds[1]!;
    const observedAt = new Date();
    await db.insert(apiProjectMetadataTable).values({
      workspaceId,
      projectId: "last-good",
      title: "Last good",
      creatorId: "creator",
      fetchedAt: observedAt,
    });
    await db.insert(apiProjectMetadataStateTable).values({
      workspaceId,
      status: "success",
      completedAt: observedAt,
      lastSuccessfulAt: observedAt,
    });
    globalThis.fetch = async (input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor");
      return Response.json(cursor
        ? {
            data: [{
              id: "duplicate-project",
              title: "Duplicate",
              creatorId: "other-owner",
              workspace: { id: otherWorkspaceId },
            }],
            pagination: { hasMore: false },
          }
        : {
            data: [{
              id: "duplicate-project",
              title: "Duplicate",
              creatorId: "creator",
              workspace: { id: workspaceId },
            }],
            pagination: { hasMore: true, nextCursor: "next" },
          });
    };

    const counters = await refreshProjectMetadataSlice(
      [workspaceId, otherWorkspaceId],
      { retryIncomplete: true },
    );

    expect(counters).toMatchObject({
      attempted: 2,
      succeeded: 0,
      failed: 2,
      requests: 2,
      remaining: 2,
    });
    const rows = await db.select().from(apiProjectMetadataTable)
      .where(eq(apiProjectMetadataTable.workspaceId, workspaceId));
    expect(rows).toEqual([
      expect.objectContaining({
        projectId: "last-good",
        creatorId: "creator",
      }),
    ]);
  });

  it("preserves honest last-success freshness for an empty listing after failure", async () => {
    const workspaceId = workspaceIds[4]!;
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    globalThis.fetch = async () => Response.json({
      data: [],
      pagination: { hasMore: false },
    });
    await refreshProjectMetadata(workspaceId, true);
    const [successfulState] = await db.select().from(apiProjectMetadataStateTable)
      .where(eq(apiProjectMetadataStateTable.workspaceId, workspaceId));

    globalThis.fetch = async () => new Response("private payload", { status: 503 });
    await refreshProjectMetadata(workspaceId, true).catch(() => undefined);

    const snapshot = await readProjectMetadata([workspaceId]);
    expect(snapshot.byWorkspace.get(workspaceId)?.size).toBe(0);
    expect(snapshot.completeWorkspaceIds.has(workspaceId)).toBe(true);
    expect(snapshot.freshnessByWorkspace.get(workspaceId)).toEqual({
      status: "failed",
      lastAttemptAt: expect.any(Date),
      lastSuccessfulAt: successfulState?.completedAt,
    });
  });

  it("defers an aborted slice without replacing last-good rows or admitting the next workspace", async () => {
    const workspaceId = workspaceIds[5]!;
    const nextWorkspaceId = workspaceIds[6]!;
    const lastSuccessfulAt = new Date(Date.now() - 60 * 60_000);
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    await db.insert(apiProjectMetadataStateTable).values([
      {
        workspaceId,
        status: "success",
        errorMessage: null,
        startedAt: lastSuccessfulAt,
        completedAt: lastSuccessfulAt,
        lastSuccessfulAt,
      },
      {
        workspaceId: nextWorkspaceId,
        status: "success",
        errorMessage: null,
        startedAt: new Date(Date.now() - 30 * 60_000),
        completedAt: new Date(Date.now() - 30 * 60_000),
        lastSuccessfulAt: new Date(Date.now() - 30 * 60_000),
      },
    ]);
    await db.insert(apiProjectMetadataTable).values({
      workspaceId,
      projectId: "last-good",
      title: "Last good",
      creatorId: "creator",
      fetchedAt: lastSuccessfulAt,
    });

    const controller = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 60_000 ? controller.signal : originalTimeout(ms)
    );
    const admitted: string[] = [];
    globalThis.fetch = async (input, init) => {
      admitted.push(new URL(String(input)).searchParams.get("workspaceId")!);
      controller.abort(new DOMException("slice deadline", "TimeoutError"));
      throw init?.signal?.reason ?? controller.signal.reason;
    };

    const counters = await refreshProjectMetadataSlice([nextWorkspaceId, workspaceId]);

    expect(counters).toEqual({
      considered: 2,
      attempted: 2,
      succeeded: 0,
      failed: 0,
      deferred: 2,
      requests: 1,
      remaining: 2,
    });
    expect(admitted).toEqual([null]);
    const [state, rows] = await Promise.all([
      db.select().from(apiProjectMetadataStateTable)
        .where(eq(apiProjectMetadataStateTable.workspaceId, workspaceId)),
      db.select().from(apiProjectMetadataTable)
        .where(eq(apiProjectMetadataTable.workspaceId, workspaceId)),
    ]);
    expect(state[0]).toMatchObject({
      status: "unavailable",
      lastSuccessfulAt,
    });
    expect(rows).toEqual([
      expect.objectContaining({ projectId: "last-good", creatorId: "creator" }),
    ]);
  });
});