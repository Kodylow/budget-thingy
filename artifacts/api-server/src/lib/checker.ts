import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  groupBudgetsTable,
  teamBudgetsTable,
  groupTeamsTable,
  alertsTable,
  firedThresholdsTable,
  alertDeliveryClaimsTable,
  budgetCheckerStateTable,
  type Alert,
} from "@workspace/db";
import { logger } from "./logger";
import {
  getDirectory,
  getBillingPeriod,
  isConfigured,
  getCanonicalUsage,
  getStoredBudgetEvaluationSnapshot,
  buildCanonicalGroupMergePlan,
  resolveCanonicalMergedGroupBudget,
  resolveRange,
  type EnterpriseGroup,
} from "./enterprise";
import { sendEmail, buildAlertEmail, isEmailConfigured } from "./email";
import { resolveAlertRecipients } from "./alert-recipients";
import { getVisibleEffectiveTeamBudgetMap } from "./team-budgets";
import { withJobClaim } from "./job-claims";

export const THRESHOLDS = [50, 75, 90, 100];
export const CHECK_INTERVAL_MINUTES = 10;

type CheckerDirectory = Awaited<ReturnType<typeof getDirectory>>;

function getStrictCheckerCanonicalUsage(
  dir: CheckerDirectory,
  teamByGroupName?: ReadonlyMap<string, string>,
) {
  const rangeKey = resolveRange("billing").key;
  return getCanonicalUsage(
    dir.groups,
    rangeKey,
    new Set(dir.workspaces.keys()),
    dir.groupMembers,
    dir.members,
    teamByGroupName,
    dir.workspaces,
    false,
    true,
  );
}

export interface CheckerState {
  lastSuccessfulEvaluationAt: Date | null;
  lastEvaluatedDataAsOf: Date | null;
  lastAttemptAt: Date | null;
  lastSkipReason: string | null;
}

let checkerState: CheckerState = {
  lastSuccessfulEvaluationAt: null,
  lastEvaluatedDataAsOf: null,
  lastAttemptAt: null,
  lastSkipReason: null,
};

const evaluationsInFlight = new Map<string, Promise<Alert[]>>();
export function getLastCheckAt(): Date | null {
  return checkerState.lastSuccessfulEvaluationAt;
}

export function getCheckerState(): CheckerState {
  return { ...checkerState };
}

