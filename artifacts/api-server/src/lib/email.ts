import { logger } from "./logger";

/**
 * Email sending layer. Wired to a Replit email connector (Gmail or Outlook)
 * once the user authorizes one; until then sends fail with a clear error and
 * isEmailConfigured() returns false so the UI can surface a setup notice.
 */
export function isEmailConfigured(): boolean {
  return false; // flipped when an email connector is wired up
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export async function sendEmail(
  to: string[],
  subject: string,
  htmlBody: string,
): Promise<SendResult> {
  if (!isEmailConfigured()) {
    logger.warn({ to, subject }, "Email send skipped: no email connector configured");
    return { ok: false, error: "Email is not connected yet" };
  }
  void htmlBody;
  return { ok: false, error: "Email is not connected yet" };
}

export function buildAlertEmail(args: {
  groupName: string;
  workspaceName: string | null;
  threshold: number;
  spendUsd: number;
  budgetUsd: number;
  billingPeriodLabel: string;
}): { subject: string; html: string } {
  const pct = ((args.spendUsd / args.budgetUsd) * 100).toFixed(1);
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const severity = args.threshold >= 100 ? "Budget exceeded" : `${args.threshold}% budget alert`;
  const subject = `[Replit Budget Alert] ${args.groupName}: ${severity} (${args.billingPeriodLabel})`;
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: ${args.threshold >= 100 ? "#b91c1c" : args.threshold >= 90 ? "#c2410c" : "#a16207"};">
        ${severity}: ${args.groupName}
      </h2>
      <p>The Replit Enterprise group <strong>${args.groupName}</strong>${
        args.workspaceName ? ` (workspace: ${args.workspaceName})` : ""
      } has used <strong>${pct}%</strong> of its ${args.billingPeriodLabel} budget.</p>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 6px 0; color: #555;">Current spend</td><td style="text-align: right; font-weight: 600;">${fmt(args.spendUsd)}</td></tr>
        <tr><td style="padding: 6px 0; color: #555;">Budget</td><td style="text-align: right; font-weight: 600;">${fmt(args.budgetUsd)}</td></tr>
        <tr><td style="padding: 6px 0; color: #555;">Threshold crossed</td><td style="text-align: right; font-weight: 600;">${args.threshold}%</td></tr>
      </table>
      <p style="color: #777; font-size: 12px; margin-top: 24px;">Sent automatically by Group Budget Monitor.</p>
    </div>`;
  return { subject, html };
}
