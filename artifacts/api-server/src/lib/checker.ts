import { and, eq } from "drizzle-orm";
import {
  db,
  groupBudgetsTable,
  teamBudgetsTable,
  groupTeamsTable,
  alertsTable,
  firedThresholdsTable,
  alertDeliveryClaimsTable,
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
  queueExtraWorkspacesFetch,
  getExtraWorkspaceSpend,
  getDedupedUsageRollup,
  getMemberUsage,
  resolveRange,
  type EnterpriseGroup,
} from "./enterprise";
import { sendEmail, buildAlertEmail, isEmailConfigured } from "./email";
import { resolveAlertRecipients } from "./alert-recipients";

export const THRESHOLDS = [50, 75, 90, 100];
export const CHECK_INTERVAL_MINUTES = 10;

// Team spend is always evaluated against the same cutoff-anchored billing range
// the dashboard uses for its deduped team rollups.
const TEAM_RANGE_KEY = "billing:from-cutoff";

let lastCheckAt: Date | null = null;

const evaluationsInFlight = new Map<string, Promise<Alert[]>>();
export function getLastCheckAt(): Date | null {
  return lastCheckAt;
}

/**
 * A single allocated-pool entity to evaluate. Both raw groups and cross-workspace
 * teams reduce to this shape so a single evaluator handles dedup, retries, and
 * the "one highest-due email, mark all due" behavior identically.
 */
interface EntitySpec {
  entityType: "group" | "team";
  entityId: string;
  entityName: string;
  spendUsd: number;
  budgetUsd: number;
  periodStart: string;
  workspaceIds: string[];
  // Only meaningful for group alerts; teams may span multiple workspaces.
  workspaceName: string | null;
}

/**
 * Fired thresholds for an entity/period. entityType defaults to "group" so
 * existing group callers (e.g. dashboard routes) keep working unchanged.
 */
export async function getFiredThresholds(
  entityId: string,
  billingPeriod: string,
  entityType: "group" | "team" = "group",
): Promise<number[]> {
  const rows = await db
    .select()
    .from(firedThresholdsTable)
    .where(
      and(
        eq(firedThresholdsTable.entityType, entityType),
        eq(firedThresholdsTable.entityId, entityId),
        eq(firedThresholdsTable.billingPeriod, billingPeriod),
      ),
    );
  return rows.map((r) => r.threshold).sort((a, b) => a - b);
}

/**
 * Shared evaluation for one allocated-pool entity (group or team).
 *
 * - Dedups per (entityType, entityId, billing period, threshold).
 * - Retries (marks nothing fired) when recipients are missing, email is not
 *   connected, or the send fails — the next check re-attempts naturally.
 * - Sends only the highest currently-due threshold as one email, but marks all
 *   due thresholds as fired on success.
 * - Lowering a pool below current spend is picked up naturally on the next run
 *   because due thresholds are recomputed from the live spend/budget ratio.
 */
const entityEvaluationsInFlight = new Map<string, Promise<Alert[]>>();

