import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";

/**
 * Email sending layer backed by the Replit AgentMail connector.
 *
 * ReplitConnectors is deliberately created inside each operation. Connector
 * credentials are short-lived, so neither the connector client nor an inbox
 * lookup is cached between sends.
 */
export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  senderEmail?: string;
}

interface AgentMailInbox {
  inbox_id: string;
  email: string;
  client_id?: string;
}

interface ListInboxesResponse {
  inboxes?: AgentMailInbox[];
}

interface SendMessageResponse {
  message_id?: string;
}

const CONNECTOR_NAME = "agentmail";
const APP_CLIENT_ID = "group-budget-monitor";

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  if (!body) return `${response.status} ${response.statusText}`.trim();
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string };
      message?: string;
      detail?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? parsed.message ?? parsed.detail ?? body;
  } catch {
    return body;
  }
}

async function resolveSenderInbox(connectors: ReplitConnectors): Promise<AgentMailInbox> {
  const listResponse = await connectors.proxy(
    CONNECTOR_NAME,
    "/v0/inboxes?limit=100",
    { method: "GET" },
  );
  if (!listResponse.ok) {
    throw new Error(`Unable to list AgentMail inboxes: ${await readError(listResponse)}`);
  }

  const listed = (await listResponse.json()) as ListInboxesResponse;
  const inboxes = listed.inboxes ?? [];
  const existing = inboxes.find((inbox) => inbox.client_id === APP_CLIENT_ID);
  if (existing) return existing;

  const createResponse = await connectors.proxy(CONNECTOR_NAME, "/v0/inboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: "Group Budget Monitor",
      client_id: APP_CLIENT_ID,
      metadata: { app: APP_CLIENT_ID },
    }),
  });
  if (createResponse.status === 409) {
    const retryListResponse = await connectors.proxy(
      CONNECTOR_NAME,
      "/v0/inboxes?limit=100",
      { method: "GET" },
    );
    if (retryListResponse.ok) {
      const retryListed = (await retryListResponse.json()) as ListInboxesResponse;
      const racedInbox = retryListed.inboxes?.find(
        (inbox) => inbox.client_id === APP_CLIENT_ID,
      );
      if (racedInbox) return racedInbox;
    }
  }
  if (!createResponse.ok) {
    throw new Error(`Unable to create an AgentMail inbox: ${await readError(createResponse)}`);
  }
  return (await createResponse.json()) as AgentMailInbox;
}

/**
 * Verify that the AgentMail connector is currently usable and that this app
 * can resolve its dedicated sender inbox. A fresh connector client is used on
 * every probe so short-lived connector credentials are never cached.
 */
export async function isEmailConfigured(): Promise<boolean> {
  try {
    const connectors = new ReplitConnectors();
    await resolveSenderInbox(connectors);
    return true;
  } catch (err) {
    logger.warn({ err }, "AgentMail connector is not ready");
    return false;
  }
}

export async function sendEmail(
  to: string[],
  subject: string,
  htmlBody: string,
): Promise<SendResult> {
  if (to.length === 0) {
    return { ok: false, error: "No email recipients were provided" };
  }

  try {
    const connectors = new ReplitConnectors();
    const sender = await resolveSenderInbox(connectors);
    const response = await connectors.proxy(
      CONNECTOR_NAME,
      `/v0/inboxes/${encodeURIComponent(sender.inbox_id)}/messages/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, html: htmlBody }),
      },
    );
    if (!response.ok) {
      const error = `AgentMail send failed: ${await readError(response)}`;
      logger.error({ to, subject, status: response.status }, error);
      return { ok: false, error };
    }

    const sent = (await response.json()) as SendMessageResponse;
    logger.info(
      { to, subject, messageId: sent.message_id, senderEmail: sender.email },
      "Email sent through AgentMail",
    );
    return {
      ok: true,
      messageId: sent.message_id,
      senderEmail: sender.email,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown AgentMail error";
    logger.error({ err, to, subject }, "AgentMail send failed");
    return { ok: false, error };
  }
}

export function buildAlertEmail(args: {
  // Which allocated pool crossed a threshold: a raw Enterprise group or a
  // cross-workspace team. Defaults to "group" for backward compatibility.
  entityType?: "group" | "team";
  entityName?: string;
  // Legacy field: for group alerts this is the group name. Kept so existing
  // callers/tests continue to work; entityName takes precedence when provided.
  groupName: string;
  workspaceName: string | null;
  threshold: number;
  spendUsd: number;
  budgetUsd: number;
  billingPeriodLabel: string;
}): { subject: string; html: string } {
  const entityType = args.entityType ?? "group";
  const name = args.entityName ?? args.groupName;
  const kindLabel = entityType === "team" ? "team" : "group";
  const pct = ((args.spendUsd / args.budgetUsd) * 100).toFixed(1);
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const severity =
    args.threshold >= 100
      ? "Allocated pool exceeded"
      : `${args.threshold}% allocated pool alert`;
  const subject = `[Replit Budget Alert] ${name}: ${severity} (${args.billingPeriodLabel})`;
  // Only surface a specific workspace for group alerts — teams may span several
  // workspaces, so a single-workspace note would be misleading.
  const workspaceNote =
    entityType === "group" && args.workspaceName
      ? ` (workspace: ${args.workspaceName})`
      : "";
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: ${args.threshold >= 100 ? "#b91c1c" : args.threshold >= 90 ? "#c2410c" : "#a16207"};">
        ${severity}: ${name}
      </h2>
      <p>The Replit Enterprise ${kindLabel} <strong>${name}</strong>${workspaceNote} has used <strong>${pct}%</strong> of its allocated pool for ${args.billingPeriodLabel}.</p>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 6px 0; color: #555;">Current spend</td><td style="text-align: right; font-weight: 600;">${fmt(args.spendUsd)}</td></tr>
        <tr><td style="padding: 6px 0; color: #555;">Allocated pool</td><td style="text-align: right; font-weight: 600;">${fmt(args.budgetUsd)}</td></tr>
        <tr><td style="padding: 6px 0; color: #555;">Threshold crossed</td><td style="text-align: right; font-weight: 600;">${args.threshold}%</td></tr>
      </table>
      <p style="color: #777; font-size: 12px; margin-top: 24px;">Sent automatically by Group Budget Monitor.</p>
    </div>`;
  return { subject, html };
}
