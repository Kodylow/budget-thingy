import { eq, and, asc, inArray } from "drizzle-orm";
import { db, spendSnapshotsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  isConfigured,
  getDirectory,
  getSpend,
  queueGroupSpendFetch,
  type GroupSpend,
} from "./enterprise";

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
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

/**
 * Snapshot every group's current spend. Fresh cached values are recorded
 * directly; stale/missing ones are queued through the serial usage queue
 * (background priority) and recorded as each fetch lands.
 */
export async function snapshotAllGroups(): Promise<void> {
  if (!isConfigured()) return;
  const dir = await getDirectory();
  for (const g of dir.groups) {
    // Default range = the cutoff-anchored billing period, matching getSpend().
    const result = queueGroupSpendFetch(g, 1, false, (spend) => {
      void recordSnapshot(g.id, spend);
    });
    if (result === "fresh_cache") {
      // Cache is fresh — record the cached value now. For "queued" and
      // "duplicate_queued" the callback fires when the in-flight fetch lands,
      // so we never persist a stale value.
      const spend = getSpend(g.id);
      if (spend) void recordSnapshot(g.id, spend);
    }
  }
  logger.info({ groups: dir.groups.length }, "Daily snapshot pass queued");
}

/** Start the daily snapshot job: one pass shortly after boot, then every 24h. */
export function startSnapshotJob(): void {
  setTimeout(() => {
    void snapshotAllGroups().catch((err) =>
      logger.error({ err }, "Snapshot pass failed"),
    );
  }, 30 * 1000);
  setInterval(() => {
    void snapshotAllGroups().catch((err) =>
      logger.error({ err }, "Snapshot pass failed"),
    );
  }, SNAPSHOT_INTERVAL_MS);
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
