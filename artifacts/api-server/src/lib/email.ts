import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";
import { BOOTSTRAP_EDITOR_EMAIL, normalizeEmail } from "./authz";

/**
 * Email sending layer backed by the Replit AgentMail connector.
 *
 * ReplitConnectors is deliberately created inside each operation. Connector
 * credentials are short-lived, so the connector client is never cached. A
 * successfully resolved sender inbox may be reused briefly as inert metadata.
 */
export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  senderEmail?: string;
  deliveredTo?: string[];
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
const SENDER_CACHE_TTL_MS = 10 * 60 * 1000;
let senderCache: { inbox: AgentMailInbox; expiresAt: number } | null = null;
let sendOverride:
  | ((
      to: string[],
      subject: string,
      htmlBody: string,
    ) => Promise<SendResult>)
  | null = null;

/** Test-only seam; production callers must never set this. */
export function setSendEmailOverrideForTests(
  override:
    | ((
        to: string[],
        subject: string,
        htmlBody: string,
      ) => Promise<SendResult>)
    | null,
): void {
  sendOverride = override;
}

/** Test-only cache reset. */
export function clearSenderInboxCacheForTests(): void {
  senderCache = null;
}

function getCachedSenderInbox(): AgentMailInbox | null {
  if (!senderCache || senderCache.expiresAt <= Date.now()) return null;
  return senderCache.inbox;
}

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
  const cached = getCachedSenderInbox();
  if (cached) return cached;
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
  if (existing) {
    senderCache = { inbox: existing, expiresAt: Date.now() + SENDER_CACHE_TTL_MS };
    return existing;
  }

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
      if (racedInbox) {
        senderCache = { inbox: racedInbox, expiresAt: Date.now() + SENDER_CACHE_TTL_MS };
        return racedInbox;
      }
    }
  }
  if (!createResponse.ok) {
    throw new Error(`Unable to create an AgentMail inbox: ${await readError(createResponse)}`);
  }
  const created = (await createResponse.json()) as AgentMailInbox;
  senderCache = { inbox: created, expiresAt: Date.now() + SENDER_CACHE_TTL_MS };
  return created;
}

/**
 * Verify that the AgentMail connector is currently usable and that this app
 * can resolve its dedicated sender inbox. A fresh connector client is used on
 * every probe so short-lived connector credentials are never cached.
 */
export async function isEmailConfigured(): Promise<boolean> {
  try {
    if (getCachedSenderInbox()) return true;
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
  const intended = [
    ...new Set(to.map(normalizeEmail).filter((email) => email.length > 0)),
  ].sort();
  if (intended.length === 0) {
    return { ok: false, error: "No email recipients were provided" };
  }
  const deliveredTo =
    process.env.NODE_ENV === "production"
      ? intended
      : [BOOTSTRAP_EDITOR_EMAIL];
  const deliveredSubject =
    process.env.NODE_ENV === "production" ? subject : `[DEV] ${subject}`;
  if (sendOverride) {
    return sendOverride(deliveredTo, deliveredSubject, htmlBody);
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
        body: JSON.stringify({
          to: deliveredTo,
          subject: deliveredSubject,
          html: htmlBody,
        }),
      },
    );
    if (!response.ok) {
      const error = `AgentMail send failed: ${await readError(response)}`;
      logger.error(
        { to: deliveredTo, subject: deliveredSubject, status: response.status },
        error,
      );
      return { ok: false, error, deliveredTo };
    }

    const sent = (await response.json()) as SendMessageResponse;
    if (!sent.message_id || !sender.email) {
      const error = "AgentMail send did not return sender and message identifiers";
      logger.error({ to: deliveredTo, subject: deliveredSubject }, error);
      return { ok: false, error, deliveredTo };
    }
    logger.info(
      {
        to: deliveredTo,
        subject: deliveredSubject,
        messageId: sent.message_id,
        senderEmail: sender.email,
      },
      "Email sent through AgentMail",
    );
    return {
      ok: true,
      messageId: sent.message_id,
      senderEmail: sender.email,
      deliveredTo,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown AgentMail error";
    logger.error(
      { err, to: deliveredTo, subject: deliveredSubject },
      "AgentMail send failed",
    );
    return { ok: false, error, deliveredTo };
  }
}