async function evaluateEntityOnce(spec: EntitySpec): Promise<Alert[]> {
  if (spec.budgetUsd <= 0) return [];

  const pct = (spec.spendUsd / spec.budgetUsd) * 100;
  const fired = await getFiredThresholds(spec.entityId, spec.periodStart, spec.entityType);
  const due = THRESHOLDS.filter((t) => pct >= t && !fired.includes(t));
  if (due.length === 0) return [];

  const recipients = await resolveAlertRecipients(spec.workspaceIds);
  if (recipients.length === 0) {
    logger.warn(
      { entityType: spec.entityType, entityId: spec.entityId },
      "Threshold crossed but no admin emails configured; will retry",
    );
    return [];
  }
  if (!(await isEmailConfigured())) {
    logger.warn(
      { entityType: spec.entityType, entityId: spec.entityId },
      "Threshold crossed but email is not connected; will retry once connected",
    );
    return [];
  }

  const { label } = getBillingPeriod();
  const created: Alert[] = [];

  // Send only the highest due threshold as one email (avoids 4 emails when a
  // pool is first set on an already-over entity), but mark all due as fired.
  const highest = Math.max(...due);
  const [insertedClaim] = await db.insert(alertDeliveryClaimsTable).values({
    entityType: spec.entityType,
    entityId: spec.entityId,
    billingPeriod: spec.periodStart,
    threshold: highest,
    status: "claimed",
  }).onConflictDoNothing().returning();
  let claim = insertedClaim;
  if (!claim) {
    const [retryClaim] = await db.update(alertDeliveryClaimsTable)
      .set({ status: "claimed", updatedAt: new Date() })
      .where(and(
        eq(alertDeliveryClaimsTable.entityType, spec.entityType),
        eq(alertDeliveryClaimsTable.entityId, spec.entityId),
        eq(alertDeliveryClaimsTable.billingPeriod, spec.periodStart),
        eq(alertDeliveryClaimsTable.threshold, highest),
        eq(alertDeliveryClaimsTable.status, "failed"),
      )).returning();
    claim = retryClaim;
  }
  if (!claim) return [];
  const { subject, html } = buildAlertEmail({
    entityType: spec.entityType,
    entityName: spec.entityName,
    groupName: spec.entityName,
    workspaceName: spec.workspaceName,
    threshold: highest,
    spendUsd: spec.spendUsd,
    budgetUsd: spec.budgetUsd,
    billingPeriodLabel: label,
  });
  const result = await sendEmail(recipients, subject, html);

  if (result.ok) {
    await db.update(alertDeliveryClaimsTable)
      .set({ status: "sent", updatedAt: new Date() })
      .where(eq(alertDeliveryClaimsTable.id, claim.id));
    for (const t of due) {
      await db
        .insert(firedThresholdsTable)
        .values({
          groupId: spec.entityId,
          entityType: spec.entityType,
          entityId: spec.entityId,
          billingPeriod: spec.periodStart,
          threshold: t,
        })
        .onConflictDoNothing();
    }
  } else {
    await db.update(alertDeliveryClaimsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(alertDeliveryClaimsTable.id, claim.id));
  }

  const [alert] = await db
    .insert(alertsTable)
    .values({
      groupId: spec.entityId,
      groupName: spec.entityName,
      entityType: spec.entityType,
      entityId: spec.entityId,
      entityName: spec.entityName,
      workspaceIds: spec.workspaceIds,
      threshold: highest,
      spendUsd: spec.spendUsd,
      budgetUsd: spec.budgetUsd,
      recipients: result.deliveredTo ?? recipients,
      status: result.ok ? "sent" : "failed",
      errorMessage: result.ok ? null : (result.error ?? "unknown error"),
    })
    .returning();
  if (alert) created.push(alert);
  logger.info(
    {
      entityType: spec.entityType,
      entityId: spec.entityId,
      threshold: highest,
      status: result.ok ? "sent" : "failed",
    },
    "Allocated pool alert processed",
  );
  return created;
}

async function evaluateEntity(spec: EntitySpec): Promise<Alert[]> {
  const key = `${spec.entityType}|${spec.entityId}`;
  const existing = entityEvaluationsInFlight.get(key);
  if (existing) return existing;
  const evaluation = evaluateEntityOnce(spec).finally(() => {
    if (entityEvaluationsInFlight.get(key) === evaluation) {
      entityEvaluationsInFlight.delete(key);
    }
  });
  entityEvaluationsInFlight.set(key, evaluation);
  return evaluation;
}

/**
 * Evaluate thresholds for one group and send any due alerts.
 * Group spend is the raw per-group spend (unchanged behavior).
 */
async function evaluateGroupOnce(group: EnterpriseGroup): Promise<Alert[]> {
  const spend = getSpend(group.id);
  if (!spend) return [];

  const [budget] = await db
    .select()
    .from(groupBudgetsTable)
    .where(eq(groupBudgetsTable.groupId, group.id));
  if (!budget || budget.amountUsd <= 0) return [];

  const dir = await getDirectory();
  const workspaceName = dir.workspaces.get(group.workspaceId)?.name ?? null;

  return evaluateEntity({
    entityType: "group",
    entityId: group.id,
    entityName: group.name,
    spendUsd: spend.spendUsd,
    budgetUsd: budget.amountUsd,
    periodStart: spend.periodStart,
    workspaceIds: [group.workspaceId],
    workspaceName,
  });
}

