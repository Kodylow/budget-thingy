import { afterEach, describe, expect, it } from "vitest";
import {
  listBudgets,
  listReplitGroupBudgets,
  listReplitMemberBudgets,
  ReplitBudgetWrite,
  setBudget,
  setReplitBudgetTransportForTests,
  setReplitGroupBudget,
  setReplitMemberBudget,
  setWorkspaceDefaultUserLimit,
} from "./replit-budgets";

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => setReplitBudgetTransportForTests(null));

describe("Replit budgets transport", () => {
  it("lists with only the supported query keys and follows cursors", async () => {
    const paths: string[] = [];
    setReplitBudgetTransportForTests(async (path, init) => {
      expect(init).toEqual({ method: "GET" });
      paths.push(path);
      return json(
        path.includes("cursor=next")
          ? { data: [{ userId: "u2" }], pagination: { hasMore: false } }
          : {
              data: [{ userId: "u1" }],
              pagination: { hasMore: true, cursor: "next" },
            },
      );
    });

    await expect(listBudgets("workspace_user_limit", "ws")).resolves.toEqual([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    expect(paths).toEqual([
      "/v1/budgets?type=workspace_user_limit&workspaceId=ws&limit=100",
      "/v1/budgets?type=workspace_user_limit&workspaceId=ws&limit=100&cursor=next",
    ]);
    for (const path of paths) {
      const keys = [...new URL(`https://example.test${path}`).searchParams.keys()];
      expect(keys.every((key) =>
        ["type", "workspaceId", "limit", "cursor"].includes(key),
      )).toBe(true);
    }
  });

  it("keeps member and group list wrappers compatible", async () => {
    const paths: string[] = [];
    setReplitBudgetTransportForTests(async (path) => {
      paths.push(path);
      return json({
        data: path.includes("workspace_user_limit")
          ? [{
              type: "workspace_user_limit",
              workspaceId: "ws",
              userId: "u",
              amountUsd: 12,
            }]
          : [{
              type: "workspace_group_limit",
              workspaceId: "ws",
              groupId: "g",
              amountUsd: 24,
            }],
        pagination: { hasMore: false },
      });
    });

    expect((await listReplitMemberBudgets("ws")).budgets.get("u")?.budgetUsd).toBe(12);
    expect((await listReplitGroupBudgets("ws")).budgets.get("g")?.budgetUsd).toBe(24);
    expect(paths).toEqual([
      "/v1/budgets?type=workspace_user_limit&workspaceId=ws&limit=100",
      "/v1/budgets?type=workspace_group_limit&workspaceId=ws&limit=100",
    ]);
  });

  const writes: Array<{
    name: string;
    invoke: () => Promise<void>;
    expected: ReplitBudgetWrite;
  }> = [
    {
      name: "group",
      invoke: () => setReplitGroupBudget("ws", "g", 25),
      expected: {
        type: "workspace_group_limit",
        workspaceId: "ws",
        groupId: "g",
        amountUsd: 25,
      },
    },
    {
      name: "user",
      invoke: () => setReplitMemberBudget("ws", "u", 30),
      expected: {
        type: "workspace_user_limit",
        workspaceId: "ws",
        userId: "u",
        amountUsd: 30,
      },
    },
    {
      name: "workspace default",
      invoke: () => setWorkspaceDefaultUserLimit("ws", 40),
      expected: {
        type: "workspace_default_user_limit",
        workspaceId: "ws",
        amountUsd: 40,
      },
    },
    {
      name: "generic null clear",
      invoke: () =>
        setBudget({
          type: "workspace_user_limit",
          workspaceId: "ws",
          userId: "u",
          amountUsd: null,
        }),
      expected: {
        type: "workspace_user_limit",
        workspaceId: "ws",
        userId: "u",
        amountUsd: null,
      },
    },
  ];

  it.each(writes)("sends the exact $name POST", async ({ invoke, expected }) => {
    const calls: Array<{ path: string; method: string; headers?: unknown; body: unknown }> = [];
    setReplitBudgetTransportForTests(async (path, init) => {
      calls.push({
        path,
        method: init.method,
        headers: init.headers,
        body: init.body && JSON.parse(init.body),
      });
      return new Response(null, { status: 204 });
    });

    await invoke();
    const { amountUsd, ...identity } = expected;
    expect(calls).toEqual([{
      path: "/v1/budgets",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        ...identity,
        currency: "USD",
        period: "billing_cycle",
        amountUsd,
      },
    }]);
  });

  it("retries a 409 once using Retry-After", async () => {
    let calls = 0;
    setReplitBudgetTransportForTests(async () => {
      calls++;
      return calls === 1
        ? json({ message: "conflict" }, 409, { "retry-after": "0" })
        : new Response(null, { status: 204 });
    });

    await setWorkspaceDefaultUserLimit("ws", null);
    expect(calls).toBe(2);
  });

  it("surfaces a 400 upstream message verbatim", async () => {
    setReplitBudgetTransportForTests(async () =>
      json({ message: "amountUsd is invalid" }, 400),
    );
    await expect(setWorkspaceDefaultUserLimit("ws", 10)).rejects.toThrow(
      /^amountUsd is invalid$/,
    );
  });
});