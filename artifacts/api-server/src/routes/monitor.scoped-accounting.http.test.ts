import express from "express";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
  usageMemberDayTable,
  usageProjectDayTable,
  usageWorkspaceDayTable,
} from "@workspace/db";
import type { Authorization } from "../lib/authz";
import {
  __setDirectoryCacheForTests,
  type PlatformBudgets,
} from "../lib/enterprise";
import { invalidateUsageSnapshotMemo } from "../lib/usage-store";
import { setAuthorizationResolver } from "../middlewares/requireAuth";
import monitorRouter from "./monitor";

const PREFIX = "scopedhttp";
const W1 = `${PREFIX}-w1`;
const W2 = `${PREFIX}-w2`;
const W3 = `${PREFIX}-w3`;
const W4 = `${PREFIX}-w4`;
const W5 = `${PREFIX}-w5`;
const SHARED_1 = `${PREFIX}-shared-1`;
const SHARED_2 = `${PREFIX}-shared-2`;
const FAMILY_A = `${PREFIX}-family-a`;
const FAMILY_B = `${PREFIX}-family-b`;
const SHARED_TEAM = `${PREFIX}-canonical-team`;
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
const TODAY = new Date().toISOString().slice(0, 10);
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
    isTrueAccountAdmin: true, capabilities: capabilities(),
  },
  [DETAIL_OUTSIDER]: {
    userId: DETAIL_OUTSIDER, role: "member", roles: ["member"],
    workspaceIds: [], teamNames: [], groupIds: [], managedGroupIds: [],
    groupUserIds: {}, userIds: [DETAIL_OUTSIDER],
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

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let baseUrl = "";

async function get(path: string, userId: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "x-test-user": userId },
  });
}

