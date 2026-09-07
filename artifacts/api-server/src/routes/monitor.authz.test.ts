// @ts-nocheck
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import {
  alertsTable,
  appAdminsTable,
  apiProjectMetadataStateTable,
  db,
  pool,
  teamBudgetsTable,
  teamLimitTargetsTable,
  usageLimitAuditsTable,
  usageAccountDayTable,
  usageMemberDayTable,
  usageWorkspaceDayTable,
  groupRosterSnapshotsTable,
  groupRosterSnapshotDaysTable,
  notificationSettingsTable,
} from "@workspace/db";

import { __setDirectoryCacheForTests } from "../lib/enterprise";
import * as enterprise from "../lib/enterprise";
import {
  beginUsageGenerationUpdate,
  invalidateUsageSnapshotMemo,
} from "../lib/usage-store";
import { setReplitBudgetTransportForTests } from "../lib/replit-budgets";
import { setSendEmailOverrideForTests } from "../lib/email";
import { setAuthorizationResolver } from "../middlewares/requireAuth";
import {
  getBootstrapAccountAdminEmail,
  isPersistedAppAdmin,
  maybeBootstrapAppAdmin,
  type Authorization,
  type AuthzRole,
} from "../lib/authz";
import monitorRouter, { canSeeAlertEntity } from "./monitor";
import { __getScopedAccountingCacheSizeForTests } from "../services/scoped-accounting";

const PREFIX = "rbac217";
const GROWTH = `${PREFIX}growth`;
const PLATFORM = `${PREFIX}platform`;
const GM = `${PREFIX}growthmembers`;
const GA = `${PREFIX}growthadmins`;
const GL = `${PREFIX}legacygrowthmembers`;
const PM = `${PREFIX}platformmembers`;
const TEAM = `${PREFIX} Growth MDU`;
const WRITE_USER = "217123";
const INTERNAL_USER = "internal-user";
const TODAY = "2026-06-17";
const upstreamMemberBudgets = new Map<string, number>();

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
      [WRITE_USER, member(WRITE_USER, { [GROWTH]: active })],
      [INTERNAL_USER, {
        ...member(INTERNAL_USER, { [GROWTH]: active }),
        email: "  Employee@REPL.IT ",
      }],
    ]),
    groupMembers: new Map([
      [GM, ["workspace", "team", "both", "member", "other", WRITE_USER]],
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
  const fixtureMembership = new Map<string, string[]>([
    [GM, ["workspace", "team", "both", "member", "other", WRITE_USER]],
    [GA, ["workspace", "both"]],
    [GL, ["team", "both", "other"]],
    [PM, ["platform"]],
  ]);
  return {
    userId, role, roles, groupIds, userIds, workspaceIds, teamNames,
    managedGroupIds: role === "member" ? [] : groupIds,
    groupUserIds: Object.fromEntries(groupIds.map((groupId) => [
      groupId,
      (fixtureMembership.get(groupId) ?? []).filter((id) => userIds.includes(id)),
    ])),
    isTrueAccountAdmin: account,
    capabilities: {
      canViewAccountUsage: account,
      canManageAccess: account,
      canEditAllocations: account,
      canManageNotifications: account,
      canManageSystem: account,
      canPreviewRoles: false,
      canWriteGroupLimits: account,
      canRunChecks: account,
      canSendTestEmail: account,
      canWriteUserLimitsIn: account ? [GROWTH, PLATFORM] : workspaceIds,
    },
  };
}

const allGroups = [GM, GA, GL, PM];
const allUsers = [
  "account",
  "workspace",
  "team",
  "both",
  "member",
  "other",
  "platform",
  WRITE_USER,
];
const spendByUser = new Map([
  ["workspace", 1], ["team", 2], ["both", 3], ["member", 4],
  ["other", 5], ["platform", 6], ["account", 0],
  [WRITE_USER, 0],
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
      ["workspace", "team", "both", "member", "other", WRITE_USER], [GROWTH],
    ),
    groups: [GM, GA],
    users: ["workspace", "team", "both", "member", "other", WRITE_USER],
    teams: [TEAM],
    canWrite: true,
  },
  {
    id: "team",
    authz: authorization(
      "team", "team_admin", [GM, GL],
      ["workspace", "team", "both", "member", "other", WRITE_USER], [], [TEAM],
    ),
    groups: [GM, GL],
    users: ["workspace", "team", "both", "member", "other", WRITE_USER],
    teams: [TEAM],
    canWrite: false,
  },
  {
    id: "both",
    authz: authorization(
      "both", "workspace_admin", [GM, GA, GL],
      ["workspace", "team", "both", "member", "other", WRITE_USER], [GROWTH], [TEAM],
      ["workspace_admin", "team_admin"],
    ),
    groups: [GM, GA, GL],
    users: ["workspace", "team", "both", "member", "other", WRITE_USER],
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

it("traverses all authorized alert pages without including intervening unauthorized rows", async () => {
  const inserted = await db.insert(alertsTable).values(Array.from({ length: 205 }, (_, index) => ({
    groupId: index % 2 ? PM : GM,
    groupName: GM,
    entityType: "group",
    entityId: index % 2 ? PM : GM,
    entityName: GM,
    workspaceIds: [index % 2 ? PLATFORM : GROWTH],
    threshold: 50, spendUsd: 5, budgetUsd: 10, recipients: [], status: "sent",
  }))).returning({ id: alertsTable.id, groupId: alertsTable.groupId });
  try {
    const seen: number[] = [];
    let beforeId: number | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await request(`/alerts?limit=17${beforeId ? `&beforeId=${beforeId}` : ""}`, fixtures[1]);
      expect(response.status).toBe(200);
      const rows = await response.json();
      expect(rows.every((row) => row.entityType !== "group" || row.entityId === GM)).toBe(true);
      seen.push(...rows.map((row) => row.id));
      if (rows.length < 17) break;
      beforeId = rows.at(-1).id;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const expected = inserted.filter((row) => row.groupId === GM).map((row) => row.id);
    expect(expected.every((id) => seen.includes(id))).toBe(true);
  } finally {
    await db.delete(alertsTable).where(inArray(alertsTable.id, inserted.map((row) => row.id)));
  }
});

it("returns retryable unavailable rather than empty history when scope preparation fails", async () => {
  const failing = vi.spyOn(enterprise, "getCachedDirectory").mockRejectedValue(new Error("fixture outage"));
  try {
    const response = await request("/alerts", fixtures[4]);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("unavailable") });
  } finally {
    failing.mockRestore();
  }
});

