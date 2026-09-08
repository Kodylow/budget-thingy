import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import groupPlansRouter from "./group-plans";
import type { Authorization } from "../lib/authz";
import {
  __setDirectoryCacheForTests,
  getCachedDirectory,
} from "../lib/enterprise";

function authorization(
  canEditAllocations: boolean,
  canViewAccountUsage = true,
): Authorization {
  return {
    role: "account",
    roles: ["account"],
    userId: "group-plan-http-user",
    workspaceIds: [],
    teamNames: [],
    groupIds: [],
    userIds: [],
    managedGroupIds: [],
    groupUserIds: {},
    isTrueAccountAdmin: true,
    capabilities: {
      canViewAccountUsage,
      canManageAccess: false,
      canEditAllocations,
      canManageFundingMappings: false,
      canManageNotifications: false,
      canManageSystem: false,
      canPreviewRoles: false,
      canWriteGroupLimits: false,
      canRunChecks: false,
      canSendTestEmail: false,
      canWriteUserLimitsIn: [],
    },
  };
}

describe("group plan HTTP mutation boundary", () => {
  let server: Server;
  let baseUrl: string;
  let canEdit = false;
  let canView = true;
  let authzOverride: Authorization | null = null;

  beforeAll(async () => {
    __setDirectoryCacheForTests({
      workspaces: new Map([
        ["task60-w1", {
          id: "task60-w1", name: "Task 60 One", slug: "task-60-one", memberCount: 1,
        }],
        ["task60-w2", {
          id: "task60-w2", name: "Task 60 Two", slug: "task-60-two", memberCount: 1,
        }],
      ]),
      groups: [
        {
          id: "task60-g1",
          workspaceId: "task60-w1",
          name: "Task 60 One - Member",
          type: "custom",
        },
        {
          id: "task60-g2",
          workspaceId: "task60-w2",
          name: "Task 60 Two - Member",
          type: "custom",
        },
      ],
      groupMembers: new Map([
        ["task60-g1", ["task60-u1"]],
        ["task60-g2", ["task60-u2"]],
      ]),
      members: new Map([
        ["task60-u1", {
          userId: "task60-u1",
          username: "task60-u1",
          email: "task60-u1@example.com",
          name: "Task 60 One",
          isAccountAdmin: false,
          isInternalReplitUser: false,
          workspaces: new Map([
            ["task60-w1", { role: "member", isDisabled: false }],
          ]),
        }],
        ["task60-u2", {
          userId: "task60-u2",
          username: "task60-u2",
          email: "task60-u2@example.com",
          name: "Task 60 Two",
          isAccountAdmin: false,
          isInternalReplitUser: false,
          workspaces: new Map([
            ["task60-w2", { role: "member", isDisabled: false }],
          ]),
        }],
      ]),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.authz = authzOverride ?? authorization(canEdit, canView);
      req.user = {
        id: "group-plan-http-user",
        email: "planner@example.com",
        firstName: "Plan",
        lastName: "Operator",
        profileImageUrl: null,
      };
      req.configurationSnapshot = {
        revision: "definitely-stale",
        groupBudgets: [],
        teamLimitTargets: [],
        teamBudgets: [{
          teamName: "Task 60 Team",
          originalAmountUsd: 120_000,
          amountUsd: 120_000,
          monthlyLimitUsd: null,
          monthlyLimitSource: "derived",
          isHidden: false,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        }],
        teamBudgetAdjustments: [],
        familyTeamMappings: [],
        fundingGroupOverrides: [
          {
            workspaceId: "task60-w1",
            groupId: "task60-g1",
            teamName: "Task 60 Team",
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            workspaceId: "task60-w2",
            groupId: "task60-g2",
            teamName: "Task 60 Team",
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      };
      req.log = {
        error: () => undefined,
      } as unknown as typeof req.log;
      next();
    });
    app.use("/api", groupPlansRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    __setDirectoryCacheForTests(null);
  });

  it("rejects fractional cents and revisions on the wire", async () => {
    canEdit = true;
    for (const body of [
      {
        amountUsdCents: 100.5,
        expectedPlanRevision: null,
        expectedConfigurationRevision: "1",
      },
      {
        amountUsdCents: 100,
        expectedPlanRevision: 1.5,
        expectedConfigurationRevision: "1",
      },
    ]) {
      const response = await fetch(`${baseUrl}/api/limits/group-plans/ws/group`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid group plan save" });
    }
  });

  it("uses allocation-edit capability independently of limit-write scope", async () => {
    canEdit = false;
    const response = await fetch(`${baseUrl}/api/limits/group-plans/ws/group`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountUsdCents: 100,
        expectedPlanRevision: null,
        expectedConfigurationRevision: "1",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("capability-gates the inventory read", async () => {
    authzOverride = {
      ...authorization(false, false),
      role: "member",
      roles: ["member"],
      isTrueAccountAdmin: false,
    };
    const response = await fetch(`${baseUrl}/api/limits/group-plans`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Access denied" });
    authzOverride = null;
  });

  it("returns a date-only full-scope inventory on the HTTP wire", async () => {
    authzOverride = authorization(true, true);
    const response = await fetch(`${baseUrl}/api/limits/group-plans`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      fundingPeriod: { start: string; end: string };
      plans: Array<Record<string, unknown>>;
    };
    expect(body.fundingPeriod).toEqual({
      start: "2026-05-20",
      end: "2027-05-20",
    });
    expect(body.plans).toHaveLength(2);
    expect(body.plans[0]).toMatchObject({
      canEditPlan: true,
      eligibleMemberCount: 1,
      savedStatus: "unset",
    });
    authzOverride = null;
  });

  it("returns only managed groups and suppresses a partial team's envelope", async () => {
    const base = authorization(false, false);
    authzOverride = {
      ...base,
      role: "workspace_admin",
      roles: ["workspace_admin"],
      workspaceIds: ["task60-w1"],
      groupIds: ["task60-g1"],
      managedGroupIds: ["task60-g1"],
      isTrueAccountAdmin: false,
      isPreview: true,
    };
    const response = await fetch(`${baseUrl}/api/limits/group-plans`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      plans: Array<Record<string, unknown>>;
    };
    expect(body.plans).toHaveLength(1);
    expect(body.plans[0]).toMatchObject({
      workspaceId: "task60-w1",
      canEditPlan: false,
      teamEnvelopeUsdCents: null,
    });
    authzOverride = null;
  });

  it("treats a referenced unknown roster member as unavailable", async () => {
    const directory = await getCachedDirectory();
    directory.groupMembers.set("task60-g2", ["missing-directory-user"]);
    authzOverride = authorization(true, true);
    const response = await fetch(`${baseUrl}/api/limits/group-plans`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      plans: Array<{
        groupId: string;
        eligibleMemberCount: number | null;
        recommendationStatus: string;
      }>;
    };
    expect(body.plans.find((plan) => plan.groupId === "task60-g2")).toMatchObject({
      eligibleMemberCount: null,
      recommendationStatus: "missing_history",
    });
    directory.groupMembers.set("task60-g2", ["task60-u2"]);
    authzOverride = null;
  });

  it("rejects a stale funding configuration before resolving the group", async () => {
    canEdit = true;
    const response = await fetch(`${baseUrl}/api/limits/group-plans/ws/group`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountUsdCents: 100,
        expectedPlanRevision: null,
        expectedConfigurationRevision: "not-the-request-snapshot",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Funding configuration revision is stale",
    });
  });
});