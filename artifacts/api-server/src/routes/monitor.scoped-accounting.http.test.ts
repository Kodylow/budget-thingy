import express from "express";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  db,
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  groupRosterSnapshotDaysTable,
  groupRosterSnapshotsTable,
  ingestRunTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
  usageMemberDayTable,
  usageProjectDayTable,
  usageWorkspaceDayTable,
} from "@workspace/db";
import type { Authorization } from "../lib/authz";
import {
  __setDirectoryCacheForTests,
  getBillingPeriod,
  type PlatformBudgets,
} from "../lib/enterprise";
import {
  beginUsageGenerationUpdate,
  invalidateUsageSnapshotMemo,
} from "../lib/usage-store";
import { setAuthorizationResolver } from "../middlewares/requireAuth";
import monitorRouter from "./monitor";
import { __reportingDetailBaseQualificationsForTests } from "./monitor.groups-detail";
import {
  __setDashboardAfterAccountingHookForTests,
} from "./monitor.dashboard";
import {
  __getScopedAccountingBuildCountForTests,
} from "../services/scoped-accounting";

const PREFIX = "scopedhttp";
const W1 = `${PREFIX}-w1`;
const W2 = `${PREFIX}-w2`;
const W3 = `${PREFIX}-w3`;
const W4 = `${PREFIX}-w4`;
const W5 = `${PREFIX}-w5`;
const W6 = `${PREFIX}-w6`;
const W7 = `${PREFIX}-internal-personal`;
const W8 = `${PREFIX}-internal-shared`;
const W9 = `${PREFIX}-internal-known-zero`;
const W10 = `${PREFIX}-internal-unknown`;
const WLEG = "1awqan";
const SHARED_1 = `${PREFIX}-shared-1`;
const SHARED_2 = `${PREFIX}-shared-2`;
const FAMILY_A = `${PREFIX}-family-a`;
const FAMILY_B = `${PREFIX}-family-b`;
const SHARED_TEAM = `${PREFIX}-canonical-team`;
const ZERO_SPEND_TEAM = `${PREFIX}-configured-zero-spend-team`;
const LARGE_TEAM = `${PREFIX}-large-team`;
const LARGE_TEAM_GROUPS = Array.from({ length: 33 }, (_, index) => ({
  id: `${PREFIX}-large-team-group-${index + 1}`,
  name: `Large Team Family ${index + 1} - Member`,
}));
const SHARED_ADMIN = `${PREFIX}-shared-admin`;
const FAMILY_ADMIN = `${PREFIX}-family-admin`;
const COWORKER = `${PREFIX}-coworker`;
const DETAIL_GROUP = `${PREFIX}-detail-members`;
const DETAIL_MEMBER = `${PREFIX}-detail-member`;
const DETAIL_COWORKER = `${PREFIX}-detail-coworker`;
const DETAIL_FAMILY_ADMIN = `${PREFIX}-detail-family-admin`;
const DETAIL_WORKSPACE_ADMIN = `${PREFIX}-detail-workspace-admin`;
const DETAIL_ACCOUNT_ADMIN = `${PREFIX}-detail-account-admin`;
const DETAIL_OUTSIDER = `${PREFIX}-detail-outsider`;
const MERGED_PRIMARY = `${PREFIX}-merged-primary`;
const MERGED_LEGACY = `${PREFIX}-merged-legacy`;
const HISTORICAL_MEMBER = `${PREFIX}-historical-member`;
const CURRENT_MERGED_MEMBER = `${PREFIX}-current-merged-member`;
const INTERNAL_SELF = `${PREFIX}-internal-self`;
const INTERNAL_PEER = `${PREFIX}-internal-peer`;
const BENCHMARK_GROUPS = [
  "Member",
  "Members",
  "Admin",
  "Admins",
  "Viewer",
  "Viewers",
  "Guest",
  "Guests",
].map((suffix, index) => ({
  id: `${PREFIX}-benchmark-${index + 1}`,
  name: `Benchmark Family - ${suffix}`,
}));
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - 86_400_000)
  .toISOString().slice(0, 10);
const RANGE = `rangeType=custom&startDate=${TODAY}&endDate=${TODAY}`;

function capabilities() {
  return {
    canViewAccountUsage: false,
    canManageAccess: false,
    canEditAllocations: false,
    canManageNotifications: false,
    canManageSystem: false,
    canPreviewRoles: false,
    canWriteGroupLimits: false,
    canRunChecks: false,
    canSendTestEmail: false,
    canWriteUserLimitsIn: [],
  };
}

const authorizations: Record<string, Authorization> = {
  [SHARED_ADMIN]: {
    userId: SHARED_ADMIN,
    role: "team_admin",
    roles: ["team_admin"],
    workspaceIds: [],
    teamNames: [SHARED_TEAM],
    groupIds: [SHARED_1],
    managedGroupIds: [SHARED_1],
    groupUserIds: { [SHARED_1]: [SHARED_ADMIN] },
    userIds: [SHARED_ADMIN],
    isTrueAccountAdmin: false,
    capabilities: capabilities(),
  },
  [FAMILY_ADMIN]: {
    userId: FAMILY_ADMIN,
    role: "team_admin",
    roles: ["team_admin", "member"],
    workspaceIds: [],
    teamNames: [],
    groupIds: [FAMILY_A, FAMILY_B],
    managedGroupIds: [FAMILY_A],
    groupUserIds: {
      [FAMILY_A]: [FAMILY_ADMIN, COWORKER],
      [FAMILY_B]: [FAMILY_ADMIN],
    },
    userIds: [FAMILY_ADMIN, COWORKER],
    isTrueAccountAdmin: false,
    capabilities: capabilities(),
  },
  [DETAIL_MEMBER]: {
    userId: DETAIL_MEMBER, role: "member", roles: ["member"],
    workspaceIds: [], teamNames: [], groupIds: [DETAIL_GROUP],
    managedGroupIds: [],
    groupUserIds: { [DETAIL_GROUP]: [DETAIL_MEMBER] },
    userIds: [DETAIL_MEMBER], isTrueAccountAdmin: false,
    capabilities: capabilities(),
  },
  [DETAIL_FAMILY_ADMIN]: {
    userId: DETAIL_FAMILY_ADMIN, role: "team_admin", roles: ["team_admin"],
    workspaceIds: [], teamNames: [], groupIds: [DETAIL_GROUP],
    managedGroupIds: [DETAIL_GROUP],
    groupUserIds: { [DETAIL_GROUP]: [DETAIL_FAMILY_ADMIN] },
    userIds: [DETAIL_FAMILY_ADMIN], isTrueAccountAdmin: false,
    capabilities: capabilities(),
  },
  [DETAIL_WORKSPACE_ADMIN]: {
    userId: DETAIL_WORKSPACE_ADMIN, role: "workspace_admin",
    roles: ["workspace_admin"], workspaceIds: [W5], teamNames: [],
    groupIds: [DETAIL_GROUP], managedGroupIds: [DETAIL_GROUP],
    groupUserIds: {
      [DETAIL_GROUP]: [DETAIL_MEMBER, DETAIL_COWORKER, DETAIL_FAMILY_ADMIN],
    },
    userIds: [DETAIL_MEMBER, DETAIL_COWORKER, DETAIL_FAMILY_ADMIN],
    isTrueAccountAdmin: false, capabilities: capabilities(),
  },
  [DETAIL_ACCOUNT_ADMIN]: {
    userId: DETAIL_ACCOUNT_ADMIN, role: "account", roles: ["account"],
    workspaceIds: [], teamNames: [], groupIds: [DETAIL_GROUP],
    managedGroupIds: [DETAIL_GROUP],
    groupUserIds: {
      [DETAIL_GROUP]: [DETAIL_MEMBER, DETAIL_COWORKER, DETAIL_FAMILY_ADMIN],
    },
    userIds: [DETAIL_MEMBER, DETAIL_COWORKER, DETAIL_FAMILY_ADMIN],
    isTrueAccountAdmin: true,
    capabilities: {
      ...capabilities(),
      canManageAccess: true,
      canPreviewRoles: true,
    },
  },
  [DETAIL_OUTSIDER]: {
    userId: DETAIL_OUTSIDER, role: "member", roles: ["member"],
    workspaceIds: [], teamNames: [], groupIds: [], managedGroupIds: [],
    groupUserIds: {}, userIds: [DETAIL_OUTSIDER],
    isTrueAccountAdmin: false, capabilities: capabilities(),
  },
  [INTERNAL_SELF]: {
    userId: INTERNAL_SELF, role: "member", roles: ["member"],
    workspaceIds: [], teamNames: [], groupIds: [], managedGroupIds: [],
    groupUserIds: {}, userIds: [INTERNAL_SELF],
    isTrueAccountAdmin: false, capabilities: capabilities(),
  },
};