export function evaluateGroup(group: EnterpriseGroup): Promise<Alert[]> {
  const key = `group|${group.id}`;
  const existing = evaluationsInFlight.get(key);
  if (existing) return existing;

  const evaluation = evaluateGroupOnce(group).finally(() => {
    if (evaluationsInFlight.get(key) === evaluation) {
      evaluationsInFlight.delete(key);
    }
  });
  evaluationsInFlight.set(key, evaluation);
  return evaluation;
}

/**
 * Build the deduped, cross-workspace team rollup for the cutoff-anchored billing
 * range, aggregating per-group attributed spend by team (groupName -> teamName)
 * exactly like the dashboard team totals. Cross-workspace overlaps are handled by
 * getDedupedUsageRollup (users attributed to their first group in stable order).
 */
async function buildTeamSpecs(): Promise<EntitySpec[]> {
  const dir = await getDirectory();

  const [teamBudgets, groupTeams] = await Promise.all([
    db.select().from(teamBudgetsTable),
    db.select().from(groupTeamsTable),
  ]);
  if (teamBudgets.length === 0) return [];

  const budgetByTeam = new Map(teamBudgets.map((tb) => [tb.teamName, tb.amountUsd]));
  const teamByGroupName = new Map(groupTeams.map((gt) => [gt.groupName, gt.teamName]));

  // Deduped rollup across ALL directory groups, including extra-workspace spend,
  // so a team spanning multiple workspaces sees exactly the dashboard total.
  const extra = getExtraWorkspaceSpend(dir, TEAM_RANGE_KEY);
  const rollup = getDedupedUsageRollup(
    dir.groups,
    TEAM_RANGE_KEY,
    extra.byUser,
    dir.groupMembers,
  );

  // Period start for team thresholds: use the shared cutoff-anchored billing
  // period (same anchor the dashboard/groups use for fired-threshold tracking).
  const period = getBillingPeriod();
  const periodStart = period.start;
  if (!periodStart) return [];

  // Aggregate attributed group spend and contributing workspaces per team.
  const spendByTeam = new Map<string, number>();
  const workspacesByTeam = new Map<string, Set<string>>();
  for (const group of dir.groups) {
    const teamName = teamByGroupName.get(group.name);
    if (!teamName) continue;
    if (!budgetByTeam.has(teamName)) continue;
    const groupSpend = rollup.byGroup.get(group.id)?.spendUsd ?? 0;
    spendByTeam.set(teamName, (spendByTeam.get(teamName) ?? 0) + groupSpend);
    let wsSet = workspacesByTeam.get(teamName);
    if (!wsSet) {
      wsSet = new Set<string>();
      workspacesByTeam.set(teamName, wsSet);
    }
    wsSet.add(group.workspaceId);
  }

  const specs: EntitySpec[] = [];
  for (const [teamName, budgetUsd] of budgetByTeam) {
    if (budgetUsd <= 0) continue;
    specs.push({
      entityType: "team",
      entityId: teamName,
      entityName: teamName,
      spendUsd: spendByTeam.get(teamName) ?? 0,
      budgetUsd,
      periodStart,
      workspaceIds: [...(workspacesByTeam.get(teamName) ?? [])].sort(),
      workspaceName: null,
    });
  }
  return specs;
}

/**
 * Poll until every group's member usage is loaded for the given range, bounded
 * by a timeout so a stuck fetch cannot hang the whole check. Extra-workspace
 * completeness is checked separately by the rollup builder, which degrades to
 * whatever has loaded rather than blocking indefinitely.
 */
