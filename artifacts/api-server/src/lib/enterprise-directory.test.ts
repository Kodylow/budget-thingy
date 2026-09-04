import { afterEach, describe, expect, it } from "vitest";
import {
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
  isInternalReplitEmail,
  persistCanonicalFamilyFinancialRows,
  parseDirectoryGroupName,
  type EnterpriseMember,
} from "./enterprise";
import {
  resolveAuthorization,
  resolvePreviewAuthorization,
  type Authorization,
} from "./authz";

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

  it("generates stable workspace-qualified teams for collisions while named overrides share", () => {
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
      .toBe("Shared Family [one]");
    expect(account.familiesById.get("two:shared family")?.teamName)
      .toBe("Shared Family [two]");
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
    expect(effective.byRoleGroupId.get("one-shared")).toBe("Shared Family [one]");
    expect(effective.byRoleGroupId.get("two-shared")).toBe("Shared Family [two]");
  });

  it("seeds distinct targets and zero-allocation budget identities for colliding families", async () => {
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
      expect(new Set(targets.map((target) => target.teamName))).toEqual(new Set(teamNames));
      expect(budgets).toEqual(expect.arrayContaining(teamNames.map((teamName) =>
        expect.objectContaining({ teamName, originalAmountUsd: 0, amountUsd: 0 })
      )));
    } finally {
      await db.delete(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      await db.delete(teamBudgetsTable)
        .where(inArray(teamBudgetsTable.teamName, teamNames));
    }
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

  it("leaves pre-provenance targets untouched and seeds new collision-safe automatic targets", async () => {
    const workspaceIds = ["__auto_collision_one__", "__auto_collision_two__"];
    const groupIds = ["__auto_collision_group_one__", "__auto_collision_group_two__"];
    const familyKey = "__auto collision family__";
    const familyName = "Auto Collision Family";
    const generatedTeamNames = workspaceIds.map((workspaceId) =>
      `${familyName} [${workspaceId}]`
    );
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
        .toEqual(new Set(generatedTeamNames));
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
      expect(effective.byRoleGroupId.get(groupIds[0]!)).toBe(generatedTeamNames[0]);
      expect(effective.byRoleGroupId.get(groupIds[1]!)).toBe(generatedTeamNames[1]);

      await db.delete(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      await persistCanonicalFamilyFinancialRows(account);
      const repairedTargets = await db.select().from(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      expect(new Set(repairedTargets.map((target) => target.teamName)))
        .toEqual(new Set(generatedTeamNames));
      expect(repairedTargets.every((target) => target.assignmentSource === "automatic"))
        .toBe(true);
      await db.update(teamLimitTargetsTable).set({
        teamName: familyName,
        monthlyLimitUsd: 42,
        isEnabled: false,
      }).where(and(
        eq(teamLimitTargetsTable.workspaceId, workspaceIds[0]!),
        eq(teamLimitTargetsTable.groupId, groupIds[0]!),
      ));
      await db.update(teamLimitTargetsTable).set({
        teamName: "Manual Shared Identity",
        assignmentSource: "manual",
      }).where(and(
        eq(teamLimitTargetsTable.workspaceId, workspaceIds[1]!),
        eq(teamLimitTargetsTable.groupId, groupIds[1]!),
      ));
      await persistCanonicalFamilyFinancialRows(account);
      const preservedTargets = await db.select().from(teamLimitTargetsTable)
        .where(inArray(teamLimitTargetsTable.groupId, groupIds));
      expect(preservedTargets.find((target) => target.groupId === groupIds[0]))
        .toMatchObject({
          teamName: generatedTeamNames[0],
          assignmentSource: "automatic",
          monthlyLimitUsd: 42,
          isEnabled: false,
        });
      expect(preservedTargets.find((target) => target.groupId === groupIds[1]))
        .toMatchObject({
          teamName: "Manual Shared Identity",
          assignmentSource: "manual",
        });

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
      await db.delete(teamBudgetsTable)
        .where(inArray(teamBudgetsTable.teamName, generatedTeamNames));
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
        canManageAccess: true,
        canEditAllocations: true,
        canWriteGroupLimits: true,
        canWriteUserLimitsIn: [],
      },
    };
    const preview = await resolvePreviewAuthorization(real, "team_admin:Growth MDU");
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
        canManageAccess: true,
        canEditAllocations: true,
        canWriteGroupLimits: true,
        canWriteUserLimitsIn: [],
      },
    };
    expect(await resolvePreviewAuthorization(real, "team_admin:Growth MDU")).toBe(real);
  });
});