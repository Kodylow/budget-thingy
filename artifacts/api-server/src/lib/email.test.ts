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

import {
  isEmailConfigured,
  sendEmail,
  setSendEmailOverrideForTests,
} from "./email";

describe("isEmailConfigured", () => {
  beforeEach(() => {
    connectorMocks.proxy.mockReset();
    connectorMocks.constructor.mockClear();
    setSendEmailOverrideForTests(null);
    process.env.NODE_ENV = "test";
  });

  it("routes non-production delivery only to Kody and marks the subject", async () => {
    connectorMocks.proxy
      .mockResolvedValueOnce(Response.json({
        inboxes: [{
          inbox_id: "inbox-1",
          email: "budget-monitor@agentmail.to",
          client_id: "group-budget-monitor",
        }],
      }))
      .mockResolvedValueOnce(Response.json({ message_id: "message-1" }));

    const result = await sendEmail(
      ["account@example.com", "workspace@example.com"],
      "Budget threshold",
      "<p>Alert</p>",
    );
    expect(result.deliveredTo).toEqual(["kody.low@repl.it"]);
    const sendRequest = connectorMocks.proxy.mock.calls[1]![2] as RequestInit;
    expect(JSON.parse(String(sendRequest.body))).toMatchObject({
      to: ["kody.low@repl.it"],
      subject: "[DEV] Budget threshold",
    });
  });

  it("fans out to the deduplicated intended list in production", async () => {
    process.env.NODE_ENV = "production";
    connectorMocks.proxy
      .mockResolvedValueOnce(Response.json({
        inboxes: [{
          inbox_id: "inbox-1",
          email: "budget-monitor@agentmail.to",
          client_id: "group-budget-monitor",
        }],
      }))
      .mockResolvedValueOnce(Response.json({ message_id: "message-1" }));

    const result = await sendEmail(
      [" Workspace@example.com ", "account@example.com", "workspace@example.com"],
      "Budget threshold",
      "<p>Alert</p>",
    );
    expect(result.deliveredTo).toEqual([
      "account@example.com",
      "workspace@example.com",
    ]);
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