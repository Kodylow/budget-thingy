import { beforeEach, describe, expect, it, vi } from "vitest";

const connectorMocks = vi.hoisted(() => {
  const proxy = vi.fn();
  const constructor = vi.fn(function MockReplitConnectors() {
    return { proxy };
  });
  return { proxy, constructor };
});

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: connectorMocks.constructor,
}));

import { isEmailConfigured } from "./email";

describe("isEmailConfigured", () => {
  beforeEach(() => {
    connectorMocks.proxy.mockReset();
    connectorMocks.constructor.mockClear();
  });

  it("returns true when the dedicated AgentMail inbox is usable", async () => {
    connectorMocks.proxy.mockResolvedValue(
      Response.json({
        inboxes: [
          {
            inbox_id: "inbox-1",
            email: "budget-monitor@agentmail.to",
            client_id: "group-budget-monitor",
          },
        ],
      }),
    );

    await expect(isEmailConfigured()).resolves.toBe(true);
    expect(connectorMocks.constructor).toHaveBeenCalledTimes(1);
    expect(connectorMocks.proxy).toHaveBeenCalledWith(
      "agentmail",
      "/v0/inboxes?limit=100",
      { method: "GET" },
    );
  });

  it("returns false when AgentMail cannot list inboxes", async () => {
    connectorMocks.proxy.mockResolvedValue(
      new Response("connector unavailable", { status: 503 }),
    );

    await expect(isEmailConfigured()).resolves.toBe(false);
  });

  it("creates a fresh connector client for every readiness probe", async () => {
    connectorMocks.proxy.mockResolvedValue(
      Response.json({
        inboxes: [
          {
            inbox_id: "inbox-1",
            email: "budget-monitor@agentmail.to",
            client_id: "group-budget-monitor",
          },
        ],
      }),
    );

    await isEmailConfigured();
    await isEmailConfigured();

    expect(connectorMocks.constructor).toHaveBeenCalledTimes(2);
  });
});