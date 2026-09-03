import {
  boolean,
  date,
  doublePrecision,
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

/**
 * Canonical attribution for one reporting month. `userKey` is a real user ID
 * for member rows and the stable `residual` sentinel for the group's
 * unattributed remainder. This avoids nullable primary-key semantics and makes
 * group totals and user drill-downs equally indexable.
 */
export const canonicalMonthlyGroupUserRollupsTable = pgTable(
  "canonical_monthly_group_user_rollups",
  {
    monthStart: date("month_start", { mode: "string" }).notNull(),
    groupId: text("group_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userKey: text("user_key").notNull(),
    aiSpendUsd: doublePrecision("ai_spend_usd").notNull().default(0),
    nonAiSpendUsd: doublePrecision("non_ai_spend_usd").notNull().default(0),
    residualSpendUsd: doublePrecision("residual_spend_usd").notNull().default(0),
    authoritativeSpendUsd: doublePrecision("authoritative_spend_usd").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.monthStart, t.groupId, t.userKey] }),
    index("canonical_monthly_rollups_group_idx").on(t.groupId, t.monthStart),
    index("canonical_monthly_rollups_user_idx").on(t.userKey, t.monthStart),
    index("canonical_monthly_rollups_workspace_idx").on(t.workspaceId, t.monthStart),
  ],
);

/** Commit marker and attribution-input identity for a complete month rebuild. */
export const canonicalMonthlyRollupStateTable = pgTable(
  "canonical_monthly_rollup_state",
  {
    monthStart: date("month_start", { mode: "string" }).primaryKey(),
    rangeStart: timestamp("range_start", { withTimezone: true }).notNull(),
    rangeEnd: timestamp("range_end", { withTimezone: true }).notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    status: text("status").notNull().default("success"),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("canonical_monthly_rollup_state_status_idx").on(t.status, t.monthStart),
  ],
);

export type CanonicalMonthlyGroupUserRollup =
  typeof canonicalMonthlyGroupUserRollupsTable.$inferSelect;
export type CanonicalMonthlyRollupState =
  typeof canonicalMonthlyRollupStateTable.$inferSelect;