import {
  pgTable,
  serial,
  text,
  doublePrecision,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
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

/**
 * Immutable membership observed for one custom group on one UTC day. User IDs
 * are stable Enterprise identifiers; display names and emails are deliberately
 * excluded because they can change or disappear.
 */
export const groupRosterSnapshotsTable = pgTable(
  "group_roster_snapshots",
  {
    groupId: text("group_id").notNull(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
    userIds: jsonb("user_ids").$type<string[]>().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.snapshotDate] }),
    index("group_roster_snapshots_day_idx").on(t.snapshotDate),
  ],
);

/**
 * Completeness marker written in the same transaction as a day's roster rows.
 * A group without a row on a completed day did not exist in that captured
 * directory; without this marker, absence would be indistinguishable from a
 * partially failed snapshot pass.
 */
export const groupRosterSnapshotDaysTable = pgTable(
  "group_roster_snapshot_days",
  {
    snapshotDate: date("snapshot_date", { mode: "string" }).primaryKey(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type GroupRosterSnapshot = typeof groupRosterSnapshotsTable.$inferSelect;
export type InsertGroupRosterSnapshot = typeof groupRosterSnapshotsTable.$inferInsert;
export type GroupRosterSnapshotDay = typeof groupRosterSnapshotDaysTable.$inferSelect;
