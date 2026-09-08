import { and, eq } from "drizzle-orm";
import {
  configurationRevisionTable,
  db,
  groupPlanAuditsTable,
  groupPlansTable,
} from "@workspace/db";

const DAY_MS = 86_400_000;

export interface FundingEnvelope {
  status: "available" | "not_started" | "expired" | "missing_funding" |
    "missing_history" | "exhausted";
  amountUsdCents: number | null;
  reason: string;
  openingRemainingUsdCents: number | null;
  currentMonthWeight: number | null;
  remainingMonthWeight: number | null;
}

function utcMonthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function nextUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}

function monthWeight(startMs: number, endMs: number): number {
  const month = new Date(startMs);
  const monthDays = (
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) -
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)
  ) / DAY_MS;
  return (endMs - startMs) / DAY_MS / monthDays;
}

export function remainingFundingMonthWeights(input: {
  now: Date;
  periodStart: string;
  periodEndExclusive: string;
}): { current: number; total: number } | null {
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEndExclusive);
  const currentMonth = utcMonthStart(input.now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      currentMonth >= end || input.now.getTime() < start) return null;
  let cursor = Math.max(start, currentMonth);
  let total = 0;
  let current = 0;
  while (cursor < end) {
    const monthEnd = Math.min(nextUtcMonth(new Date(cursor)).getTime(), end);
    const weight = monthWeight(cursor, monthEnd);
    if (current === 0) current = weight;
    total += weight;
    cursor = monthEnd;
  }
  return { current, total };
}

export function calculateFundingEnvelope(input: {
  now: Date;
  periodStart: string;
  periodEndExclusive: string;
  allocationUsdCents: number | null;
  priorSpendUsdCents: number | null;
}): FundingEnvelope {
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEndExclusive);
  if (input.now.getTime() < start) {
    return {
      status: "not_started", amountUsdCents: null,
      reason: "The fixed funding term has not started.", openingRemainingUsdCents: null,
      currentMonthWeight: null, remainingMonthWeight: null,
    };
  }
  if (input.now.getTime() >= end) {
    return {
      status: "expired", amountUsdCents: null,
      reason: "The fixed funding term has ended.", openingRemainingUsdCents: null,
      currentMonthWeight: null, remainingMonthWeight: null,
    };
  }
  if (input.allocationUsdCents === null) {
    return {
      status: "missing_funding", amountUsdCents: null,
      reason: "Approved funding is unavailable.", openingRemainingUsdCents: null,
      currentMonthWeight: null, remainingMonthWeight: null,
    };
  }
  if (input.priorSpendUsdCents === null) {
    return {
      status: "missing_history", amountUsdCents: null,
      reason: "Complete canonical spend before this planning month is unavailable.",
      openingRemainingUsdCents: null, currentMonthWeight: null, remainingMonthWeight: null,
    };
  }
  const weights = remainingFundingMonthWeights(input);
  if (!weights) {
    return {
      status: "missing_history", amountUsdCents: null,
      reason: "Funding month weights are unavailable.", openingRemainingUsdCents: null,
      currentMonthWeight: null, remainingMonthWeight: null,
    };
  }
  const opening = Math.max(0, input.allocationUsdCents - input.priorSpendUsdCents);
  const exhausted = opening === 0;
  return {
    status: exhausted ? "exhausted" : "available",
    amountUsdCents: exhausted
      ? 0
      : Math.round(opening * weights.current / weights.total),
    reason: exhausted
      ? "Approved funding is exhausted; the local planning recommendation is zero."
      : "Opening remaining funds are weighted across the fixed term's remaining months.",
    openingRemainingUsdCents: opening,
    currentMonthWeight: weights.current,
    remainingMonthWeight: weights.total,
  };
}

