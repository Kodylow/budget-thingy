import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReplitGroupBudget,
  clearReplitMemberBudget,
  listReplitGroupBudgets,
  listReplitMemberBudgets,
  parseReplitGroupBudget,
  parseReplitMemberBudget,
  setReplitBudgetTransportForTests,
  setReplitGroupBudget,
  setReplitMemberBudget,
} from "./replit-budgets";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => setReplitBudgetTransportForTests(null));

describe("Replit budgets connector", () => {
  it("uses the configured Enterprise budget API key as write-capable access", async () => {
    const previousKey = process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS;
    process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS = "scoped-test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      data: [],
      pagination: { hasMore: false, cursor: null },
    }));
    try {
      const result = await listReplitGroupBudgets("ws");
      expect(result).toMatchObject({ status: "available", canWrite: true });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("https://api.replit.com/v1/budgets?"),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer scoped-test-key",
          }),
        }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      if (previousKey === undefined) {
        delete process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS;
      } else {
        process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS = previousKey;
      }
    }
  });

  it("lets the Budgets API reject a write the configured key cannot perform", async () => {
    const previousKey = process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS;
    process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS = "scoped-test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "forbidden" }, 403),
    );
    try {
      await expect(setReplitGroupBudget("ws", "g", 25)).rejects.toMatchObject({
        kind: "error",
        upstreamStatus: 403,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      if (previousKey === undefined) {
        delete process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS;
      } else {
        process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS = previousKey;
      }
    }
  });

  it("follows cursors and deduplicates identical member observations", async () => {
    const paths: string[] = [];
    setReplitBudgetTransportForTests(async (path) => {
      paths.push(path);
      if (!path.includes("cursor=next")) {
        return json({
          data: [
            { workspaceId: "ws", userId: "u1", amountUsd: 10 },
          ],
          pagination: { hasMore: true, cursor: "next" },
        });
      }
      return json({
        data: [
          { workspaceId: "ws", userId: "u1", amountUsd: 10 },
          { workspaceId: "ws", userId: "u2", amountUsd: null },
        ],
        pagination: { hasMore: false, cursor: null },
      });
    });

    const result = await listReplitMemberBudgets("ws");
    expect(result.status).toBe("available");
    expect(paths).toHaveLength(2);
    expect(paths[1]).toContain("cursor=next");
    expect(result.budgets.get("u1")).toMatchObject({ budgetUsd: 10 });
    expect(result.budgets.get("u2")).toMatchObject({ budgetUsd: null });
  });

  it("fails closed instead of choosing between conflicting duplicate limits", async () => {
    setReplitBudgetTransportForTests(async (path) =>
      json(path.includes("cursor=next")
        ? {
            data: [{ workspaceId: "ws", userId: "u1", amountUsd: 20 }],
            pagination: { hasMore: false, cursor: null },
          }
        : {
            data: [{ workspaceId: "ws", userId: "u1", amountUsd: 10 }],
            pagination: { hasMore: true, cursor: "next" },
          }),
    );

    const result = await listReplitMemberBudgets("ws");
    expect(result.status).toBe("error");
    expect(result.error).toContain("conflicting limits");
    expect(result.budgets.size).toBe(0);
  });

  it("parses the Agent limit while ignoring unrelated metric entries and usage", () => {
    expect(
      parseReplitMemberBudget({
        workspace: { id: "ws" },
        user: { id: "u" },
        metrics: [
          { id: "storage", amount: 999, spent: 999 },
          { id: "replit:v0:teams:ai_agent", limit: 50, spent: 65 },
        ],
      }),
    ).toEqual({
      workspaceId: "ws",
      userId: "u",
      budgetUsd: 50,
    });
  });

  it("reports missing scope and unavailable connectors without partial data", async () => {
    setReplitBudgetTransportForTests(async () =>
      json({ error: { message: "missing_scope: budgets.read" } }, 403),
    );
    const missingScope = await listReplitMemberBudgets("ws");
    expect(missingScope.status).toBe("error");
    expect(missingScope.error).toContain("missing_scope");
    expect(missingScope.budgets.size).toBe(0);

    setReplitBudgetTransportForTests(async () => {
      throw new Error("Replit connector not connected");
    });
    const unavailable = await listReplitMemberBudgets("ws");
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.budgets.size).toBe(0);
  });

  it("uses desired-state PUT for set/replace and DELETE for clear", async () => {
    const calls: Array<{ path: string; method: string; body?: any }> = [];
    setReplitBudgetTransportForTests(async (path, init) => {
      calls.push({
        path,
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(null, { status: 204 });
    });

    await setReplitMemberBudget("ws", "u", 25);
    await setReplitMemberBudget("ws", "u", 40);
    await clearReplitMemberBudget("ws", "u");
    expect(calls[0]).toMatchObject({
      path: "/v1/budgets",
      method: "PUT",
      body: {
        workspaceId: "ws",
        userId: "u",
        billingPeriod: "current",
        metric: "replit:v0:teams:ai_agent",
        amountUsd: 25,
      },
    });
    expect(calls[1].body.amountUsd).toBe(40);
    expect(calls[2].method).toBe("DELETE");
    expect(calls[2].path).toContain("/v1/budgets?");
  });

  it("fails closed when the connector lacks write:budgets", async () => {
    let mutationCalled = false;
    setReplitBudgetTransportForTests(async (_path, init) => {
      if (init.method !== "GET") mutationCalled = true;
      return json({
        data: [{ workspaceId: "ws", userId: "u", amountUsd: 20 }],
        pagination: { hasMore: false, cursor: null },
      });
    }, false);

    const snapshot = await listReplitMemberBudgets("ws");
    expect(snapshot.status).toBe("available");
    expect(snapshot.canWrite).toBe(false);
    expect(snapshot.budgets.get("u")?.budgetUsd).toBe(20);
    await expect(setReplitMemberBudget("ws", "u", 30)).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(clearReplitMemberBudget("ws", "u")).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(mutationCalled).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid desired budget %s before calling upstream",
    async (amount) => {
      let called = false;
      setReplitBudgetTransportForTests(async () => {
        called = true;
        return new Response(null, { status: 204 });
      });
      await expect(setReplitMemberBudget("ws", "u", amount)).rejects.toThrow(
        "greater than zero",
      );
      expect(called).toBe(false);
    },
  );

  it("parses typed group Agent limits and rejects unrelated rows", () => {
    expect(
      parseReplitGroupBudget({
        workspace: { id: "ws" },
        group: { id: "g" },
        metrics: [
          { id: "storage", amount: 999 },
          { id: "replit:v0:teams:ai_agent", limitUsd: "75" },
        ],
      }),
    ).toEqual({
      workspaceId: "ws",
      groupId: "g",
      budgetUsd: 75,
    });
    expect(
      parseReplitGroupBudget({
        workspaceId: "ws",
        groupId: "g",
        metric: "storage",
        amountUsd: 10,
      }),
    ).toBeNull();
    expect(parseReplitGroupBudget({ workspaceId: "ws", userId: "u" })).toBeNull();
  });

  it("paginates group budgets, filters other workspaces, and deduplicates by group ID", async () => {
    const paths: string[] = [];
    setReplitBudgetTransportForTests(async (path) => {
      paths.push(path);
      return path.includes("cursor=next")
        ? json({
            data: [
              { workspaceId: "ws", groupId: "g1", amountUsd: 10 },
              { workspaceId: "ws", groupId: "g2", amountUsd: null },
            ],
            pagination: { hasMore: false },
          })
        : json({
            data: [
              { workspaceId: "ws", groupId: "g1", amountUsd: 10 },
              { workspaceId: "other", groupId: "g3", amountUsd: 30 },
              { workspaceId: "ws", userId: "u1", amountUsd: 40 },
            ],
            pagination: { hasMore: true, nextCursor: "next" },
          });
    });

    const result = await listReplitGroupBudgets("ws");
    expect(result.status).toBe("available");
    expect([...result.budgets]).toEqual([
      ["g1", { workspaceId: "ws", groupId: "g1", budgetUsd: 10 }],
      ["g2", { workspaceId: "ws", groupId: "g2", budgetUsd: null }],
    ]);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(
      "/v1/budgets?workspaceId=ws&billingPeriod=current&metric=replit%3Av0%3Ateams%3Aai_agent&limit=100",
    );
    expect(paths[1]).toContain("cursor=next");
  });

  it("rejects conflicting duplicate group budgets", async () => {
    setReplitBudgetTransportForTests(async (path) =>
      path.includes("cursor=next")
        ? json({
            data: [{ workspaceId: "ws", groupId: "g", amountUsd: 20 }],
            pagination: { hasMore: false },
          })
        : json({
            data: [{ workspaceId: "ws", groupId: "g", amountUsd: 10 }],
            pagination: { hasMore: true, cursor: "next" },
          }),
    );

    const result = await listReplitGroupBudgets("ws");
    expect(result.status).toBe("error");
    expect(result.error).toContain("conflicting limits for workspace group g");
    expect(result.budgets.size).toBe(0);
  });

  it("uses exact group PUT and DELETE requests", async () => {
    const calls: Array<{
      path: string;
      method: string;
      headers?: Record<string, string>;
      body?: unknown;
    }> = [];
    setReplitBudgetTransportForTests(async (path, init) => {
      calls.push({
        path,
        method: init.method,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(null, { status: 204 });
    });

    await setReplitGroupBudget("ws", "g", 25);
    await clearReplitGroupBudget("ws", "g");
    expect(calls).toEqual([
      {
        path: "/v1/budgets",
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: {
          workspaceId: "ws",
          groupId: "g",
          billingPeriod: "current",
          metric: "replit:v0:teams:ai_agent",
          amountUsd: 25,
        },
      },
      {
        path:
          "/v1/budgets?workspaceId=ws&groupId=g&billingPeriod=current&metric=replit%3Av0%3Ateams%3Aai_agent",
        method: "DELETE",
        headers: undefined,
        body: undefined,
      },
    ]);
  });

  it("denies group writes without scope and makes no mutation", async () => {
    let called = false;
    setReplitBudgetTransportForTests(async () => {
      called = true;
      return new Response(null, { status: 204 });
    }, false);

    await expect(setReplitGroupBudget("ws", "g", 10)).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(clearReplitGroupBudget("ws", "g")).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(called).toBe(false);
  });

  it("handles zero by clearing while keeping the group setter positive-only", async () => {
    const methods: string[] = [];
    setReplitBudgetTransportForTests(async (_path, init) => {
      methods.push(init.method);
      return new Response(null, { status: 204 });
    });

    await expect(setReplitGroupBudget("ws", "g", 0)).rejects.toThrow(
      "greater than zero",
    );
    await clearReplitGroupBudget("ws", "g");
    expect(methods).toEqual(["DELETE"]);
  });
});
