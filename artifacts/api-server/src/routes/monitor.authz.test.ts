// @ts-nocheck
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import {
  alertsTable,
  apiProjectMetadataStateTable,
  db,
  teamBudgetsTable,
  teamLimitTargetsTable,
  usageLimitAuditsTable,
  usageMemberDayTable,
  usageWorkspaceDayTable,
} from "@workspace/db";

import { __setDirectoryCacheForTests } from "../lib/enterprise";
import { invalidateUsageSnapshotMemo } from "../lib/usage-store";
import { setReplitBudgetTransportForTests } from "../lib/replit-budgets";
import { setAuthorizationResolver } from "../middlewares/requireAuth";
import type { Authorization, AuthzRole } from "../lib/authz";
import monitorRouter, { canSeeAlertEntity } from "./monitor";

const PREFIX = "__rbac217__";
const GROWTH = `${PREFIX}-growth`;
const PLATFORM = `${PREFIX}-platform`;
const GM = `${PREFIX}-growth-members`;
const GA = `${PREFIX}-growth-admins`;
const GL = `${PREFIX}-legacy-growth-members`;
const PM = `${PREFIX}-platform-members`;
const TEAM = `${PREFIX} Growth MDU`;
const TODAY = new Date().toISOString().slice(0, 10);

function member(id, workspaces = {}, isAccountAdmin = false) {
  return {
    userId: id,
    username: id,
    email: `${id}@example.test`,
    name: id,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

function authorization(
  userId: string,
  role: AuthzRole,
  groupIds: string[],
  userIds: string[],
  workspaceIds: string[] = [],
  teamNames: string[] = [],
  roles: AuthzRole[] = [role],
): Authorization {
  const account = roles.includes("account");
  return {
    userId, role, roles, groupIds, userIds, workspaceIds, teamNames,
    isTrueAccountAdmin: account,
    capabilities: {
      canManageAccess: account,
      canEditAllocations: account,
      canWriteGroupLimits: account,
      canWriteUserLimitsIn: account ? [GROWTH, PLATFORM] : workspaceIds,
    },
  };
}

const allGroups = [GM, GA, GL, PM];
const allUsers = ["account", "workspace", "team", "both", "member", "other", "platform"];
const spendByUser = new Map([
  ["workspace", 1], ["team", 2], ["both", 3], ["member", 4],
  ["other", 5], ["platform", 6], ["account", 0],
]);
const fixtures = [
  {
    id: "account",
    authz: authorization("account", "account", allGroups, allUsers),
    groups: allGroups,
    users: allUsers,
    teams: [TEAM],
    canWrite: true,
  },
  {
    id: "workspace",
    authz: authorization(
      "workspace", "workspace_admin", [GM, GA],
      ["workspace", "team", "both", "member", "other"], [GROWTH],
    ),
    groups: [GM, GA],
    users: ["workspace", "team", "both", "member", "other"],
    teams: [TEAM],
    canWrite: true,
  },
  {
    id: "team",
    authz: authorization(
      "team", "team_admin", [GM, GL],
      ["workspace", "team", "both", "member", "other"], [], [TEAM],
    ),
    groups: [GM, GL],
    users: ["workspace", "team", "both", "member", "other"],
    teams: [TEAM],
    canWrite: false,
  },
  {
    id: "both",
    authz: authorization(
      "both", "workspace_admin", [GM, GA, GL],
      ["workspace", "team", "both", "member", "other"], [GROWTH], [TEAM],
      ["workspace_admin", "team_admin"],
    ),
    groups: [GM, GA, GL],
    users: ["workspace", "team", "both", "member", "other"],
    teams: [TEAM],
    canWrite: true,
  },
  {
    id: "member",
    authz: authorization("member", "member", [GM], ["member"]),
    groups: [GM],
    users: ["member"],
    teams: [TEAM],
    canWrite: false,
  },
];

let server;
let baseUrl: string;

async function request(path: string, fixture, init: RequestInit = {}) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "x-test-user": fixture.id,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

beforeAll(async () => {
  process.env.REPLIT_ENTERPRISE_API_KEY = "test";
  const active = { role: "member", isDisabled: false };
  __setDirectoryCacheForTests({
    workspaces: new Map([
      [GROWTH, { id: GROWTH, name: "Growth", slug: "growth", memberCount: 6 }],
      [PLATFORM, { id: PLATFORM, name: "Platform", slug: "platform", memberCount: 2 }],
    ]),
    groups: [
      { id: GM, workspaceId: GROWTH, name: `${TEAM} - Member`, type: "custom" },
      { id: GA, workspaceId: GROWTH, name: `${TEAM} - Admins`, type: "custom" },
      { id: GL, workspaceId: PLATFORM, name: `${TEAM} Legacy - Member`, type: "custom" },
      { id: PM, workspaceId: PLATFORM, name: `${PREFIX} Platform - Member`, type: "custom" },
    ],
    members: new Map([
      ["account", member("account", {}, true)],
      ["workspace", member("workspace", { [GROWTH]: { role: "admin", isDisabled: false } })],
      ["team", member("team", { [GROWTH]: active })],
      ["both", member("both", { [GROWTH]: { role: "admin", isDisabled: false } })],
      ["member", member("member", { [GROWTH]: active })],
      ["other", member("other", { [GROWTH]: active })],
      ["platform", member("platform", { [PLATFORM]: active })],
    ]),
    groupMembers: new Map([
      [GM, ["workspace", "team", "both", "member", "other"]],
      [GA, ["workspace", "both"]],
      [GL, ["team", "both", "other"]],
      [PM, ["platform"]],
    ]),
  });
  setAuthorizationResolver(async (id) => fixtures.find((item) => item.id === id)?.authz ?? null);
  setReplitBudgetTransportForTests(async () => Response.json({ ok: true }), true);

  await db.delete(alertsTable).where(like(alertsTable.groupId, `${PREFIX}%`));
  await db.delete(teamLimitTargetsTable).where(like(teamLimitTargetsTable.groupId, `${PREFIX}%`));
  await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, TEAM));
  await db.delete(usageMemberDayTable).where(inArray(usageMemberDayTable.workspaceId, [GROWTH, PLATFORM]));
  await db.delete(usageWorkspaceDayTable).where(inArray(usageWorkspaceDayTable.workspaceId, [GROWTH, PLATFORM]));
  await db.delete(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, [GROWTH, PLATFORM]));
  await db.insert(teamBudgetsTable).values({
    teamName: TEAM, originalAmountUsd: 1200, amountUsd: 1200,
  });
  await db.insert(teamLimitTargetsTable).values([
    { teamName: TEAM, workspaceId: GROWTH, groupId: GM, groupName: `${TEAM} - Member` },
    { teamName: TEAM, workspaceId: PLATFORM, groupId: GL, groupName: `${TEAM} Legacy - Member` },
  ]);
  await db.insert(alertsTable).values([
    {
      groupId: GM, groupName: GM, entityType: "group", entityId: GM, entityName: GM,
      workspaceIds: [GROWTH], threshold: 50, spendUsd: 5, budgetUsd: 10,
      recipients: [], status: "sent",
    },
    {
      groupId: TEAM, groupName: TEAM, entityType: "team", entityId: TEAM, entityName: TEAM,
      workspaceIds: [GROWTH, PLATFORM], threshold: 50, spendUsd: 10, budgetUsd: 20,
      recipients: [], status: "sent",
    },
  ]);
  await db.insert(usageMemberDayTable).values(
    allUsers.filter((id) => id !== "account").map((id, index) => ({
      workspaceId: id === "platform" ? PLATFORM : GROWTH,
      usageDate: TODAY, userId: id, totalCostUsd: index + 1, aiCostUsd: index + 1,
      metricsJson: [], fetchedAt: new Date(),
    })),
  );
  await db.insert(usageWorkspaceDayTable).values([GROWTH, PLATFORM].map((workspaceId) => ({
    workspaceId, usageDate: TODAY, totalCostUsd: 20, memberAttributableUsd: 20,
    memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete",
  })));
  invalidateUsageSnapshotMemo();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.header("x-test-user");
    req.isAuthenticated = () => !!id;
    if (id) req.user = { id };
    next();
  });
  app.use("/api", monitorRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  setAuthorizationResolver(null);
  setReplitBudgetTransportForTests(null);
  __setDirectoryCacheForTests(null);
  await db.delete(usageLimitAuditsTable).where(like(usageLimitAuditsTable.workspaceId, `${PREFIX}%`));
  await db.delete(alertsTable).where(like(alertsTable.groupId, `${PREFIX}%`));
  await db.delete(teamLimitTargetsTable).where(like(teamLimitTargetsTable.groupId, `${PREFIX}%`));
  await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, TEAM));
  await db.delete(usageMemberDayTable).where(inArray(usageMemberDayTable.workspaceId, [GROWTH, PLATFORM]));
  await db.delete(usageWorkspaceDayTable).where(inArray(usageWorkspaceDayTable.workspaceId, [GROWTH, PLATFORM]));
});

