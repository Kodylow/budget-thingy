import { pgTable, text, doublePrecision, timestamp, jsonb, primaryKey, boolean, index } from "drizzle-orm/pg-core";

// One row — stores the full serialised directory as JSON + when it was fetched.
export const apiDirectoryCacheTable = pgTable("api_directory_cache", {
  id: text("id").primaryKey().default("singleton"),
  directoryJson: jsonb("directory_json").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export type ApiDirectoryCache = typeof apiDirectoryCacheTable.$inferSelect;

/** Last successfully resolved Enterprise billingPeriod=current interval. */
export const apiBillingPeriodCacheTable = pgTable("api_billing_period_cache", {
  id: text("id").primaryKey().default("current"),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export type ApiBillingPeriodCache = typeof apiBillingPeriodCacheTable.$inferSelect;

/** Last account-wide exact-range verification of the durable usage aggregate. */
export const apiAccountTotalVerificationTable = pgTable("api_account_total_verification", {
  id: text("id").primaryKey().default("singleton"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  outcome: text("outcome").notNull(),
  errorMessage: text("error_message"),
  rangeKey: text("range_key").notNull(),
  rangeStart: timestamp("range_start", { withTimezone: true }).notNull(),
  rangeEnd: timestamp("range_end", { withTimezone: true }).notNull(),
  upstreamTotalUsd: doublePrecision("upstream_total_usd"),
  storedTotalUsd: doublePrecision("stored_total_usd"),
  deltaUsd: doublePrecision("delta_usd"),
});

export type ApiAccountTotalVerification =
  typeof apiAccountTotalVerificationTable.$inferSelect;

/** Durable status for the database-only allocated-pool checker. */
export const budgetCheckerStateTable = pgTable("budget_checker_state", {
  id: text("id").primaryKey().default("singleton"),
  lastSuccessfulEvaluationAt: timestamp("last_successful_evaluation_at", { withTimezone: true }),
  lastEvaluatedDataAsOf: timestamp("last_evaluated_data_as_of", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSkipReason: text("last_skip_reason"),
});

export type BudgetCheckerState = typeof budgetCheckerStateTable.$inferSelect;

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

/**
 * Durable, successfully committed pieces of a /usage synchronization.
 *
 * `scopeKey` is an opaque stable API scope (workspace/group IDs, never names).
 * `payloadJson` contains the aggregate returned for exactly [chunkStart, chunkEnd).
 * A synchronization replaces all mutable chunks in one transaction, so retries
 * and reconciliation overlap cannot double count.
 */
export const usageSyncChunksTable = pgTable(
  "usage_sync_chunks",
  {
    mode: text("mode").notNull(),
    rangeKey: text("range_key").notNull(),
    scopeKey: text("scope_key").notNull(),
    chunkStart: timestamp("chunk_start", { withTimezone: true }).notNull(),
    chunkEnd: timestamp("chunk_end", { withTimezone: true }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mode, t.rangeKey, t.scopeKey, t.chunkStart] }),
    index("usage_sync_chunks_scope_idx").on(t.mode, t.rangeKey, t.scopeKey),
  ],
);

/** Watermark for the last complete transaction for a mode/range/scope. */
export const usageSyncStateTable = pgTable(
  "usage_sync_state",
  {
    mode: text("mode").notNull(),
    rangeKey: text("range_key").notNull(),
    scopeKey: text("scope_key").notNull(),
    rangeStart: timestamp("range_start", { withTimezone: true }).notNull(),
    syncedThrough: timestamp("synced_through", { withTimezone: true }).notNull(),
    isClosed: boolean("is_closed").notNull().default(false),
    status: text("status").notNull().default("success"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mode, t.rangeKey, t.scopeKey] }),
    index("usage_sync_state_retention_idx").on(t.isClosed, t.completedAt),
  ],
);

export type UsageSyncChunk = typeof usageSyncChunksTable.$inferSelect;
export type UsageSyncState = typeof usageSyncStateTable.$inferSelect;

/** Durable project directory entries returned by /projects. */
export const apiProjectMetadataTable = pgTable(
  "api_project_metadata",
  {
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    title: text("title"),
    creatorId: text("creator_id"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.projectId] }),
    index("api_project_metadata_workspace_idx").on(t.workspaceId),
  ],
);

/** Records even empty workspace project listings so they hydrate as complete. */
export const apiProjectMetadataStateTable = pgTable("api_project_metadata_state", {
  workspaceId: text("workspace_id").primaryKey(),
  status: text("status").notNull().default("success"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
});
