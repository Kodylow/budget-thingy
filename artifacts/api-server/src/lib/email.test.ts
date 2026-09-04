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
  buildAlertEmail,
  clearSenderInboxCacheForTests,
  isEmailConfigured,
  sendEmail,
  sendTestEmail,
  setSendEmailOverrideForTests,
} from "./email";

describe("isEmailConfigured", () => {
  beforeEach(() => {
    connectorMocks.proxy.mockReset();
    connectorMocks.constructor.mockClear();
    clearSenderInboxCacheForTests();
    setSendEmailOverrideForTests(null);
    process.env.NODE_ENV = "test";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "bootstrap-admin@example.com";
    delete process.env.APP_BASE_URL;
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
    expect(result.deliveredTo).toEqual(["bootstrap-admin@example.com"]);
    const sendRequest = connectorMocks.proxy.mock.calls[1]![2] as RequestInit;
    expect(JSON.parse(String(sendRequest.body))).toMatchObject({
      to: ["bootstrap-admin@example.com"],
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

  it("caches only a successful sender lookup for ten-minute readiness probes", async () => {
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

    expect(connectorMocks.constructor).toHaveBeenCalledTimes(1);
    expect(connectorMocks.proxy).toHaveBeenCalledTimes(1);
  });

  it("refreshes readiness after the ten-minute sender cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    connectorMocks.proxy.mockResolvedValue(Response.json({
      inboxes: [{
        inbox_id: "inbox-1",
        email: "budget-monitor@agentmail.to",
        client_id: "group-budget-monitor",
      }],
    }));
    try {
      await isEmailConfigured();
      vi.setSystemTime(new Date("2026-09-04T12:10:01Z"));
      await isEmailConfigured();
      expect(connectorMocks.proxy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries sender resolution immediately after a failed readiness probe", async () => {
    connectorMocks.proxy
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        inboxes: [{
          inbox_id: "inbox-1",
          email: "budget-monitor@agentmail.to",
          client_id: "group-budget-monitor",
        }],
      }));

    await expect(isEmailConfigured()).resolves.toBe(false);
    await expect(isEmailConfigured()).resolves.toBe(true);
    expect(connectorMocks.proxy).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh connector client for every actual send while reusing sender metadata", async () => {
    connectorMocks.proxy
      .mockResolvedValueOnce(Response.json({
        inboxes: [{
          inbox_id: "inbox-1",
          email: "budget-monitor@agentmail.to",
          client_id: "group-budget-monitor",
        }],
      }))
      .mockResolvedValueOnce(Response.json({ message_id: "message-1" }))
      .mockResolvedValueOnce(Response.json({ message_id: "message-2" }));

    await sendTestEmail("First", "<p>First</p>");
    await sendTestEmail("Second", "<p>Second</p>");

    expect(connectorMocks.constructor).toHaveBeenCalledTimes(2);
    expect(connectorMocks.proxy).toHaveBeenCalledTimes(3);
    expect(connectorMocks.proxy.mock.calls[2]![1]).toContain("/messages/send");
  });

  it("fixes test delivery to Kody in production", async () => {
    process.env.NODE_ENV = "production";
    setSendEmailOverrideForTests(async (to, subject) => ({
      ok: true,
      deliveredTo: to,
      messageId: subject,
    }));

    const result = await sendTestEmail("[TEST] Alert", "<p>Test</p>");
    expect(result.deliveredTo).toEqual(["bootstrap-admin@example.com"]);
    expect(result.messageId).toBe("[TEST] Alert");
  });

  it("does not report success when AgentMail omits the message identifier", async () => {
    connectorMocks.proxy
      .mockResolvedValueOnce(Response.json({
        inboxes: [{
          inbox_id: "inbox-1",
          email: "budget-monitor@agentmail.to",
          client_id: "group-budget-monitor",
        }],
      }))
      .mockResolvedValueOnce(Response.json({}));
    await expect(sendTestEmail("Test", "<p>Test</p>")).resolves.toMatchObject({
      ok: false,
      error: "AgentMail send did not return sender and message identifiers",
    });
  });
});

describe("buildAlertEmail", () => {
  beforeEach(() => {
    delete process.env.APP_BASE_URL;
  });

  it.each([
    ["group", 50],
    ["group", 75],
    ["group", 90],
    ["group", 100],
    ["team", 50],
    ["team", 75],
    ["team", 90],
    ["team", 100],
  ] as const)("renders the predefined %s %i%% variant", (entityType, threshold) => {
    const rendered = buildAlertEmail({
      entityType,
      entityId: entityType === "group" ? "group/id" : "Platform Team",
      entityName: entityType === "group" ? "Engineering" : "Platform Team",
      groupName: "Engineering",
      workspaceName: entityType === "group" ? "Example Workspace" : null,
      threshold,
      spendUsd: threshold === 100 ? 10_250 : threshold * 100,
      budgetUsd: 10_000,
      billingPeriodLabel: "September 2026",
      dataAsOf: new Date("2026-09-04T14:30:00.000Z"),
    });
    expect(rendered.subject).toContain("[Replit Budget Alert]");
    expect(rendered.subject).toContain("(September 2026)");
    expect(rendered.html).toContain("Reporting window");
    expect(rendered.html).toContain("September 2026");
    expect(rendered.html).toContain("Data as of");
    expect(rendered.html).toContain("2026-09-04T14:30:00Z");
    expect(rendered.html).not.toContain("<a href=");
  });

  it("adds safe entity links only for an HTTP(S) APP_BASE_URL", () => {
    process.env.APP_BASE_URL = "https://budget.example.com/app";
    const group = buildAlertEmail({
      entityType: "group",
      entityId: "group/id",
      entityName: "Engineering",
      groupName: "Engineering",
      workspaceName: "Workspace",
      threshold: 75,
      spendUsd: 750,
      budgetUsd: 1_000,
      billingPeriodLabel: "September 2026",
      dataAsOf: "2026-09-04T14:30:00Z",
    });
    expect(group.html).toContain(
      "https://budget.example.com/app/groups/group%2Fid",
    );

    process.env.APP_BASE_URL = "javascript:alert(1)";
    const unsafe = buildAlertEmail({
      entityType: "team",
      entityName: "Platform Team",
      groupName: "Platform Team",
      workspaceName: null,
      threshold: 90,
      spendUsd: 900,
      budgetUsd: 1_000,
      billingPeriodLabel: "September 2026",
    });
    expect(unsafe.html).not.toContain("<a href=");
  });

  it("integrates server-owned test delivery context into the branded email", () => {
    const rendered = buildAlertEmail({
      entityType: "group",
      entityId: "engineering",
      entityName: "Engineering",
      groupName: "Engineering",
      workspaceName: "Example Workspace",
      threshold: 50,
      spendUsd: 5_000,
      budgetUsd: 10_000,
      billingPeriodLabel: "Aug 19, 2026 – Sep 19, 2026",
      dataAsOf: "2026-09-04T05:21:47.324Z",
      testDeliveryLabel: "Predefined group example",
    });
    expect(rendered.html).toContain("Budget Monitor");
    expect(rendered.html).toContain("Replit Enterprise");
    expect(rendered.html).toContain("Test delivery · Predefined group example");
    expect(rendered.html).toContain("safe preview sent only to Kody");
    expect(rendered.html).toContain("width:50%");
    expect(rendered.html).toContain("$5,000.00");
    expect(rendered.html).toContain("2026-09-04T05:21:47.324Z UTC");
    expect(rendered.html).not.toContain("padding: 12px; margin-bottom: 16px");
  });
});