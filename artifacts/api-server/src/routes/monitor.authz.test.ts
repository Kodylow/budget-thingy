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
  notificationSettingsTable,
} from "@workspace/db";

import { __setDirectoryCacheForTests } from "../lib/enterprise";
import { invalidateUsageSnapshotMemo } from "../lib/usage-store";
import { setReplitBudgetTransportForTests } from "../lib/replit-budgets";
import { setSendEmailOverrideForTests } from "../lib/email";
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

function installDefaultDirectory() {
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
const fixtureResolver = async (id: string) =>
  fixtures.find((item) => item.id === id)?.authz ?? null;

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
  installDefaultDirectory();
  setAuthorizationResolver(fixtureResolver);
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
  setSendEmailOverrideForTests(null);
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
    if (fixture.id === "account" || fixture.id === "both") {
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

function percentile(samples: number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}

describe("usage endpoint performance", () => {
  it("keeps warm and cold p95 within the dashboard targets", async () => {
    const fixture = fixtures[0]!;
    const paths = [
      "/groups?rangeType=full-term",
      "/summary?rangeType=full-term",
      `/groups/${GM}?rangeType=full-term`,
    ];
    const report = [];
    for (const path of paths) {
      const cold = [];
      for (let index = 0; index < 20; index++) {
        invalidateUsageSnapshotMemo();
        const started = performance.now();
        const response = await request(path, fixture);
        expect(response.status).toBe(200);
        cold.push(performance.now() - started);
      }
      const primed = await request(path, fixture);
      expect(primed.status).toBe(200);
      const warm = [];
      for (let index = 0; index < 20; index++) {
        const started = performance.now();
        const response = await request(path, fixture);
        expect(response.status).toBe(200);
        warm.push(performance.now() - started);
      }
      const result = {
        path,
        coldP50Ms: percentile(cold, 0.5),
        coldP95Ms: percentile(cold, 0.95),
        warmP50Ms: percentile(warm, 0.5),
        warmP95Ms: percentile(warm, 0.95),
      };
      report.push(result);
      expect(result.coldP95Ms).toBeLessThan(1_000);
      expect(result.warmP95Ms).toBeLessThan(300);
    }
    process.stdout.write(`USAGE_ENDPOINT_PERFORMANCE ${JSON.stringify(report)}\n`);
  });
});

describe("GET /workspace-admins", () => {
  it("returns complete current family data, nullable admin fields, and families without an admin group", async () => {
    const alpha = `${PREFIX}-admins-alpha`;
    const beta = `${PREFIX}-admins-beta`;
    const alphaAdminGroup = `${PREFIX}-alpha-admin`;
    const alphaMemberGroup = `${PREFIX}-alpha-member`;
    const betaMemberGroup = `${PREFIX}-beta-member`;
    const nullableAdmin = {
      ...member("nullable-admin"),
      email: null,
      name: null,
    };
    const namedAdmin = {
      ...member("named-admin"),
      name: "Named Admin",
    };
    __setDirectoryCacheForTests({
      workspaces: new Map([
        [alpha, { id: alpha, name: "Alpha Workspace", slug: "alpha", memberCount: 2 }],
        [beta, { id: beta, name: "Beta Workspace", slug: "beta", memberCount: 0 }],
      ]),
      groups: [
        { id: alphaMemberGroup, workspaceId: alpha, name: "Zeta - Member", type: "custom" },
        { id: alphaAdminGroup, workspaceId: alpha, name: "Zeta - Admins", type: "custom" },
        { id: betaMemberGroup, workspaceId: beta, name: "Lone - Member", type: "custom" },
      ],
      groupMembers: new Map([
        [alphaAdminGroup, [nullableAdmin.userId, namedAdmin.userId]],
      ]),
      members: new Map([
        [nullableAdmin.userId, nullableAdmin],
        [namedAdmin.userId, namedAdmin],
      ]),
    });

    try {
      const response = await request("/workspace-admins", fixtures[0]);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          groupId: `${beta}:lone`,
          groupName: "Lone",
          workspaceId: beta,
          workspaceName: "Beta Workspace",
          familyKey: "lone",
          familyName: "Lone",
          isLegacy: false,
          teamName: "Lone",
          admins: [],
        },
        {
          groupId: alphaAdminGroup,
          groupName: "Zeta",
          workspaceId: alpha,
          workspaceName: "Alpha Workspace",
          familyKey: "zeta",
          familyName: "Zeta",
          isLegacy: false,
          teamName: "Zeta",
          admins: [
            {
              userId: "nullable-admin",
              username: "nullable-admin",
              email: null,
              name: null,
            },
            {
              userId: "named-admin",
              username: "named-admin",
              email: "named-admin@example.test",
              name: "Named Admin",
            },
          ],
        },
      ]);
    } finally {
      installDefaultDirectory();
    }
  });

  it.each([
    ["an empty directory", new Map()],
    ["workspaces with no families", new Map([
      [`${PREFIX}-empty-workspace`, {
        id: `${PREFIX}-empty-workspace`,
        name: "Empty Workspace",
        slug: "empty",
        memberCount: 0,
      }],
    ])],
  ])("returns an empty list for %s", async (_label, workspaces) => {
    __setDirectoryCacheForTests({ workspaces, groups: [], members: new Map() });
    try {
      const response = await request("/workspace-admins", fixtures[0]);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    } finally {
      installDefaultDirectory();
    }
  });

  it("keeps the endpoint account-only", async () => {
    expect((await request("/workspace-admins", fixtures[0])).status).toBe(200);
    for (const fixture of [fixtures[1], fixtures[2], fixtures[4]]) {
      expect((await request("/workspace-admins", fixture)).status).toBe(403);
    }
  });

  it("rejects unauthenticated requests", async () => {
    const response = await fetch(`${baseUrl}/api/workspace-admins`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  it("turns malformed directory data into an error response", async () => {
    __setDirectoryCacheForTests({
      groups: [{
        id: `${PREFIX}-malformed-admin`,
        workspaceId: null,
        name: "Malformed - Admin",
        type: "custom",
      }],
      members: new Map(),
    });
    try {
      const response = await request("/workspace-admins", fixtures[0]);
      expect(response.status).toBe(500);
    } finally {
      installDefaultDirectory();
    }
  });
});

describe("persisted automated email settings authorization", () => {
  it("allows account operators to read and update the global setting", async () => {
    const account = fixtures[0]!;
    const update = await request("/settings/email", account, {
      method: "PATCH",
      body: JSON.stringify({ automatedEmailEnabled: true }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ automatedEmailEnabled: true });

    const read = await request("/settings/email", account);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ automatedEmailEnabled: true });

    const [stored] = await db.select().from(notificationSettingsTable);
    expect(stored?.automatedEmailEnabled).toBe(true);

    await request("/settings/email", account, {
      method: "PATCH",
      body: JSON.stringify({ automatedEmailEnabled: false }),
    });
  });

  it.each(fixtures.slice(1))("denies $id from reading or changing the setting", async (fixture) => {
    expect((await request("/settings/email", fixture)).status).toBe(403);
    expect((await request("/settings/email", fixture, {
      method: "PATCH",
      body: JSON.stringify({ automatedEmailEnabled: true }),
    })).status).toBe(403);
  });

  it("rejects malformed updates without changing the saved value", async () => {
    const account = fixtures[0]!;
    const response = await request("/settings/email", account, {
      method: "PATCH",
      body: JSON.stringify({ automatedEmailEnabled: "yes" }),
    });
    expect(response.status).toBe(400);
    const read = await request("/settings/email", account);
    expect(await read.json()).toMatchObject({ automatedEmailEnabled: false });
  });

  it("keeps fixed-recipient Test Email available while automation is off", async () => {
    const account = fixtures[0]!;
    process.env.BOOTSTRAP_ADMIN_EMAIL = "kody@example.test";
    setSendEmailOverrideForTests(async (to) => ({
      ok: true,
      deliveredTo: to,
      messageId: "test-message",
      senderEmail: "budget-monitor@example.test",
    }));
    await request("/settings/email", account, {
      method: "PATCH",
      body: JSON.stringify({ automatedEmailEnabled: false }),
    });

    const response = await request("/alerts/test-email", account, {
      method: "POST",
      body: JSON.stringify({ entityType: "group", threshold: 50 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      recipient: "kody@example.test",
      messageId: "test-message",
    });
    setSendEmailOverrideForTests(null);
  });
});

it("uses one cross-workspace team alert predicate for role unions", () => {
  const alert = { entityType: "team", entityId: TEAM, groupId: TEAM, workspaceIds: [GROWTH, PLATFORM] };
  const canonicalScope = new Map([
    [TEAM, new Map([
      [GROWTH, new Set([GM, GA])],
      [PLATFORM, new Set([GL])],
    ])],
  ]);
  expect(canSeeAlertEntity(fixtures[1].authz, alert, new Set(), canonicalScope)).toBe(false);
  expect(canSeeAlertEntity(fixtures[2].authz, alert, new Set(), canonicalScope)).toBe(false);
  expect(canSeeAlertEntity(fixtures[3].authz, alert, new Set(), canonicalScope)).toBe(true);
  expect(canSeeAlertEntity(fixtures[4].authz, alert, new Set(), canonicalScope)).toBe(false);
});

it("requires team alerts to stay inside workspace-qualified canonical family scope", () => {
  const workspaceA = `${PREFIX}-finance-a`;
  const workspaceB = `${PREFIX}-finance-b`;
  const legacy = "1awqan";
  const groupsA = [`${PREFIX}-a-admin`, `${PREFIX}-a-member`];
  const groupsB = [`${PREFIX}-b-admin`, `${PREFIX}-b-member`];
  const legacyGroups = [`${PREFIX}-legacy-admin`, `${PREFIX}-legacy-member`];
  const teamAdmin = authorization(
    "finance-admin",
    "team_admin",
    [...groupsA, ...legacyGroups],
    ["finance-admin"],
    [],
    ["Finance"],
  );
  const canonicalScope = new Map([
    ["Finance", new Map([
      [workspaceA, new Set(groupsA)],
      [workspaceB, new Set(groupsB)],
      [legacy, new Set(legacyGroups)],
    ])],
  ]);
  const alert = (workspaceIds: string[]) => ({
    entityType: "team",
    entityId: "Finance",
    groupId: "Finance",
    workspaceIds,
  });

  expect(canSeeAlertEntity(teamAdmin, alert([workspaceA]), new Set(), canonicalScope)).toBe(true);
  expect(canSeeAlertEntity(teamAdmin, alert([workspaceB]), new Set(), canonicalScope)).toBe(false);
  expect(canSeeAlertEntity(teamAdmin, alert([workspaceA, workspaceB]), new Set(), canonicalScope)).toBe(false);
  expect(canSeeAlertEntity(teamAdmin, alert([legacy]), new Set(), canonicalScope)).toBe(true);
});

it("hides independent and spanning same-team alerts on the mounted history route", async () => {
  const teamAdmin = authorization(
    "route-team-a",
    "team_admin",
    [GM, GA],
    ["route-team-a"],
    [],
    [TEAM],
  );
  await db.insert(teamLimitTargetsTable).values({
    teamName: TEAM,
    workspaceId: PLATFORM,
    groupId: PM,
    groupName: `${PREFIX} Platform - Member`,
  });
  await db.insert(alertsTable).values([
    {
      groupId: TEAM, groupName: TEAM, entityType: "team", entityId: TEAM, entityName: TEAM,
      workspaceIds: [GROWTH], threshold: 75, spendUsd: 7, budgetUsd: 10,
      recipients: [], status: "sent",
    },
    {
      groupId: TEAM, groupName: TEAM, entityType: "team", entityId: TEAM, entityName: TEAM,
      workspaceIds: [PLATFORM], threshold: 75, spendUsd: 7, budgetUsd: 10,
      recipients: [], status: "sent",
    },
    {
      groupId: TEAM, groupName: TEAM, entityType: "team", entityId: TEAM, entityName: TEAM,
      workspaceIds: [GROWTH, PLATFORM], threshold: 90, spendUsd: 9, budgetUsd: 10,
      recipients: [], status: "sent",
    },
  ]);
  setAuthorizationResolver(async (id) => id === "route-team-a" ? teamAdmin : fixtureResolver(id));
  try {
    const response = await request("/alerts", { id: "route-team-a" });
    expect(response.status).toBe(200);
    const teamAlerts = (await response.json())
      .filter((alert) => alert.entityType === "team" && alert.entityId === TEAM);
    expect(teamAlerts.map((alert) => alert.workspaceIds)).toEqual([[GROWTH]]);
  } finally {
    setAuthorizationResolver(fixtureResolver);
    await db.delete(teamLimitTargetsTable).where(eq(teamLimitTargetsTable.groupId, PM));
  }
});

function dirMemberIdsForWorkspace(workspaceId: string): string[] {
  return workspaceId === PLATFORM
    ? ["platform"]
    : ["workspace", "team", "both", "member", "other"];
}