const listedReads = (fixture) => {
  const group = fixture.groups[0];
  return [
    "/groups",
    `/groups/${group}`,
    `/groups/${group}/projects`,
    `/clusters/${group}/headline`,
    `/clusters/${group}/projects`,
    "/summary",
    "/teams/budgets",
    "/trends?granularity=week",
    "/alerts",
    "/users/activity",
    `/export/users.csv?groupIds=${group}`,
    "/projects/export",
  ];
};

describe.each(fixtures)("$id mounted monitor scope", (fixture) => {
  it.each(listedReads(fixture))("%s responds inside the effective scope", async (path) => {
    const response = await request(path, fixture);
    expect(response.status).toBe(200);
  });

  it("returns exact group, team, user, and alert entities", async () => {
    const groups = await (await request("/groups", fixture)).json();
    expect(groups.groups
      .filter((group) => !group.isSynthetic)
      .map((group) => group.groupId).sort()).toEqual([...fixture.groups].sort());
    const teams = await (await request("/teams/budgets", fixture)).json();
    expect(teams.budgets
      .map((team) => team.teamName)
      .filter((name) => name.startsWith(PREFIX))).toEqual(fixture.teams);
    const activity = await (await request("/users/activity", fixture)).json();
    expect(activity.users.map((user) => user.userId).sort()).toEqual([...fixture.users].sort());
    const expectedSpend = fixture.users.reduce((sum, id) => sum + spendByUser.get(id), 0);
    const summary = await (await request("/summary", fixture)).json();
    expect(summary.totalSpendUsd).toBe(fixture.id === "account" ? 40 : expectedSpend);
    const trends = await (await request("/trends?granularity=week", fixture)).json();
    expect(trends.totals.reduce((sum, amount) => sum + amount, 0)).toBe(expectedSpend);
    const alerts = await (await request("/alerts", fixture)).json();
    const entities = alerts
      .filter((alert) => alert.entityId.startsWith(PREFIX))
      .map((alert) => `${alert.entityType}:${alert.entityId}`).sort();
    const expected = [`group:${GM}`];
    if (fixture.id === "account" || fixture.id === "team" || fixture.id === "both" || fixture.id === "member") {
      expected.push(`team:${TEAM}`);
    }
    expect(entities).toEqual(expected.sort());
  });

  it("returns only scoped members when reading a visible workspace", async () => {
    const workspaceId = fixture.groups.includes(PM) ? PLATFORM : GROWTH;
    const response = await request(
      `/directory/workspaces/${workspaceId}/members`,
      fixture,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const expectedUsers = fixture.users.filter((userId) =>
      dirMemberIdsForWorkspace(workspaceId).includes(userId),
    );
    expect(body.members.map((member) => member.userId).sort())
      .toEqual(expectedUsers.sort());
  });

  it("allows per-user writes only in canWriteUserLimitsIn", async () => {
    const response = await request(
      `/directory/workspaces/${GROWTH}/members/member/budget`,
      fixture,
      { method: "PUT", body: JSON.stringify({ amountUsd: 12 }) },
    );
    expect(response.status).toBe(fixture.canWrite ? 200 : 403);
  });

  it("ignores preview headers from non-account callers", async () => {
    if (fixture.id === "account") return;
    const response = await request("/groups", fixture, {
      headers: { "X-Preview-As": `workspace_admin:${PLATFORM}` },
    });
    const body = await response.json();
    expect(body.groups
      .filter((group) => !group.isSynthetic)
      .map((group) => group.groupId).sort()).toEqual([...fixture.groups].sort());
  });
});

it("uses one cross-workspace team alert predicate for role unions", () => {
  const alert = { entityType: "team", entityId: TEAM, groupId: TEAM, workspaceIds: [GROWTH, PLATFORM] };
  expect(canSeeAlertEntity(fixtures[1].authz, alert, new Set(), new Set([TEAM]))).toBe(false);
  expect(canSeeAlertEntity(fixtures[2].authz, alert, new Set(), new Set())).toBe(true);
  expect(canSeeAlertEntity(fixtures[4].authz, alert, new Set(), new Set([TEAM]))).toBe(true);
});

function dirMemberIdsForWorkspace(workspaceId: string): string[] {
  return workspaceId === PLATFORM
    ? ["platform"]
    : ["workspace", "team", "both", "member", "other"];
}