it("rejects malformed alert cursors instead of silently returning the first page", async () => {
  expect((await request("/alerts?beforeId=not-an-id", fixtures[4])).status).toBe(400);
  expect((await request("/alerts?limit=201", fixtures[4])).status).toBe(400);
});

let server;
let baseUrl: string;
const budgetTransportMock = vi.fn(async (_path, init) => {
  if (init.method === "GET") {
    return Response.json({
      data: [...upstreamMemberBudgets].map(([userId, amountUsd]) => ({
        type: "workspace_user_limit",
        workspaceId: GROWTH,
        userId,
        currency: "USD",
        period: "billing_cycle",
        amountUsd,
      })),
      pagination: { hasMore: false },
    });
  }
  const body = JSON.parse(init.body ?? "{}");
  if (body.amountUsd == null) {
    upstreamMemberBudgets.delete(body.userId);
  } else {
    upstreamMemberBudgets.set(body.userId, body.amountUsd);
  }
  return Response.json({ data: body.amountUsd == null ? null : body });
});

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
  setReplitBudgetTransportForTests(budgetTransportMock, true);

  await db.delete(alertsTable).where(like(alertsTable.groupId, `${PREFIX}%`));
  await db.delete(teamLimitTargetsTable).where(like(teamLimitTargetsTable.groupId, `${PREFIX}%`));
  await db.delete(teamBudgetsTable).where(eq(teamBudgetsTable.teamName, TEAM));
  await db.delete(usageMemberDayTable).where(inArray(usageMemberDayTable.workspaceId, [GROWTH, PLATFORM]));
  await db.delete(usageWorkspaceDayTable).where(inArray(usageWorkspaceDayTable.workspaceId, [GROWTH, PLATFORM]));
  await db.delete(usageAccountDayTable).where(eq(usageAccountDayTable.usageDate, TODAY));
  await db.delete(groupRosterSnapshotsTable).where(inArray(
    groupRosterSnapshotsTable.groupId,
    allGroups,
  ));
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
      usageDate: TODAY,
      userId: id,
      totalCostUsd: id === WRITE_USER ? 0 : index + 1,
      aiCostUsd: id === WRITE_USER ? 0 : index + 1,
      metricsJson: [], fetchedAt: new Date(),
    })),
  );
  await db.insert(usageWorkspaceDayTable).values([GROWTH, PLATFORM].map((workspaceId) => ({
    workspaceId, usageDate: TODAY, totalCostUsd: 20, memberAttributableUsd: 20,
    memberUnattributableUsd: 0, metricsJson: [], fetchedAt: new Date(), status: "complete",
  })));
  await db.insert(usageAccountDayTable).values({
    usageDate: TODAY,
    totalCostUsd: 45,
    fetchedAt: new Date(),
  });
  await db.insert(groupRosterSnapshotsTable).values([
    { groupId: GM, workspaceId: GROWTH, snapshotDate: TODAY, userIds: ["workspace", "team", "both", "member", "other", WRITE_USER] },
    { groupId: GA, workspaceId: GROWTH, snapshotDate: TODAY, userIds: ["workspace", "both"] },
    { groupId: GL, workspaceId: PLATFORM, snapshotDate: TODAY, userIds: ["team", "both", "other"] },
    { groupId: PM, workspaceId: PLATFORM, snapshotDate: TODAY, userIds: ["platform"] },
  ]);
  await db.insert(groupRosterSnapshotDaysTable)
    .values({ snapshotDate: TODAY })
    .onConflictDoNothing();
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
  await db.delete(usageAccountDayTable).where(eq(usageAccountDayTable.usageDate, TODAY));
  await db.delete(groupRosterSnapshotsTable).where(inArray(
    groupRosterSnapshotsTable.groupId,
    allGroups,
  ));
});

