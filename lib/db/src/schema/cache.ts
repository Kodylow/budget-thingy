import { pgTable, text, doublePrecision, timestamp, jsonb, primaryKey } from "drizzle-orm/pg-core";

// One row — stores the full serialised directory as JSON + when it was fetched.
export const apiDirectoryCacheTable = pgTable("api_directory_cache", {
  id: text("id").primaryKey().default("singleton"),
  directoryJson: jsonb("directory_json").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export type ApiDirectoryCache = typeof apiDirectoryCacheTable.$inferSelect;

// One row per (range_key, group_id) — stores the spend value + when it was fetched.
export const apiSpendCacheTable = pgTable(
  "api_spend_cache",
  {
    rangeKey: text("range_key").notNull(),
    groupId: text("group_id").notNull(),
    spendUsd: doublePrecision("spend_usd").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.rangeKey, t.groupId] })],
);

export type ApiSpendCache = typeof apiSpendCacheTable.$inferSelect;