beforeAll(async () => {
  const workspaceIds = [W1, W2, W3, W4, W5];
  await db.delete(teamLimitTargetsTable)
    .where(like(teamLimitTargetsTable.groupId, `${PREFIX}%`));
  await db.delete(teamBudgetsTable)
    .where(eq(teamBudgetsTable.teamName, SHARED_TEAM));
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

  const budgets: PlatformBudgets = {
    groupLimits: new Map(),
    userLimits: new Map([[W5, new Map([
      [DETAIL_MEMBER, 20],
      [DETAIL_FAMILY_ADMIN, 30],
    ])]]),
    workspaceDefaults: new Map([[W5, 40]]),
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
    workspaces: new Map(workspaceIds.map((id) => [
      id,
      { id, name: id, slug: id, memberCount: 2 },
    ])),
    groups: [
      { id: SHARED_1, workspaceId: W1, name: "Shared Pool A", type: "custom" },
      { id: SHARED_2, workspaceId: W2, name: "Shared Pool B", type: "custom" },
      { id: FAMILY_A, workspaceId: W3, name: "Authorized Family", type: "custom" },
      { id: FAMILY_B, workspaceId: W4, name: "Unauthorized Family", type: "custom" },
      { id: DETAIL_GROUP, workspaceId: W5, name: "Detail - Member", type: "custom" },
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
    ]),
    groupMembers: new Map([
      [SHARED_1, [SHARED_ADMIN]],
      [SHARED_2, [COWORKER]],
      [FAMILY_A, [FAMILY_ADMIN, COWORKER]],
      [FAMILY_B, [FAMILY_ADMIN, COWORKER]],
      [DETAIL_GROUP, [DETAIL_MEMBER, DETAIL_COWORKER, DETAIL_FAMILY_ADMIN]],
    ]),
    budgets,
  });
  await db.insert(teamBudgetsTable).values({
    teamName: SHARED_TEAM,
    originalAmountUsd: 1_000,
    amountUsd: 1_000,
  });
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
  ]);
  await db.insert(usageMemberDayTable).values([
    { workspaceId: W1, usageDate: TODAY, userId: SHARED_ADMIN, totalCostUsd: 5, aiCostUsd: 5, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W2, usageDate: TODAY, userId: COWORKER, totalCostUsd: 500, aiCostUsd: 500, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W3, usageDate: TODAY, userId: FAMILY_ADMIN, totalCostUsd: 0, aiCostUsd: 0, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W3, usageDate: TODAY, userId: COWORKER, totalCostUsd: 10, aiCostUsd: 10, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W4, usageDate: TODAY, userId: FAMILY_ADMIN, totalCostUsd: 1, aiCostUsd: 1, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W4, usageDate: TODAY, userId: COWORKER, totalCostUsd: 99, aiCostUsd: 99, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, userId: DETAIL_MEMBER, totalCostUsd: 5, aiCostUsd: 5, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, userId: DETAIL_COWORKER, totalCostUsd: 7, aiCostUsd: 7, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, userId: DETAIL_FAMILY_ADMIN, totalCostUsd: 3, aiCostUsd: 3, metricsJson: [], fetchedAt: new Date() },
  ]);
  await db.insert(usageWorkspaceDayTable).values([
    { workspaceId: W1, usageDate: TODAY, totalCostUsd: 5, memberAttributableUsd: 5, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W2, usageDate: TODAY, totalCostUsd: 500, memberAttributableUsd: 500, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W3, usageDate: TODAY, totalCostUsd: 10, memberAttributableUsd: 10, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W4, usageDate: TODAY, totalCostUsd: 100, memberAttributableUsd: 100, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
    { workspaceId: W5, usageDate: TODAY, totalCostUsd: 30, memberAttributableUsd: 30, memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete" },
  ]);
  await db.insert(usageProjectDayTable).values([
    { workspaceId: W5, usageDate: TODAY, projectId: `${PREFIX}-self-project`, totalCostUsd: 5, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, projectId: `${PREFIX}-coworker-project`, totalCostUsd: 7, metricsJson: [], fetchedAt: new Date() },
    { workspaceId: W5, usageDate: TODAY, projectId: `${PREFIX}-family-project`, totalCostUsd: 3, metricsJson: [], fetchedAt: new Date() },
  ]);
  await db.insert(apiProjectMetadataTable).values([
    { workspaceId: W5, projectId: `${PREFIX}-self-project`, title: "Visible self project", creatorId: DETAIL_MEMBER, fetchedAt: new Date() },
    { workspaceId: W5, projectId: `${PREFIX}-coworker-project`, title: "Secret coworker project", creatorId: DETAIL_COWORKER, fetchedAt: new Date() },
    { workspaceId: W5, projectId: `${PREFIX}-family-project`, title: "Family admin project", creatorId: DETAIL_FAMILY_ADMIN, fetchedAt: new Date() },
  ]);
  await db.insert(apiProjectMetadataStateTable).values({
    workspaceId: W5, status: "success", completedAt: new Date(),
  });
  invalidateUsageSnapshotMemo();
  setAuthorizationResolver(async (id) => authorizations[id] ?? null);

  const app = express();
  app.use((req, _res, next) => {
    const id = req.header("x-test-user");
    const mutable = req as unknown as {
      isAuthenticated: () => boolean;
      user?: { id: string };
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
  const workspaceIds = [W1, W2, W3, W4, W5];
  await db.delete(teamLimitTargetsTable)
    .where(like(teamLimitTargetsTable.groupId, `${PREFIX}%`));
  await db.delete(teamBudgetsTable)
    .where(eq(teamBudgetsTable.teamName, SHARED_TEAM));
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
});

describe("authenticated scoped accounting HTTP endpoints", () => {
  test("People includes authorized directory members with no spend or group", async () => {
    const response = await get(
      `/spend/people?viewScope=managed&${RANGE}`,
      DETAIL_WORKSPACE_ADMIN,
    );
    expect(response.status).toBe(200);
    const value = await response.json() as {
      rows: Array<{ id: string; spendUsd: number; agentSpendUsd: number }>;
    };
    expect(value.rows).toContainEqual(expect.objectContaining({
      id: `person:${W5}:${DETAIL_WORKSPACE_ADMIN}`,
      spendUsd: 0,
      agentSpendUsd: 0,
    }));
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
    if (dashboard.metadata.status === "complete") {
      expect(dashboard.trend.buckets.reduce((sum, bucket) =>
        sum + (bucket.spendUsd ?? 0), 0)).toBe(5);
    } else {
      expect(dashboard.trend.buckets).toEqual(expect.arrayContaining([
        expect.objectContaining({ spendUsd: null }),
      ]));
    }
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
});