const listedReads = (fixture) => {
  const group = fixture.groups[0];
  return [
    "/groups",
    `/reporting/details/${group}`,
    `/groups/${group}`,
    `/groups/${group}/projects`,
    `/clusters/${group}/headline`,
    `/clusters/${group}/projects`,
    "/dashboard?viewScope=all_authorized",
    fixture.id === "member"
      ? "/spend/people?viewScope=all_authorized"
      : "/spend/groups?viewScope=all_authorized",
    "/teams/budgets",
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
    const hasGrowthWorkspaceScope = ["workspace", "both"].includes(fixture.id);
    const expectedActivityUsers = fixture.id === "account"
      ? [...fixture.users, INTERNAL_USER]
      : fixture.users;
    expect(activity.users.map((user) => user.userId).sort())
      .toEqual([...expectedActivityUsers].sort());
    const expectedSpend = fixture.users.reduce((sum, id) => sum + spendByUser.get(id), 0);
    const expectedCanonicalSpend = fixture.id === "account"
      ? 40
      : hasGrowthWorkspaceScope
        ? 20
        : expectedSpend;
    const dashboard = await (
      await request(
        `/dashboard?rangeType=custom&startDate=${TODAY}&endDate=${TODAY}&viewScope=all_authorized`,
        fixture,
      )
    ).json();
    expect(dashboard.accounting.eligibleSpendUsd).toBe(expectedCanonicalSpend);
    expect(
      dashboard.accounting.grossSpendUsd -
        dashboard.accounting.internalExcludedUsd,
    ).toBeCloseTo(dashboard.accounting.eligibleSpendUsd, 8);
    const trendSpend = dashboard.trend.buckets.reduce(
      (sum, bucket) => sum + bucket.spendUsd,
      0,
    );
    expect(trendSpend).toBeCloseTo(expectedCanonicalSpend, 8);
    expect(trendSpend).toBeCloseTo(dashboard.accounting.eligibleSpendUsd, 8);
    expect(dashboard.breakdown.reduce(
      (sum, item) => sum + item.spendUsd,
      0,
    )).toBeCloseTo(dashboard.accounting.eligibleSpendUsd, 8);
    if (fixture.id === "account") {
      expect(dashboard.accounting.reconciliationUsd).toBe(5);
      expect(
        dashboard.accounting.eligibleSpendUsd +
          dashboard.accounting.reconciliationUsd,
      ).toBe(45);
    } else {
      expect(dashboard.accounting.reconciliationUsd).toBe(0);
    }
    const alerts = await (await request("/alerts", fixture)).json();
    const entities = alerts
      .filter((alert) => alert.entityId.startsWith(PREFIX))
      .map((alert) => `${alert.entityType}:${alert.entityId}`).sort();
    const expected = fixture.id === "member" ? [] : [`group:${GM}`];
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
      `/directory/workspaces/${GROWTH}/members/${WRITE_USER}/budget`,
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

it("traverses workspace limit audits beyond 200 without widening cursor scope", async () => {
  const operatorUserId = `${PREFIX}-audit-pagination`;
  const inserted = await db.insert(usageLimitAuditsTable).values(
    Array.from({ length: 201 }, (_, index) => ({
      operatorUserId,
      workspaceId: GROWTH,
      workspaceName: "Growth",
      memberUserId: `audit-member-${index}`,
      action: "set",
      operation: "individual",
      requestedAmountUsd: index + 1,
      outcome: "success",
    })),
  ).returning({ id: usageLimitAuditsTable.id });
  try {
    const account = fixtures[0]!;
    const firstResponse = await request(
      `/directory/workspaces/${GROWTH}/usage-limit-audits`,
      account,
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first).toHaveLength(200);

    const secondResponse = await request(
      `/directory/workspaces/${GROWTH}/usage-limit-audits?beforeId=${first.at(-1).id}`,
      account,
    );
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    const traversedIds = [...first, ...second]
      .filter((row) => row.operatorUserId === operatorUserId)
      .map((row) => row.id);
    expect(new Set(traversedIds).size).toBe(201);

    const member = fixtures.find((fixture) => fixture.id === "member")!;
    const forbidden = await request(
      `/directory/workspaces/${PLATFORM}/usage-limit-audits?beforeId=${inserted.at(-1)!.id}`,
      member,
    );
    expect(forbidden.status).toBe(403);
  } finally {
    await db.delete(usageLimitAuditsTable).where(
      eq(usageLimitAuditsTable.operatorUserId, operatorUserId),
    );
  }
});

it("ignores a forged preview header from an ordinary account admin", async () => {
  const fixture = fixtures[0]!;
  const response = await request("/groups", fixture, {
    headers: { "X-Preview-As": `workspace_admin:${PLATFORM}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.groups
    .filter((group) => !group.isSynthetic)
    .map((group) => group.groupId).sort()).toEqual([...allGroups].sort());
});

it("enforces the editor action matrix on direct mutation routes", async () => {
  const editor: Authorization = {
    ...authorization("budget-editor", "account", allGroups, allUsers),
    isTrueAccountAdmin: false,
    capabilities: {
      canViewAccountUsage: true,
      canEditAllocations: true,
      canManageAccess: false,
      canManageNotifications: false,
      canManageSystem: false,
      canPreviewRoles: false,
      canWriteGroupLimits: false,
      canWriteUserLimitsIn: [],
      canRunChecks: false,
      canSendTestEmail: false,
    },
  };
  setAuthorizationResolver(async (id) =>
    id === "budget-editor" ? editor : fixtureResolver(id)
  );
  try {
    const caller = { id: "budget-editor" };
    // Invalid bodies establish that the planning guard passed without committing writes.
    expect((await request(`/groups/${GM}/budget`, caller, {
      method: "PUT",
      body: JSON.stringify({}),
    })).status).toBe(400);
    expect((await request(`/admin/team-budgets/${encodeURIComponent(TEAM)}/allocation`, caller, {
      method: "PATCH",
      body: JSON.stringify({}),
    })).status).toBe(400);

    for (const [path, method, body] of [
      ["/app-admins", "POST", { userId: "member" }],
      ["/settings/email", "PATCH", { automatedEmailEnabled: true }],
      ["/alerts/check", "POST", {}],
      ["/alerts/test-email", "POST", { entityType: "group", threshold: 50 }],
      [`/admin/team-budgets/${encodeURIComponent(TEAM)}/limit`, "PATCH", { monthlyLimitUsd: 10 }],
      [`/directory/workspaces/${GROWTH}/members/${WRITE_USER}/budget`, "PUT", { amountUsd: 10 }],
    ] as const) {
      expect((await request(path, caller, {
        method,
        body: JSON.stringify(body),
      })).status).toBe(403);
    }
  } finally {
    setAuthorizationResolver(fixtureResolver);
  }
});

it("rejects individual and bulk usage-limit targeting of internal members", async () => {
  const fixture = fixtures[0]!;
  budgetTransportMock.mockClear();

  const individual = await request(
    `/directory/workspaces/${GROWTH}/members/${INTERNAL_USER}/budget`,
    fixture,
    { method: "PUT", body: JSON.stringify({ amountUsd: 12 }) },
  );
  expect(individual.status).toBe(403);
  expect(await individual.json()).toEqual({
    error: "Internal Replit members cannot be targeted by usage limits",
  });

  const bulk = await request(
    `/directory/workspaces/${GROWTH}/members/budget`,
    fixture,
    {
      method: "PUT",
      body: JSON.stringify({ userIds: ["member", INTERNAL_USER], amountUsd: 12 }),
    },
  );
  expect(bulk.status).toBe(403);

  const clear = await request(
    `/directory/workspaces/${GROWTH}/members/${INTERNAL_USER}/budget`,
    fixture,
    { method: "DELETE" },
  );
  expect(clear.status).toBe(403);
  expect(budgetTransportMock).not.toHaveBeenCalled();
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
      "/dashboard?rangeType=full-term&viewScope=all_authorized",
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

  it("reports reproducible persisted dashboard read-path evidence", async () => {
    const fixture = fixtures[0]!;
    const originalQuery = pool.query.bind(pool);
    const sqlCounts = new Map<string, number>();
    let queryCount = 0;
    let configLoadCount = 0;
    let usageQueryCount = 0;
    pool.query = (async (text, values) => {
      queryCount += 1;
      const sql = typeof text === "string" ? text : text?.text ?? "";
      for (const table of [
        "usage_member_day",
        "usage_project_day",
        "usage_workspace_day",
        "usage_account_day",
        "group_budgets",
        "team_limit_targets",
        "team_budgets",
        "team_budget_adjustments",
        "team_budget_sync_state",
        "family_team_mappings",
        "configuration_revision",
      ]) {
        if (sql.includes(table)) {
          sqlCounts.set(table, (sqlCounts.get(table) ?? 0) + 1);
          if (table.startsWith("usage_")) usageQueryCount += 1;
          else configLoadCount += 1;
        }
      }
      return originalQuery(text, values);
    }) as typeof pool.query;

    const p95 = (values: number[]) => percentile(values, 0.95);
    const measured = async (path: string, caller = fixture) => {
      const beforeQueries = queryCount;
      const beforeConfigLoads = configLoadCount;
      const beforeUsageQueries = usageQueryCount;
      const started = performance.now();
      const response = await request(path, caller);
      const body = await response.arrayBuffer();
      const bodyText = new TextDecoder().decode(body);
      expect(
        response.status,
        `${path}: ${bodyText.slice(0, 300)}`,
      ).toBe(200);
      const timing = response.headers.get("server-timing") ?? "";
      const accounting = Number(
        /accounting;dur=([\d.]+)/.exec(timing)?.[1] ?? 0,
      );
      const queries = queryCount - beforeQueries;
      const configLoads = configLoadCount - beforeConfigLoads;
      const usageQueries = usageQueryCount - beforeUsageQueries;
      let resolvedPeriod: string | null = null;
      if (response.headers.get("content-type")?.includes("application/json")) {
        const json = JSON.parse(bodyText) as {
          period?: { start?: string; endExclusive?: string };
        };
        if (json.period?.start && json.period.endExclusive) {
          resolvedPeriod = `${json.period.start}|${json.period.endExclusive}`;
        }
      }
      return {
        durationMs: performance.now() - started,
        bytes: body.byteLength,
        queries,
        configLoads,
        build: usageQueries > 0,
        accountingMs: accounting,
        resolvedPeriod,
        serverTiming: timing,
      };
    };
    const measuredBatch = async (paths: string[]) => {
      const beforeQueries = queryCount;
      const beforeConfigLoads = configLoadCount;
      const beforeUsageQueries = usageQueryCount;
      const samples = await Promise.all(paths.map((path) => measured(path)));
      return {
        samples,
        queryTotal: queryCount - beforeQueries,
        configLoadTotal: configLoadCount - beforeConfigLoads,
        buildTotal: (usageQueryCount - beforeUsageQueries) / 4,
      };
    };

    try {
      budgetTransportMock.mockClear();
      const path = "/dashboard?rangeType=full-term&viewScope=all_authorized";
      const cold = [];
      for (let index = 0; index < 20; index += 1) {
        invalidateUsageSnapshotMemo();
        cold.push(await measured(path));
      }
      await measured(path);
      const warm = [];
      for (let index = 0; index < 20; index += 1) {
        warm.push(await measured(path));
      }

      invalidateUsageSnapshotMemo();
      const concurrentCold = await measuredBatch(
        Array.from({ length: 8 }, () => path),
      );

      const navigation = [];
      for (const navPath of [
        path,
        "/spend/pools?rangeType=full-term&viewScope=all_authorized",
        "/spend/groups?rangeType=full-term&viewScope=all_authorized",
        "/spend/people?rangeType=full-term&viewScope=all_authorized",
        "/spend/projects?rangeType=full-term&viewScope=all_authorized",
        "/teams/budgets",
        `/groups/${GM}?rangeType=full-term`,
      ]) {
        invalidateUsageSnapshotMemo();
        navigation.push({ path: navPath, ...await measured(navPath) });
      }

      const spendWarmProfiles = [];
      for (const spendPath of [
        "/spend/pools?rangeType=full-term&viewScope=all_authorized",
        "/spend/groups?rangeType=full-term&viewScope=all_authorized",
        "/spend/people?rangeType=full-term&viewScope=all_authorized",
        "/spend/projects?rangeType=full-term&viewScope=all_authorized",
        "/spend/pools.csv?rangeType=full-term&viewScope=all_authorized",
        "/spend/groups.csv?rangeType=full-term&viewScope=all_authorized",
        "/spend/people.csv?rangeType=full-term&viewScope=all_authorized",
        "/spend/projects.csv?rangeType=full-term&viewScope=all_authorized",
      ]) {
        invalidateUsageSnapshotMemo();
        await measured(spendPath);
        const samples = [];
        for (let index = 0; index < 20; index += 1) {
          samples.push(await measured(spendPath));
        }
        spendWarmProfiles.push({ path: spendPath, samples });
      }

      const heapBefore = process.memoryUsage();
      const requestedScopes = new Set<string>();
      const resolvedScopes = new Set<string>();
      const resolvedScopeIdentities = new Set<string>();
      for (let index = 0; index < 280; index += 1) {
        const startDay = "2026-05-20";
        const endDay = new Date(
          Date.parse(`${startDay}T00:00:00.000Z`) +
          (index % 60) * 86_400_000,
        )
          .toISOString().slice(0, 10);
        const caller = fixtures[Math.floor(index / 60)]!;
        const requestedScope =
          `/dashboard?rangeType=custom&startDate=${startDay}&endDate=${endDay}` +
          `&viewScope=all_authorized`;
        requestedScopes.add(`${caller.id}|${requestedScope}`);
        const sample = await measured(requestedScope, caller);
        if (sample.resolvedPeriod) {
          resolvedScopes.add(sample.resolvedPeriod);
          resolvedScopeIdentities.add(`${caller.id}|${sample.resolvedPeriod}`);
        }
      }
      const heapAfter = process.memoryUsage();

      const endOverlap = beginUsageGenerationUpdate();
      invalidateUsageSnapshotMemo();
      let ingestionOverlap;
      try {
        ingestionOverlap = await measuredBatch(
          Array.from({ length: 8 }, () => path),
        );
      } finally {
        endOverlap();
      }

      const summarize = (
        samples,
        concurrentQueryTotal,
        concurrentConfigLoadTotal,
        concurrentBuildTotal,
      ) => ({
        count: samples.length,
        p50Ms: percentile(samples.map((item) => item.durationMs), 0.5),
        p95Ms: p95(samples.map((item) => item.durationMs)),
        payloadBytes: [...new Set(samples.map((item) => item.bytes))],
        queryCount: concurrentQueryTotal === undefined ? {
          perRequestMin: Math.min(...samples.map((item) => item.queries)),
          perRequestMax: Math.max(...samples.map((item) => item.queries)),
          total: samples.reduce((sum, item) => sum + item.queries, 0),
        } : { concurrentBatchTotal: concurrentQueryTotal },
        configLoads: concurrentConfigLoadTotal === undefined ? {
          perRequestMin: Math.min(...samples.map((item) => item.configLoads)),
          perRequestMax: Math.max(...samples.map((item) => item.configLoads)),
          total: samples.reduce((sum, item) => sum + item.configLoads, 0),
        } : { concurrentBatchTotal: concurrentConfigLoadTotal },
        builds: concurrentBuildTotal ??
          samples.filter((item) => item.build).length,
      });
      const report = {
        fixture: {
          storage: "Vitest per-worker migrated schema with explicit suite seed",
          upstream: "member-budget transport mocked; usage upstream unreachable",
          workspaces: 2,
          groups: 4,
          members: allUsers.length,
          usageDays: 1,
        },
        cold: summarize(cold),
        warm: summarize(warm),
        concurrentCold: summarize(
          concurrentCold.samples,
          concurrentCold.queryTotal,
          concurrentCold.configLoadTotal,
          concurrentCold.buildTotal,
        ),
        navigation,
        spendWarm: spendWarmProfiles.map(({ path: spendPath, samples }) => ({
          path: spendPath,
          ...summarize(samples),
        })),
        multiScopeBound: {
          requestedScopes: 280,
          distinctRequestedScopes: requestedScopes.size,
          distinctResolvedPeriods: resolvedScopes.size,
          distinctResolvedScopeIdentities: resolvedScopeIdentities.size,
          dashboardCacheEntries: __getScopedAccountingCacheSizeForTests(),
          heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
          rssDeltaBytes: heapAfter.rss - heapBefore.rss,
        },
        isolatedIngestionOverlap: {
          method: "generation-publication overlap only; no ingestion reads or writes",
          ...summarize(
            ingestionOverlap.samples,
            ingestionOverlap.queryTotal,
            ingestionOverlap.configLoadTotal,
            ingestionOverlap.buildTotal,
          ),
        },
        sqlCounts: Object.fromEntries([...sqlCounts].sort()),
        mockedUpstreamCalls: budgetTransportMock.mock.calls.length,
      };
      expect(report.multiScopeBound.dashboardCacheEntries).toBeLessThanOrEqual(256);
      expect(report.mockedUpstreamCalls).toBe(0);
      process.stdout.write(
        `SIMPLIFY_BUDGET_READS_PERFORMANCE ${JSON.stringify(report)}\n`,
      );
    } finally {
      pool.query = originalQuery as typeof pool.query;
    }
  }, 120_000);
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

describe("bootstrap account-admin revocation", () => {
  it("survives deletion and both authentication callback bootstrap attempts", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = "configured-operator@example.test";
    const bootstrapEmail = getBootstrapAccountAdminEmail()!;
    const userId = "workspace";
    await db.delete(appAdminsTable).where(eq(appAdminsTable.userId, userId));
    await db.insert(appAdminsTable).values({
      userId,
      email: bootstrapEmail,
      createdBy: null,
    });

    const response = await request(
      `/app-admins/${encodeURIComponent(userId)}`,
      fixtures[0],
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);

    const claims = {
      sub: userId,
      email: bootstrapEmail,
      email_verified: true,
    };
    await expect(maybeBootstrapAppAdmin(claims)).resolves.toBe(false);
    await expect(maybeBootstrapAppAdmin(claims)).resolves.toBe(false);
    expect(await isPersistedAppAdmin(userId)).toBe(false);

    const [row] = await db
      .select()
      .from(appAdminsTable)
      .where(eq(appAdminsTable.userId, userId));
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(row?.revokedBy).toBe("account");

    await db.delete(appAdminsTable).where(eq(appAdminsTable.userId, userId));
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
    process.env.BOOTSTRAP_ADMIN_EMAIL = "configured-operator@example.test";
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
      recipient: "configured-operator@example.test",
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
    : ["workspace", "team", "both", "member", "other", WRITE_USER, INTERNAL_USER];
}