// @ts-nocheck
import { test, expect, beforeAll, afterAll, afterEach } from "vitest";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  teamLimitTargetsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetAllocationAuditsTable,
  teamBudgetsTable,
  fundingGroupOverridesTable,
  fundingGroupOverrideAuditsTable,
  familyTeamMappingsTable,
  usageAccountDayTable,
  usageMemberDayTable,
  usageProjectDayTable,
  usageWorkspaceDayTable,
} from "@workspace/db";

import monitorRouter from "./monitor.ts";
import { setAuthorizationResolver } from "../middlewares/requireAuth.ts";
import { __setDirectoryCacheForTests, getDirectory } from "../lib/enterprise.ts";
import {
  setTeamBudgetDirectoryFetcherForTests,
  TEAM_BUDGET_SOURCE,
} from "../lib/team-budgets.ts";
import { invalidateUsageSnapshotMemo } from "../lib/usage-store.ts";
const PREFIX = "__task158_route__";
const ASSIGNED = `${PREFIX} Assigned`;
const BUDGET_ONLY = `${PREFIX} Budget Only`;
const ORIGINAL_ONLY = `${PREFIX} Original Only`;
const HIDDEN = `${PREFIX} Hidden`;
const GROUP_NAME = `${PREFIX} Group`;
const GROUP_ID = `${PREFIX}-group`;
const SECOND_GROUP_ID = `${PREFIX}-group-2`;
const HIDDEN_ZERO_GROUP_ID = `${PREFIX}-hidden-zero`;
const HIDDEN_ZERO_ALIAS_ID = `${PREFIX}-hidden-zero-alias`;
const VISIBLE_ZERO_GROUP_ID = `${PREFIX}-visible-zero`;
const SNAPSHOT_GROUP_ID = `${PREFIX}-snapshot-family`;
const LEGACY_GROUP_ID = `${PREFIX}-legacy-unsuffixed`;
const BUILTIN_GROUP_ID = `${PREFIX}-builtin-members`;
const HIDDEN_ZERO_NAME = `${PREFIX} Hidden Zero - Member`;
const VISIBLE_ZERO_NAME = `${PREFIX} Visible Zero - Member`;
const SHARED_PROJECT_ID = `${PREFIX}-shared-project`;
const USAGE_DATE = new Date().toISOString().slice(0, 10);
const PREVIOUS_USAGE_DATE = new Date(Date.parse(`${USAGE_DATE}T00:00:00.000Z`) - 86_400_000)
  .toISOString().slice(0, 10);
const COMPLETE_RANGE = `rangeType=custom&startDate=${USAGE_DATE}&endDate=${USAGE_DATE}`;
const PARTIAL_RANGE =
  `rangeType=custom&startDate=${PREVIOUS_USAGE_DATE}&endDate=${USAGE_DATE}`;

