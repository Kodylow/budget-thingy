import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listBudgets,
  listReplitGroupBudgets,
  listReplitMemberBudgets,
  ReplitBudgetWrite,
  ReversibleBudgetCanaryError,
  runReversibleMemberBudgetCanary,
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
    invoke: () => Promise<unknown>;
    expected: ReplitBudgetWrite;
  }> = [
    {
      name: "group",
      invoke: () => setReplitGroupBudget("ws1", "group2", 25),
      expected: {
        type: "workspace_group_limit",
        workspaceId: "ws1",
        groupId: "group2",
        amountUsd: 25,
      },
    },
    {
      name: "user",
      invoke: () => setReplitMemberBudget("ws1", "42", 30),
      expected: {
        type: "workspace_user_limit",
        workspaceId: "ws1",
        userId: "42",
        amountUsd: 30,
      },
    },
    {
      name: "workspace default",
      invoke: () => setWorkspaceDefaultUserLimit("ws1", 40),
      expected: {
        type: "workspace_default_user_limit",
        workspaceId: "ws1",
        amountUsd: 40,
      },
    },
    {
      name: "generic null clear",
      invoke: () =>
        setBudget({
          type: "workspace_user_limit",
          workspaceId: "ws1",
          userId: "42",
          amountUsd: null,
        }),
      expected: {
        type: "workspace_user_limit",
        workspaceId: "ws1",
        userId: "42",
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
      const { amountUsd, ...identity } = expected;
      const stored = {
        ...identity,
        currency: "USD",
        period: "billing_cycle",
        amountUsd,
      };
      return init.method === "POST"
        ? json({ data: amountUsd === null ? null : stored }, 200, {
            "x-request-id": "write-request",
          })
        : json({
            data: amountUsd === null ? [] : [stored],
            pagination: { hasMore: false },
          }, 200, { "x-request-id": "read-request" });
    });

    await invoke();
    const { amountUsd, ...identity } = expected;
    expect(calls).toEqual([
      {
        path: "/v1/budgets",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          ...identity,
          currency: "USD",
          period: "billing_cycle",
          amountUsd,
        },
      },
      {
        path: `/v1/budgets?type=${expected.type}&workspaceId=ws1&limit=100`,
        method: "GET",
        headers: undefined,
        body: undefined,
      },
    ]);
  });

  it("uses the configured Enterprise Bearer key for writes and readback", async () => {
    const previousKey = process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS;
    process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS = "secret-budget-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer secret-budget-key",
      });
      return init?.method === "POST"
        ? json({
            data: {
              type: "workspace_default_user_limit",
              workspaceId: "ws1",
              currency: "USD",
              period: "billing_cycle",
              amountUsd: 10,
            },
          })
        : json({
            data: [{
              type: "workspace_default_user_limit",
              workspaceId: "ws1",
              currency: "USD",
              period: "billing_cycle",
              amountUsd: 10,
            }],
            pagination: { hasMore: false },
          });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await setWorkspaceDefaultUserLimit("ws1", 10);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        "https://api.replit.com/v1/budgets",
        "https://api.replit.com/v1/budgets?type=workspace_default_user_limit&workspaceId=ws1&limit=100",
      ]);
    } finally {
      vi.unstubAllGlobals();
      if (previousKey == null) {
        delete process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS;
      } else {
        process.env.REPLIT_ENTERPRISE_API_KEY_BUDGETS = previousKey;
      }
    }
  });

  it.each([
    [409, { "retry-after": "0" }],
    [429, { "x-ratelimit-reset": "0" }],
  ])("retries HTTP %i with upstream retry headers", async (status, headers) => {
    let postCalls = 0;
    setReplitBudgetTransportForTests(async (_path, init) => {
      if (init.method === "GET") {
        return json({ data: [], pagination: { hasMore: false } });
      }
      postCalls++;
      return postCalls < 3
        ? json({ message: "retry" }, status, headers)
        : json({ data: null });
    });

    await setWorkspaceDefaultUserLimit("ws1", null);
    expect(postCalls).toBe(3);
  });

  it.each([401, 403])(
    "preserves HTTP %i authorization status and request ID",
    async (status) => {
      setReplitBudgetTransportForTests(async () =>
        json({ message: "denied" }, status, { "x-request-id": `request-${status}` }),
      );
      const error = await setWorkspaceDefaultUserLimit("ws1", 10).catch(
        (caught) => caught,
      );
      expect(error).toMatchObject({
        upstreamStatus: status,
        requestId: `request-${status}`,
        kind: status === 401 ? "unavailable" : "error",
      });
      expect(error.message).not.toContain("Bearer");
    },
  );

  it("rejects invalid identifiers and amounts before transport", async () => {
    const transport = vi.fn();
    setReplitBudgetTransportForTests(transport);
    const invalid: ReplitBudgetWrite[] = [
      { type: "workspace_default_user_limit", workspaceId: "", amountUsd: 1 },
      { type: "workspace_default_user_limit", workspaceId: "ws-1", amountUsd: 1 },
      {
        type: "workspace_group_limit",
        workspaceId: "ws1",
        groupId: "",
        amountUsd: 1,
      },
      {
        type: "workspace_user_limit",
        workspaceId: "ws1",
        userId: "0",
        amountUsd: 1,
      },
      {
        type: "workspace_user_limit",
        workspaceId: "ws1",
        userId: "12a",
        amountUsd: 1,
      },
      { type: "workspace_default_user_limit", workspaceId: "ws1", amountUsd: 0 },
      {
        type: "workspace_default_user_limit",
        workspaceId: "ws1",
        amountUsd: Number.POSITIVE_INFINITY,
      },
    ];
    for (const budget of invalid) {
      await expect(setBudget(budget)).rejects.toBeInstanceOf(TypeError);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("requires an exact HTTP 200 JSON update response", async () => {
    setReplitBudgetTransportForTests(async () =>
      new Response(null, { status: 204, headers: { "x-request-id": "bad-status" } }),
    );
    const error = await setWorkspaceDefaultUserLimit("ws1", 10).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ upstreamStatus: 204, requestId: "bad-status" });
    expect(error.message).toContain("expected HTTP 200");

    setReplitBudgetTransportForTests(async () =>
      new Response("{", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "bad-json",
        },
      }),
    );
    await expect(setWorkspaceDefaultUserLimit("ws1", 10)).rejects.toMatchObject({
      requestId: "bad-json",
      message: "Replit budgets API returned malformed JSON",
    });
  });

  it("rejects a POST response that differs from desired state", async () => {
    setReplitBudgetTransportForTests(async () =>
      json({
        data: {
          type: "workspace_user_limit",
          workspaceId: "ws1",
          userId: "42",
          currency: "USD",
          period: "billing_cycle",
          amountUsd: 99,
        },
      }, 200, { "x-request-id": "mismatch-write" }),
    );
    await expect(setReplitMemberBudget("ws1", "42", 10)).rejects.toMatchObject({
      requestId: "mismatch-write",
      message: "Replit budgets API response did not match the requested desired state",
    });
  });

  it("rejects a non-null clear response", async () => {
    setReplitBudgetTransportForTests(async () =>
      json({ data: { amountUsd: null } }),
    );
    await expect(setWorkspaceDefaultUserLimit("ws1", null)).rejects.toThrow(
      "response did not match",
    );
  });

  it("rejects readback mismatches with read request diagnostics", async () => {
    setReplitBudgetTransportForTests(async (_path, init) =>
      init.method === "POST"
        ? json({
            data: {
              type: "workspace_user_limit",
              workspaceId: "ws1",
              userId: "42",
              currency: "USD",
              period: "billing_cycle",
              amountUsd: 10,
            },
          })
        : json({
            data: [{
              type: "workspace_user_limit",
              workspaceId: "ws1",
              userId: "42",
              currency: "USD",
              period: "billing_cycle",
              amountUsd: 11,
            }],
            pagination: { hasMore: false },
          }, 200, { "x-request-id": "mismatch-read" }),
    );
    await expect(setReplitMemberBudget("ws1", "42", 10)).rejects.toMatchObject({
      requestId: "mismatch-read",
      message: "Replit budgets API readback did not match the requested desired state",
    });
  });

  it("restores the exact prior member state after a reversible canary", async () => {
    let current: number | null = 25;
    const writes: Array<number | null> = [];
    setReplitBudgetTransportForTests(async (_path, init) => {
      if (init.method === "POST") {
        const desired = JSON.parse(init.body!) as ReplitBudgetWrite;
        current = desired.amountUsd;
        writes.push(current);
        return json({
          data: current == null ? null : {
            ...desired,
            currency: "USD",
            period: "billing_cycle",
          },
        });
      }
      return json({
        data: current == null ? [] : [{
          type: "workspace_user_limit",
          workspaceId: "ws1",
          userId: "42",
          currency: "USD",
          period: "billing_cycle",
          amountUsd: current,
        }],
        pagination: { hasMore: false },
      });
    });

    await expect(
      runReversibleMemberBudgetCanary("ws1", "42", 26),
    ).resolves.toEqual({
      previousAmountUsd: 25,
      temporaryAmountUsd: 26,
      restoredAmountUsd: 25,
    });
    expect(writes).toEqual([26, 25]);
    expect(current).toBe(25);
  });

  it("restores after the temporary POST succeeds but its readback fails", async () => {
    let current: number | null = 25;
    let readCount = 0;
    const writes: Array<number | null> = [];
    setReplitBudgetTransportForTests(async (_path, init) => {
      if (init.method === "POST") {
        const desired = JSON.parse(init.body!) as ReplitBudgetWrite;
        current = desired.amountUsd;
        writes.push(current);
        return json({
          data: current == null ? null : {
            ...desired,
            currency: "USD",
            period: "billing_cycle",
          },
        });
      }
      readCount += 1;
      const readAmount = readCount === 2 ? 999 : current;
      return json({
        data: readAmount == null ? [] : [{
          type: "workspace_user_limit",
          workspaceId: "ws1",
          userId: "42",
          currency: "USD",
          period: "billing_cycle",
          amountUsd: readAmount,
        }],
        pagination: { hasMore: false },
      });
    });

    const error = await runReversibleMemberBudgetCanary("ws1", "42", 26)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ReversibleBudgetCanaryError);
    expect(error.restorationError).toBeNull();
    expect(writes).toEqual([26, 25]);
    expect(current).toBe(25);
  });

  it("reports restoration failure without claiming the canary succeeded", async () => {
    let current: number | null = 25;
    let postCount = 0;
    setReplitBudgetTransportForTests(async (_path, init) => {
      if (init.method === "POST") {
        postCount += 1;
        if (postCount === 2) return json({ error: "restore failed" }, 500);
        const desired = JSON.parse(init.body!) as ReplitBudgetWrite;
        current = desired.amountUsd;
        return json({
          data: { ...desired, currency: "USD", period: "billing_cycle" },
        });
      }
      return json({
        data: [{
          type: "workspace_user_limit",
          workspaceId: "ws1",
          userId: "42",
          currency: "USD",
          period: "billing_cycle",
          amountUsd: current,
        }],
        pagination: { hasMore: false },
      });
    });

    await expect(
      runReversibleMemberBudgetCanary("ws1", "42", 26),
    ).rejects.toMatchObject({
      name: "ReversibleBudgetCanaryError",
      message: expect.stringContaining("could not be verified as restored"),
    });
  });
});