async function waitForTeamData(
  groups: EnterpriseGroup[],
  rangeKey: string,
  timeoutMs = 5 * 60 * 1000,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const allLoaded = () => groups.every((g) => !!getMemberUsage(g.id, rangeKey));
  while (!allLoaded() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return allLoaded();
}

const teamChecksInFlight = new Map<string, Promise<{ checkedTeams: number; alerts: Alert[] }>>();

async function evaluateTeamsOnceInternal(): Promise<{ checkedTeams: number; alerts: Alert[] }> {
  const specs = await buildTeamSpecs();
  const alerts: Alert[] = [];
  for (const spec of specs) {
    alerts.push(...(await evaluateEntity(spec)));
  }
  return { checkedTeams: specs.length, alerts };
}

async function evaluateTeamsOnce(): Promise<{ checkedTeams: number; alerts: Alert[] }> {
  const key = TEAM_RANGE_KEY;
  const existing = teamChecksInFlight.get(key);
  if (existing) return existing;
  const evaluation = evaluateTeamsOnceInternal().finally(() => {
    if (teamChecksInFlight.get(key) === evaluation) teamChecksInFlight.delete(key);
  });
  teamChecksInFlight.set(key, evaluation);
  return evaluation;
}

/**
 * Full check: refresh spend for all budgeted groups (high priority, forced),
 * then evaluate group and team thresholds. Used by the interval job and the
 * manual endpoint.
 */
async function runCheckInternal(
  force = false,
): Promise<{ checkedGroups: number; checkedTeams: number; alerts: Alert[] }> {
  if (!isConfigured()) return { checkedGroups: 0, checkedTeams: 0, alerts: [] };

  const dir = await getDirectory();
  const [budgets, teamBudgets] = await Promise.all([
    db.select().from(groupBudgetsTable),
    db.select().from(teamBudgetsTable),
  ]);
  const budgeted = new Set(budgets.map((b) => b.groupId));
  const groups = dir.groups.filter((g) => budgeted.has(g.id));
  const teamsConfigured = teamBudgets.length > 0;
  let teamDataReady = true;
  // Team thresholds use the same period anchor as group thresholds. In a
  // team-only configuration there may be no group-budget fetch to populate
  // that anchor, so refresh one directory group's raw spend as the period
  // source without counting/evaluating it as a group pool.
  const spendRefreshGroups = [...groups];
  if (teamsConfigured && dir.groups[0] && !budgeted.has(dir.groups[0].id)) {
    spendRefreshGroups.push(dir.groups[0]);
  }

  // Queue (forced when manual) raw spend refreshes for budgeted groups plus the
  // optional team period anchor, and wait for them to land.
  await Promise.all(
    spendRefreshGroups.map(
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

  // Team pools need the deduped cross-workspace rollup, which is built from
  // per-group member usage plus extra-workspace spend across ALL directory
  // groups (so cross-workspace overlap dedups exactly like the dashboard).
  // queueMemberUsageFetch has no completion callback, so queue every group's
  // member usage and poll the caches until they land (bounded wait).
  if (teamsConfigured) {
    const range = resolveRange("billing");
    for (const g of dir.groups) queueMemberUsageFetch(g, range, force ? 0 : 1, force);
    queueExtraWorkspacesFetch(dir, range, force ? 0 : 1, force);
    const memberDataComplete = await waitForTeamData(dir.groups, range.key);
    const extraDataComplete = getExtraWorkspaceSpend(dir, range.key).isComplete;
    if (!memberDataComplete || !extraDataComplete) {
      teamDataReady = false;
      logger.warn(
        { memberDataComplete, extraDataComplete },
        "Team pool check deferred because deduplication data is incomplete",
      );
    }
  }

  const alerts: Alert[] = [];
  for (const g of groups) {
    alerts.push(...(await evaluateGroup(g)));
  }
  let checkedTeams = 0;
  if (teamsConfigured && teamDataReady) {
    const teamResult = await evaluateTeamsOnce();
    checkedTeams = teamResult.checkedTeams;
    alerts.push(...teamResult.alerts);
  }

  lastCheckAt = new Date();
  return { checkedGroups: groups.length, checkedTeams, alerts };
}

let fullCheckInFlight: Promise<{
  checkedGroups: number;
  checkedTeams: number;
  alerts: Alert[];
}> | null = null;

export function runCheck(
  force = false,
): Promise<{ checkedGroups: number; checkedTeams: number; alerts: Alert[] }> {
  if (fullCheckInFlight) return fullCheckInFlight;
  const check = runCheckInternal(force).finally(() => {
    if (fullCheckInFlight === check) fullCheckInFlight = null;
  });
  fullCheckInFlight = check;
  return check;
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