function member(userId: string, workspaceIds: string[]) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.test`,
    name: userId,
    isAccountAdmin: false,
    isInternalReplitUser: false,
    workspaces: new Map(workspaceIds.map((workspaceId) => [
      workspaceId,
      { role: "member", isDisabled: false },
    ])),
  };
}

function internalMember(userId: string, workspaceIds: string[]) {
  return {
    ...member(userId, workspaceIds),
    email: `${userId}@repl.it`,
    isInternalReplitUser: true,
  };
}

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let baseUrl = "";

async function get(
  path: string,
  userId: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "x-test-user": userId, ...headers },
  });
}

beforeAll(async () => {
  const workspaceIds = [W1, W2, W3, W4, W5, W6, W7, W8, W9, W10, WLEG];
  const directoryWorkspaceIds = workspaceIds.filter(
    (workspaceId) => workspaceId !== W9 && workspaceId !== W10,
  );
  await db.delete(teamLimitTargetsTable)
    .where(like(teamLimitTargetsTable.groupId, `${PREFIX}%`));
  await db.delete(teamBudgetsTable)
    .where(inArray(teamBudgetsTable.teamName, [
      SHARED_TEAM,
      ZERO_SPEND_TEAM,
      LARGE_TEAM,
    ]));
  await db.delete(usageMemberDayTable)
    .where(inArray(usageMemberDayTable.workspaceId, workspaceIds));
  await db.delete(usageWorkspaceDayTable)
    .where(inArray(usageWorkspaceDayTable.workspaceId, workspaceIds));
  await db.delete(usageProjectDayTable)
    .where(inArray(usageProjectDayTable.workspaceId, workspaceIds));
  await db.delete(apiProjectMetadataTable)
    .where(inArray(apiProjectMetadataTable.workspaceId, workspaceIds));
  await db.delete(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, workspaceIds));
  await db.delete(groupRosterSnapshotsTable)
    .where(inArray(groupRosterSnapshotsTable.groupId, [MERGED_PRIMARY, MERGED_LEGACY]));
  await db.delete(groupRosterSnapshotDaysTable)
    .where(eq(groupRosterSnapshotDaysTable.snapshotDate, YESTERDAY));

  const budgets: PlatformBudgets = {
    groupLimits: new Map(),
    userLimits: new Map([
      [W5, new Map([
        [DETAIL_MEMBER, 20],
        [DETAIL_FAMILY_ADMIN, 30],
      ])],
      [W7, new Map([[INTERNAL_SELF, 20]])],
    ]),
    workspaceDefaults: new Map([[W5, 40], [W8, 30]]),
    observation: {
      status: "complete",
      observedAt: Date.now(),
      lastSuccessfulAt: Date.now(),
      lastAttemptAt: Date.now(),
      refreshStartedAt: null,
      generation: "scoped-accounting-fixture",
      error: null,
    },
  };
  __setDirectoryCacheForTests({
    workspaces: new Map(directoryWorkspaceIds.map((id) => [
      id,
      {
        id,
        name: id === W6 ? "Compact" : id,
        slug: id,
        memberCount: 2,
      },
    ])),
    groups: [
      { id: SHARED_1, workspaceId: W1, name: "Shared Pool A", type: "custom" },
      { id: SHARED_2, workspaceId: W2, name: "Shared Pool B", type: "custom" },
      { id: FAMILY_A, workspaceId: W3, name: "Authorized Family", type: "custom" },
      { id: FAMILY_B, workspaceId: W4, name: "Unauthorized Family", type: "custom" },
      { id: DETAIL_GROUP, workspaceId: W5, name: "Detail - Member", type: "custom" },
      { id: MERGED_PRIMARY, workspaceId: W6, name: "Compact Merge - Member", type: "custom" },
      { id: MERGED_LEGACY, workspaceId: WLEG, name: "Compact Merge - Member", type: "custom" },
      ...LARGE_TEAM_GROUPS.map((group) => ({
        ...group,
        workspaceId: W6,
        type: "custom",
      })),
      ...(process.env.REPORTING_DETAIL_BENCHMARK === "1"
        ? BENCHMARK_GROUPS
        : []).map((group) => ({
        ...group,
        workspaceId: W6,
        type: "custom",
      })),
    ],
    members: new Map([
      [SHARED_ADMIN, member(SHARED_ADMIN, [W1])],
      [FAMILY_ADMIN, member(FAMILY_ADMIN, [W3, W4])],
      [COWORKER, member(COWORKER, [W3, W4])],
      [DETAIL_MEMBER, member(DETAIL_MEMBER, [W5])],
      [DETAIL_COWORKER, member(DETAIL_COWORKER, [W5])],
      [DETAIL_FAMILY_ADMIN, member(DETAIL_FAMILY_ADMIN, [W5])],
      [DETAIL_WORKSPACE_ADMIN, member(DETAIL_WORKSPACE_ADMIN, [W5])],
      [DETAIL_ACCOUNT_ADMIN, member(DETAIL_ACCOUNT_ADMIN, [])],
      [DETAIL_OUTSIDER, member(DETAIL_OUTSIDER, [])],
      [HISTORICAL_MEMBER, member(HISTORICAL_MEMBER, [W6])],
      [CURRENT_MERGED_MEMBER, member(CURRENT_MERGED_MEMBER, [W6, WLEG])],
      [INTERNAL_SELF, internalMember(INTERNAL_SELF, [W7, W8, W9, W10])],
      [INTERNAL_PEER, internalMember(INTERNAL_PEER, [W7, W8])],
    ]),
    groupMembers: new Map([
      [SHARED_1, [SHARED_ADMIN]],
      [SHARED_2, [COWORKER]],
      [FAMILY_A, [FAMILY_ADMIN, COWORKER]],
      [FAMILY_B, [FAMILY_ADMIN, COWORKER]],
      [DETAIL_GROUP, [DETAIL_MEMBER, DETAIL_COWORKER, DETAIL_FAMILY_ADMIN]],
      [MERGED_PRIMARY, [CURRENT_MERGED_MEMBER]],
      [MERGED_LEGACY, [CURRENT_MERGED_MEMBER]],
      ...LARGE_TEAM_GROUPS.map((group) =>
        [group.id, []] as [string, string[]]),
      ...(process.env.REPORTING_DETAIL_BENCHMARK === "1"
        ? BENCHMARK_GROUPS
        : []).map((group) =>
        [group.id, [CURRENT_MERGED_MEMBER]] as [string, string[]]),
    ]),
    budgets,
  });
  await db.insert(teamBudgetsTable).values([
    {
      teamName: SHARED_TEAM,
      originalAmountUsd: 1_000,
      amountUsd: 1_000,
    },
    {
      teamName: ZERO_SPEND_TEAM,
      originalAmountUsd: 240,
      amountUsd: 240,
    },
    {
      teamName: LARGE_TEAM,
      originalAmountUsd: 330,
      amountUsd: 330,
    },
  ]);
  await db.insert(teamLimitTargetsTable).values([
    {
      teamName: SHARED_TEAM,
      workspaceId: W1,
      groupId: SHARED_1,
      groupName: "Shared Pool A",
    },
    {
      teamName: SHARED_TEAM,
      workspaceId: W2,
      groupId: SHARED_2,
      groupName: "Shared Pool B",
    },
    ...LARGE_TEAM_GROUPS.map((group) => ({
      teamName: LARGE_TEAM,
      workspaceId: W6,
      groupId: group.id,
      groupName: group.name,
    })),
  ]);
  await db.insert(usageMemberDayTable).values([
    { workspaceId: W1, usageDate: TODAY, userId: SHARED_ADMIN, totalCostUsd: 5, aiCostUsd: 5, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W2, usageDate: TODAY, userId: COWORKER, totalCostUsd: 500, aiCostUsd: 500, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W3, usageDate: TODAY, userId: FAMILY_ADMIN, totalCostUsd: 0, aiCostUsd: 0, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W3, usageDate: TODAY, userId: COWORKER, totalCostUsd: 10, aiCostUsd: 10, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W4, usageDate: TODAY, userId: FAMILY_ADMIN, totalCostUsd: 1, aiCostUsd: 1, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W4, usageDate: TODAY, userId: COWORKER, totalCostUsd: 99, aiCostUsd: 99, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, userId: DETAIL_MEMBER, totalCostUsd: 5, aiCostUsd: 5, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 5 }], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, userId: DETAIL_COWORKER, totalCostUsd: 7, aiCostUsd: 7, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, userId: DETAIL_FAMILY_ADMIN, totalCostUsd: 3, aiCostUsd: 3, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W6, usageDate: TODAY, userId: CURRENT_MERGED_MEMBER, totalCostUsd: 11, aiCostUsd: 11, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 11 }], fetchedAt: new Date() },
    { workspaceId: WLEG, usageDate: TODAY, userId: CURRENT_MERGED_MEMBER, totalCostUsd: 13, aiCostUsd: 13, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 13 }], fetchedAt: new Date() },
    { workspaceId: W6, usageDate: YESTERDAY, userId: HISTORICAL_MEMBER, totalCostUsd: 17, aiCostUsd: 17, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 17 }], fetchedAt: new Date() },
    { workspaceId: W7, usageDate: TODAY, userId: INTERNAL_SELF, totalCostUsd: 5, aiCostUsd: 5, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 5 }], fetchedAt: new Date() },
    { workspaceId: W7, usageDate: TODAY, userId: INTERNAL_PEER, totalCostUsd: 100, aiCostUsd: 100, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 100 }], fetchedAt: new Date() },
    { workspaceId: W8, usageDate: TODAY, userId: INTERNAL_SELF, totalCostUsd: 7, aiCostUsd: 7, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 7 }], fetchedAt: new Date() },
    { workspaceId: W8, usageDate: TODAY, userId: INTERNAL_PEER, totalCostUsd: 200, aiCostUsd: 200, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 200 }], fetchedAt: new Date() },
  ]);
  const billingStart = getBillingPeriod().start.slice(0, 10);
  const priorBillingDays = Array.from({
    length: Math.max(0, Math.round(
      (Date.parse(`${TODAY}T00:00:00.000Z`) -
        Date.parse(`${billingStart}T00:00:00.000Z`)) / 86_400_000,
    )),
  }, (_, index) =>
    new Date(Date.parse(`${billingStart}T00:00:00.000Z`) +
      index * 86_400_000).toISOString().slice(0, 10));
  await db.insert(usageWorkspaceDayTable).values([
    { workspaceId: W1, usageDate: TODAY, totalCostUsd: 5, memberAttributableUsd: 5, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W2, usageDate: TODAY, totalCostUsd: 500, memberAttributableUsd: 500, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W3, usageDate: TODAY, totalCostUsd: 10, memberAttributableUsd: 10, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W4, usageDate: TODAY, totalCostUsd: 100, memberAttributableUsd: 100, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W5, usageDate: TODAY, totalCostUsd: 30, memberAttributableUsd: 30, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W6, usageDate: TODAY, totalCostUsd: 11, memberAttributableUsd: 11, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: WLEG, usageDate: TODAY, totalCostUsd: 13, memberAttributableUsd: 13, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W6, usageDate: YESTERDAY, totalCostUsd: 17, memberAttributableUsd: 17, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W7, usageDate: TODAY, totalCostUsd: 108, memberAttributableUsd: 108, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W8, usageDate: TODAY, totalCostUsd: 207, memberAttributableUsd: 207, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W9, usageDate: TODAY, totalCostUsd: 0, memberAttributableUsd: 0, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    ...priorBillingDays.map((usageDate) => ({
      workspaceId: W5,
      usageDate,
      totalCostUsd: 0,
      memberAttributableUsd: 0,
      memberUnattributableUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
      status: "complete" as const,
    })),
    ...priorBillingDays.flatMap((usageDate) => [W7, W8].map((workspaceId) => ({
      workspaceId,
      usageDate,
      totalCostUsd: 0,
      memberAttributableUsd: 0,
      memberUnattributableUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
      status: "complete" as const,
    }))),
    ...priorBillingDays.map((usageDate) => ({
      workspaceId: W9,
      usageDate,
      totalCostUsd: 0,
      memberAttributableUsd: 0,
      memberUnattributableUsd: 0,
      metricsJson: [],
      fetchedAt: new Date(),
      status: "complete" as const,
    })),
  ]);
  await db.insert(groupRosterSnapshotDaysTable).values({
    snapshotDate: YESTERDAY,
    capturedAt: new Date(),
  });
  await db.insert(groupRosterSnapshotsTable).values({
    groupId: MERGED_PRIMARY,
    snapshotDate: YESTERDAY,
    workspaceId: W6,
    userIds: [HISTORICAL_MEMBER],
    capturedAt: new Date(),
  });
  await db.insert(usageProjectDayTable).values([
    {
      workspaceId: W3,
      usageDate: TODAY,
      projectId: `${PREFIX}-group-coworker-project`,
      totalCostUsd: 10,
      metricsJson: [{
        id: "ai_agent",
        name: "Agent",
        category: "ai",
        costUsd: 10,
      }],
      fetchedAt: new Date(),
    },
    { workspaceId: W5, usageDate: TODAY, projectId: `${PREFIX}-self-project`, totalCostUsd: 5, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, projectId: `${PREFIX}-coworker-project`, totalCostUsd: 7, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, projectId: `${PREFIX}-family-project`, totalCostUsd: 3, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W7, usageDate: TODAY, projectId: `${PREFIX}-internal-self-project-1`, totalCostUsd: 5, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 5 }], fetchedAt: new Date() },
    { workspaceId: W7, usageDate: TODAY, projectId: `${PREFIX}-internal-peer-project`, totalCostUsd: 100, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 100 }], fetchedAt: new Date() },
    { workspaceId: W8, usageDate: TODAY, projectId: `${PREFIX}-internal-self-project-2`, totalCostUsd: 7, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 7 }], fetchedAt: new Date() },
    { workspaceId: W7, usageDate: TODAY, projectId: `${PREFIX}-internal-self-service-project`, totalCostUsd: 3, metricsJson: [{ id: "hosting", name: "Hosting", category: "compute", costUsd: 3 }], fetchedAt: new Date() },
  ]);
  const projectMetadataObservedAt = new Date();
  const olderProjectMetadataObservedAt =
    new Date(projectMetadataObservedAt.getTime() - 1_000);
  await db.insert(apiProjectMetadataTable).values([
    {
      workspaceId: W5,
      projectId: `${PREFIX}-self-project`,
      title: "Visible self project",
      creatorId: DETAIL_MEMBER,
      createdAt: new Date(Date.now() - 90 * 86_400_000),
      updatedAt: new Date(Date.now() - 31 * 86_400_000),
      deployments: [
        {
          id: `${PREFIX}-unsafe-deployment`,
          url: "javascript:alert(1)",
          privacy: "private",
          status: "running",
          createdAt: null,
          updatedAt: null,
        },
        {
          id: `${PREFIX}-safe-deployment`,
          url: "https://example.test/deployed",
          privacy: "public",
          status: "running",
          createdAt: null,
          updatedAt: null,
        },
      ],
      deploymentsObservedAt: projectMetadataObservedAt,
      fetchedAt: projectMetadataObservedAt,
    },
    { workspaceId: W5, projectId: `${PREFIX}-coworker-project`, title: "Secret coworker project", creatorId: DETAIL_COWORKER, fetchedAt: projectMetadataObservedAt },
    { workspaceId: W5, projectId: `${PREFIX}-family-project`, title: "Family admin project", creatorId: DETAIL_FAMILY_ADMIN, fetchedAt: projectMetadataObservedAt },
    {
      workspaceId: W3,
      projectId: `${PREFIX}-group-coworker-project`,
      title: "Authorized coworker Agent project",
      creatorId: COWORKER,
      fetchedAt: projectMetadataObservedAt,
    },
    {
      workspaceId: W3,
      projectId: `${PREFIX}-inaccessible-transfer`,
      title: "Old authorized transfer source",
      creatorId: COWORKER,
      fetchedAt: olderProjectMetadataObservedAt,
    },
    {
      workspaceId: W8,
      projectId: `${PREFIX}-inaccessible-transfer`,
      title: "Current inaccessible transfer destination",
      creatorId: INTERNAL_PEER,
      fetchedAt: projectMetadataObservedAt,
    },
    { workspaceId: W7, projectId: `${PREFIX}-internal-self-project-1`, title: "Internal self project 1", creatorId: INTERNAL_SELF, fetchedAt: projectMetadataObservedAt },
    { workspaceId: W7, projectId: `${PREFIX}-internal-peer-project`, title: "Internal peer project", creatorId: INTERNAL_PEER, fetchedAt: projectMetadataObservedAt },
    { workspaceId: W8, projectId: `${PREFIX}-internal-self-project-2`, title: "Internal self project 2", creatorId: INTERNAL_SELF, fetchedAt: projectMetadataObservedAt },
    { workspaceId: W7, projectId: `${PREFIX}-internal-self-service-project`, title: "Internal self service project", creatorId: INTERNAL_SELF, fetchedAt: projectMetadataObservedAt },
    { workspaceId: W7, projectId: `${PREFIX}-internal-self-zero-project`, title: "Internal self zero project", creatorId: INTERNAL_SELF, hasDeployment: true, fetchedAt: projectMetadataObservedAt },
    { workspaceId: W10, projectId: `${PREFIX}-internal-self-stale-project`, title: "Internal self stale project", creatorId: INTERNAL_SELF, fetchedAt: projectMetadataObservedAt },
    { workspaceId: W7, projectId: `${PREFIX}-transferred-project`, title: "Transferred old project", creatorId: INTERNAL_SELF, fetchedAt: olderProjectMetadataObservedAt },
    { workspaceId: W8, projectId: `${PREFIX}-transferred-project`, title: "Transferred current project", creatorId: INTERNAL_PEER, fetchedAt: projectMetadataObservedAt },
  ]);
  await db.insert(apiProjectMetadataStateTable).values([W3, W5, W7, W8].map(
    (workspaceId) => ({
      workspaceId,
      status: "success" as const,
      completedAt: workspaceId === W7
        ? olderProjectMetadataObservedAt
        : projectMetadataObservedAt,
      lastSuccessfulAt: workspaceId === W7
        ? olderProjectMetadataObservedAt
        : projectMetadataObservedAt,
      deploymentStatusObserved: workspaceId === W7 || workspaceId === W5,
    }),
  ));
  await db.insert(apiProjectMetadataStateTable).values({
    workspaceId: W10,
    status: "failed",
    completedAt: projectMetadataObservedAt,
    lastSuccessfulAt: projectMetadataObservedAt,
  });
  invalidateUsageSnapshotMemo();
  setAuthorizationResolver(async (id) => authorizations[id] ?? null);

  const app = express();
  app.use((req, _res, next) => {
    const id = req.header("x-test-user");
    const mutable = req as unknown as {
      isAuthenticated: () => boolean;
      user?: { id: string };
      log?: {
        info: () => void;
        error: () => void;
        warn: () => void;
        debug: () => void;
      };
    };
    mutable.log = {
      info: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    };
    mutable.isAuthenticated = () => !!id;
    if (id) mutable.user = { id };
    next();
  });
  app.use("/api", monitorRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture failed");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setAuthorizationResolver(null);
  __setDirectoryCacheForTests(null);
  const workspaceIds = [W1, W2, W3, W4, W5, W6, W7, W8, W9, W10, WLEG];
  await db.delete(teamLimitTargetsTable)
    .where(like(teamLimitTargetsTable.groupId, `${PREFIX}%`));
  await db.delete(teamBudgetsTable)
    .where(inArray(teamBudgetsTable.teamName, [
      SHARED_TEAM,
      ZERO_SPEND_TEAM,
      LARGE_TEAM,
    ]));
  await db.delete(usageMemberDayTable)
    .where(inArray(usageMemberDayTable.workspaceId, workspaceIds));
  await db.delete(usageWorkspaceDayTable)
    .where(inArray(usageWorkspaceDayTable.workspaceId, workspaceIds));
  await db.delete(usageProjectDayTable)
    .where(inArray(usageProjectDayTable.workspaceId, workspaceIds));
  await db.delete(apiProjectMetadataTable)
    .where(inArray(apiProjectMetadataTable.workspaceId, workspaceIds));
  await db.delete(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, workspaceIds));
  await db.delete(groupRosterSnapshotsTable)
    .where(inArray(groupRosterSnapshotsTable.groupId, [MERGED_PRIMARY, MERGED_LEGACY]));
  await db.delete(groupRosterSnapshotDaysTable)
    .where(eq(groupRosterSnapshotDaysTable.snapshotDate, YESTERDAY));
});

describe("authenticated scoped accounting HTTP endpoints", () => {
  test("personal internal usage is self-only across dashboard, people, and projects", async () => {
    const dashboardResponse = await get(
      `/dashboard?viewScope=my&${RANGE}`,
      INTERNAL_SELF,
    );
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json() as {
      accounting: {
        grossSpendUsd: number;
        eligibleSpendUsd: number;
        internalExcludedUsd: number;
        agentSpendUsd: number;
      };
      breakdown: Array<{ workspaceId?: string; spendUsd: number }>;
      insights: {
        monthly: Array<{ start: string; spendUsd: number | null }>;
      };
      personalLimits?: Array<{
        workspaceId: string;
        workspaceName: string | null;
        amount: number | null;
        currentCycleAgentSpendUsd: number | null;
        currentCycleRemainingUsd: number | null;
        currentCyclePercentUsed: number | null;
      }>;
      personalSpendByWorkspace?: Array<{
        workspaceId: string;
        workspaceName: string | null;
        spendUsd: number | null;
        agentSpendUsd: number | null;
        otherServicesUsd: number | null;
        usageObserved: boolean;
        coverage: "complete" | "partial" | "missing";
         activeProjectCount: number | null;
         publishedProjectCount: number | null;
         projectCountCoverage: "complete" | "partial" | "missing";
      }>;
      personalProjectCatalog?: {
        projectCount: number;
        publishedProjectCount: number;
        publicationKnownProjectCount: number;
        publicationUnknownProjectCount: number;
        coverage: "complete" | "partial" | "missing";
        dataAsOf: string | null;
      };
    };
    expect(dashboard.accounting).toMatchObject({
      grossSpendUsd: 15,
      eligibleSpendUsd: 0,
      internalExcludedUsd: 15,
      agentSpendUsd: 12,
    });
    expect(dashboard.accounting.grossSpendUsd).toBe(
      dashboard.accounting.eligibleSpendUsd +
        dashboard.accounting.internalExcludedUsd,
    );
    expect(dashboard.breakdown.reduce(
      (sum, row) => sum + row.spendUsd, 0)).toBe(15);
    expect(dashboard.insights.monthly.find((month) =>
      month.start.slice(0, 7) === TODAY.slice(0, 7))?.spendUsd).toBe(15);
    expect(dashboard.personalLimits).toHaveLength(4);
    expect(dashboard.personalLimits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: W7,
        workspaceName: W7,
        amount: 20,
        currentCycleAgentSpendUsd: 5,
        currentCycleRemainingUsd: 15,
        currentCyclePercentUsed: 25,
      }),
      expect.objectContaining({
        workspaceId: W8,
        workspaceName: W8,
        amount: 30,
        currentCycleAgentSpendUsd: 7,
        currentCycleRemainingUsd: 23,
      }),
    ]));
    expect(dashboard.personalSpendByWorkspace).toEqual([
      expect.objectContaining({
        workspaceId: W7,
        workspaceName: W7,
        spendUsd: 8,
        agentSpendUsd: 5,
        otherServicesUsd: 3,
        usageObserved: true,
        coverage: "complete",
         activeProjectCount: 2,
         publishedProjectCount: null,
         projectCountCoverage: "partial",
      }),
      expect.objectContaining({
        workspaceId: W8,
        workspaceName: W8,
        spendUsd: 7,
        agentSpendUsd: 7,
        otherServicesUsd: 0,
        usageObserved: true,
        coverage: "complete",
         activeProjectCount: 1,
         publishedProjectCount: null,
         projectCountCoverage: "partial",
      }),
      expect.objectContaining({
        workspaceId: W9,
        workspaceName: null,
        spendUsd: 0,
        usageObserved: true,
        coverage: "complete",
      }),
      expect.objectContaining({
        workspaceId: W10,
        workspaceName: null,
        spendUsd: null,
        agentSpendUsd: null,
        otherServicesUsd: null,
        usageObserved: false,
        coverage: "missing",
      }),
    ]);
    expect(dashboard.personalSpendByWorkspace?.reduce(
      (sum, row) => sum + (row.spendUsd ?? 0), 0,
    )).toBe(dashboard.accounting.grossSpendUsd);
    expect(dashboard.personalProjectCatalog).toMatchObject({
      projectCount: 5,
      publishedProjectCount: 1,
      publicationKnownProjectCount: 1,
      publicationUnknownProjectCount: 4,
      coverage: "partial",
    });

    const peopleResponse = await get(
      `/spend/people?viewScope=my&pageSize=100&${RANGE}`,
      INTERNAL_SELF,
    );
    expect(peopleResponse.status).toBe(200);
    const people = await peopleResponse.json() as {
      rows: Array<{
        id: string;
        spendUsd: number;
        agentSpendUsd: number;
        currentCycleAgentSpendUsd: number | null;
      }>;
    };
    expect(people.rows).toHaveLength(4);
    expect(people.rows.map((row) => row.id).sort()).toEqual([
      `person:${W10}:${INTERNAL_SELF}`,
      `person:${W7}:${INTERNAL_SELF}`,
      `person:${W8}:${INTERNAL_SELF}`,
      `person:${W9}:${INTERNAL_SELF}`,
    ].sort());
    expect(people.rows.reduce((sum, row) => sum + row.spendUsd, 0)).toBe(15);
    expect(people.rows.reduce(
      (sum, row) => sum + (row.currentCycleAgentSpendUsd ?? 0), 0)).toBe(12);

    const projectsResponse = await get(
      `/spend/projects?viewScope=my&pageSize=100&${RANGE}`,
      INTERNAL_SELF,
    );
    expect(projectsResponse.status).toBe(200);
    const projects = await projectsResponse.json() as {
      rows: Array<{
        id: string;
        ownerName: string | null;
        spendUsd: number;
        agentSpendUsd: number;
        usageObserved: boolean;
        isPublished?: boolean | null;
      }>;
      totalRows: number;
      filteredRows: number;
      personalProjectCatalog?: {
        projectCount: number;
        publishedProjectCount: number;
        publicationUnknownProjectCount: number;
        coverage: string;
      };
    };
    expect(projects.rows).toHaveLength(5);
    expect(projects.totalRows).toBe(5);
    expect(projects.filteredRows).toBe(5);
    expect(projects.rows.every((row) => row.ownerName === INTERNAL_SELF))
      .toBe(true);
    expect(projects.rows.some((row) =>
      row.id.includes(`${PREFIX}-transferred-project`))).toBe(false);
    // Project Agent usage is not user-granular and must not be assigned to a
    // self-only viewer merely because they currently own the project.
    expect(projects.rows.reduce((sum, row) => sum + row.spendUsd, 0)).toBe(3);
    expect(projects.rows.every((row) => row.agentSpendUsd === 0)).toBe(true);
    expect(projects.rows).toContainEqual(expect.objectContaining({
      spendUsd: 0,
      usageObserved: true,
      isPublished: true,
    }));
    expect(projects.rows).toContainEqual(expect.objectContaining({
      spendUsd: 0,
      usageObserved: false,
    }));
    expect(projects.personalProjectCatalog).toMatchObject({
      projectCount: 5,
      publishedProjectCount: 1,
      publicationUnknownProjectCount: 4,
      coverage: "partial",
    });

    const projectSearchResponse = await get(
      `/spend/projects?viewScope=my&page=1&pageSize=1&search=zero&${RANGE}`,
      INTERNAL_SELF,
    );
    const projectSearch = await projectSearchResponse.json() as {
      rows: unknown[];
      totalRows: number;
      filteredRows: number;
    };
    expect(projectSearch).toMatchObject({
      totalRows: 5,
      filteredRows: 1,
    });
    expect(projectSearch.rows).toHaveLength(1);

    const accountResponse = await get(
      `/dashboard?viewScope=all_authorized&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(accountResponse.status).toBe(200);
    const account = await accountResponse.json() as {
      accounting: {
        grossSpendUsd: number;
        eligibleSpendUsd: number;
        internalExcludedUsd: number;
      };
      personalLimits?: unknown;
      personalSpendByWorkspace?: unknown;
      personalProjectCatalog?: unknown;
    };
    expect(account.personalLimits).toBeUndefined();
    expect(account.personalSpendByWorkspace).toBeUndefined();
    expect(account.personalProjectCatalog).toBeUndefined();
    expect(account.accounting.internalExcludedUsd).toBe(315);
    expect(account.accounting.grossSpendUsd).toBe(
      account.accounting.eligibleSpendUsd +
        account.accounting.internalExcludedUsd,
    );

    const accountPersonResponse = await get(
      `/spend/people?viewScope=all_authorized&search=${INTERNAL_SELF}&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    const accountPerson = await accountPersonResponse.json() as {
      rows: Array<{
        agentSpendUsd: number;
        currentCycleAgentSpendUsd: number | null;
      }>;
    };
    expect(accountPerson.rows.every((row) =>
      row.agentSpendUsd === 0 && row.currentCycleAgentSpendUsd === 0)).toBe(true);
  });

  test("account scope includes configured zero-spend pools without leaking them to scoped admins", async () => {
    const accountResponse = await get(
      `/spend/pools?viewScope=all_authorized&search=${encodeURIComponent(ZERO_SPEND_TEAM)}&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(accountResponse.status).toBe(200);
    const account = await accountResponse.json() as {
      rows: Array<{
        id: string;
        name: string;
        spendUsd: number;
        allocationUsd: number | null;
        remainingUsd: number | null;
      }>;
    };
    expect(account.rows.filter((row) => row.name === ZERO_SPEND_TEAM))
      .toEqual([expect.objectContaining({
        id: `pool:team:${encodeURIComponent(ZERO_SPEND_TEAM)}`,
        spendUsd: 0,
        allocationUsd: 240,
        remainingUsd: 240,
        usageObserved: true,
      })]);

    const scopedResponse = await get(
      `/spend/pools?viewScope=managed&search=${encodeURIComponent(ZERO_SPEND_TEAM)}&${RANGE}`,
      SHARED_ADMIN,
    );
    expect(scopedResponse.status).toBe(200);
    const scoped = await scopedResponse.json() as {
      rows: Array<{ name: string }>;
    };
    expect(scoped.rows.some((row) => row.name === ZERO_SPEND_TEAM)).toBe(false);
  });

  test("project intelligence deep links fail closed and reject invalid ranges", async () => {
    const projectId = `${PREFIX}-self-project`;
    const visible = await get(
      `/workspaces/${W5}/projects/${projectId}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(visible.status).toBe(200);
    const project = await visible.json() as {
      project: {
        projectId: string;
        ownerId: string;
        spendUsd: number;
        deploymentAvailability: string;
        deployments: Array<{ id: string; url: string | null }>;
      };
    };
    expect(project.project).toMatchObject({
      projectId,
      ownerId: DETAIL_MEMBER,
      spendUsd: 5,
      deploymentAvailability: "complete",
    });
    expect(project.project.deployments).toContainEqual({
      id: `${PREFIX}-unsafe-deployment`,
      url: null,
      privacy: "private",
      status: "running",
      createdAt: null,
      updatedAt: null,
    });
    expect(project.project.deployments).toContainEqual(expect.objectContaining({
      id: `${PREFIX}-safe-deployment`,
      url: "https://example.test/deployed",
    }));

    expect((await get(
      `/workspaces/${W6}/projects/${projectId}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    )).status).toBe(404);
    expect((await get(
      `/workspaces/${W5}/projects/${projectId}?rangeType=custom&startDate=nope&endDate=${TODAY}`,
      DETAIL_ACCOUNT_ADMIN,
    )).status).toBe(400);
    expect((await get(
      `/workspaces/${W5}/projects/${projectId}?${RANGE}`,
      DETAIL_OUTSIDER,
    )).status).toBe(404);
    expect((await get(
      `/users/${DETAIL_MEMBER}/projects?${RANGE}`,
      DETAIL_OUTSIDER,
    )).status).toBe(404);
    expect((await get(
      `/users/${DETAIL_MEMBER}/projects?workspaceId=${W6}&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    )).status).toBe(404);
  });

  test("owned projects retain zero spend and one current transfer identity", async () => {
    const owned = await get(
      `/users/${INTERNAL_SELF}/projects?viewScope=all_authorized&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(owned.status).toBe(200);
    const body = await owned.json() as {
      projects: { rows: Array<{
        projectId: string;
        workspaceId: string;
        spendUsd: number;
        hasDeployment: boolean | null;
        deploymentAvailability: string;
      }> };
    };
    expect(body.projects.rows).toContainEqual(expect.objectContaining({
      projectId: `${PREFIX}-internal-self-zero-project`,
      workspaceId: W7,
      spendUsd: 0,
      hasDeployment: true,
      deploymentAvailability: "unavailable",
    }));
    expect(body.projects.rows.some((row) =>
      row.projectId === `${PREFIX}-transferred-project`)).toBe(false);

    const transferred = await get(
      `/users/${INTERNAL_PEER}/projects?viewScope=all_authorized&search=${encodeURIComponent("Transferred current")}&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(transferred.status).toBe(200);
    const transferredBody = await transferred.json() as {
      projects: { rows: Array<{ projectId: string; workspaceId: string }> };
    };
    expect(transferredBody.projects.rows).toEqual([expect.objectContaining({
      projectId: `${PREFIX}-transferred-project`,
      workspaceId: W8,
    })]);
  });

  test("project spend uses viewer qualification and global transfer identity", async () => {
    const personal = await get(
      `/spend/projects?viewScope=my&search=${encodeURIComponent("Visible self project")}&${RANGE}`,
      DETAIL_MEMBER,
    );
    expect(personal.status).toBe(200);
    const personalBody = await personal.json() as {
      rows: Array<{ agentSpendUsd: number; spendUsd: number }>;
    };
    expect(personalBody.rows).toEqual([expect.objectContaining({
      agentSpendUsd: 0,
      spendUsd: 5,
    })]);

    const group = await get(
      `/spend/projects?viewScope=all_authorized&search=${encodeURIComponent("Authorized coworker Agent project")}&${RANGE}`,
      FAMILY_ADMIN,
    );
    expect(group.status).toBe(200);
    const groupBody = await group.json() as {
      rows: Array<{ agentSpendUsd: number; spendUsd: number }>;
    };
    expect(groupBody.rows).toEqual([expect.objectContaining({
      agentSpendUsd: 10,
      spendUsd: 10,
    })]);

    const inaccessibleTransfer = await get(
      `/spend/projects?viewScope=all_authorized&search=${encodeURIComponent("Old authorized transfer source")}&${RANGE}`,
      FAMILY_ADMIN,
    );
    expect(inaccessibleTransfer.status).toBe(200);
    expect((await inaccessibleTransfer.json() as { rows: unknown[] }).rows)
      .toEqual([]);
    expect((await get(
      `/workspaces/${W3}/projects/${PREFIX}-inaccessible-transfer?${RANGE}`,
      FAMILY_ADMIN,
    )).status).toBe(404);
  });

  test("dashboard stale spend reconciles to the MTD list from a non-month range", async () => {
    const dashboardResponse = await get(
      `/dashboard?viewScope=all_authorized&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json() as {
      staleSpend: {
        spendUsd: number | null;
        projectCount: number | null;
        availability: string;
        drillThrough: string;
      };
    };
    expect(dashboard.staleSpend).toMatchObject({
      spendUsd: 5,
      projectCount: 1,
      availability: "partial",
    });
    expect(dashboard.staleSpend.drillThrough)
      .toContain("staleButSpending=true");

    const listResponse = await get(
      "/spend/projects?viewScope=all_authorized&rangeType=mtd&staleButSpending=true",
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as {
      rows: Array<{ projectId: string; currentMonthSpendUsd: number | null }>;
      totals: { currentMonthSpendUsd: number | null };
      staleEvaluation: { availability: string };
    };
    expect(list.rows.map((row) => row.projectId))
      .toEqual([`${PREFIX}-self-project`]);
    expect(list.totals.currentMonthSpendUsd)
      .toBe(dashboard.staleSpend.spendUsd);
    expect(list.staleEvaluation.availability).toBe("partial");

    const otherWorkspace = await get(
      `/spend/projects?viewScope=all_authorized&rangeType=mtd&staleButSpending=true&workspaceId=${W7}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(otherWorkspace.status).toBe(200);
    expect((await otherWorkspace.json() as { rows: unknown[] }).rows).toEqual([]);

    const workspaceDashboardResponse = await get(
      `/dashboard?viewScope=all_authorized&workspaceId=${W5}&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(workspaceDashboardResponse.status).toBe(200);
    const workspaceDashboard = await workspaceDashboardResponse.json() as {
      scope: { workspaceIds: string[] };
      accounting: { eligibleSpendUsd: number };
      staleSpend: { spendUsd: number | null; drillThrough: string };
    };
    expect(workspaceDashboard.scope.workspaceIds).toEqual([W5]);
    expect(workspaceDashboard.accounting.eligibleSpendUsd).toBe(30);
    expect(workspaceDashboard.staleSpend.spendUsd).toBe(5);
    expect(workspaceDashboard.staleSpend.drillThrough)
      .toContain(`workspaceId=${W5}`);
  });

  test("workspace group directory uses effective capability and qualified IDs", async () => {
    const groupsResponse = await get(
      `/directory/workspace-groups?workspaceId=${W5}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(groupsResponse.status).toBe(200);
    const groups = await groupsResponse.json() as {
      workspaces: Array<{ groups: Array<{ groupId: string; memberCount: number }> }>;
    };
    expect(groups.workspaces[0]?.groups).toContainEqual(expect.objectContaining({
      groupId: DETAIL_GROUP,
      memberCount: 3,
    }));

    const membersResponse = await get(
      `/directory/workspaces/${W5}/groups/${DETAIL_GROUP}/members?page=1&pageSize=2`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(membersResponse.status).toBe(200);
    const members = await membersResponse.json() as {
      members: unknown[];
      totalMembers: number;
    };
    expect(members.members).toHaveLength(2);
    expect(members.totalMembers).toBe(3);
    expect((await get(
      `/directory/workspaces/${W6}/groups/${DETAIL_GROUP}/members`,
      DETAIL_ACCOUNT_ADMIN,
    )).status).toBe(404);
    expect((await get(
      "/directory/workspace-groups",
      DETAIL_OUTSIDER,
    )).status).toBe(403);
    expect((await get(
      "/directory/workspace-groups",
      DETAIL_ACCOUNT_ADMIN,
      { "x-preview-as": `member:${DETAIL_MEMBER}` },
    )).status).toBe(403);
  });

  test("a committed metadata-only creator/title change invalidates warm accounting", async () => {
    const projectId = `${PREFIX}-self-project`;
    const warm = await get(
      `/dashboard?viewScope=all_authorized&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(warm.status).toBe(200);

    await db.update(apiProjectMetadataTable).set({
      title: "Reassigned project",
      creatorId: DETAIL_COWORKER,
      fetchedAt: new Date(),
    }).where(and(
      eq(apiProjectMetadataTable.workspaceId, W5),
      eq(apiProjectMetadataTable.projectId, projectId),
    ));
    await db.update(apiProjectMetadataStateTable).set({
      completedAt: new Date(Date.now() + 1_000),
      status: "success",
    }).where(eq(apiProjectMetadataStateTable.workspaceId, W5));

    const accountResponse = await get(
      `/spend/projects?viewScope=all_authorized&search=${encodeURIComponent("Reassigned project")}&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(accountResponse.status).toBe(200);
    const account = await accountResponse.json() as {
      rows: Array<{
        id: string;
        name: string;
        ownerName: string | null;
        spendUsd: number;
      }>;
    };
    expect(account.rows).toEqual([expect.objectContaining({
      id: `project:${W5}:${projectId}`,
      name: "Reassigned project",
      ownerName: DETAIL_COWORKER,
      spendUsd: 5,
    })]);

    const memberResponse = await get(
      `/spend/projects?viewScope=my&search=${encodeURIComponent("Reassigned project")}&${RANGE}`,
      DETAIL_MEMBER,
    );
    expect(memberResponse.status).toBe(200);
    const scoped = await memberResponse.json() as { rows: unknown[] };
    expect(scoped.rows).toEqual([]);

    await db.update(apiProjectMetadataTable).set({
      title: "Visible self project",
      creatorId: DETAIL_MEMBER,
      fetchedAt: new Date(),
    }).where(and(
      eq(apiProjectMetadataTable.workspaceId, W5),
      eq(apiProjectMetadataTable.projectId, projectId),
    ));
    await db.update(apiProjectMetadataStateTable).set({
      completedAt: new Date(Date.now() + 2_000),
      status: "success",
    }).where(eq(apiProjectMetadataStateTable.workspaceId, W5));
  });

  test("warm Dashboard to Spend presentation changes reuse common accounting without scope contamination", async () => {
    const before = __getScopedAccountingBuildCountForTests();
    const managedResponse = await get(
      `/dashboard?viewScope=managed&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(managedResponse.status).toBe(200);
    const managed = await managedResponse.json() as {
      scope: { viewScope: string; label: string };
    };
    expect(managed.scope).toMatchObject({
      viewScope: "managed",
      label: "Managed scope",
    });
    const afterDashboard = __getScopedAccountingBuildCountForTests();
    expect(afterDashboard).toBeGreaterThanOrEqual(before);

    const allResponse = await get(
      `/dashboard?viewScope=all_authorized&${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(allResponse.status).toBe(200);
    const all = await allResponse.json() as {
      scope: { viewScope: string; label: string };
    };
    expect(all.scope).toMatchObject({
      viewScope: "all_authorized",
      label: "All authorized",
    });
    for (const suffix of [
      "page=1&pageSize=2&sort=name_asc",
      "page=2&pageSize=2&sort=spend_desc",
      `page=1&pageSize=2&search=${encodeURIComponent("detail")}`,
    ]) {
      const response = await get(
        `/spend/groups?viewScope=all_authorized&${suffix}&${RANGE}`,
        DETAIL_ACCOUNT_ADMIN,
      );
      expect(response.status).toBe(200);
    }
    expect(__getScopedAccountingBuildCountForTests()).toBe(afterDashboard);

    const mtdResponse = await get(
      "/dashboard?viewScope=all_authorized&rangeType=mtd",
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(mtdResponse.status).toBe(200);
    const mtd = await mtdResponse.json() as {
      period: { start: string; endExclusive: string; label: string };
    };
    const afterMtd = __getScopedAccountingBuildCountForTests();
    const endDate = new Date(
      Date.parse(mtd.period.endExclusive) - 86_400_000,
    ).toISOString().slice(0, 10);
    const customResponse = await get(
      `/dashboard?viewScope=all_authorized&rangeType=custom&startDate=${mtd.period.start.slice(0, 10)}&endDate=${endDate}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(customResponse.status).toBe(200);
    const custom = await customResponse.json() as {
      period: { start: string; endExclusive: string; label: string };
    };
    expect(custom.period.start).toBe(mtd.period.start);
    expect(custom.period.endExclusive).toBe(mtd.period.endExclusive);
    expect(mtd.period.label).toContain("(MTD)");
    expect(custom.period.label).not.toContain("(MTD)");
    expect(__getScopedAccountingBuildCountForTests()).toBe(afterMtd);
  });

  test("People includes authorized directory members with no spend or group", async () => {
    const response = await get(
      `/spend/people?viewScope=managed&${RANGE}`,
      DETAIL_WORKSPACE_ADMIN,
    );
    expect(response.status).toBe(200);
    const value = await response.json() as {
      rows: Array<{ id: string; spendUsd: number; agentSpendUsd: number }>;
      metadata: { status: string; coverage: { missingDays: string[] } };
      totals: { reconciliationUsd: number };
    };
    expect(value.rows).toContainEqual(expect.objectContaining({
      id: `person:${W5}:${DETAIL_WORKSPACE_ADMIN}`,
      spendUsd: 0,
      agentSpendUsd: 0,
    }));
    expect(value.metadata.status).toBe("complete");
    expect(value.metadata.coverage.missingDays).toEqual([]);
    expect(value.totals.reconciliationUsd).toBe(0);
  });

  test("workspace scope exposes a failed refresh as qualified last-good data", async () => {
    const attemptedAt = new Date(Date.now() + 5_000);
    const [run] = await db.insert(ingestRunTable).values({
      kind: "live",
      startedAt: new Date(attemptedAt.getTime() - 1_000),
      finishedAt: attemptedAt,
      units: 1,
      calls: 1,
      failures: 1,
      remaining: 0,
      error: `failed-units:${TODAY}|${W5}\n${TODAY}|${W2}\n${TODAY}|`,
    }).returning({ id: ingestRunTable.id });
    invalidateUsageSnapshotMemo();
    try {
      const response = await get(
        `/spend/people?viewScope=managed&${RANGE}`,
        DETAIL_WORKSPACE_ADMIN,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      const value = JSON.parse(text) as {
        metadata: { status: string; stale: boolean; qualifications: string[] };
      };
      expect(value.metadata).toMatchObject({ status: "stale", stale: true });
      expect(value.metadata.qualifications).toContain(
        "The latest usage refresh failed for part of this scope; last successful facts are shown.",
      );
      expect(text).not.toContain(W2);
    } finally {
      if (run) {
        await db.delete(ingestRunTable).where(eq(ingestRunTable.id, run.id));
      }
      invalidateUsageSnapshotMemo();
    }
  });

  test("cold workspace rows are unavailable without turning observed zeroes unhealthy", async () => {
    await db.delete(usageMemberDayTable).where(and(
      eq(usageMemberDayTable.workspaceId, W1),
      eq(usageMemberDayTable.usageDate, TODAY),
    ));
    await db.delete(usageWorkspaceDayTable).where(and(
      eq(usageWorkspaceDayTable.workspaceId, W1),
      eq(usageWorkspaceDayTable.usageDate, TODAY),
    ));
    invalidateUsageSnapshotMemo();
    try {
      const response = await get(
        `/spend/groups?viewScope=all_authorized&${RANGE}`,
        DETAIL_ACCOUNT_ADMIN,
      );
      expect(response.status).toBe(200);
      const value = await response.json() as {
        rows: Array<{
          workspaceId: string | null;
          usageObserved: boolean;
          status: string;
          remainingUsd: number | null;
          percentUsed: number | null;
        }>;
        metadata: { status: string; qualifications: string[] };
      };
      const coldRows = value.rows.filter((row) => row.workspaceId === W1);
      expect(coldRows.length).toBeGreaterThan(0);
      expect(coldRows).toEqual(coldRows.map((row) => ({
        ...row,
        usageObserved: false,
        status: "unavailable",
        remainingUsd: null,
        percentUsed: null,
      })));
      expect(value.rows.filter((row) => row.workspaceId === W2)
        .every((row) => row.usageObserved)).toBe(true);
      expect(value.metadata.status).toBe("partial");
      expect(value.metadata.qualifications).toContain(
        "Partial usage coverage; missing facts are not zero.",
      );
      const scopedPoolResponse = await get(
        `/spend/pools?viewScope=managed&${RANGE}`,
        SHARED_ADMIN,
      );
      const scopedPools = await scopedPoolResponse.json() as {
        rows: Array<{ usageObserved: boolean; status: string }>;
      };
      expect(scopedPools.rows).toEqual([
        expect.objectContaining({
          usageObserved: false,
          status: "unavailable",
        }),
      ]);
    } finally {
      await db.insert(usageMemberDayTable).values({
        workspaceId: W1,
        usageDate: TODAY,
        userId: SHARED_ADMIN,
        totalCostUsd: 5,
        aiCostUsd: 5,
        metricsJson: [],
        fetchedAt: new Date(),
      });
      await db.insert(usageWorkspaceDayTable).values({
        workspaceId: W1,
        usageDate: TODAY,
        totalCostUsd: 5,
        memberAttributableUsd: 5,
        memberUnattributableUsd: 0,
        metricsJson: [],
        fetchedAt: new Date(),
        status: "complete",
      });
      invalidateUsageSnapshotMemo();
    }
  });

  test("cross-workspace pool returns only authorized contribution and no denominator", async () => {
    const poolResponse = await get(
      `/spend/pools?viewScope=managed&${RANGE}`,
      SHARED_ADMIN,
    );
    expect(poolResponse.status).toBe(200);
    const pools = await poolResponse.json() as {
      rows: Array<Record<string, unknown>>;
    };
    expect(pools.rows).toHaveLength(1);
    expect(pools.rows[0]).toMatchObject({
      spendUsd: 5,
      allocationUsd: null,
      remainingUsd: null,
      percentUsed: null,
      status: "shared",
      sharedPool: true,
    });
    const poolCsvResponse = await get(
      `/spend/pools.csv?viewScope=managed&${RANGE}`,
      SHARED_ADMIN,
    );
    expect(poolCsvResponse.status).toBe(200);
    const poolCsv = await poolCsvResponse.text();
    const poolCells = poolCsv.trim().split("\r\n")[1]!
      .split(",").map((cell) => JSON.parse(cell) as string);
    expect(poolCells[5]).toBe("5");
    expect(poolCells.slice(8, 14)).toEqual(["", "", "", "", "", ""]);
    expect(poolCells[14]).toBe("shared");

    const dashboardResponse = await get(
      `/dashboard?viewScope=managed&${RANGE}`,
      SHARED_ADMIN,
    );
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json() as {
      accounting: { eligibleSpendUsd: number };
      cards: Array<{ key: string; value: number | null }>;
      trend: { buckets: Array<{ spendUsd: number | null }> };
      breakdown: Array<{ spendUsd: number; drillThrough: string }>;
      metadata: { generationId: string; status: string };
      period: { start: string; endExclusive: string };
      scope: { viewScope: string };
    };
    expect(dashboard.accounting.eligibleSpendUsd).toBe(5);
    expect(dashboard.cards.every((card: { value: number | null }) =>
      card.value !== 1_000 && card.value !== 500)).toBe(true);
    expect(dashboard.breakdown.reduce((sum, item) =>
      sum + item.spendUsd, 0)).toBe(5);
    // Workspace-only daily readiness does not depend on a privileged account
    // anchor, so known scoped spend remains present in the trend.
    expect(dashboard.metadata.status).toBe("complete");
    expect(dashboard.trend.buckets.reduce((sum, bucket) =>
      sum + (bucket.spendUsd ?? 0), 0)).toBe(5);
    expect(dashboard.metadata.generationId).toHaveLength(24);
    for (const item of dashboard.breakdown) {
      const drill = new URL(item.drillThrough, baseUrl);
      expect(drill.searchParams.get("viewScope")).toBe(dashboard.scope.viewScope);
      expect(drill.searchParams.get("rangeType")).toBe("custom");
      expect(drill.searchParams.get("startDate"))
        .toBe(dashboard.period.start.slice(0, 10));
      expect(drill.searchParams.get("endDate")).toBe(TODAY);
    }
  });

  test("invalid dashboard query receives 400 without becoming accounting unavailable", async () => {
    for (const query of [
      "/dashboard?rangeType=custom&startDate=not-a-day",
      "/dashboard?rangeType=custom&startDate=2026-02-31&endDate=2026-03-01",
      "/dashboard?rangeType=custom&startDate=2020-01-01&endDate=2020-01-02",
    ]) {
      const response = await get(query, SHARED_ADMIN);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.any(String),
      });
    }
  });

  test("dashboard fails closed when ingest publishes between accounting and projection reads", async () => {
    __setDashboardAfterAccountingHookForTests(() => {
      const finish = beginUsageGenerationUpdate();
      invalidateUsageSnapshotMemo();
      finish();
    });
    try {
      const response = await get(
        `/dashboard?viewScope=all_authorized&${RANGE}`,
        DETAIL_ACCOUNT_ADMIN,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Dashboard usage changed during generation; retry the request",
      });
    } finally {
      __setDashboardAfterAccountingHookForTests(null);
    }
  });

  test("family admin cannot see authorized coworker's other-family spend", async () => {
    const dashboardResponse = await get(
      `/dashboard?viewScope=all_authorized&${RANGE}`,
      FAMILY_ADMIN,
    );
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json() as {
      accounting: { eligibleSpendUsd: number };
    };
    expect(dashboard.accounting.eligibleSpendUsd).toBe(11);
    expect(dashboard.accounting.eligibleSpendUsd).not.toBe(110);

    const peopleResponse = await get(
      `/spend/people?viewScope=all_authorized&${RANGE}&sort=spend_desc`,
      FAMILY_ADMIN,
    );
    expect(peopleResponse.status).toBe(200);
    const people = await peopleResponse.json() as {
      rows: Array<{ id: string; spendUsd: number }>;
    };
    expect(people.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `person:${W3}:${COWORKER}`, spendUsd: 10 }),
      expect.objectContaining({ id: `person:${W4}:${FAMILY_ADMIN}`, spendUsd: 1 }),
    ]));
    expect(people.rows.some((row: { id: string }) =>
      row.id === `person:${W4}:${COWORKER}`)).toBe(false);
    const peopleCsvResponse = await get(
      `/spend/people.csv?viewScope=all_authorized&${RANGE}&sort=spend_desc`,
      FAMILY_ADMIN,
    );
    expect(peopleCsvResponse.status).toBe(200);
    const peopleCsv = await peopleCsvResponse.text();
    expect(peopleCsv).toContain(`\"person:${W3}:${COWORKER}\"`);
    expect(peopleCsv).not.toContain(`\"person:${W4}:${COWORKER}\"`);
  });

  test("JSON and CSV apply identical scope, period, search, status, and sort", async () => {
    const predicates =
      `viewScope=all_authorized&${RANGE}&search=coworker&status=no_limit&sort=spend_desc`;
    const jsonResponse = await get(`/spend/people?${predicates}`, FAMILY_ADMIN);
    const csvResponse = await get(`/spend/people.csv?${predicates}`, FAMILY_ADMIN);
    expect(jsonResponse.status).toBe(200);
    expect(csvResponse.status).toBe(200);
    const json = await jsonResponse.json() as {
      filteredRows: number;
      rows: Array<{ id: string }>;
      metadata: { generationId: string };
    };
    const csv = await csvResponse.text();
    expect(json.filteredRows).toBe(1);
    expect(json.rows.map((row: { id: string }) => row.id)).toEqual([
      `person:${W3}:${COWORKER}`,
    ]);
    expect(csvResponse.headers.get("x-filtered-rows")).toBe("1");
    expect(csvResponse.headers.get("x-total-spend-usd")).toBe("10");
    expect(csv).toContain(`\"person:${W3}:${COWORKER}\"`);
    expect(csv).not.toContain(`\"person:${W4}:${COWORKER}\"`);
    expect(csvResponse.headers.get("x-generation-id"))
      .toBe(json.metadata.generationId);
  });
});

