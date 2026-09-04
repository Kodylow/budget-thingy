import { eq, and, asc, inArray, gte, lte, sql } from "drizzle-orm";
import {
  db,
  spendSnapshotsTable,
  groupRosterSnapshotsTable,
  groupRosterSnapshotDaysTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  type GroupSpend,
  type EnterpriseGroup,
} from "./enterprise";

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface RosterSnapshotRow {
  groupId: string;
  snapshotDate: string;
  workspaceId: string;
  userIds: string[];
}

export interface RosterSnapshotStore {
  capture(snapshotDate: string, rows: RosterSnapshotRow[]): Promise<boolean>;
}

export async function hasDailyRosterSnapshot(now = Date.now()): Promise<boolean> {
  const [existing] = await db
    .select({ snapshotDate: groupRosterSnapshotDaysTable.snapshotDate })
    .from(groupRosterSnapshotDaysTable)
    .where(eq(groupRosterSnapshotDaysTable.snapshotDate, utcDay(now)))
    .limit(1);
  return !!existing;
}

const databaseRosterStore: RosterSnapshotStore = {
  async capture(snapshotDate, rows) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"group-roster:" + snapshotDate}))`,
      );
      const [existing] = await tx
        .select({ snapshotDate: groupRosterSnapshotDaysTable.snapshotDate })
        .from(groupRosterSnapshotDaysTable)
        .where(eq(groupRosterSnapshotDaysTable.snapshotDate, snapshotDate))
        .limit(1);
      if (existing) return false;
      if (rows.length > 0) {
        await tx.insert(groupRosterSnapshotsTable).values(rows);
      }
      await tx.insert(groupRosterSnapshotDaysTable).values({ snapshotDate });
      return true;
    });
  },
};

export function buildRosterSnapshotRows(
  groups: readonly EnterpriseGroup[],
  groupMembers: ReadonlyMap<string, readonly string[]>,
  snapshotDate: string,
): RosterSnapshotRow[] {
  return groups
    .map((group) => ({
      groupId: group.id,
      snapshotDate,
      workspaceId: group.workspaceId,
      userIds: [...new Set(groupMembers.get(group.id) ?? [])].sort(),
    }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
}

/** Capture the current directory once for this UTC day. The first complete
 * transaction wins, so retries, restarts, and duplicate schedulers are safe. */
export async function recordDailyRosters(
  groups: readonly EnterpriseGroup[],
  groupMembers: ReadonlyMap<string, readonly string[]>,
  now = Date.now(),
  store: RosterSnapshotStore = databaseRosterStore,
): Promise<boolean> {
  const snapshotDate = utcDay(now);
  const captured = await store.capture(
    snapshotDate,
    buildRosterSnapshotRows(groups, groupMembers, snapshotDate),
  );
  if (captured) {
    logger.info({ groups: groups.length, snapshotDate }, "Daily group roster captured");
  }
  return captured;
}

/** Upsert today's snapshot for one group. */
export async function recordSnapshot(
  groupId: string,
  spend: GroupSpend,
): Promise<void> {
  const snapshotDate = utcDay(spend.fetchedAt);
  try {
    await db
      .insert(spendSnapshotsTable)
      .values({
        groupId,
        snapshotDate,
        billingPeriod: spend.periodStart,
        spendUsd: spend.spendUsd,
      })
      .onConflictDoUpdate({
        target: [spendSnapshotsTable.groupId, spendSnapshotsTable.snapshotDate],
        set: {
          spendUsd: spend.spendUsd,
          billingPeriod: spend.periodStart,
          capturedAt: new Date(),
        },
      });
  } catch (err) {
    logger.error({ err, groupId }, "Failed to record spend snapshot");
  }
}

export interface RosterHistory {
  completedDays: Set<string>;
  membersByDate: Map<string, Map<string, string[]>>;
}

export async function getRosterHistory(
  groupIds: string[],
  startDate: string,
  endDate: string,
): Promise<RosterHistory> {
  const [days, rows] = await Promise.all([
    db
      .select({ snapshotDate: groupRosterSnapshotDaysTable.snapshotDate })
      .from(groupRosterSnapshotDaysTable)
      .where(and(
        gte(groupRosterSnapshotDaysTable.snapshotDate, startDate),
        lte(groupRosterSnapshotDaysTable.snapshotDate, endDate),
      )),
    groupIds.length === 0
      ? Promise.resolve([])
      : db
        .select({
          groupId: groupRosterSnapshotsTable.groupId,
          snapshotDate: groupRosterSnapshotsTable.snapshotDate,
          userIds: groupRosterSnapshotsTable.userIds,
        })
        .from(groupRosterSnapshotsTable)
        .where(and(
          inArray(groupRosterSnapshotsTable.groupId, groupIds),
          gte(groupRosterSnapshotsTable.snapshotDate, startDate),
          lte(groupRosterSnapshotsTable.snapshotDate, endDate),
        )),
  ]);
  const membersByDate = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const byGroup = membersByDate.get(row.snapshotDate) ?? new Map<string, string[]>();
    byGroup.set(row.groupId, row.userIds);
    membersByDate.set(row.snapshotDate, byGroup);
  }
  return {
    completedDays: new Set(days.map((row) => row.snapshotDate)),
    membersByDate,
  };
}

export interface SpendPoint {
  date: string;
  spendUsd: number;
}

/** History for many groups in one query, limited to one billing period. */
export async function getHistoryForGroups(
  groupIds: string[],
  billingPeriod: string,
): Promise<Map<string, SpendPoint[]>> {
  const out = new Map<string, SpendPoint[]>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({
      groupId: spendSnapshotsTable.groupId,
      date: spendSnapshotsTable.snapshotDate,
      spendUsd: spendSnapshotsTable.spendUsd,
    })
    .from(spendSnapshotsTable)
    .where(
      and(
        inArray(spendSnapshotsTable.groupId, groupIds),
        eq(spendSnapshotsTable.billingPeriod, billingPeriod),
      ),
    )
    .orderBy(asc(spendSnapshotsTable.snapshotDate));
  for (const r of rows) {
    const list = out.get(r.groupId) ?? [];
    list.push({ date: r.date, spendUsd: r.spendUsd });
    out.set(r.groupId, list);
  }
  return out;
}

/**
 * Linear projection of end-of-period spend based on elapsed fraction of the
 * billing period. Returns null too early in the period to be meaningful.
 */
export function projectEndOfPeriod(
  spendUsd: number,
  periodStart: string,
  periodEnd: string,
  now = Date.now(),
): number | null {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const elapsed = Math.min(now, end) - start;
  const fraction = elapsed / (end - start);
  if (fraction < 0.03) return null; // < ~1 day into a month: too noisy
  return spendUsd / fraction;
}