export const EMAIL_TEST_RECIPIENT = BOOTSTRAP_EDITOR_EMAIL;

/** Fixed-recipient test transport; callers cannot supply or override recipients. */
export function sendTestEmail(subject: string, htmlBody: string): Promise<SendResult> {
  return sendEmail([EMAIL_TEST_RECIPIENT], subject, htmlBody);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function buildEntityUrl(entityType: "group" | "team", entityId: string, entityName: string):
  string | null {
  const configured = process.env.APP_BASE_URL;
  if (!configured) return null;
  try {
    const base = new URL(configured);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    if (entityType === "group") {
      base.pathname = `${base.pathname.replace(/\/$/, "")}/groups/${encodeURIComponent(entityId)}`;
    } else {
      base.searchParams.set("team", entityName);
    }
    return base.toString();
  } catch {
    return null;
  }
}

export function buildAlertEmail(args: {
  // Which allocated pool crossed a threshold: a raw Enterprise group or a
  // cross-workspace team. Defaults to "group" for backward compatibility.
  entityType?: "group" | "team";
  entityName?: string;
  entityId?: string;
  // Legacy field: for group alerts this is the group name. Kept so existing
  // callers/tests continue to work; entityName takes precedence when provided.
  groupName: string;
  workspaceName: string | null;
  threshold: number;
  spendUsd: number;
  budgetUsd: number;
  billingPeriodLabel: string;
  dataAsOf?: Date | string | null;
  /** Server-owned label shown only on fixed-recipient test deliveries. */
  testDeliveryLabel?: string;
}): { subject: string; html: string } {
  const entityType = args.entityType ?? "group";
  const name = args.entityName ?? args.groupName;
  const safeName = escapeHtml(name);
  const safeWindow = escapeHtml(args.billingPeriodLabel);
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
      ? ` (workspace: ${escapeHtml(args.workspaceName)})`
      : "";
  const dataAsOf = args.dataAsOf
    ? new Date(args.dataAsOf).toISOString().replace(".000Z", "Z")
    : "Unavailable";
  const entityUrl = buildEntityUrl(entityType, args.entityId ?? name, name);
  const thresholdTone =
    args.threshold >= 100
      ? { color: "#b42318", soft: "#fff1f0", border: "#fecdca" }
      : args.threshold >= 90
        ? { color: "#c2410c", soft: "#fff4ed", border: "#fed7aa" }
        : args.threshold >= 75
          ? { color: "#b54708", soft: "#fffaeb", border: "#fedf89" }
          : { color: "#946200", soft: "#fffbea", border: "#f5d76e" };
  const progressWidth = Math.min(Math.max(Number(pct), 0), 100);
  const safeTestDeliveryLabel = args.testDeliveryLabel
    ? escapeHtml(args.testDeliveryLabel)
    : null;
  const html = `
    <div style="margin:0; padding:0; background:#f4f7f9; color:#1a2533; font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; background:#f4f7f9; border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:32px 16px;">
            <table role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:620px; background:#ffffff; border:1px solid #dce3e8; border-radius:10px; border-collapse:separate; overflow:hidden;">
              <tr>
                <td style="padding:22px 28px; background:#14202e; border-bottom:4px solid #00b8d4;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td width="44" valign="middle">
                        <div style="width:36px; height:36px; line-height:36px; text-align:center; border-radius:8px; background:#00b8d4; color:#ffffff; font-size:18px; font-weight:700;">$</div>
                      </td>
                      <td valign="middle">
                        <div style="color:#ffffff; font-size:16px; line-height:20px; font-weight:700; letter-spacing:-0.2px;">Budget Monitor</div>
                        <div style="margin-top:2px; color:#aeb9c5; font-size:11px; line-height:16px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase;">Replit Enterprise</div>
                      </td>
                      <td align="right" valign="middle">
                        <span style="display:inline-block; padding:5px 9px; border:1px solid ${thresholdTone.border}; border-radius:999px; background:${thresholdTone.soft}; color:${thresholdTone.color}; font-size:11px; line-height:14px; font-weight:700;">${args.threshold}% threshold</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              ${safeTestDeliveryLabel ? `
              <tr>
                <td style="padding:20px 28px 0;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:separate; background:#eafafd; border:1px solid #9ddfea; border-radius:7px;">
                    <tr>
                      <td style="padding:12px 14px; color:#155f6c; font-size:13px; line-height:19px;">
                        <strong style="display:block; color:#08798d; font-size:11px; line-height:15px; letter-spacing:0.8px; text-transform:uppercase;">Test delivery · ${safeTestDeliveryLabel}</strong>
                        <span>This is a safe preview sent only to Kody. It does not change alert activity or threshold state.</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>` : ""}
              <tr>
                <td style="padding:${safeTestDeliveryLabel ? "24px" : "28px"} 28px 10px;">
                  <div style="margin-bottom:10px; color:${thresholdTone.color}; font-size:12px; line-height:16px; font-weight:700; letter-spacing:0.7px; text-transform:uppercase;">${severity}</div>
                  <h1 style="margin:0; color:#14202e; font-size:28px; line-height:34px; font-weight:700; letter-spacing:-0.6px;">${safeName}</h1>
                  <p style="margin:14px 0 0; color:#4f5e6d; font-size:15px; line-height:23px;">
                    The Replit Enterprise ${kindLabel} <strong style="color:#1a2533;">${safeName}</strong>${workspaceNote} has used <strong style="color:${thresholdTone.color};">${pct}%</strong> of its allocated pool.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 28px 24px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:separate; background:#f7f9fb; border:1px solid #e3e8ed; border-radius:8px;">
                    <tr>
                      <td style="padding:20px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                          <tr>
                            <td valign="bottom">
                              <div style="color:#667584; font-size:12px; line-height:16px; font-weight:700; letter-spacing:0.6px; text-transform:uppercase;">Current spend</div>
                              <div style="margin-top:5px; color:#14202e; font-size:27px; line-height:32px; font-weight:700; letter-spacing:-0.5px;">${fmt(args.spendUsd)}</div>
                            </td>
                            <td align="right" valign="bottom">
                              <div style="color:#667584; font-size:12px; line-height:16px;">Allocated pool</div>
                              <div style="margin-top:5px; color:#344454; font-size:16px; line-height:22px; font-weight:700;">${fmt(args.budgetUsd)}</div>
                            </td>
                          </tr>
                        </table>
                        <div style="margin-top:18px; height:9px; overflow:hidden; border-radius:999px; background:#e2e8ed;">
                          <div style="width:${progressWidth}%; height:9px; border-radius:999px; background:${thresholdTone.color};"></div>
                        </div>
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
                          <tr>
                            <td style="color:#667584; font-size:12px; line-height:16px;">0%</td>
                            <td align="right" style="color:${thresholdTone.color}; font-size:12px; line-height:16px; font-weight:700;">${pct}% used</td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:0 28px 24px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse;">
                    <tr>
                      <td style="padding:12px 0; border-top:1px solid #e7ecef; color:#667584; font-size:13px; line-height:18px;">Reporting window</td>
                      <td align="right" style="padding:12px 0; border-top:1px solid #e7ecef; color:#263746; font-size:13px; line-height:18px; font-weight:700;">${safeWindow}</td>
                    </tr>
                    <tr>
                      <td style="padding:12px 0; border-top:1px solid #e7ecef; color:#667584; font-size:13px; line-height:18px;">Data as of</td>
                      <td align="right" style="padding:12px 0; border-top:1px solid #e7ecef; color:#263746; font-family:'Courier New',monospace; font-size:12px; line-height:18px; font-weight:700;">${dataAsOf} UTC</td>
                    </tr>
                  </table>
                  ${entityUrl ? `
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
                    <tr>
                      <td style="border-radius:6px; background:#009bb5;">
                        <a href="${escapeHtml(entityUrl)}" style="display:inline-block; padding:11px 16px; color:#ffffff; font-size:13px; line-height:18px; font-weight:700; text-decoration:none;">View ${kindLabel} in Budget Monitor&nbsp;&nbsp;→</a>
                      </td>
                    </tr>
                  </table>` : ""}
                </td>
              </tr>
              <tr>
                <td style="padding:18px 28px; background:#f7f9fb; border-top:1px solid #e3e8ed; color:#7a8794; font-size:11px; line-height:17px;">
                  Sent automatically by Group Budget Monitor · Reporting data is shown in UTC.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>`;
  return { subject, html };
}