describe("authenticated group detail qualification", () => {
  test("compact qualification preserves stale cache refresh failures", () => {
    expect(__reportingDetailBaseQualificationsForTests([
      "Partial usage coverage for an unrelated workspace.",
      "The latest accounting refresh failed; the last successful stored result is shown.",
    ])).toEqual([
      "The latest accounting refresh failed; the last successful stored result is shown.",
    ]);
  });

  async function detail(userId: string) {
    const response = await get(`/groups/${DETAIL_GROUP}?${RANGE}`, userId);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      group: {
        spendUsd: number;
        rollupSpendUsd: number;
        projectSpendUsd: number;
        memberCount: number;
        rollupMemberCount: number;
        cycleAgentSpendUsd: number;
        budgetUsd: number | null;
        remainingUsd: number | null;
        percentUsed: number | null;
        history: Array<{ spendUsd: number }>;
      };
      members: Array<{
        userId: string;
        spendUsd: number;
        aiSpendUsd: number;
        allocatedBudgetUsd: number | null;
        budgetSource: string | null;
        limitState: string;
        limitObservationStatus: string;
      }>;
      membersSpendUsd: number;
      unattributedSpendUsd: number;
      usageHealth: { accountWorkspaceUnreconciledUsd: number };
    }>;
  }

  async function projects(userId: string) {
    const response = await get(
      `/groups/${DETAIL_GROUP}/projects?${RANGE}`,
      userId,
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      projects: Array<{
        projectId: string;
        title: string | null;
        creatorId: string | null;
        totalCostUsd: number;
      }>;
      unattributedSpendUsd: number;
      usageHealth: { accountWorkspaceUnreconciledUsd: number };
    }>;
  }

  test("member sees only self aggregate, history, Agent usage, and project", async () => {
    const value = await detail(DETAIL_MEMBER);
    expect(value.group).toMatchObject({
      spendUsd: 10,
      rollupSpendUsd: 10,
      projectSpendUsd: 5,
      memberCount: 1,
      rollupMemberCount: 1,
      cycleAgentSpendUsd: 5,
      budgetUsd: null,
      remainingUsd: null,
      percentUsed: null,
    });
    expect(value.group.history.map((item) => item.spendUsd)).toEqual([10]);
    expect(value.members).toEqual([
      expect.objectContaining({
        userId: DETAIL_MEMBER,
        spendUsd: 10,
        aiSpendUsd: 5,
        allocatedBudgetUsd: 20,
        budgetSource: "workspace_user_limit",
        limitState: "explicit",
        limitObservationStatus: "complete",
      }),
    ]);
    const projectValue = await projects(DETAIL_MEMBER);
    expect(projectValue.projects).toEqual([
      expect.objectContaining({
        projectId: `${PREFIX}-self-project`,
        title: "Visible self project",
        creatorId: DETAIL_MEMBER,
        totalCostUsd: 5,
      }),
    ]);
    expect(JSON.stringify(projectValue)).not.toContain("Secret coworker project");
    expect(JSON.stringify(projectValue)).not.toContain(DETAIL_COWORKER);
    expect(projectValue.projects.reduce((sum, project) =>
      sum + project.totalCostUsd, projectValue.unattributedSpendUsd))
      .toBe(value.group.spendUsd);
  });

  test("family admin excludes users not qualified for that family", async () => {
    const value = await detail(DETAIL_FAMILY_ADMIN);
    expect(value.group.spendUsd).toBe(6);
    expect(value.group.memberCount).toBe(1);
    expect(value.members.map((item) => item.userId)).toEqual([
      DETAIL_FAMILY_ADMIN,
    ]);
    const projectValue = await projects(DETAIL_FAMILY_ADMIN);
    expect(projectValue.projects.map((item) => item.projectId)).toEqual([
      `${PREFIX}-family-project`,
    ]);
    expect(projectValue.projects.reduce((sum, project) =>
      sum + project.totalCostUsd, projectValue.unattributedSpendUsd))
      .toBe(value.group.spendUsd);
  });

  test.each([
    [DETAIL_WORKSPACE_ADMIN, 30],
    [DETAIL_ACCOUNT_ADMIN, 30],
  ])("%s retains the full authorized group", async (userId, expectedSpend) => {
    const value = await detail(userId);
    expect(value.group.spendUsd).toBe(expectedSpend);
    expect(value.group.memberCount).toBe(3);
    expect(value.membersSpendUsd + value.unattributedSpendUsd)
      .toBe(expectedSpend);
    const projectValue = await projects(userId);
    expect(projectValue.projects).toHaveLength(3);
    expect(projectValue.projects.reduce((sum, project) =>
      sum + project.totalCostUsd, projectValue.unattributedSpendUsd))
      .toBe(expectedSpend);
    expect(value.usageHealth.accountWorkspaceUnreconciledUsd).toBe(0);
    expect(projectValue.usageHealth.accountWorkspaceUnreconciledUsd).toBe(0);
  });

  test("a direct bookmarked group URL cannot bypass scope", async () => {
    const detailResponse = await get(
      `/groups/${DETAIL_GROUP}?${RANGE}`,
      DETAIL_OUTSIDER,
    );
    const projectResponse = await get(
      `/groups/${DETAIL_GROUP}/projects?${RANGE}`,
      DETAIL_OUTSIDER,
    );
    expect(detailResponse.status).toBe(404);
    expect(projectResponse.status).toBe(404);
  });

  test("compact reporting detail deduplicates IDs and uses workspace current-cycle Agent metrics", async () => {
    const response = await get(
      `/reporting/details/${DETAIL_GROUP},${DETAIL_GROUP}?${RANGE}`,
      DETAIL_MEMBER,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("current-cycle;dur=");
    expect(response.headers.get("server-timing")).toContain("projection;dur=");
    const value = await response.json() as {
      kind: string;
      groups: Array<{ groupId: string }>;
      members: Array<{
        workspaceId: string;
        userId: string;
        currentCycleAgentSpendUsd: number | null;
        limitUsd: number | null;
        remainingUsd: number | null;
      }>;
      headline: { memberCount: number; isComplete: boolean };
    };
    expect(value.kind).toBe("group");
    expect(value.groups.map((group) => group.groupId)).toEqual([DETAIL_GROUP]);
    expect(value.headline).toMatchObject({ memberCount: 1, isComplete: true });
    expect(value.members).toEqual([
      expect.objectContaining({
        workspaceId: W5,
        userId: DETAIL_MEMBER,
        currentCycleAgentSpendUsd: 5,
        limitUsd: 20,
        remainingUsd: 15,
      }),
    ]);
  });

  test("compact reporting detail fails closed for unknown Agent metrics and scope", async () => {
    const authorized = await get(
      `/reporting/details/${DETAIL_GROUP}?${RANGE}`,
      DETAIL_WORKSPACE_ADMIN,
    );
    expect(authorized.status).toBe(200);
    const value = await authorized.json() as {
      members: Array<{
        userId: string;
        currentCycleAgentSpendUsd: number | null;
        remainingUsd: number | null;
      }>;
      metadata: { qualifications: string[] };
    };
    expect(value.members.find((member) => member.userId === DETAIL_COWORKER))
      .toMatchObject({
        currentCycleAgentSpendUsd: null,
        remainingUsd: null,
      });
    expect(value.metadata.qualifications.join(" ")).toContain(
      "Current-cycle Agent metric classification is unavailable",
    );

    const hidden = await get(
      `/reporting/details/${DETAIL_GROUP}?${RANGE}`,
      DETAIL_OUTSIDER,
    );
    expect(hidden.status).toBe(404);
    const tooMany = Array.from({ length: 33 }, (_, index) => `g${index}`).join(",");
    const bounded = await get(`/reporting/details/${tooMany}?${RANGE}`, DETAIL_ACCOUNT_ADMIN);
    expect(bounded.status).toBe(400);
  });

  test("compact reporting does not expand canonical pools outside scope", async () => {
    const scopedResponse = await get(
      `/reporting/details/${SHARED_1}?${RANGE}`,
      SHARED_ADMIN,
    );
    expect(scopedResponse.status).toBe(200);
    const scoped = await scopedResponse.json() as {
      groups: Array<{ spendUsd: number; allocationUsd: number | null }>;
      headline: { spendUsd: number };
    };
    expect(scoped.groups).toEqual([
      expect.objectContaining({ spendUsd: 5, allocationUsd: null }),
    ]);
    expect(scoped.headline.spendUsd).toBe(5);
  });

  test("budget team report uses the authorized canonical pool across families and workspaces", async () => {
    const poolId = `pool:team:${encodeURIComponent(SHARED_TEAM)}`;
    const response = await get(
      `/reporting/teams/${encodeURIComponent(poolId)}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(response.status).toBe(200);
    const value = await response.json() as {
      kind: string;
      id: string;
      name: string;
      headline: {
        familyKey: string | null;
        familyName: string;
        usageObserved?: boolean;
        spendUsd: number;
        allocationUsd: number | null;
        memberCount: number;
      };
      groups: Array<{ groupId: string; workspaceId: string }>;
      sourceGroups: Array<{ groupId: string; workspaceId: string }>;
      members: Array<{ workspaceId: string; userId: string; groupIds: string[] }>;
    };
    expect(value).toMatchObject({
      kind: "team",
      id: poolId,
      name: SHARED_TEAM,
      headline: {
        familyKey: null,
        familyName: SHARED_TEAM,
        usageObserved: true,
        spendUsd: 505,
        allocationUsd: 1_000,
        memberCount: 2,
      },
    });
    expect(value.groups.map((group) => group.groupId).sort())
      .toEqual([SHARED_1, SHARED_2].sort());
    expect(value.sourceGroups.map((group) => group.groupId).sort())
      .toEqual([SHARED_1, SHARED_2].sort());
    expect(value.members.map((member) =>
      `${member.workspaceId}:${member.userId}`).sort()).toEqual([
      `${W1}:${SHARED_ADMIN}`,
      `${W2}:${COWORKER}`,
    ].sort());
  });

  test("budget team report and pool source IDs never expand beyond authorized scope", async () => {
    const poolId = `pool:team:${encodeURIComponent(SHARED_TEAM)}`;
    const poolsResponse = await get(
      `/spend/pools?${RANGE}&viewScope=all_authorized&pageSize=100`,
      SHARED_ADMIN,
    );
    expect(poolsResponse.status).toBe(200);
    const pools = await poolsResponse.json() as {
      rows: Array<{ id: string; sourceGroupIds?: string[] }>;
    };
    expect(pools.rows.find((row) => row.id === poolId)?.sourceGroupIds)
      .toEqual([SHARED_1]);
    expect(JSON.stringify(pools)).not.toContain(SHARED_2);

    const response = await get(
      `/reporting/teams/${encodeURIComponent(poolId)}?${RANGE}`,
      SHARED_ADMIN,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const value = JSON.parse(text) as {
      headline: { spendUsd: number; allocationUsd: number | null };
      sourceGroups: Array<{ groupId: string }>;
      members: Array<{ userId: string }>;
    };
    expect(value.headline).toMatchObject({ spendUsd: 5, allocationUsd: null });
    expect(value.sourceGroups.map((group) => group.groupId)).toEqual([SHARED_1]);
    expect(value.members.map((member) => member.userId)).toEqual([SHARED_ADMIN]);
    expect(text).not.toContain(SHARED_2);
  });

  test("budget team report handles an allocated unmapped team and rejects non-team pools", async () => {
    const emptyPoolId = `pool:team:${encodeURIComponent(ZERO_SPEND_TEAM)}`;
    const emptyResponse = await get(
      `/reporting/teams/${encodeURIComponent(emptyPoolId)}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toMatchObject({
      kind: "team",
      id: emptyPoolId,
      groups: [],
      sourceGroups: [],
      members: [],
      headline: {
        spendUsd: 0,
        allocationUsd: 240,
        remainingUsd: 240,
        memberCount: 0,
        isComplete: true,
        usageObserved: true,
      },
      metadata: { status: "complete", coverage: { ratio: 1 } },
    });

    const generic = await get(
      `/reporting/teams/${encodeURIComponent(`pool:group:${W5}:${DETAIL_GROUP}`)}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(generic.status).toBe(404);
    const unbudgeted = await get(
      `/reporting/teams/${encodeURIComponent(`pool:unbudgeted:${W5}`)}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(unbudgeted.status).toBe(404);
  });

  test("budget team reports allow more than 32 mapped canonical groups", async () => {
    const poolId = `pool:team:${encodeURIComponent(LARGE_TEAM)}`;
    const response = await get(
      `/reporting/teams/${encodeURIComponent(poolId)}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(response.status).toBe(200);
    const value = await response.json() as {
      headline: { usageObserved?: boolean; allocationUsd: number | null };
      groups: Array<{ groupId: string }>;
      sourceGroups: Array<{ groupId: string }>;
    };
    expect(value.headline).toMatchObject({
      usageObserved: true,
      allocationUsd: 330,
    });
    expect(value.groups).toHaveLength(33);
    expect(value.sourceGroups).toHaveLength(33);
    expect(value.sourceGroups.map((group) => group.groupId).sort())
      .toEqual(LARGE_TEAM_GROUPS.map((group) => group.id).sort());
  });

  test("team headline marks zero accumulators unknown when mapped workspaces have no facts", async () => {
    await db.delete(usageWorkspaceDayTable).where(and(
      inArray(usageWorkspaceDayTable.workspaceId, [W1, W2]),
      eq(usageWorkspaceDayTable.usageDate, TODAY),
    ));
    await db.delete(usageMemberDayTable).where(and(
      inArray(usageMemberDayTable.workspaceId, [W1, W2]),
      eq(usageMemberDayTable.usageDate, TODAY),
    ));
    invalidateUsageSnapshotMemo();
    try {
      const poolId = `pool:team:${encodeURIComponent(SHARED_TEAM)}`;
      const response = await get(
        `/reporting/teams/${encodeURIComponent(poolId)}?${RANGE}`,
        DETAIL_ACCOUNT_ADMIN,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        headline: {
          usageObserved: false,
          spendUsd: 0,
          isComplete: false,
          remainingUsd: null,
        },
        metadata: { status: "empty" },
      });
    } finally {
      await db.insert(usageWorkspaceDayTable).values([
        { workspaceId: W1, usageDate: TODAY, totalCostUsd: 5, memberAttributableUsd: 5, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
        { workspaceId: W2, usageDate: TODAY, totalCostUsd: 500, memberAttributableUsd: 500, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
      ]);
      await db.insert(usageMemberDayTable).values([
        { workspaceId: W1, usageDate: TODAY, userId: SHARED_ADMIN, totalCostUsd: 5, aiCostUsd: 5, metricsJson: [], fetchedAt: new Date() },
        { workspaceId: W2, usageDate: TODAY, userId: COWORKER, totalCostUsd: 500, aiCostUsd: 500, metricsJson: [], fetchedAt: new Date() },
      ]);
      invalidateUsageSnapshotMemo();
    }
  });

  test("physical group reporting still rejects groups from multiple families", async () => {
    const response = await get(
      `/reporting/details/${FAMILY_A},${FAMILY_B}?${RANGE}`,
      FAMILY_ADMIN,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Requested groups must belong to one family",
    });
  });

  test("compact reporting deduplicates primary-only and primary-plus-legacy requests", async () => {
    const primaryResponse = await get(
      `/reporting/details/${MERGED_PRIMARY}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    const aliasesResponse = await get(
      `/reporting/details/${MERGED_PRIMARY},${MERGED_LEGACY}?${RANGE}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(primaryResponse.status).toBe(200);
    expect(aliasesResponse.status).toBe(200);
    const primary = await primaryResponse.json() as {
      groups: Array<{ groupId: string }>;
      sourceGroups: Array<{
        groupId: string;
        workspaceId: string;
        role: string;
      }>;
      headline: { spendUsd: number };
    };
    const aliases = await aliasesResponse.json() as typeof primary;
    expect(primary.groups).toHaveLength(1);
    expect(primary.groups[0]!.groupId).toBe(MERGED_PRIMARY);
    expect(primary.sourceGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        groupId: MERGED_PRIMARY,
        workspaceId: W6,
        role: "member",
      }),
      expect.objectContaining({
        groupId: MERGED_LEGACY,
        workspaceId: WLEG,
        role: "member",
      }),
    ]));
    expect(primary.headline.spendUsd).toBe(24);
    expect(aliases).toEqual(primary);
  });

  test("compact reporting preserves historical roster spend as reconciled residual", async () => {
    const response = await get(
      `/reporting/details/${MERGED_PRIMARY}?rangeType=custom&startDate=${YESTERDAY}&endDate=${YESTERDAY}`,
      DETAIL_ACCOUNT_ADMIN,
    );
    expect(response.status).toBe(200);
    const value = await response.json() as {
      headline: {
        spendUsd: number;
        membersSpendUsd: number;
        unattributedSpendUsd: number;
      };
      members: Array<{ userId: string }>;
    };
    expect(value.headline).toMatchObject({
      spendUsd: 17,
      membersSpendUsd: 0,
      unattributedSpendUsd: 17,
    });
    expect(value.members.some((member) =>
      member.userId === HISTORICAL_MEMBER)).toBe(false);
  });

  test("compact reporting health excludes unrelated workspace coverage failures", async () => {
    await db.delete(usageWorkspaceDayTable).where(and(
      eq(usageWorkspaceDayTable.workspaceId, W2),
      eq(usageWorkspaceDayTable.usageDate, TODAY),
    ));
    invalidateUsageSnapshotMemo();
    try {
      const response = await get(
        `/reporting/details/${DETAIL_GROUP}?${RANGE}`,
        DETAIL_ACCOUNT_ADMIN,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      const value = JSON.parse(text) as {
        headline: { isComplete: boolean };
        metadata: {
          status: string;
          coverage: { ratio: number; missingDays: string[]; failedWorkspaceDays: string[] };
          qualifications: string[];
        };
      };
      expect(value.headline.isComplete).toBe(true);
      expect(value.metadata.status).toBe("complete");
      expect(value.metadata.coverage).toMatchObject({
        ratio: 1,
        missingDays: [],
        failedWorkspaceDays: [],
      });
      expect(text).not.toContain(W2);
      expect(value.metadata.qualifications.join(" ")).not.toContain(
        "Partial usage coverage",
      );
    } finally {
      await db.insert(usageWorkspaceDayTable).values({
        workspaceId: W2,
        usageDate: TODAY,
        totalCostUsd: 500,
        memberAttributableUsd: 500,
        memberUnattributableUsd: 0,
        metricsJson: [],
        fetchedAt: new Date(),
        status: "complete",
      });
      invalidateUsageSnapshotMemo();
    }
  });

  test("compact reporting reports empty when requested workspaces have no facts", async () => {
    await db.delete(usageWorkspaceDayTable).where(and(
      inArray(usageWorkspaceDayTable.workspaceId, [W6, WLEG]),
      eq(usageWorkspaceDayTable.usageDate, TODAY),
    ));
    await db.delete(usageMemberDayTable).where(and(
      inArray(usageMemberDayTable.workspaceId, [W6, WLEG]),
      eq(usageMemberDayTable.usageDate, TODAY),
    ));
    invalidateUsageSnapshotMemo();
    try {
      const response = await get(
        `/reporting/details/${MERGED_PRIMARY}?${RANGE}`,
        DETAIL_ACCOUNT_ADMIN,
      );
      expect(response.status).toBe(200);
      const value = await response.json() as {
        headline: { spendUsd: number; isComplete: boolean };
        metadata: { status: string };
      };
      expect(value.headline).toMatchObject({ spendUsd: 0, isComplete: false });
      expect(value.metadata.status).toBe("empty");
    } finally {
      await db.insert(usageWorkspaceDayTable).values([
        { workspaceId: W6, usageDate: TODAY, totalCostUsd: 11, memberAttributableUsd: 11, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
        { workspaceId: WLEG, usageDate: TODAY, totalCostUsd: 13, memberAttributableUsd: 13, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
      ]);
      await db.insert(usageMemberDayTable).values([
        { workspaceId: W6, usageDate: TODAY, userId: CURRENT_MERGED_MEMBER, totalCostUsd: 11, aiCostUsd: 11, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 11 }], fetchedAt: new Date() },
        { workspaceId: WLEG, usageDate: TODAY, userId: CURRENT_MERGED_MEMBER, totalCostUsd: 13, aiCostUsd: 13, metricsJson: [{ id: "ai_agent", name: "Agent", category: "ai", costUsd: 13 }], fetchedAt: new Date() },
      ]);
      invalidateUsageSnapshotMemo();
    }
  });

  if (process.env.REPORTING_DETAIL_BENCHMARK === "1") {
    test("measures compact reporting against the legacy request sequence", async () => {
      const percentiles = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          p50: sorted[Math.floor(sorted.length * 0.5)]!,
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
        };
      };
      const cases = [1, 2, 8].map((count) => ({
        count,
        ids: BENCHMARK_GROUPS.slice(0, count).map((group) => group.id),
      }));
      const output = [];
      for (const fixture of cases) {
        const path = `/reporting/details/${fixture.ids.join(",")}?${RANGE}`;
        for (let warmup = 0; warmup < 2; warmup += 1) {
          const response = await get(path, DETAIL_ACCOUNT_ADMIN);
          expect(response.ok).toBe(true);
          await response.arrayBuffer();
        }
        const durations = [];
        let bytes = 0;
        let timing = "";
        for (let sample = 0; sample < 20; sample += 1) {
          const startedAt = performance.now();
          const response = await get(path, DETAIL_ACCOUNT_ADMIN);
          expect(response.ok).toBe(true);
          const body = await response.text();
          durations.push(performance.now() - startedAt);
          bytes = Buffer.byteLength(body);
          timing = response.headers.get("server-timing") ?? "";
        }
        output.push({
          kind: "compact",
          requestedIds: fixture.count,
          ...percentiles(durations),
          bytes,
          timing,
        });
      }
      const legacyDurations = [];
      let legacyBytes = 0;
      // Match the old operator drilldown: detail/headline/projects first, then
      // workspace limit data and audits once the workspace is known.
      authorizations[DETAIL_ACCOUNT_ADMIN]!.capabilities.canWriteUserLimitsIn = [W6];
      const legacySequence = async (ids: string[]) => {
        const responses = await Promise.all([
          ...ids.map((id) => get(`/groups/${id}?${RANGE}`, DETAIL_ACCOUNT_ADMIN)),
          get(`/clusters/${ids.join(",")}/headline?${RANGE}`, DETAIL_ACCOUNT_ADMIN),
          get(`/clusters/${ids.join(",")}/projects?${RANGE}`, DETAIL_ACCOUNT_ADMIN),
        ]);
        responses.push(...await Promise.all([
          get(`/directory/workspaces/${W6}/members`, DETAIL_ACCOUNT_ADMIN),
          get(`/directory/workspaces/${W6}/usage-limit-audits`, DETAIL_ACCOUNT_ADMIN),
        ]));
        expect(responses.every((response) => response.ok)).toBe(true);
        const bodies = await Promise.all(responses.map((response) => response.text()));
        return bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0);
      };
      const legacyIds = BENCHMARK_GROUPS.map((group) => group.id);
      for (let warmup = 0; warmup < 2; warmup += 1) {
        await legacySequence(legacyIds);
      }
      for (let sample = 0; sample < 20; sample += 1) {
        const startedAt = performance.now();
        legacyBytes = await legacySequence(legacyIds);
        legacyDurations.push(performance.now() - startedAt);
      }
      process.stdout.write(`REPORTING_DETAIL_BENCHMARK ${JSON.stringify([
        ...output,
        {
          kind: "legacy-8-group-operator-drilldown",
          requestCount: legacyIds.length + 4,
          ...percentiles(legacyDurations),
          bytes: legacyBytes,
        },
      ])}\n`);
    });
  }
});