import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * One immutable identity per UTC day and stable Enterprise API scope.
 * Payloads intentionally retain the API response shape so all existing
 * attribution code can consume fact-backed ranges without a second model.
 */
export const usageDailyFactsTable = pgTable(
  "usage_daily_facts",
  {
    mode: text("mode").notNull(),
    scopeKey: text("scope_key").notNull(),
    usageDate: date("usage_date", { mode: "string" }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    source: text("source").notNull().default("enterprise_api"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mode, t.scopeKey, t.usageDate] }),
    index("usage_daily_facts_range_idx").on(t.usageDate, t.mode, t.scopeKey),
    index("usage_daily_facts_scope_idx").on(t.mode, t.scopeKey, t.usageDate),
  ],
);

/** Month-level completion state. Closed months are never refreshed. */
export const usageFactMonthsTable = pgTable(
  "usage_fact_months",
  {
    mode: text("mode").notNull(),
    scopeKey: text("scope_key").notNull(),
    monthStart: date("month_start", { mode: "string" }).notNull(),
    isClosed: boolean("is_closed").notNull().default(false),
    status: text("status").notNull().default("success"),
    errorMessage: text("error_message"),
    syncedThrough: timestamp("synced_through", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mode, t.scopeKey, t.monthStart] }),
    index("usage_fact_months_open_idx").on(t.isClosed, t.monthStart),
  ],
);

export type UsageDailyFact = typeof usageDailyFactsTable.$inferSelect;
export type UsageFactMonth = typeof usageFactMonthsTable.$inferSelect;