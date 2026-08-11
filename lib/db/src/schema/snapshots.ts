import {
  pgTable,
  serial,
  text,
  doublePrecision,
  timestamp,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Daily per-group spend snapshots. One row per (group, UTC day); the daily
 * snapshot job upserts so re-runs within a day just refresh the value.
 */
export const spendSnapshotsTable = pgTable(
  "spend_snapshots",
  {
    id: serial("id").primaryKey(),
    groupId: text("group_id").notNull(),
    snapshotDate: date("snapshot_date").notNull(),
    // Billing-period key: the resolved interval.startTime from the usage API.
    billingPeriod: text("billing_period").notNull(),
    spendUsd: doublePrecision("spend_usd").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("spend_snapshots_group_day_idx").on(t.groupId, t.snapshotDate),
    index("spend_snapshots_group_period_idx").on(t.groupId, t.billingPeriod),
  ],
);

export type SpendSnapshot = typeof spendSnapshotsTable.$inferSelect;
export type InsertSpendSnapshot = typeof spendSnapshotsTable.$inferInsert;
