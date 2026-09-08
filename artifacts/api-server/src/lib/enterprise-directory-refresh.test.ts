import { afterEach, describe, expect, test, vi } from "vitest";
import {
  db,
  familyTeamMappingsTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { refreshDirectoryForIngest } from "./enterprise";

describe("Enterprise directory refresh write mode", () => {
  const dataWorkspaceId = "__directory_data_only__";
  const normalWorkspaceId = "__directory_business__";
  const dataTeam = "__Directory existing team__";
  const normalTeam = "Directory Normal Family";
  const originalFetch = globalThis.fetch;
  const originalKey = process.env["REPLIT_ENTERPRISE_API_KEY"];

  function installProvider(
    workspaceId: string,
    familyName: string,
    requests: { method: string; path: string }[],
    beforeResponse?: (path: string) => Promise<void>,
  ): void {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", path: url.pathname });
      await beforeResponse?.(url.pathname);
      if (url.pathname.endsWith("/workspaces")) {
        return Response.json({
          data: [{ id: workspaceId, name: "Workspace", slug: workspaceId, memberCount: 0 }],
          pagination: { hasMore: false },
        });
      }
      if (url.pathname.endsWith("/groups")) {
        return Response.json({
          data: [{
            id: `${workspaceId}-member`,
            workspaceId,
            name: `${familyName} - Members`,
            type: "custom",
          }],
          pagination: { hasMore: false },
        });
      }
      if (url.pathname.includes("/groups/") && url.pathname.endsWith("/users")) {
        return Response.json({ data: [], pagination: { hasMore: false } });
      }
      if (url.pathname.endsWith("/members") || url.pathname.endsWith("/budgets")) {
        return Response.json({ data: [], pagination: { hasMore: false } });
      }
      return new Response("unexpected provider route", { status: 404 });
    });
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env["REPLIT_ENTERPRISE_API_KEY"];
    else process.env["REPLIT_ENTERPRISE_API_KEY"] = originalKey;
    await db.delete(teamLimitTargetsTable)
      .where(inArray(teamLimitTargetsTable.workspaceId, [dataWorkspaceId, normalWorkspaceId]));
    await db.delete(familyTeamMappingsTable)
      .where(inArray(familyTeamMappingsTable.workspaceId, [dataWorkspaceId, normalWorkspaceId]));
    await db.delete(teamBudgetsTable)
      .where(inArray(teamBudgetsTable.teamName, [dataTeam, normalTeam]));
  });

  test("data-only refresh uses existing mappings without configuration writes", async () => {
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    await db.insert(familyTeamMappingsTable).values({
      workspaceId: dataWorkspaceId,
      familyKey: "directory data family",
      familyName: "Operator-owned family name",
      teamName: dataTeam,
      isLegacy: false,
    });
    await db.insert(teamLimitTargetsTable).values({
      workspaceId: dataWorkspaceId,
      groupId: `${dataWorkspaceId}-member`,
      groupName: "Operator-owned group name",
      teamName: dataTeam,
      assignmentSource: "automatic",
      monthlyLimitUsd: 123,
      isEnabled: false,
    });
    const requests: { method: string; path: string }[] = [];
    installProvider(dataWorkspaceId, "Directory Data Family", requests);

    const directory = await refreshDirectoryForIngest(true);

    expect(directory.account.familiesById
      .get(`${dataWorkspaceId}:directory data family`)?.teamName).toBe(dataTeam);
    expect(await db.select().from(familyTeamMappingsTable).where(and(
      eq(familyTeamMappingsTable.workspaceId, dataWorkspaceId),
      eq(familyTeamMappingsTable.familyKey, "directory data family"),
    ))).toEqual([
      expect.objectContaining({
        familyName: "Operator-owned family name",
        teamName: dataTeam,
      }),
    ]);
    expect(await db.select().from(teamLimitTargetsTable).where(and(
      eq(teamLimitTargetsTable.workspaceId, dataWorkspaceId),
      eq(teamLimitTargetsTable.groupId, `${dataWorkspaceId}-member`),
    ))).toEqual([
      expect.objectContaining({
        groupName: "Operator-owned group name",
        monthlyLimitUsd: 123,
        isEnabled: false,
      }),
    ]);
    expect(await db.select().from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, dataTeam))).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("regular refresh records unknown families without manufacturing funding or limit targets", async () => {
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    const requests: { method: string; path: string }[] = [];
    installProvider(normalWorkspaceId, normalTeam, requests);

    await refreshDirectoryForIngest();

    expect(await db.select().from(familyTeamMappingsTable).where(and(
      eq(familyTeamMappingsTable.workspaceId, normalWorkspaceId),
      eq(familyTeamMappingsTable.familyKey, "directory normal family"),
    ))).toEqual([
      expect.objectContaining({ familyName: normalTeam, teamName: null }),
    ]);
    expect(await db.select().from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, normalTeam))).toHaveLength(0);
    expect(await db.select().from(teamLimitTargetsTable).where(and(
      eq(teamLimitTargetsTable.workspaceId, normalWorkspaceId),
      eq(teamLimitTargetsTable.groupId, `${normalWorkspaceId}-member`),
    ))).toEqual([]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("different write modes do not coalesce onto the active refresh", async () => {
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    const requests: { method: string; path: string }[] = [];
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markEntered = resolve; });
    let blocked = false;
    installProvider(normalWorkspaceId, normalTeam, requests, async (path) => {
      if (!blocked && path.endsWith("/workspaces")) {
        blocked = true;
        markEntered();
        await firstBlocked;
      }
    });

    const businessRefresh = refreshDirectoryForIngest();
    await firstEntered;
    const dataOnlyRefresh = refreshDirectoryForIngest(true);
    releaseFirst();
    await Promise.all([businessRefresh, dataOnlyRefresh]);

    expect(requests.filter((request) => request.path.endsWith("/workspaces")))
      .toHaveLength(2);
  });

  test("retains built-in groups only for presentation with complete membership", async () => {
    process.env["REPLIT_ENTERPRISE_API_KEY"] = "test-key";
    const workspaceId = dataWorkspaceId;
    const requestedMemberships: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/workspaces")) {
        return Response.json({
          data: [{ id: workspaceId, name: "Workspace", slug: workspaceId, memberCount: 1 }],
          pagination: { hasMore: false },
        });
      }
      if (url.pathname.endsWith("/groups")) {
        return Response.json({
          data: [
            { id: "builtin", workspaceId, name: "Members", type: "member" },
            { id: "custom", workspaceId, name: "Finance - Members", type: "custom" },
          ],
          pagination: { hasMore: false },
        });
      }
      if (url.pathname.includes("/groups/") && url.pathname.endsWith("/users")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2)!);
        requestedMemberships.push(id);
        return Response.json({
          data: [{ userId: "123" }],
          pagination: { hasMore: false },
        });
      }
      if (url.pathname.endsWith("/members")) {
        return Response.json({
          data: [{
            user: {
              id: "123",
              username: "member",
              email: "member@example.com",
              firstName: null,
              lastName: null,
            },
            workspaces: [{ id: workspaceId, role: "member", isDisabled: false }],
          }],
          pagination: { hasMore: false },
        });
      }
      if (url.pathname.endsWith("/budgets")) {
        return Response.json({ data: [], pagination: { hasMore: false } });
      }
      return new Response("unexpected route", { status: 404 });
    });

    const directory = await refreshDirectoryForIngest(true);

    expect(requestedMemberships.sort()).toEqual(["builtin", "custom"]);
    expect(directory.allGroups.map((group) => group.id).sort())
      .toEqual(["builtin", "custom"]);
    expect(directory.groupMembers.get("builtin")).toEqual(["123"]);
    expect(directory.groups.map((group) => group.id)).toEqual(["custom"]);
    expect(directory.account.roleGroupsById.has("builtin")).toBe(false);
    expect(directory.account.roleGroupsById.get("custom")?.members.has("123")).toBe(true);
  });
});