function member(userId, isAccountAdmin, workspaces = {}) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.com`,
    name: userId,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

let server;
let baseUrl;

beforeAll(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test-key";
  __setDirectoryCacheForTests({
    workspaces: new Map([
      ["task158-ws", {
        id: "task158-ws",
        name: "Task 158",
        slug: "task-158",
        memberCount: 2,
      }],
      ["task158-ws-2", {
        id: "task158-ws-2",
        name: "Task 158 Two",
        slug: "task-158-two",
        memberCount: 1,
      }],
      ["1awqan", {
        id: "1awqan",
        name: "Legacy Comcast",
        slug: "legacy-comcast",
        memberCount: 0,
      }],
    ]),
    groups: [
      {
        id: GROUP_ID,
        workspaceId: "task158-ws",
        name: GROUP_NAME,
        type: "custom",
      },
      {
        id: SECOND_GROUP_ID,
        workspaceId: "task158-ws-2",
        name: `${GROUP_NAME} Two`,
        type: "custom",
      },
      {
        id: HIDDEN_ZERO_GROUP_ID,
        workspaceId: "task158-ws",
        name: HIDDEN_ZERO_NAME,
        type: "custom",
      },
      {
        id: HIDDEN_ZERO_ALIAS_ID,
        workspaceId: "task158-ws-2",
        name: HIDDEN_ZERO_NAME,
        type: "custom",
      },
      {
        id: VISIBLE_ZERO_GROUP_ID,
        workspaceId: "task158-ws",
        name: VISIBLE_ZERO_NAME,
        type: "custom",
      },
      {
        id: SNAPSHOT_GROUP_ID,
        workspaceId: "task158-ws",
        name: "Snapshot Only",
        type: "custom",
      },
      {
        id: LEGACY_GROUP_ID,
        workspaceId: "1awqan",
        name: "Executive Group",
        type: "custom",
      },
      {
        id: BUILTIN_GROUP_ID,
        workspaceId: "task158-ws",
        name: "Members",
        type: "member",
      },
    ],
    members: new Map([
      ["task158-account", member("task158-account", true)],
      ["task158-own-account", member("task158-own-account", true, {
        "task158-ws": { role: "admin", isDisabled: false },
      })],
      ["task158-workspace", member("task158-workspace", false, {
        "task158-ws": { role: "admin", isDisabled: false },
      })],
      ["task158-plain", member("task158-plain", false, {
        "task158-ws": { role: "member", isDisabled: false },
      })],
      ["task158-viewer", member("task158-viewer", false, {
        "task158-ws": { role: "viewer", isDisabled: false },
      })],
      ["task158-unknown-role", member("task158-unknown-role", false, {
        "task158-ws": { role: "future_role", isDisabled: false },
      })],
      ["task158-creator-2", member("task158-creator-2", false, {
        "task158-ws-2": { role: "member", isDisabled: false },
      })],
      ["task158-disabled", member("task158-disabled", false, {
        "task158-ws": { role: "member", isDisabled: true },
      })],
    ]),
    groupMembers: new Map([
      [GROUP_ID, [
        "task158-workspace",
        "task158-plain",
        "task158-plain",
        "task158-own-account",
        "task158-creator-2",
        "task158-disabled",
      ]],
      [SECOND_GROUP_ID, ["task158-creator-2"]],
      [HIDDEN_ZERO_GROUP_ID, []],
      [HIDDEN_ZERO_ALIAS_ID, []],
      [VISIBLE_ZERO_GROUP_ID, []],
      [LEGACY_GROUP_ID, []],
      [BUILTIN_GROUP_ID, []],
    ]),
  });
  const { resolveAuthorization } = await import("../lib/authz.ts");
  setAuthorizationResolver((userId) => {
    if (userId === "task158-delegate") {
      return Promise.resolve({
        role: "account", roles: ["account"], userId, workspaceIds: [],
        teamNames: [], groupIds: [], userIds: [userId], isTrueAccountAdmin: false,
        capabilities: {
          canViewAccountUsage: true,
          canManageAccess: false, canEditAllocations: true,
          canManageFundingMappings: false,
          canManageNotifications: false, canManageSystem: false,
          canPreviewRoles: false,
          canWriteGroupLimits: false, canWriteUserLimitsIn: [],
          canRunChecks: false, canSendTestEmail: false,
        },
      });
    }
    if (userId === "task158-readonly-account") {
      return Promise.resolve({
        role: "account", roles: ["account"], userId, workspaceIds: [],
        teamNames: [], groupIds: [], userIds: [userId], isTrueAccountAdmin: true,
        capabilities: {
          canViewAccountUsage: true,
          canManageAccess: false, canEditAllocations: false,
          canManageFundingMappings: false,
          canManageNotifications: false, canManageSystem: false,
          canPreviewRoles: false,
          canWriteGroupLimits: false, canWriteUserLimitsIn: [],
          canRunChecks: false, canSendTestEmail: false,
        },
        isPreview: true,
        previewReadOnly: true,
      });
    }
    if (userId === "task158-editor") {
      return Promise.resolve({
        role: "account", roles: ["account"], userId, workspaceIds: [],
        teamNames: [], groupIds: [], userIds: [userId], isTrueAccountAdmin: false,
        capabilities: {
          canViewAccountUsage: true,
          canManageAccess: false, canEditAllocations: true,
          canManageFundingMappings: false,
          canManageNotifications: false, canManageSystem: false,
          canPreviewRoles: false,
          canWriteGroupLimits: false, canWriteUserLimitsIn: [],
          canRunChecks: false, canSendTestEmail: false,
        },
      });
    }
    if (userId === "38408700") {
      return Promise.resolve({
        role: "account", roles: ["account"], userId, workspaceIds: [],
        teamNames: [], groupIds: [], userIds: [userId], isTrueAccountAdmin: false,
        capabilities: {
          canViewAccountUsage: true,
          canManageAccess: false, canEditAllocations: true,
          canManageFundingMappings: true,
          canManageNotifications: false, canManageSystem: false,
          canPreviewRoles: false,
          canWriteGroupLimits: false, canWriteUserLimitsIn: [],
          canRunChecks: false, canSendTestEmail: false,
        },
      });
    }
    return resolveAuthorization(userId);
  });
  setTeamBudgetDirectoryFetcherForTests(async () => ({
    allGroups: [{
      id: GROUP_ID,
      workspaceId: "task158-ws",
      name: GROUP_NAME,
      type: "custom",
    }],
  }));

  await db.delete(teamBudgetAdjustmentsTable).where(inArray(
    teamBudgetAdjustmentsTable.sourceRecordId,
    [`${PREFIX}-assigned`, `${PREFIX}-budget-only`, `${PREFIX}-hidden`],
  ));
  await db.delete(teamBudgetAllocationAuditsTable).where(inArray(
    teamBudgetAllocationAuditsTable.teamName,
    [ASSIGNED, BUDGET_ONLY, ORIGINAL_ONLY, HIDDEN],
  ));
  await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
    ASSIGNED,
    BUDGET_ONLY,
    ORIGINAL_ONLY,
    HIDDEN,
  ]));
  await db.delete(teamLimitTargetsTable).where(inArray(teamLimitTargetsTable.groupId, [
    GROUP_ID,
    SECOND_GROUP_ID,
    HIDDEN_ZERO_GROUP_ID,
    HIDDEN_ZERO_ALIAS_ID,
    VISIBLE_ZERO_GROUP_ID,
  ]));
  const usageWorkspaceIds = ["task158-ws", "task158-ws-2"];
  await db.delete(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, usageWorkspaceIds));
  await db.delete(apiProjectMetadataTable)
    .where(inArray(apiProjectMetadataTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageAccountDayTable)
    .where(eq(usageAccountDayTable.usageDate, USAGE_DATE));
  await db.delete(usageMemberDayTable)
    .where(inArray(usageMemberDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageProjectDayTable)
    .where(inArray(usageProjectDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageWorkspaceDayTable)
    .where(inArray(usageWorkspaceDayTable.workspaceId, usageWorkspaceIds));
  await db.insert(teamBudgetsTable).values([
    { teamName: ASSIGNED, amountUsd: 100, originalAmountUsd: 100 },
    { teamName: BUDGET_ONLY, amountUsd: 50, originalAmountUsd: 50 },
    { teamName: ORIGINAL_ONLY, amountUsd: 75, originalAmountUsd: 75 },
    { teamName: HIDDEN, amountUsd: 1000, originalAmountUsd: 1000, isHidden: true },
  ]);
  await db.insert(teamLimitTargetsTable).values([
    {
      workspaceId: "task158-ws",
      groupId: GROUP_ID,
      groupName: GROUP_NAME,
      teamName: ASSIGNED,
    },
    {
      workspaceId: "task158-ws",
      groupId: HIDDEN_ZERO_GROUP_ID,
      groupName: HIDDEN_ZERO_NAME,
      teamName: HIDDEN,
    },
    {
      workspaceId: "task158-ws-2",
      groupId: HIDDEN_ZERO_ALIAS_ID,
      groupName: HIDDEN_ZERO_NAME,
      teamName: HIDDEN,
    },
    {
      workspaceId: "task158-ws",
      groupId: VISIBLE_ZERO_GROUP_ID,
      groupName: VISIBLE_ZERO_NAME,
      teamName: ASSIGNED,
    },
  ]);
  await db.insert(usageMemberDayTable).values([
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      userId: "task158-workspace",
      totalCostUsd: 15,
      aiCostUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
    },
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      userId: "task158-plain",
      totalCostUsd: 5,
      aiCostUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
    },
  ]);
  await db.insert(usageWorkspaceDayTable).values([
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      totalCostUsd: 20,
      memberAttributableUsd: 20,
      memberUnattributableUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
      status: "complete",
    },
    {
      workspaceId: "task158-ws-2",
      usageDate: USAGE_DATE,
      totalCostUsd: 13,
      memberAttributableUsd: 13,
      memberUnattributableUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
      status: "complete",
    },
  ]);
  await db.insert(usageAccountDayTable).values({
    usageDate: USAGE_DATE,
    totalCostUsd: 33,
    fetchedAt: new Date(),
  });
  await db.insert(usageProjectDayTable).values([
    {
      workspaceId: "task158-ws",
      usageDate: USAGE_DATE,
      projectId: SHARED_PROJECT_ID,
      totalCostUsd: 20,
      metricsJson: [],
      fetchedAt: new Date(),
    },
    {
      workspaceId: "task158-ws-2",
      usageDate: USAGE_DATE,
      projectId: SHARED_PROJECT_ID,
      totalCostUsd: 13,
      metricsJson: [],
      fetchedAt: new Date(),
    },
  ]);
  await db.insert(apiProjectMetadataTable).values([
    {
      workspaceId: "task158-ws",
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project One",
      creatorId: "task158-workspace",
      fetchedAt: new Date(Date.now() - 2_000),
    },
    {
      workspaceId: "task158-ws-2",
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project Two",
      creatorId: "task158-creator-2",
      fetchedAt: new Date(),
    },
  ]);
  await db.insert(apiProjectMetadataStateTable).values(
    usageWorkspaceIds.map((workspaceId) => ({
      workspaceId,
      status: "success",
      completedAt: new Date(),
      lastSuccessfulAt: new Date(),
    })),
  );
  invalidateUsageSnapshotMemo();
  await db.insert(teamBudgetAdjustmentsTable).values([
    {
      source: TEAM_BUDGET_SOURCE,
      sourceRecordId: `${PREFIX}-assigned`,
      sourceTeamName: ASSIGNED,
      teamName: ASSIGNED,
      amountUsd: 25,
      submissionPeriod: "2026-01",
      matchState: "accepted",
    },
    {
      source: TEAM_BUDGET_SOURCE,
      sourceRecordId: `${PREFIX}-budget-only`,
      sourceTeamName: BUDGET_ONLY,
      teamName: BUDGET_ONLY,
      amountUsd: 10,
      submissionPeriod: "2026-02",
      matchState: "accepted",
    },
    {
      source: TEAM_BUDGET_SOURCE,
      sourceRecordId: `${PREFIX}-hidden`,
      sourceTeamName: HIDDEN,
      teamName: HIDDEN,
      amountUsd: 500,
      submissionPeriod: "2026-03",
      matchState: "accepted",
    },
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { info() {}, warn() {}, error() {} } as typeof req.log;
    const userId = req.headers["x-test-user"];
    req.isAuthenticated = function () { return this.user != null; };
    if (userId) req.user = { id: String(userId) };
    next();
  });
  app.use("/api", monitorRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server?.close();
  setAuthorizationResolver(null);
  setTeamBudgetDirectoryFetcherForTests(null);
  __setDirectoryCacheForTests(null);
  const usageWorkspaceIds = ["task158-ws", "task158-ws-2"];
  await db.delete(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, usageWorkspaceIds));
  await db.delete(apiProjectMetadataTable)
    .where(inArray(apiProjectMetadataTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageAccountDayTable)
    .where(eq(usageAccountDayTable.usageDate, USAGE_DATE));
  await db.delete(usageMemberDayTable)
    .where(inArray(usageMemberDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageProjectDayTable)
    .where(inArray(usageProjectDayTable.workspaceId, usageWorkspaceIds));
  await db.delete(usageWorkspaceDayTable)
    .where(inArray(usageWorkspaceDayTable.workspaceId, usageWorkspaceIds));
  invalidateUsageSnapshotMemo();
  await db.delete(teamBudgetAdjustmentsTable).where(inArray(
    teamBudgetAdjustmentsTable.sourceRecordId,
    [`${PREFIX}-assigned`, `${PREFIX}-budget-only`, `${PREFIX}-hidden`],
  ));
  await db.delete(teamBudgetAllocationAuditsTable).where(inArray(
    teamBudgetAllocationAuditsTable.teamName,
    [ASSIGNED, BUDGET_ONLY, ORIGINAL_ONLY, HIDDEN],
  ));
  await db.delete(teamLimitTargetsTable).where(inArray(teamLimitTargetsTable.groupId, [
    GROUP_ID,
    SECOND_GROUP_ID,
    HIDDEN_ZERO_GROUP_ID,
    HIDDEN_ZERO_ALIAS_ID,
    VISIBLE_ZERO_GROUP_ID,
  ]));
  await db.delete(teamBudgetsTable).where(inArray(teamBudgetsTable.teamName, [
    ASSIGNED,
    BUDGET_ONLY,
    ORIGINAL_ONLY,
    HIDDEN,
  ]));
  delete process.env.REPLIT_ENTERPRISE_API_KEY;
});

async function request(path, user, method = "GET", body = undefined) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return {
    status: response.status,
    json,
    headers: response.headers,
  };
}

test("budget audit and sync status reject workspace-scoped users", async () => {
  for (const path of ["/admin/team-budgets/history", "/admin/team-budgets/sync"]) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, "task158-plain")).status).toBe(403);
    expect((await request(path, "task158-workspace")).status).toBe(403);
    expect((await request(path, "task158-account")).status).toBe(200);
  }
});

test("funding group routes scope reads and enforce the narrow mutation capability", async () => {
  await db.delete(familyTeamMappingsTable).where(eq(
    familyTeamMappingsTable.familyKey,
    "snapshot only",
  ));
  await db.insert(familyTeamMappingsTable).values({
    workspaceId: "task158-ws",
    familyKey: "snapshot only",
    familyName: "Snapshot Only",
    teamName: ASSIGNED,
    isLegacy: false,
  });
  await db.delete(fundingGroupOverrideAuditsTable).where(inArray(
    fundingGroupOverrideAuditsTable.groupId,
    [VISIBLE_ZERO_GROUP_ID, HIDDEN_ZERO_GROUP_ID],
  ));
  await db.delete(fundingGroupOverridesTable).where(inArray(
    fundingGroupOverridesTable.groupId,
    [VISIBLE_ZERO_GROUP_ID, HIDDEN_ZERO_GROUP_ID],
  ));
  try {
    const allocationsBefore = await request(
      "/admin/team-budgets/history",
      "task158-account",
    );
    expect(allocationsBefore.status).toBe(200);
    expect((await request("/admin/funding-groups")).status).toBe(401);
    expect((await request("/admin/funding-groups", "task158-plain")).status).toBe(403);
    const adminInventory = await request(
      "/admin/funding-groups",
      "task158-account",
    );
    expect(adminInventory.status).toBe(200);
    expect(adminInventory.json.teams).toEqual(expect.arrayContaining([
      expect.objectContaining({ teamName: HIDDEN, isHidden: true }),
    ]));
    expect(adminInventory.json.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        groupId: HIDDEN_ZERO_GROUP_ID,
        memberCount: 0,
        teamName: HIDDEN,
        isHidden: true,
      }),
      expect.objectContaining({
        groupId: GROUP_ID,
        memberCount: 3,
      }),
      expect.objectContaining({
        groupId: SNAPSHOT_GROUP_ID,
        groupName: "Snapshot Only",
        memberCount: null,
        teamName: ASSIGNED,
        origin: "inferred",
      }),
      expect.objectContaining({
        workspaceId: "1awqan",
        groupId: LEGACY_GROUP_ID,
        groupName: "Executive Group",
        origin: "unmapped",
      }),
    ]));
    expect(adminInventory.json.groups.some(
      (group) => group.groupId === BUILTIN_GROUP_ID,
    )).toBe(false);

    const hiddenUnmap = await request(
      "/admin/funding-groups",
      "task158-account",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: HIDDEN_ZERO_GROUP_ID,
        teamName: null,
        expectedRevision: adminInventory.json.revision,
      },
    );
    expect(hiddenUnmap.status).toBe(200);
    expect(hiddenUnmap.json.groups.find(
      (group) => group.groupId === HIDDEN_ZERO_GROUP_ID,
    )).toMatchObject({ teamName: null, origin: "unmapped", isHidden: true });

    const delegateInventory = await request(
      "/admin/funding-groups",
      "task158-delegate",
    );
    expect(delegateInventory.status).toBe(200);
    expect(delegateInventory.json.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: "task158-ws",
        workspaceName: "Task 158",
        groupId: VISIBLE_ZERO_GROUP_ID,
        groupName: VISIBLE_ZERO_NAME,
        memberCount: 0,
        teamName: ASSIGNED,
        origin: "inferred",
        isHidden: false,
      }),
    ]));
    expect(delegateInventory.json.teams.some(
      (team) => team.teamName === HIDDEN,
    )).toBe(false);
    expect(delegateInventory.json.groups.some(
      (group) => group.groupId === HIDDEN_ZERO_GROUP_ID,
    )).toBe(false);

    const forged = await request(
      "/admin/funding-groups",
      "task158-delegate",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: null,
        expectedRevision: delegateInventory.json.revision,
      },
    );
    expect(forged.status).toBe(403);
    expect((await request(
      "/admin/funding-groups",
      "task158-readonly-account",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: null,
        expectedRevision: delegateInventory.json.revision,
      },
    )).status).toBe(403);
    expect((await request(
      "/admin/funding-groups/audit",
      "task158-readonly-account",
    )).status).toBe(403);
    const kodyAuditBefore = await request(
      "/admin/funding-groups/audit",
      "38408700",
    );
    expect(kodyAuditBefore.status).toBe(200);
    expect(kodyAuditBefore.json.changes.some(
      (change) => change.groupId === HIDDEN_ZERO_GROUP_ID,
    )).toBe(false);
    expect((await request(
      "/admin/funding-groups",
      "38408700",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: HIDDEN_ZERO_GROUP_ID,
        teamName: ASSIGNED,
        expectedRevision: delegateInventory.json.revision,
      },
    )).status).toBe(404);
    expect((await request(
      "/admin/funding-groups",
      "38408700",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: HIDDEN,
        expectedRevision: delegateInventory.json.revision,
      },
    )).status).toBe(404);

    const unmapped = await request(
      "/admin/funding-groups",
      "38408700",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: null,
        expectedRevision: delegateInventory.json.revision,
      },
    );
    expect(unmapped.status).toBe(200);
    expect(unmapped.json.groups.find(
      (group) => group.groupId === VISIBLE_ZERO_GROUP_ID,
    )).toMatchObject({ memberCount: 0, teamName: null, origin: "unmapped" });

    const cachedDirectory = await getDirectory();
    __setDirectoryCacheForTests({
      fetchedAt: Date.now(),
      workspaces: new Map(cachedDirectory.workspaces),
      groups: [...cachedDirectory.groups],
      groupMembers: new Map(cachedDirectory.groupMembers),
      members: new Map(cachedDirectory.members),
      budgets: cachedDirectory.budgets,
    });
    const afterDirectoryRefresh = await request(
      "/admin/funding-groups",
      "38408700",
    );
    expect(afterDirectoryRefresh.status).toBe(200);
    expect(afterDirectoryRefresh.json.groups.find(
      (group) => group.groupId === VISIBLE_ZERO_GROUP_ID,
    )).toMatchObject({ teamName: null, origin: "unmapped" });
    expect(afterDirectoryRefresh.json.groups.find(
      (group) => group.groupId === SNAPSHOT_GROUP_ID,
    )).toMatchObject({ teamName: ASSIGNED, origin: "inferred" });

    expect((await request(
      "/admin/funding-groups",
      "task158-account",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: ASSIGNED,
        expectedRevision: delegateInventory.json.revision,
      },
    )).status).toBe(409);
    expect((await request(
      "/admin/funding-groups",
      "38408700",
      "PATCH",
      {
        workspaceId: "wrong-workspace",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: ASSIGNED,
        expectedRevision: unmapped.json.revision,
      },
    )).status).toBe(404);
    expect((await request(
      "/admin/funding-groups",
      "38408700",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: ASSIGNED,
        expectedRevision: unmapped.json.revision,
        forgedCapability: true,
      },
    )).status).toBe(400);

    const reassigned = await request(
      "/admin/funding-groups",
      "task158-account",
      "PATCH",
      {
        workspaceId: "task158-ws",
        groupId: VISIBLE_ZERO_GROUP_ID,
        teamName: ASSIGNED,
        expectedRevision: unmapped.json.revision,
      },
    );
    expect(reassigned.status).toBe(200);
    expect(reassigned.json.groups.find(
      (group) => group.groupId === VISIBLE_ZERO_GROUP_ID,
    )).toMatchObject({
      memberCount: 0,
      teamName: ASSIGNED,
      origin: "explicit",
    });
    expect(reassigned.json.groups.find(
      (group) => group.groupId === SNAPSHOT_GROUP_ID,
    )).toMatchObject({ memberCount: null });
    const persistedReassignment = await request(
      "/admin/funding-groups",
      "task158-account",
    );
    expect(persistedReassignment.status).toBe(200);
    expect(persistedReassignment.json.groups.find(
      (group) => group.groupId === VISIBLE_ZERO_GROUP_ID,
    )).toMatchObject({
      memberCount: 0,
      teamName: ASSIGNED,
      origin: "explicit",
    });

    const audit = await request("/admin/funding-groups/audit", "38408700");
    expect(audit.status).toBe(200);
    expect(audit.json.changes.filter(
      (change) => change.groupId === VISIBLE_ZERO_GROUP_ID,
    ).slice(0, 2)).toEqual([
      expect.objectContaining({
        workspaceId: "task158-ws",
        previousTeamName: null,
        newTeamName: ASSIGNED,
        actor: "task158-account",
      }),
      expect.objectContaining({
        previousTeamName: ASSIGNED,
        newTeamName: null,
        actor: "38408700",
      }),
    ]);
    const allocationsAfter = await request(
      "/admin/team-budgets/history",
      "task158-account",
    );
    expect(allocationsAfter.status).toBe(200);
    expect(allocationsAfter.json.teams).toEqual(allocationsBefore.json.teams);
    const directoryAfter = await getDirectory();
    expect(directoryAfter.budgets).toEqual(cachedDirectory.budgets);
  } finally {
    await db.delete(fundingGroupOverrideAuditsTable).where(inArray(
      fundingGroupOverrideAuditsTable.groupId,
      [VISIBLE_ZERO_GROUP_ID, HIDDEN_ZERO_GROUP_ID],
    ));
    await db.delete(fundingGroupOverridesTable).where(inArray(
      fundingGroupOverridesTable.groupId,
      [VISIBLE_ZERO_GROUP_ID, HIDDEN_ZERO_GROUP_ID],
    ));
    await db.delete(familyTeamMappingsTable).where(eq(
      familyTeamMappingsTable.familyKey,
      "snapshot only",
    ));
  }
});

afterEach(async () => {
  await request(
    `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/visibility`,
    "task158-account",
    "PATCH",
    { isHidden: false },
  );
  await request(
    `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/allocation`,
    "task158-account",
    "PATCH",
    { annualAllocationUsd: 100 },
  );
});

test("sync status identifies the approval-only Finance Approval feed", async () => {
  const { status, json } = await request(
    "/admin/team-budgets/sync",
    "task158-account",
  );
  expect(status).toBe(200);
  expect(json.sourceTable).toBe("Replit Finance Approval");
  expect(json.requiredApprovalStatus).toBe("Approved");
});

test("history orders months and exposes hidden teams only to true admins", async () => {
  const { status, json } = await request(
    "/admin/team-budgets/history",
    "task158-account",
  );
  expect(status).toBe(200);
  expect(json.teams.find((team) => team.teamName === HIDDEN)).toMatchObject({
    isHidden: true,
    originalAmountUsd: 1000,
  });
  const delegate = await request("/admin/team-budgets/history", "task158-delegate");
  expect(delegate.status).toBe(200);
  expect(delegate.json.teams.some((team) => team.teamName === HIDDEN)).toBe(false);

  const assigned = json.teams.find((team) => team.teamName === ASSIGNED);
  const budgetOnly = json.teams.find((team) => team.teamName === BUDGET_ONLY);
  expect(assigned).toMatchObject({
    originalAmountUsd: 100,
    effectiveAmountUsd: 125,
    monthlyLimitUsd: 10.42,
    monthlyLimitSource: "derived",
  });
  expect(assigned.adjustments.map((row) => row.submissionPeriod)).toEqual(["2026-01"]);
  expect(budgetOnly.effectiveAmountUsd).toBe(60);
});

test("read-only account preview can read allocations but cannot mutate them", async () => {
  const history = await request(
    "/admin/team-budgets/history",
    "task158-readonly-account",
  );
  expect(history.status).toBe(200);
  expect(history.json.teams.some((team) => team.teamName === ASSIGNED)).toBe(true);

  const allocationPath =
    `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/allocation`;
  expect((await request(
    allocationPath,
    "task158-readonly-account",
    "PATCH",
    { annualAllocationUsd: 999 },
  )).status).toBe(403);
  expect((await request(
    "/admin/team-budgets/audit",
    "task158-readonly-account",
  )).status).toBe(403);
});

test("manual monthly allocations are validated, idempotent, audited, and rolled up", async () => {
  const key = "00000000-0000-4000-8000-000000000001";
  const path = `/admin/team-budgets/${encodeURIComponent(BUDGET_ONLY)}/allocations`;
  try {
    expect((await request(path, undefined, "POST", {
      month: "2026-04",
      amountUsd: 10.01,
      idempotencyKey: key,
    })).status).toBe(401);
    expect((await request(path, "task158-plain", "POST", {
      month: "2026-04",
      amountUsd: 10.01,
      idempotencyKey: key,
    })).status).toBe(403);
    expect((await request(path, "task158-editor", "POST", {
      month: "2026-13",
      amountUsd: 10.001,
      idempotencyKey: "not-a-uuid",
    })).status).toBe(400);

    const created = await request(path, "task158-editor", "POST", {
      month: "2026-04",
      amountUsd: 10.01,
      idempotencyKey: key,
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      teamName: BUDGET_ONLY,
      effectiveAmountUsd: 70.01,
      annualAllocationUsd: 70.01,
    });
    expect(created.json.adjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordId: key,
        source: "manual-allocation",
        sourceKind: "manual_allocation",
        submissionPeriod: "2026-04",
        amountUsd: 10.01,
      }),
    ]));

    expect((await request(path, "task158-editor", "POST", {
      month: "2026-04",
      amountUsd: 10.01,
      idempotencyKey: key,
    })).status).toBe(201);
    expect((await request(path, "task158-editor", "POST", {
      month: "2026-05",
      amountUsd: 10.01,
      idempotencyKey: key,
    })).status).toBe(409);

    const audits = await request("/admin/team-budgets/audit", "task158-editor");
    expect(audits.status).toBe(200);
    expect(audits.json.changes.filter((change) =>
      change.teamName === BUDGET_ONLY &&
      change.field === "monthlyAllocationAddition"
    )).toEqual([
      expect.objectContaining({
        oldValue: { month: "2026-04", amountUsd: 0 },
        newValue: { month: "2026-04", amountUsd: 10.01 },
        actor: "task158-editor",
      }),
    ]);
  } finally {
    await db.delete(teamBudgetAdjustmentsTable).where(eq(
      teamBudgetAdjustmentsTable.sourceRecordId,
      key,
    ));
    await db.delete(teamBudgetAllocationAuditsTable).where(eq(
      teamBudgetAllocationAuditsTable.teamName,
      BUDGET_ONLY,
    ));
  }
});

test("scoped allocation editors cannot discover hidden teams or read their audits", async () => {
  const adminKey = "00000000-0000-4000-8000-000000000002";
  const scopedKey = "00000000-0000-4000-8000-000000000003";
  const path = `/admin/team-budgets/${encodeURIComponent(HIDDEN)}/allocations`;
  try {
    const created = await request(path, "task158-account", "POST", {
      month: "2026-04",
      amountUsd: 5,
      idempotencyKey: adminKey,
    });
    expect(created.status).toBe(201);

    const annualPath = `/admin/team-budgets/${encodeURIComponent(HIDDEN)}/allocation`;
    const adminAnnual = await request(annualPath, "task158-account", "PATCH", {
      annualAllocationUsd: 1100,
    });
    expect(adminAnnual.status).toBe(200);

    const refused = await request(path, "task158-editor", "POST", {
      month: "2026-05",
      amountUsd: 7,
      idempotencyKey: scopedKey,
    });
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ error: "Team not found" });

    const refusedAnnual = await request(annualPath, "task158-editor", "PATCH", {
      annualAllocationUsd: 1200,
    });
    expect(refusedAnnual.status).toBe(404);
    expect(refusedAnnual.json).toEqual({ error: "Team not found" });

    const scopedAudit = await request("/admin/team-budgets/audit", "task158-editor");
    expect(scopedAudit.status).toBe(200);
    expect(scopedAudit.json.changes.some((change) => change.teamName === HIDDEN)).toBe(false);

    const adminAudit = await request("/admin/team-budgets/audit", "task158-account");
    expect(adminAudit.status).toBe(200);
    expect(adminAudit.json.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        teamName: HIDDEN,
        field: "monthlyAllocationAddition",
        actor: "task158-account",
      }),
      expect.objectContaining({
        teamName: HIDDEN,
        field: "annualAllocationUsd",
        oldValue: 1000,
        newValue: 1100,
        actor: "task158-account",
      }),
    ]));

    const scopedRows = await db.select().from(teamBudgetAdjustmentsTable).where(eq(
      teamBudgetAdjustmentsTable.sourceRecordId,
      scopedKey,
    ));
    expect(scopedRows).toHaveLength(0);
  } finally {
    await request(
      `/admin/team-budgets/${encodeURIComponent(HIDDEN)}/allocation`,
      "task158-account",
      "PATCH",
      { annualAllocationUsd: 1000 },
    );
    await db.delete(teamBudgetAdjustmentsTable).where(inArray(
      teamBudgetAdjustmentsTable.sourceRecordId,
      [adminKey, scopedKey],
    ));
    await db.delete(teamBudgetAllocationAuditsTable).where(eq(
      teamBudgetAllocationAuditsTable.teamName,
      HIDDEN,
    ));
  }
});

test("allocation audit cursor traverses more than 200 authorized changes", async () => {
  const actorUserId = "task158-audit-pagination";
  await db.insert(teamBudgetAllocationAuditsTable).values(
    Array.from({ length: 201 }, (_, index) => ({
      teamName: ASSIGNED,
      field: "annualAllocationUsd" as const,
      oldValue: index,
      newValue: index + 1,
      actorUserId,
    })),
  );
  try {
    const first = await request("/admin/team-budgets/audit", "task158-account");
    expect(first.status).toBe(200);
    expect(first.json.changes).toHaveLength(200);
    const second = await request(
      `/admin/team-budgets/audit?beforeId=${first.json.changes.at(-1).id}`,
      "task158-account",
    );
    expect(second.status).toBe(200);
    const traversed = [...first.json.changes, ...second.json.changes]
      .filter((change) => change.actor === actorUserId);
    expect(new Set(traversed.map((change) => change.id)).size).toBe(201);

    const forbidden = await request(
      `/admin/team-budgets/audit?beforeId=${first.json.changes.at(-1).id}`,
      "task158-plain",
    );
    expect(forbidden.status).toBe(403);
  } finally {
    await db.delete(teamBudgetAllocationAuditsTable).where(eq(
      teamBudgetAllocationAuditsTable.actorUserId,
      actorUserId,
    ));
  }
});

test("editors edit planning while true admins edit visibility with newest-first audit", async () => {
  const allocationPath =
    `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/allocation`;
  const visibilityPath =
    `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/visibility`;

  const editorAllocation = await request(allocationPath, "task158-delegate", "PATCH", {
    annualAllocationUsd: 240,
  });
  expect(editorAllocation.status).toBe(200);
  expect(editorAllocation.json).toMatchObject({
    originalAmountUsd: 240,
    effectiveAmountUsd: 265,
    annualAllocationUsd: 265,
    monthlyLimitUsd: 22.08,
  });
  // Keep this test isolated: subsequent assertions start from the fixture's baseline.
  expect((await request(allocationPath, "task158-delegate", "PATCH", {
    annualAllocationUsd: 100,
  })).status).toBe(200);
  expect((await request(allocationPath, "task158-account", "PATCH", {
    annualAllocationUsd: -1,
  })).status).toBe(400);
  expect((await request(allocationPath, "task158-account", "PATCH", {
    annualAllocationUsd: 240,
    unexpected: true,
  })).status).toBe(400);

  const allocation = await request(allocationPath, "task158-account", "PATCH", {
    annualAllocationUsd: 240,
  });
  expect(allocation.status).toBe(200);
  expect(allocation.json).toMatchObject({
    originalAmountUsd: 240,
    effectiveAmountUsd: 265,
    annualAllocationUsd: 265,
    monthlyLimitUsd: 22.08,
    isHidden: false,
  });

  const visibility = await request(visibilityPath, "task158-account", "PATCH", {
    isHidden: true,
  });
  expect(visibility.status).toBe(200);
  expect(visibility.json.isHidden).toBe(true);

  const audit = await request("/admin/team-budgets/audit", "task158-account");
  expect(audit.status).toBe(200);
  expect(audit.json.changes.filter((change) => change.teamName === ASSIGNED).slice(0, 2))
    .toEqual([
      expect.objectContaining({
        field: "isHidden",
        oldValue: false,
        newValue: true,
        actor: "task158-account",
      }),
      expect.objectContaining({
        field: "annualAllocationUsd",
        oldValue: 100,
        newValue: 240,
        actor: "task158-account",
      }),
    ]);
  const editorAudit = await request(
    "/admin/team-budgets/audit",
    "task158-delegate",
  );
  expect(editorAudit.status).toBe(200);
  expect(editorAudit.json.changes.every(
    (change) => change.field === "annualAllocationUsd",
  )).toBe(true);

  const concurrent = await Promise.all([
    request(allocationPath, "task158-account", "PATCH", { annualAllocationUsd: 300 }),
    request(allocationPath, "task158-account", "PATCH", { annualAllocationUsd: 400 }),
  ]);
  expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
  const concurrentAudit = await request("/admin/team-budgets/audit", "task158-account");
  const allocationChanges = concurrentAudit.json.changes
    .filter((change) =>
      change.teamName === ASSIGNED && change.field === "annualAllocationUsd"
    )
    .slice(0, 2);
  expect(new Set(allocationChanges.map((change) => change.newValue))).toEqual(
    new Set([300, 400]),
  );
  const firstChange = allocationChanges.find((change) => change.oldValue === 240);
  const secondChange = allocationChanges.find((change) => change.oldValue !== 240);
  expect(firstChange).toBeDefined();
  expect(secondChange?.oldValue).toBe(firstChange?.newValue);

  await request(visibilityPath, "task158-account", "PATCH", { isHidden: false });
  await request(allocationPath, "task158-account", "PATCH", { annualAllocationUsd: 100 });
});

test("effective totals agree across configured pools, groups, and Spend", async () => {
  const assignedPoolId = `pool:team:${encodeURIComponent(ASSIGNED)}`;
  const [pools, ownAccountPools, ownWorkspacePools, groups, spend, dashboard] = await Promise.all([
    request("/teams/budgets", "task158-account"),
    request("/teams/budgets?scope=own&period=full-term", "task158-account"),
    request("/teams/budgets?scope=own&period=full-term", "task158-workspace"),
    request("/groups", "task158-account"),
    request("/spend/pools?rangeType=full-term&viewScope=all_authorized&pageSize=100", "task158-account"),
    request("/dashboard?rangeType=full-term&viewScope=all_authorized", "task158-account"),
  ]);
  expect(pools.status).toBe(200);
  expect(ownAccountPools.status).toBe(200);
  expect(ownWorkspacePools.status).toBe(200);
  expect(groups.status).toBe(200);
  expect(spend.status).toBe(200);
  expect(dashboard.status).toBe(200);

  const assignedPool = pools.json.budgets.find((budget) => budget.teamName === ASSIGNED);
  const budgetOnlyPool = pools.json.budgets.find((budget) => budget.teamName === BUDGET_ONLY);
  const originalOnlyPool = pools.json.budgets.find((budget) => budget.teamName === ORIGINAL_ONLY);
  expect(assignedPool.amountUsd).toBe(125);
  expect(budgetOnlyPool.amountUsd).toBe(60);
  expect(originalOnlyPool.amountUsd).toBe(75);
  for (const budget of pools.json.budgets) {
    expect(budget.poolId).toBe(`pool:team:${encodeURIComponent(budget.teamName)}`);
  }
  expect(budgetOnlyPool.workspaceIds).toEqual([]);
  expect(originalOnlyPool.workspaceIds).toEqual([]);
  expect(!pools.json.budgets.some((budget) => budget.teamName === HIDDEN)).toBeTruthy();
  expect(ownAccountPools.json.budgets).toEqual([]);
  expect(ownWorkspacePools.json.budgets.map((budget) => budget.teamName)).toEqual([ASSIGNED]);
  expect(ownWorkspacePools.json.budgets[0].poolId).toBe(assignedPoolId);
  expect(ownWorkspacePools.json.budgets[0]).toMatchObject({
    amountUsd: 125,
    spendScope: "partial",
  });
  expect(ownWorkspacePools.json.budgets[0].spendPeriodLabel).toBeTruthy();
  expect(ownWorkspacePools.json.budgets[0].spendUsd).toBeNull();

  const assignedGroup = groups.json.groups.find((group) => group.groupId === GROUP_ID);
  expect(assignedGroup.teamName).toBe(ASSIGNED);
  const assignedWorkspace = groups.json.hierarchy.find(
    (workspace) => workspace.workspaceId === assignedGroup.workspaceId,
  );
  const assignedTeam = assignedWorkspace.teams.find(
    (team) => team.teamName === ASSIGNED,
  );
  const assignedFamily = assignedTeam.families.find(
    (family) => family.familyKey === assignedGroup.familyKey,
  );
  expect(assignedFamily.groups.map((group) => group.groupId)).toContain(GROUP_ID);
  expect(assignedFamily.spendUsd).toBe(
    assignedFamily.groups.reduce(
      (sum, group) => sum + group.rollupSpendUsd,
      0,
    ),
  );
  expect(groups.json.teamBudgets[ASSIGNED]).toBe(125);
  expect(groups.json.teamBudgets[BUDGET_ONLY]).toBe(60);
  expect(groups.json.teamBudgets[ORIGINAL_ONLY]).toBe(75);
  expect(groups.json.teamBudgets[HIDDEN]).toBe(undefined);

  const spendPools = spend.json.rows.filter((row) => row.kind === "pool");
  expect(spendPools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: ASSIGNED, allocationUsd: 125, spendUsd: 20 }),
    expect.objectContaining({ name: BUDGET_ONLY, allocationUsd: 60, spendUsd: 0 }),
    expect.objectContaining({ name: ORIGINAL_ONLY, allocationUsd: 75, spendUsd: 0 }),
  ]));
  for (const teamName of [ASSIGNED, BUDGET_ONLY, ORIGINAL_ONLY]) {
    expect(
      spendPools.filter((row) => row.name === teamName),
      `${teamName} must be represented by exactly one canonical Spend pool row`,
    ).toHaveLength(1);
  }
  expect(spendPools.some((row) => row.name === HIDDEN)).toBe(false);
  const positiveVisiblePoolTotal = pools.json.budgets.reduce(
    (sum, budget) => sum + Math.max(0, budget.amountUsd),
    0,
  );
  expect(
    spend.json.totals.allocationUsd,
    "Spend must count every visible configured pool exactly once, including zero-spend and budget-only pools",
  ).toBeCloseTo(positiveVisiblePoolTotal, 8);
  expect(spendPools.reduce(
    (sum, row) => sum + (row.allocationUsd ?? 0),
    0,
  )).toBeCloseTo(positiveVisiblePoolTotal, 8);
  expect(spend.json.period).toEqual(dashboard.json.period);
  expect(spend.json.totals.spendUsd).toBe(
    dashboard.json.accounting.eligibleSpendUsd,
  );
  expect(dashboard.json.cards.find((card) => card.key === "allocated_budget")?.value)
    .toBeCloseTo(positiveVisiblePoolTotal, 8);
  expect(dashboard.json.cards.find((card) => card.key === "allocation_remaining")?.value)
    .toBeCloseTo(positiveVisiblePoolTotal - 20, 8);
});

test("team budget query rejects unsupported scope and period values", async () => {
  expect((await request("/teams/budgets?scope=organization", "task158-account")).status)
    .toBe(400);
  expect((await request("/teams/budgets?period=annual", "task158-account")).status)
    .toBe(400);
});

test("workspace-filtered team rows expose only that workspace contribution", async () => {
  const response = await request(
    "/teams/budgets?scope=own&period=full-term&workspaceId=task158-ws",
    "task158-workspace",
  );
  expect(response.status).toBe(200);
  expect(response.json.budgets).toEqual([
    expect.objectContaining({
      teamName: ASSIGNED,
      amountUsd: null,
      workspaceIds: ["task158-ws"],
      spendScope: "partial",
    }),
  ]);
});

test("regular members can read only their own workspace team Home summary", async () => {
  const poolId = encodeURIComponent(`pool:team:${encodeURIComponent(ASSIGNED)}`);
  const own = await request(
    `/reporting/teams/${poolId}?scope=own&workspaceId=task158-ws&includeBudgetTracking=true&trackingRange=selected&${COMPLETE_RANGE}`,
    "task158-plain",
  );
  expect(own.status).toBe(200);
  expect(own.json).toMatchObject({
    id: `pool:team:${encodeURIComponent(ASSIGNED)}`,
    groups: [],
    sourceGroups: [],
    members: [],
    budgetTracking: {
      comparisonsMatchBudgetWindow: false,
      reportingStart: USAGE_DATE,
      reportingEnd: USAGE_DATE,
    },
  });
  const directory = await getDirectory();
  const originalGroupMembers = directory.groupMembers.get(GROUP_ID) ?? [];
  directory.groupMembers.set(GROUP_ID, [
    ...originalGroupMembers,
    "task158-viewer",
    "task158-unknown-role",
  ]);
  try {
    for (const userId of ["task158-viewer", "task158-unknown-role"]) {
      const legacyMembershipOwn = await request(
        `/reporting/teams/${poolId}?scope=own&workspaceId=task158-ws&includeBudgetTracking=true&trackingRange=selected&${COMPLETE_RANGE}`,
        userId,
      );
      expect(legacyMembershipOwn.status).toBe(200);
    }
  } finally {
    directory.groupMembers.set(GROUP_ID, originalGroupMembers);
  }
  const accountAdminOwn = await request(
    `/reporting/teams/${poolId}?scope=own&workspaceId=task158-ws&includeBudgetTracking=true&trackingRange=selected&${COMPLETE_RANGE}`,
    "task158-own-account",
  );
  expect(accountAdminOwn.status).toBe(200);
  expect(accountAdminOwn.json).toEqual(own.json);
  const ownHierarchy = await request(
    `/reporting/teams/${poolId}?scope=own&workspaceId=task158-ws&includeBudgetTracking=true&includeHierarchy=true&${COMPLETE_RANGE}`,
    "task158-plain",
  );
  expect(ownHierarchy.status).toBe(403);
  expect(ownHierarchy.json.error).toMatch(/hierarchy/i);
  expect((await request(
    `/reporting/teams/${poolId}?includeHierarchy=maybe&${COMPLETE_RANGE}`,
    "task158-account",
  )).status).toBe(400);
  expect((await request(
    `/reporting/teams/${poolId}?includeHierarchy=true&${COMPLETE_RANGE}`,
    "task158-plain",
  )).status).toBe(403);

  const arbitraryPool = encodeURIComponent(
    `pool:team:${encodeURIComponent(BUDGET_ONLY)}`,
  );
  expect((await request(
    `/reporting/teams/${arbitraryPool}?scope=own&workspaceId=task158-ws&includeBudgetTracking=true&trackingRange=selected&${COMPLETE_RANGE}`,
    "task158-plain",
  )).status).toBe(403);
  expect((await request(
    `/reporting/teams/${arbitraryPool}?scope=own&workspaceId=task158-ws&includeBudgetTracking=true&trackingRange=selected&${COMPLETE_RANGE}`,
    "task158-own-account",
  )).status).toBe(403);
  expect((await request(
    `/reporting/teams/${poolId}?scope=own&workspaceId=task158-ws-2&includeBudgetTracking=true&trackingRange=selected&${COMPLETE_RANGE}`,
    "task158-plain",
  )).status).toBe(403);
});

test("team report hierarchy reconciles physical groups without changing defaults", async () => {
  const poolId = encodeURIComponent(`pool:team:${encodeURIComponent(ASSIGNED)}`);
  const plain = await request(
    `/reporting/teams/${poolId}?${COMPLETE_RANGE}`,
    "task158-account",
  );
  expect(plain.status).toBe(200);
  expect(plain.json.hierarchy).toBeUndefined();

  const response = await request(
    `/reporting/teams/${poolId}?includeHierarchy=true&viewScope=all_authorized&${COMPLETE_RANGE}`,
    "task158-account",
  );
  expect(response.status).toBe(200);
  expect(response.json.hierarchy).toHaveLength(1);
  const workspace = response.json.hierarchy[0];
  expect(workspace.workspaceId).toBe("task158-ws");
  expect(workspace.usageObserved).toBe(true);
  expect(workspace.isComplete).toBe(true);
  expect(workspace.groups.map((group) => group.groupId)).toEqual(
    expect.arrayContaining([GROUP_ID, VISIBLE_ZERO_GROUP_ID]),
  );
  expect(workspace.groups.reduce((sum, group) => sum + group.spendUsd, 0) +
    workspace.unattributedSpendUsd).toBeCloseTo(workspace.spendUsd, 8);
  for (const group of workspace.groups) {
    expect(group.members.reduce((sum, member) => sum + member.spendUsd, 0) +
      group.unattributedSpendUsd).toBeCloseTo(group.spendUsd, 8);
  }
  expect(response.json.hierarchy.reduce(
    (sum, item) => sum + item.spendUsd,
    0,
  )).toBeCloseTo(response.json.headline.spendUsd, 8);
});

test("hierarchical team reports reconcile to Spend for each requested view scope", async () => {
  const poolId = encodeURIComponent(`pool:team:${encodeURIComponent(ASSIGNED)}`);
  for (const [caller, viewScope] of [
    ["task158-workspace", "my"],
    ["task158-workspace", "managed"],
    ["task158-account", "all_authorized"],
  ]) {
    const [spend, detail] = await Promise.all([
      request(
        `/spend/pools?viewScope=${viewScope}&pageSize=100&${COMPLETE_RANGE}`,
        caller,
      ),
      request(
        `/reporting/teams/${poolId}?includeHierarchy=true&viewScope=${viewScope}&${COMPLETE_RANGE}`,
        caller,
      ),
    ]);
    expect(spend.status).toBe(200);
    expect(detail.status).toBe(200);
    const pool = spend.json.rows.find((row) => row.id ===
      `pool:team:${encodeURIComponent(ASSIGNED)}`);
    expect(detail.json.headline.spendUsd).toBe(pool.spendUsd);
    expect(detail.json.hierarchy.reduce(
      (sum, workspace) => sum + workspace.spendUsd,
      detail.json.hierarchyUnattributedSpendUsd,
    )).toBeCloseTo(detail.json.headline.spendUsd, 8);
    if (viewScope === "my") {
      const memberIds = detail.json.hierarchy.flatMap((workspace) =>
        workspace.groups.flatMap((group) =>
          group.members.map((member) => member.userId)));
      expect(new Set(memberIds)).toEqual(new Set(["task158-workspace"]));
    }
  }
});

test("partial hierarchy marks mapped zero rows incomplete rather than confirmed complete", async () => {
  const poolId = encodeURIComponent(`pool:team:${encodeURIComponent(ASSIGNED)}`);
  const response = await request(
    `/reporting/teams/${poolId}?includeHierarchy=true&viewScope=all_authorized&${PARTIAL_RANGE}`,
    "task158-account",
  );
  expect(response.status).toBe(200);
  const workspace = response.json.hierarchy.find(
    (item) => item.workspaceId === "task158-ws",
  );
  expect(workspace.isComplete).toBe(false);
  const zero = workspace.groups.find(
    (group) => group.groupId === VISIBLE_ZERO_GROUP_ID,
  );
  expect(zero.spendUsd).toBe(0);
  expect(zero.isComplete).toBe(false);
});

test("hierarchy keeps physical team sources separate and workspace filtering bounded", async () => {
  await db.insert(teamLimitTargetsTable).values({
    workspaceId: "task158-ws-2",
    groupId: SECOND_GROUP_ID,
    groupName: `${GROUP_NAME} Two`,
    teamName: ASSIGNED,
  });
  try {
    invalidateUsageSnapshotMemo();
    const poolId = encodeURIComponent(`pool:team:${encodeURIComponent(ASSIGNED)}`);
    const [all, filtered] = await Promise.all([
      request(
        `/reporting/teams/${poolId}?includeHierarchy=true&viewScope=all_authorized&${COMPLETE_RANGE}`,
        "task158-account",
      ),
      request(
        `/reporting/teams/${poolId}?includeHierarchy=true&viewScope=all_authorized&workspaceId=task158-ws-2&${COMPLETE_RANGE}`,
        "task158-account",
      ),
    ]);
    expect(all.status).toBe(200);
    expect(filtered.status).toBe(200);
    expect(all.json.hierarchy.map((workspace) => workspace.workspaceId))
      .toEqual(["task158-ws", "task158-ws-2"]);
    expect(filtered.json.hierarchy.map((workspace) => workspace.workspaceId))
      .toEqual(["task158-ws-2"]);
    expect(filtered.json.hierarchy[0].groups.map((group) => group.groupId))
      .toEqual([SECOND_GROUP_ID]);
    expect(filtered.json.headline.spendUsd).toBe(
      filtered.json.hierarchy[0].spendUsd +
        filtered.json.hierarchyUnattributedSpendUsd,
    );
    expect(all.json.headline.spendUsd).toBe(
      all.json.hierarchy.reduce(
        (sum, workspace) => sum + workspace.spendUsd,
        all.json.hierarchyUnattributedSpendUsd,
      ),
    );
  } finally {
    await db.delete(teamLimitTargetsTable)
      .where(eq(teamLimitTargetsTable.groupId, SECOND_GROUP_ID));
    invalidateUsageSnapshotMemo();
  }
});

test("future-only comparison ranges fail as a date error, not metadata outage", async () => {
  const future = new Date(
    Date.parse(`${USAGE_DATE}T00:00:00.000Z`) + 86_400_000,
  ).toISOString().slice(0, 10);
  const response = await request(
    `/spend/billing-cycles?rangeType=custom&startDate=${future}&endDate=${future}`,
    "task158-plain",
  );
  expect(response.status).toBe(400);
  expect(response.json.error).toMatch(/current date/i);
});

test("shared reporting entry rejects extreme custom ranges before accounting", async () => {
  const poolId = encodeURIComponent(`pool:team:${encodeURIComponent(ASSIGNED)}`);
  for (const extreme of [
    "rangeType=custom&startDate=0006-02-02&endDate=2026-09-05",
    "rangeType=custom&startDate=2026-09-05&endDate=6090-02-02",
  ]) {
    for (const path of [
      `/dashboard?${extreme}`,
      `/spend/pools?${extreme}`,
      `/reporting/teams/${poolId}?${extreme}`,
    ]) {
      const response = await request(path, "task158-account");
      expect(response.status).toBe(400);
      expect(response.json.error).toMatch(/limited to 400 inclusive days/i);
    }
  }

  const boundary = await request(
    "/dashboard?rangeType=custom&startDate=2026-05-20&endDate=2027-06-23",
    "task158-account",
  );
  expect(boundary.status).toBe(200);
});

test("hidden-mapped and unmapped aliases stay separate without changing accounting", async () => {
  invalidateUsageSnapshotMemo();
  const [groups, dashboard] = await Promise.all([
    request(`/groups?${COMPLETE_RANGE}`, "task158-account"),
    request(`/dashboard?viewScope=all_authorized&${COMPLETE_RANGE}`, "task158-account"),
  ]);
  expect(groups.status).toBe(200);
  expect(groups.json.usageHealth.status).toBe("partial");
  expect(dashboard.status).toBe(200);

  const returnedIds = groups.json.groups.map((group) => group.groupId);
  const hierarchyIds = groups.json.hierarchy.flatMap((workspace) =>
    workspace.teams.flatMap((team) =>
      team.families.flatMap((family) => family.groups.map((group) => group.groupId))
    )
  );
  expect(returnedIds).toContain(HIDDEN_ZERO_GROUP_ID);
  expect(returnedIds).not.toContain(HIDDEN_ZERO_ALIAS_ID);
  expect(hierarchyIds).toContain(HIDDEN_ZERO_GROUP_ID);
  expect(hierarchyIds).not.toContain(HIDDEN_ZERO_ALIAS_ID);
  expect(returnedIds).toContain(VISIBLE_ZERO_GROUP_ID);
  expect(groups.json.workspaceTeamRawSpend.some((row) => row.teamName === HIDDEN))
    .toBe(false);
  expect(groups.json.eligibleSpendUsd).toBe(33);
  expect(dashboard.json.accounting.eligibleSpendUsd).toBe(33);
  expect(dashboard.json.accounting.grossSpendUsd).toBe(groups.json.grossSpendUsd);
  expect(
    dashboard.json.accounting.grossSpendUsd -
      dashboard.json.accounting.internalExcludedUsd,
  ).toBeCloseTo(dashboard.json.accounting.eligibleSpendUsd, 8);
});

test("hidden-team zero rows remain visible when the selected range is partial", async () => {
  invalidateUsageSnapshotMemo();
  const groups = await request(`/groups?${PARTIAL_RANGE}`, "task158-account");
  expect(groups.status).toBe(200);
  expect(groups.json.usageHealth.status).toBe("partial");
  const hiddenCanonicalRows = groups.json.groups.filter(
    (group) => group.name === HIDDEN_ZERO_NAME,
  );
  expect(hiddenCanonicalRows).toHaveLength(1);
  expect(hiddenCanonicalRows[0]).toMatchObject({
    teamName: null,
    rollupSpendUsd: 0,
    rollupSpendLoaded: false,
  });
});

test("positive hidden-team spend remains visible as unassigned", async () => {
  await db.insert(teamLimitTargetsTable).values({
    workspaceId: "task158-ws-2",
    groupId: SECOND_GROUP_ID,
    groupName: `${GROUP_NAME} Two`,
    teamName: HIDDEN,
  });
  try {
    invalidateUsageSnapshotMemo();
    const groups = await request(`/groups?${COMPLETE_RANGE}`, "task158-account");
    expect(groups.status).toBe(200);
    expect(groups.json.groups.find((group) => group.groupId === SECOND_GROUP_ID))
      .toMatchObject({
        teamName: null,
        rollupSpendUsd: 13,
        rollupSpendLoaded: false,
      });
  } finally {
    await db.delete(teamLimitTargetsTable)
      .where(eq(teamLimitTargetsTable.groupId, SECOND_GROUP_ID));
    invalidateUsageSnapshotMemo();
  }
});

test("scoped roles apply hidden-zero visibility without gaining out-of-scope rows", async () => {
  invalidateUsageSnapshotMemo();
  const groups = await request(`/groups?${COMPLETE_RANGE}`, "task158-workspace");
  expect(groups.status).toBe(200);
  expect(groups.json.groups.map((group) => group.groupId))
    .toEqual(expect.arrayContaining([GROUP_ID, VISIBLE_ZERO_GROUP_ID]));
  expect(groups.json.groups.some((group) => group.name === HIDDEN_ZERO_NAME)).toBe(false);
  expect(groups.json.groups.some((group) => group.workspaceId === "task158-ws-2")).toBe(false);
});

test("workspace-qualified team spend keeps the same team separate by workspace", async () => {
  await db.insert(teamLimitTargetsTable).values({
    workspaceId: "task158-ws-2",
    groupId: SECOND_GROUP_ID,
    groupName: `${GROUP_NAME} Two`,
    teamName: ASSIGNED,
  });
  try {
    invalidateUsageSnapshotMemo();
    const response = await request(
      `/groups?${COMPLETE_RANGE}`,
      "task158-account",
    );
    expect(response.status).toBe(200);
    const firstGroup = response.json.groups.find((group) => group.groupId === GROUP_ID);
    const secondGroup = response.json.groups.find((group) => group.groupId === SECOND_GROUP_ID);
    expect(response.json.workspaceTeamRawSpend).toEqual(expect.arrayContaining([
      {
        workspaceId: "task158-ws",
        teamName: ASSIGNED,
        spendUsd: firstGroup.rollupSpendUsd,
      },
      {
        workspaceId: "task158-ws-2",
        teamName: ASSIGNED,
        spendUsd: secondGroup.rollupSpendUsd,
      },
    ]));
  } finally {
    await db.delete(teamLimitTargetsTable)
      .where(eq(teamLimitTargetsTable.groupId, SECOND_GROUP_ID));
  }
});

test("directory groups are returned in server-owned hierarchy order", async () => {
  const response = await request("/directory/groups", "task158-account");
  expect(response.status).toBe(200);
  expect(Array.isArray(response.json.workspaces)).toBe(true);
  const groupIds = response.json.workspaces.flatMap((workspace) =>
    workspace.teams.flatMap((team) =>
      team.families.flatMap((family) =>
        family.groups.map((group) => group.groupId),
      ),
    ),
  );
  expect(groupIds).toContain(GROUP_ID);
  expect(new Set(groupIds).size).toBe(groupIds.length);
});

test("project history stays workspace-qualified while exports use the current UUID destination", async () => {
  invalidateUsageSnapshotMemo();
  const [first, second, cluster, projectExport, activity] = await Promise.all([
    request(`/groups/${GROUP_ID}/projects`, "task158-account"),
    request(`/groups/${SECOND_GROUP_ID}/projects`, "task158-account"),
    request(
      `/clusters/${GROUP_ID},${SECOND_GROUP_ID}/projects`,
      "task158-account",
    ),
    request("/projects/export", "task158-account"),
    request("/users/activity", "task158-account"),
  ]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.json.titlesComplete).toBe(true);
  expect(second.json.titlesComplete).toBe(true);
  expect(first.json.unattributedSpendUsd).toBe(0);
  expect(second.json.unattributedSpendUsd).toBe(0);
  expect(first.json.projects).toEqual([
    expect.objectContaining({
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project One",
      creatorId: "task158-workspace",
      creatorIsCurrentMember: true,
      totalCostUsd: 20,
    }),
  ]);
  expect(second.json.projects).toEqual([
    expect.objectContaining({
      projectId: SHARED_PROJECT_ID,
      title: "Persisted Project Two",
      creatorId: "task158-creator-2",
      creatorIsCurrentMember: true,
      totalCostUsd: 13,
    }),
  ]);
  expect(cluster.status).toBe(200);
  expect(cluster.json.projects).toHaveLength(2);
  expect(cluster.json.projects.map((project) => ({
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    totalCostUsd: project.totalCostUsd,
  })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
    { projectId: SHARED_PROJECT_ID, workspaceId: "task158-ws", totalCostUsd: 20 },
    { projectId: SHARED_PROJECT_ID, workspaceId: "task158-ws-2", totalCostUsd: 13 },
  ]);
  expect(projectExport.status).toBe(200);
  expect(projectExport.json.raw).not.toContain("Persisted Project One");
  expect(projectExport.json.raw).toContain("Persisted Project Two");
  expect(activity.status).toBe(200);
  expect(activity.json.usageHealth).toEqual(expect.objectContaining({
    status: expect.any(String),
    coverage: expect.objectContaining({ ratio: expect.any(Number) }),
  }));
  });

test("project export neutralizes formula-leading metadata", async () => {
  const formula = "=HYPERLINK(\"https://attacker.invalid\",\"Open\")";
  const [prior] = await db.select({ fetchedAt: apiProjectMetadataTable.fetchedAt })
    .from(apiProjectMetadataTable)
    .where(eq(apiProjectMetadataTable.workspaceId, "task158-ws"));
  await db.update(apiProjectMetadataTable)
    .set({ title: formula, fetchedAt: new Date() })
    .where(eq(apiProjectMetadataTable.workspaceId, "task158-ws"));
  try {
    const projectExport = await request("/projects/export", "task158-account");
    expect(projectExport.status).toBe(200);
    expect(projectExport.json.raw).toContain(
      "\"'=HYPERLINK(\"\"https://attacker.invalid\"\",\"\"Open\"\")\"",
    );
    expect(projectExport.json.raw).not.toContain(
      "\"=HYPERLINK(\"\"https://attacker.invalid\"\",\"\"Open\"\")\"",
    );
  } finally {
    await db.update(apiProjectMetadataTable)
      .set({ title: "Persisted Project One", fetchedAt: prior!.fetchedAt })
      .where(eq(apiProjectMetadataTable.workspaceId, "task158-ws"));
  }
});

test("legacy project export uses canonical filters and rejects invalid ranges", async () => {
  const invalid = await request(
    "/projects/export?rangeType=custom&startDate=not-a-date&endDate=not-a-date",
    "task158-account",
  );
  expect(invalid.status).toBe(400);

  const filtered = await request(
    `/projects/export?${COMPLETE_RANGE}&workspaceId=task158-ws-2&search=Persisted%20Project`,
    "task158-account",
  );
  expect(filtered.status).toBe(200);
  expect(filtered.json.raw).toContain("Persisted Project Two");
  expect(filtered.json.raw).not.toContain("Persisted Project One");
  expect(filtered.headers.get("x-filtered-rows")).toBe("1");
  expect(filtered.json.raw).toContain('"data_as_of"');
  expect(filtered.json.raw).toContain('"coverage_ratio"');
  expect(filtered.json.raw).toContain('"data_qualifications"');
});

test("group-user CSV embeds qualifications and blanks amounts without observations", async () => {
  const complete = await request(
    `/export/users.csv?groupIds=${GROUP_ID}&${COMPLETE_RANGE}`,
    "task158-account",
  );
  expect(complete.status).toBe(200);
  expect(complete.json.raw).toContain('"Record Kind"');
  expect(complete.json.raw).toContain('"Range Start"');
  expect(complete.json.raw).toContain('"Data As Of"');
  expect(complete.json.raw).toContain('"Coverage Ratio"');
  expect(complete.json.raw).toContain('"Data Qualifications"');
  expect(complete.headers.get("x-data-status")).toBeTruthy();
  expect(complete.headers.get("x-coverage-ratio")).toBeTruthy();

  const empty = await request(
    `/export/users.csv?groupIds=${GROUP_ID}&rangeType=custom&startDate=2026-05-20&endDate=2026-05-20`,
    "task158-account",
  );
  expect(empty.status).toBe(200);
  const memberLine = empty.json.raw
    .split("\r\n")
    .find((line) => line.includes("task158-workspace@example.com"));
  expect(memberLine).toBeTruthy();
  expect(memberLine).toContain('"","","","user"');
  expect(memberLine).toContain(
    "No valid usage observation is available; amount columns are blank.",
  );

  const noRoster = await request(
    `/export/users.csv?groupIds=${VISIBLE_ZERO_GROUP_ID}&${COMPLETE_RANGE}`,
    "task158-account",
  );
  expect(noRoster.status).toBe(200);
  expect(noRoster.json.raw.trim().split("\r\n")).toHaveLength(2);
  expect(noRoster.json.raw).toContain('"export_metadata"');
});

test("workspace admins see assigned effective pools but not account budget-only rows", async () => {
  const { status, json } = await request("/teams/budgets", "task158-workspace");
  expect(status).toBe(200);
  expect(json.budgets.find((budget) => budget.teamName === ASSIGNED)?.amountUsd).toBe(125);
  expect(!json.budgets.some((budget) => budget.teamName === BUDGET_ONLY)).toBeTruthy();
  expect(!json.budgets.some((budget) => budget.teamName === ORIGINAL_ONLY)).toBeTruthy();
  expect(!json.budgets.some((budget) => budget.teamName === HIDDEN)).toBeTruthy();
});

test("true admins can edit and reset monthly team and target limits", async () => {
  const path = `/admin/team-budgets/${encodeURIComponent(ASSIGNED)}/limit`;
  expect((await request(path, "task158-workspace", "PATCH", {
    monthlyLimitUsd: 9,
  })).status).toBe(403);
  let response = await request(path, "task158-account", "PATCH", {
    monthlyLimitUsd: 9,
  });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({
    monthlyLimitUsd: 9,
    monthlyLimitSource: "manual",
  });
  response = await request(path, "task158-account", "PATCH", {
    monthlyLimitUsd: null,
  });
  expect(response.json).toMatchObject({
    monthlyLimitUsd: 10.42,
    monthlyLimitSource: "derived",
  });
  const targetPath =
    `/admin/team-budgets/targets/task158-ws/${encodeURIComponent(GROUP_ID)}`;
  response = await request(targetPath, "task158-account", "PATCH", {
    monthlyLimitUsd: 4.5,
  });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({
    teamName: ASSIGNED,
    workspaceId: "task158-ws",
    groupId: GROUP_ID,
    monthlyLimitUsd: 4.5,
    targetAmountUsd: 4.5,
  });
  response = await request(targetPath, "task158-account", "PATCH", {
    monthlyLimitUsd: null,
  });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({
    monthlyLimitUsd: null,
    targetAmountUsd: 10.42,
  });
});

test("target configuration exposes invalid exact mappings without changing their team", async () => {
  setTeamBudgetDirectoryFetcherForTests(async () => ({
    allGroups: [{
      id: GROUP_ID,
      workspaceId: "task158-ws",
      name: `${GROUP_NAME} - Admin`,
      type: "custom",
    }],
  }));
  try {
    const response = await request(
      "/admin/team-budgets/targets",
      "task158-account",
    );
    expect(response.status).toBe(200);
    expect(response.json.targets.find((target) => target.groupId === GROUP_ID))
      .toMatchObject({
        teamName: ASSIGNED,
        isEnabled: true,
        validationReason: expect.stringContaining("no longer an eligible"),
      });
  } finally {
    setTeamBudgetDirectoryFetcherForTests(async () => ({
      allGroups: [{
        id: GROUP_ID,
        workspaceId: "task158-ws",
        name: GROUP_NAME,
        type: "custom",
      }],
    }));
  }
});

test("apply validates an exact explicit selection", async () => {
  expect((await request("/admin/team-budgets/apply", "task158-account", "POST", {
    all: false,
  })).status).toBe(400);
  expect((await request("/admin/team-budgets/apply", "task158-account", "POST", {
    all: true,
    teamNames: [ASSIGNED],
  })).status).toBe(400);
  const reviewed = {
    targets: [{
      teamName: ASSIGNED,
      workspaceId: "task158-ws",
      groupId: GROUP_ID,
      reviewedDesiredAmountUsd: 10.42,
      reviewedUpstreamAmountUsd: null,
    }],
  };
  expect((await request(
    "/admin/team-budgets/apply",
    "task158-delegate",
    "POST",
    reviewed,
  )).status).toBe(403);
  expect((await request(
    "/admin/team-budgets/apply",
    "task158-readonly-account",
    "POST",
    reviewed,
  )).status).toBe(403);
});