/**
 * A single allocated-pool entity to evaluate. Both canonical groups and cross-workspace
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
  dataAsOf: Date;
  firedThresholds?: readonly number[];
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

/** Load displayed threshold state with one set-based query. */
export async function getFiredThresholdsBatch(
  entityIds: readonly string[],
  billingPeriod: string,
  entityType: "group" | "team" = "group",
): Promise<Map<string, number[]>> {
  const uniqueIds = [...new Set(entityIds)];
  const result = new Map(uniqueIds.map((id) => [id, [] as number[]]));
  if (uniqueIds.length === 0) return result;
  const rows = await db
    .select({
      entityId: firedThresholdsTable.entityId,
      threshold: firedThresholdsTable.threshold,
    })
    .from(firedThresholdsTable)
    .where(and(
      eq(firedThresholdsTable.entityType, entityType),
      eq(firedThresholdsTable.billingPeriod, billingPeriod),
      inArray(firedThresholdsTable.entityId, uniqueIds),
    ));
  for (const row of rows) result.get(row.entityId)?.push(row.threshold);
  for (const thresholds of result.values()) thresholds.sort((a, b) => a - b);
  return result;
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
  const fired = spec.firedThresholds ??
    await getFiredThresholds(spec.entityId, spec.periodStart, spec.entityType);
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
      dataAsOf: spec.dataAsOf,
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
 * Group spend comes from the same canonical workspace-aware member rollup used
 * by dashboard group rows and team headers.
 */
async function evaluateGroupOnce(
  group: EnterpriseGroup,
  stored?: Awaited<ReturnType<typeof getStoredBudgetEvaluationSnapshot>>["snapshot"],
): Promise<Alert[]> {
  const dir = stored?.directory ?? await getDirectory();
  const mergePlan = buildCanonicalGroupMergePlan(dir.groups, dir.workspaces);
  const primaryId = mergePlan.primaryByGroupId.get(group.id) ?? group.id;
  const primary = dir.groups.find((candidate) => candidate.id === primaryId);
  if (!primary) return [];
  const budgetRows = await db.select().from(groupBudgetsTable);
  const budget = resolveCanonicalMergedGroupBudget(
    primary.id,
    mergePlan,
    new Map(budgetRows.map((row) => [row.groupId, row.amountUsd])),
  );
  if (!budget || budget.amountUsd <= 0) return [];

  const canonical = stored
    ? getCanonicalUsage(
        dir.groups, stored.rangeKey, new Set(dir.workspaces.keys()),
        dir.groupMembers, dir.members, undefined, dir.workspaces, false, true,
      )
    : getStrictCheckerCanonicalUsage(dir);
  if (!canonical.isComplete) return [];
  const workspaceName = dir.workspaces.get(primary.workspaceId)?.name ?? null;
  const periodStart = getBillingPeriod().start;
  if (!periodStart) return [];

  return evaluateEntity({
    entityType: "group",
    entityId: primary.id,
    entityName: primary.name,
    spendUsd: canonical.spendByPrimaryGroup.get(primary.id) ?? 0,
    budgetUsd: budget.amountUsd,
    periodStart,
    workspaceIds: [
      ...new Set(
        (mergePlan.mergeMap.get(primary.id) ?? [primary.id])
          .map((id) => dir.groups.find((candidate) => candidate.id === id)?.workspaceId)
          .filter((id): id is string => !!id),
      ),
    ].sort(),
    workspaceName,
    dataAsOf: stored?.dataAsOf ?? new Date(),
  });
}

export function evaluateGroup(
  group: EnterpriseGroup,
  stored?: Awaited<ReturnType<typeof getStoredBudgetEvaluationSnapshot>>["snapshot"],
): Promise<Alert[]> {
  const key = `group|${group.id}`;
  const existing = evaluationsInFlight.get(key);
  if (existing) return existing;

  const evaluation = evaluateGroupOnce(group, stored).finally(() => {
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
async function buildTeamSpecs(
  stored?: NonNullable<Awaited<ReturnType<typeof getStoredBudgetEvaluationSnapshot>>["snapshot"]>,
  prepared?: {
    allTeamBudgetRows: Array<typeof teamBudgetsTable.$inferSelect>;
    budgetByTeam: ReadonlyMap<string, number>;
    groupTeams: Array<{ groupName: string; teamName: string }>;
    canonical: ReturnType<typeof getCanonicalUsage>;
    firedByEntity?: ReadonlyMap<string, readonly number[]>;
  },
): Promise<EntitySpec[]> {
  const dir = stored?.directory ?? await getDirectory();

  const [allCheckerTeamBudgetRows, budgetByTeam, groupTeams] = prepared
    ? [prepared.allTeamBudgetRows, prepared.budgetByTeam, prepared.groupTeams]
    : await Promise.all([
        db.select().from(teamBudgetsTable),
        getVisibleEffectiveTeamBudgetMap(),
        db.select().from(groupTeamsTable),
      ]);
  const teamBudgets = allCheckerTeamBudgetRows.filter((tb) => !tb.isHidden);
  if (teamBudgets.length === 0) return [];

  const hiddenCheckerTeamNames = new Set(allCheckerTeamBudgetRows.filter((tb) => tb.isHidden).map((tb) => tb.teamName));
  const teamByGroupName = new Map(
    groupTeams
      .filter((gt) => !hiddenCheckerTeamNames.has(gt.teamName))
      .map((gt) => [gt.groupName, gt.teamName]),
  );

  // Deduped rollup across ALL directory groups, including extra-workspace spend,
  // so a team spanning multiple workspaces sees exactly the dashboard total.
  const rollup = prepared?.canonical ?? (stored
    ? getCanonicalUsage(
        dir.groups, stored.rangeKey, new Set(dir.workspaces.keys()),
        dir.groupMembers, dir.members, teamByGroupName, dir.workspaces, false, true,
      )
    : getStrictCheckerCanonicalUsage(dir, teamByGroupName));
  if (!rollup.isComplete) return [];

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
    spendByTeam.set(teamName, rollup.byTeam.get(teamName) ?? 0);
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
      dataAsOf: stored?.dataAsOf ?? new Date(),
      firedThresholds: prepared?.firedByEntity?.get(`team|${teamName}`),
    });
  }
  return specs;
}

const teamChecksInFlight = new Map<string, Promise<{ checkedTeams: number; alerts: Alert[] }>>();

async function evaluateTeamsOnceInternal(
  stored?: NonNullable<Awaited<ReturnType<typeof getStoredBudgetEvaluationSnapshot>>["snapshot"]>,
  prepared?: Parameters<typeof buildTeamSpecs>[1],
): Promise<{ checkedTeams: number; alerts: Alert[] }> {
  const specs = await buildTeamSpecs(stored, prepared);
  const alerts: Alert[] = [];
  for (const spec of specs) {
    alerts.push(...(await evaluateEntity(spec)));
  }
  return { checkedTeams: specs.length, alerts };
}

async function evaluateTeamsOnce(
  stored?: NonNullable<Awaited<ReturnType<typeof getStoredBudgetEvaluationSnapshot>>["snapshot"]>,
  prepared?: Parameters<typeof buildTeamSpecs>[1],
): Promise<{ checkedTeams: number; alerts: Alert[] }> {
  const key = stored?.rangeKey ?? resolveRange("billing").key;
  const existing = teamChecksInFlight.get(key);
  if (existing) return existing;
  const evaluation = evaluateTeamsOnceInternal(stored, prepared).finally(() => {
    if (teamChecksInFlight.get(key) === evaluation) teamChecksInFlight.delete(key);
  });
  teamChecksInFlight.set(key, evaluation);
  return evaluation;
}

/** Evaluate group and team thresholds from one database-only daily-fact snapshot. */
export interface CheckResult {
  checkedGroups: number;
  checkedTeams: number;
  alerts: Alert[];
  evaluatedAt: Date | null;
  dataAsOf: Date | null;
  skipped: boolean;
  skipReason: string | null;
}

async function persistSuccessfulCheckerState(next: CheckerState): Promise<void> {
  const [stored] = await db.insert(budgetCheckerStateTable).values({ id: "singleton", ...next })
    .onConflictDoUpdate({
      target: budgetCheckerStateTable.id,
      set: next,
    }).returning();
  checkerState = stored ? {
    lastSuccessfulEvaluationAt: stored.lastSuccessfulEvaluationAt,
    lastEvaluatedDataAsOf: stored.lastEvaluatedDataAsOf,
    lastAttemptAt: stored.lastAttemptAt,
    lastSkipReason: stored.lastSkipReason,
  } : next;
}

async function persistSkippedCheckerState(
  lastAttemptAt: Date,
  lastSkipReason: string,
): Promise<void> {
  const [stored] = await db.insert(budgetCheckerStateTable).values({
    id: "singleton",
    lastAttemptAt,
    lastSkipReason,
  }).onConflictDoUpdate({
    target: budgetCheckerStateTable.id,
    // Deliberately leave successful fields untouched, including when an
    // immediate post-restart request races the async in-memory hydration.
    set: { lastAttemptAt, lastSkipReason },
  }).returning();
  if (stored) {
    checkerState = {
      lastSuccessfulEvaluationAt: stored.lastSuccessfulEvaluationAt,
      lastEvaluatedDataAsOf: stored.lastEvaluatedDataAsOf,
      lastAttemptAt: stored.lastAttemptAt,
      lastSkipReason: stored.lastSkipReason,
    };
  }
}

async function runCheckInternal(): Promise<CheckResult> {
  const lastAttemptAt = new Date();
  if (!isConfigured()) {
    const skipReason = "Enterprise API is not configured";
    await persistSkippedCheckerState(lastAttemptAt, skipReason);
    return { checkedGroups: 0, checkedTeams: 0, alerts: [], evaluatedAt: null, dataAsOf: null, skipped: true, skipReason };
  }

  const stored = await getStoredBudgetEvaluationSnapshot();
  if (!stored.snapshot) {
    await persistSkippedCheckerState(lastAttemptAt, stored.skipReason);
    return { checkedGroups: 0, checkedTeams: 0, alerts: [], evaluatedAt: null, dataAsOf: null, skipped: true, skipReason: stored.skipReason };
  }
  const dir = stored.snapshot.directory;
  const [budgets, effectiveTeamBudgetMap, allRunTeamBudgetRows, groupTeams] = await Promise.all([
    db.select().from(groupBudgetsTable),
    getVisibleEffectiveTeamBudgetMap(),
    db.select().from(teamBudgetsTable),
    db.select().from(groupTeamsTable),
  ]);
  const budgetByGroupId = new Map(budgets.map((row) => [row.groupId, row.amountUsd]));
  const mergePlan = buildCanonicalGroupMergePlan(dir.groups, dir.workspaces);
  const groups = dir.groups.filter(
    (group) =>
      !mergePlan.hiddenGroupIds.has(group.id) &&
      !!resolveCanonicalMergedGroupBudget(
        group.id,
        mergePlan,
        budgetByGroupId,
      ),
  );
  const teamsConfigured = effectiveTeamBudgetMap.size > 0;
  const hiddenRunTeamNames = new Set(allRunTeamBudgetRows.filter((row) => row.isHidden).map((row) => row.teamName));
  const teamByGroupName = new Map(
    groupTeams
      .filter((row) => !hiddenRunTeamNames.has(row.teamName))
      .map((row) => [row.groupName, row.teamName]),
  );
  const canonical = getCanonicalUsage(
    dir.groups, stored.snapshot.rangeKey, new Set(dir.workspaces.keys()),
    dir.groupMembers, dir.members, teamByGroupName, dir.workspaces, false, true,
  );
  if (!canonical.isComplete) {
    const skipReason = "Stored canonical usage is incomplete";
    await persistSkippedCheckerState(lastAttemptAt, skipReason);
    return { checkedGroups: 0, checkedTeams: 0, alerts: [], evaluatedAt: null, dataAsOf: null, skipped: true, skipReason };
  }

  const periodStart = getBillingPeriod().start;
  if (!periodStart) {
    const skipReason = "Billing period is unavailable";
    await persistSkippedCheckerState(lastAttemptAt, skipReason);
    return { checkedGroups: 0, checkedTeams: 0, alerts: [], evaluatedAt: null, dataAsOf: null, skipped: true, skipReason };
  }
  const firedRows = await db.select().from(firedThresholdsTable)
    .where(eq(firedThresholdsTable.billingPeriod, periodStart));
  const firedByEntity = new Map<string, number[]>();
  for (const row of firedRows) {
    const key = `${row.entityType}|${row.entityId}`;
    const thresholds = firedByEntity.get(key) ?? [];
    thresholds.push(row.threshold);
    firedByEntity.set(key, thresholds);
  }

  const alerts: Alert[] = [];
  for (const group of groups) {
    const budget = resolveCanonicalMergedGroupBudget(group.id, mergePlan, budgetByGroupId);
    if (!budget || budget.amountUsd <= 0) continue;
    alerts.push(...(await evaluateEntity({
      entityType: "group",
      entityId: group.id,
      entityName: group.name,
      spendUsd: canonical.spendByPrimaryGroup.get(group.id) ?? 0,
      budgetUsd: budget.amountUsd,
      periodStart,
      workspaceIds: [
        ...new Set(
          (mergePlan.mergeMap.get(group.id) ?? [group.id])
            .map((id) => dir.groups.find((candidate) => candidate.id === id)?.workspaceId)
            .filter((id): id is string => !!id),
        ),
      ].sort(),
      workspaceName: dir.workspaces.get(group.workspaceId)?.name ?? null,
      dataAsOf: stored.snapshot.dataAsOf,
      firedThresholds: firedByEntity.get(`group|${group.id}`) ?? [],
    })));
  }
  let checkedTeams = 0;
  if (teamsConfigured) {
    const teamResult = await evaluateTeamsOnce(stored.snapshot, {
      allTeamBudgetRows: allRunTeamBudgetRows,
      budgetByTeam: effectiveTeamBudgetMap,
      groupTeams,
      canonical,
      firedByEntity,
    });
    checkedTeams = teamResult.checkedTeams;
    alerts.push(...teamResult.alerts);
  }

  const evaluatedAt = new Date();
  await persistSuccessfulCheckerState({
    lastSuccessfulEvaluationAt: evaluatedAt,
    lastEvaluatedDataAsOf: stored.snapshot.dataAsOf,
    lastAttemptAt,
    lastSkipReason: null,
  });
  return { checkedGroups: groups.length, checkedTeams, alerts, evaluatedAt, dataAsOf: stored.snapshot.dataAsOf, skipped: false, skipReason: null };
}

let fullCheckInFlight: Promise<CheckResult> | null = null;

export function runCheck(
  _force = false,
): Promise<CheckResult> {
  if (fullCheckInFlight) return fullCheckInFlight;
  const check = runCheckInternal().finally(() => {
    if (fullCheckInFlight === check) fullCheckInFlight = null;
  });
  fullCheckInFlight = check;
  return check;
}

export function startChecker(): void {
  if (!isConfigured()) {
    logger.warn("Enterprise API key missing; background checker idle");
  }
  // Hydrate database-only diagnostics. Usage ingestion is owned exclusively by
  // the fixed coordinator, never by a replica startup or dashboard request.
  void (async () => {
    try {
      const storedState = await db.query.budgetCheckerStateTable.findFirst({
        where: eq(budgetCheckerStateTable.id, "singleton"),
      });
      if (storedState) {
        checkerState = {
          lastSuccessfulEvaluationAt: storedState.lastSuccessfulEvaluationAt,
          lastEvaluatedDataAsOf: storedState.lastEvaluatedDataAsOf,
          lastAttemptAt: storedState.lastAttemptAt,
          lastSkipReason: storedState.lastSkipReason,
        };
      }
    } catch (err) {
      logger.error({ err }, "Checker state hydration failed");
    }
  })();

  setInterval(
    () => {
      void withJobClaim(
        "budget:threshold-check",
        CHECK_INTERVAL_MINUTES * 60 * 1000,
        5 * 60 * 1000,
        async (claim) => {
          claim.signal?.throwIfAborted();
          const result = await runCheck();
          claim.signal?.throwIfAborted();
          return result;
        },
      ).catch((err) => logger.error({ err }, "Scheduled check failed"));
    },
    CHECK_INTERVAL_MINUTES * 60 * 1000,
  );
}
