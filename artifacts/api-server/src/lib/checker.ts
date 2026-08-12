import { and, eq } from "drizzle-orm";
import {
  db,
  groupBudgetsTable,
  adminEmailsTable,
  alertsTable,
  firedThresholdsTable,
  type Alert,
} from "@workspace/db";
import { logger } from "./logger";
import {
  getDirectory,
  getSpend,
  getBillingPeriod,
  isConfigured,
  queueGroupSpendFetch,
  queueMemberUsageFetch,
  resolveRange,
  type EnterpriseGroup,
} from "./enterprise";
import { sendEmail, buildAlertEmail, isEmailConfigured } from "./email";

export const THRESHOLDS = [50, 75, 90, 100];
export const CHECK_INTERVAL_MINUTES = 10;

let lastCheckAt: Date | null = null;

const evaluationsInFlight = new Map<string, Promise<Alert[]>>();
export function getLastCheckAt(): Date | null {
  return lastCheckAt;
}

export async function getFiredThresholds(
  groupId: string,
  billingPeriod: string,
): Promise<number[]> {
  const rows = await db
    .select()
    .from(firedThresholdsTable)
    .where(
      and(
        eq(firedThresholdsTable.groupId, groupId),
        eq(firedThresholdsTable.billingPeriod, billingPeriod),
      ),
    );
  return rows.map((r) => r.threshold).sort((a, b) => a - b);
}

/**
 * Evaluate thresholds for one group and send any due alerts.
 * Idempotent per (group, billing period, threshold).
 */
async function evaluateGroupOnce(group: EnterpriseGroup): Promise<Alert[]> {
  const spend = getSpend(group.id);
  if (!spend) return [];

  const [budget] = await db
    .select()
    .from(groupBudgetsTable)
    .where(eq(groupBudgetsTable.groupId, group.id));
  if (!budget || budget.amountUsd <= 0) return [];

  const pct = (spend.spendUsd / budget.amountUsd) * 100;
  const fired = await getFiredThresholds(group.id, spend.periodStart);
  const due = THRESHOLDS.filter((t) => pct >= t && !fired.includes(t));
  if (due.length === 0) return [];

  const admins = await db.select().from(adminEmailsTable);
  if (admins.length === 0) {
    logger.warn({ groupId: group.id }, "Threshold crossed but no admin emails configured; will retry");
    return [];
  }
  if (!(await isEmailConfigured())) {
    logger.warn({ groupId: group.id }, "Threshold crossed but email is not connected; will retry once connected");
    return [];
  }

  const dir = await getDirectory();
  const workspaceName = dir.workspaces.get(group.workspaceId)?.name ?? null;
  const recipients = admins.map((a) => a.email);
  const { label } = getBillingPeriod();
  const created: Alert[] = [];

  // Send only the highest due threshold as one email (avoids 4 emails when a
  // budget is first set on an already-over group), but mark all due as fired.
  const highest = Math.max(...due);
  const { subject, html } = buildAlertEmail({
    groupName: group.name,
    workspaceName,
    threshold: highest,
    spendUsd: spend.spendUsd,
    budgetUsd: budget.amountUsd,
    billingPeriodLabel: label,
  });
  const result = await sendEmail(recipients, subject, html);

  if (result.ok) {
    for (const t of due) {
      await db
        .insert(firedThresholdsTable)
        .values({ groupId: group.id, billingPeriod: spend.periodStart, threshold: t })
        .onConflictDoNothing();
    }
  }

  const [alert] = await db
    .insert(alertsTable)
    .values({
      groupId: group.id,
      groupName: group.name,
      threshold: highest,
      spendUsd: spend.spendUsd,
      budgetUsd: budget.amountUsd,
      recipients,
      status: result.ok ? "sent" : "failed",
      errorMessage: result.ok ? null : (result.error ?? "unknown error"),
    })
    .returning();
  if (alert) created.push(alert);
  logger.info(
    { groupId: group.id, threshold: highest, status: result.ok ? "sent" : "failed" },
    "Budget alert processed",
  );
  return created;
}
export function evaluateGroup(group: EnterpriseGroup): Promise<Alert[]> {
  const existing = evaluationsInFlight.get(group.id);
  if (existing) return existing;

  const evaluation = evaluateGroupOnce(group).finally(() => {
    if (evaluationsInFlight.get(group.id) === evaluation) {
      evaluationsInFlight.delete(group.id);
    }
  });
  evaluationsInFlight.set(group.id, evaluation);
  return evaluation;
}