/** Largest-remainder allocation with stable identity tie-breaking. */
export function allocateCentsByWeight(
  totalCents: number,
  weights: readonly { id: string; weight: number }[],
): Map<string, number> {
  const positive = weights.filter((item) => item.weight > 0);
  const denominator = positive.reduce((sum, item) => sum + item.weight, 0);
  const result = new Map(weights.map((item) => [item.id, 0]));
  if (totalCents <= 0 || denominator <= 0) return result;
  const parts = positive.map((item) => {
    const exact = totalCents * item.weight / denominator;
    const floor = Math.floor(exact);
    return { ...item, floor, remainder: exact - floor };
  });
  let left = totalCents - parts.reduce((sum, item) => sum + item.floor, 0);
  parts.sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  for (const part of parts) {
    result.set(part.id, part.floor + (left-- > 0 ? 1 : 0));
  }
  return result;
}

export function overlappingRosterWeights(
  groups: readonly { id: string; workspaceId: string; eligibleUserIds: readonly string[] }[],
): Map<string, number> {
  const memberships = new Map<string, string[]>();
  for (const group of groups) {
    for (const userId of new Set(group.eligibleUserIds)) {
      const key = `${group.workspaceId}\0${userId}`;
      const groupIds = memberships.get(key) ?? [];
      groupIds.push(group.id);
      memberships.set(key, groupIds);
    }
  }
  const result = new Map(groups.map((group) => [group.id, 0]));
  for (const groupIds of memberships.values()) {
    const share = 1 / groupIds.length;
    for (const groupId of groupIds) {
      result.set(groupId, (result.get(groupId) ?? 0) + share);
    }
  }
  return result;
}

export type SaveGroupPlanResult =
  | { status: "ok"; plan: typeof groupPlansTable.$inferSelect }
  | { status: "conflict" };

export async function saveGroupPlan(input: {
  workspaceId: string;
  groupId: string;
  teamName: string;
  fundingPeriodStart: string;
  fundingPeriodEnd: string;
  expectedConfigurationRevision: string;
  mappingIdentity: string;
  expectedPlanRevision: number | null;
  amountUsdCents: number;
  actorUserId: string;
}): Promise<SaveGroupPlanResult> {
  return db.transaction(async (tx) => {
    const [clock] = await tx.select({ revision: configurationRevisionTable.revision })
      .from(configurationRevisionTable).for("update");
    if (clock?.revision.toString() !== input.expectedConfigurationRevision) {
      return { status: "conflict" as const };
    }
    const [current] = await tx.select().from(groupPlansTable).where(and(
      eq(groupPlansTable.workspaceId, input.workspaceId),
      eq(groupPlansTable.groupId, input.groupId),
    )).for("update");
    const sameIdentity = current?.teamName === input.teamName &&
      current.fundingPeriodStart === input.fundingPeriodStart &&
      current.fundingPeriodEnd === input.fundingPeriodEnd &&
      current.mappingIdentity === input.mappingIdentity;
    if (
      (sameIdentity && current!.revision !== input.expectedPlanRevision) ||
      (!current && input.expectedPlanRevision !== null) ||
      (!sameIdentity && input.expectedPlanRevision !== null &&
        current?.revision !== input.expectedPlanRevision)
    ) return { status: "conflict" as const };

    const nextRevision = (current?.revision ?? 0) + 1;
    const values = {
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      teamName: input.teamName,
      fundingPeriodStart: input.fundingPeriodStart,
      fundingPeriodEnd: input.fundingPeriodEnd,
      mappingIdentity: input.mappingIdentity,
      amountUsdCents: input.amountUsdCents,
      revision: nextRevision,
      updatedBy: input.actorUserId,
      updatedAt: new Date(),
    };
    const [plan] = await tx.insert(groupPlansTable).values(values)
      .onConflictDoUpdate({
        target: [groupPlansTable.workspaceId, groupPlansTable.groupId],
        set: values,
      }).returning();
    await tx.insert(groupPlanAuditsTable).values({
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      teamName: input.teamName,
      fundingPeriodStart: input.fundingPeriodStart,
      fundingPeriodEnd: input.fundingPeriodEnd,
      mappingIdentity: input.mappingIdentity,
      previousAmountUsdCents: current?.amountUsdCents ?? null,
      newAmountUsdCents: input.amountUsdCents,
      previousRevision: current?.revision ?? null,
      newRevision: nextRevision,
      actorUserId: input.actorUserId,
    });
    return { status: "ok" as const, plan: plan! };
  });
}