/**
 * Full check: refresh spend for all budgeted groups (high priority, forced),
 * then evaluate thresholds. Used by the interval job and the manual endpoint.
 */
export async function runCheck(force = false): Promise<{ checkedGroups: number; alerts: Alert[] }> {
  if (!isConfigured()) return { checkedGroups: 0, alerts: [] };

  const dir = await getDirectory();
  const budgets = await db.select().from(groupBudgetsTable);
  const budgeted = new Set(budgets.map((b) => b.groupId));
  const groups = dir.groups.filter((g) => budgeted.has(g.id));

  // Queue (forced when manual) spend refreshes and wait for them to land.
  await Promise.all(
    groups.map(
      (g) =>
        new Promise<void>((resolve) => {
          // Resolve when the fetch lands (callbacks fan out even when the
          // fetch was queued by someone else), and guard with a timeout so a
          // failed fetch can't hang the whole check.
          const timer = setTimeout(resolve, 5 * 60 * 1000);
          const result = queueGroupSpendFetch(g, 0, force, () => {
            clearTimeout(timer);
            resolve();
          });
          if (result === "fresh_cache") {
            clearTimeout(timer);
            resolve();
          }
        }),
    ),
  );

  const alerts: Alert[] = [];
  for (const g of groups) {
    alerts.push(...(await evaluateGroup(g)));
  }
  lastCheckAt = new Date();
  return { checkedGroups: groups.length, alerts };
}

export function startChecker(): void {
  if (!isConfigured()) {
    logger.warn("Enterprise API key missing; background checker idle");
  }
  // Warm-up: load directory and queue spend fetches for all groups, evaluating
  // budgeted groups as their spend arrives.
  void (async () => {
    try {
      const budgets = await db.select().from(groupBudgetsTable);
      const budgeted = new Set(budgets.map((b) => b.groupId));
      const dir = await getDirectory();
      // Budgeted groups first (higher urgency), then the rest.
      const ordered = [...dir.groups].sort(
        (a, b) => Number(budgeted.has(b.id)) - Number(budgeted.has(a.id)),
      );
      // Bootstrap the dashboard's durable member-level rollup before background
      // raw totals. On later boots, hydrated rows make this an incremental recent
      // overlap refresh while the dashboard can render the stored snapshot at once.
      const dashboardRange = resolveRange("billing");
      for (const g of ordered) {
        queueMemberUsageFetch(g, dashboardRange, 1);
      }
      for (const g of ordered) {
        const result = queueGroupSpendFetch(g, 1, false, () => {
          if (budgeted.has(g.id)) void evaluateGroup(g).catch((err) => logger.error({ err }, "evaluateGroup failed"));
        });
        if (result === "fresh_cache" && budgeted.has(g.id)) {
          void evaluateGroup(g).catch((err) => logger.error({ err }, "evaluateGroup failed"));
        }
      }
      logger.info({ groups: dir.groups.length }, "Warm-up: queued member and spend fetches");
    } catch (err) {
      logger.error({ err }, "Warm-up failed");
    }
  })();

  setInterval(
    () => {
      void runCheck(true).catch((err) => logger.error({ err }, "Scheduled check failed"));
    },
    CHECK_INTERVAL_MINUTES * 60 * 1000,
  );
}
