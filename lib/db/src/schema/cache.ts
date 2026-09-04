import { pgTable, text, timestamp, jsonb, primaryKey, index, integer } from "drizzle-orm/pg-core";

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

/** Candidate billing interval awaiting a second identical upstream observation. */
export const apiBillingPeriodObservationTable = pgTable("api_billing_period_observation", {
  id: text("id").primaryKey().default("current"),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  consecutiveCount: integer("consecutive_count").notNull().default(1),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

export type ApiBillingPeriodObservation =
  typeof apiBillingPeriodObservationTable.$inferSelect;

/** Durable status for the database-only allocated-pool checker. */
export const budgetCheckerStateTable = pgTable("budget_checker_state", {
  id: text("id").primaryKey().default("singleton"),
  lastSuccessfulEvaluationAt: timestamp("last_successful_evaluation_at", { withTimezone: true }),
  lastEvaluatedDataAsOf: timestamp("last_evaluated_data_as_of", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSkipReason: text("last_skip_reason"),
});

export type BudgetCheckerState = typeof budgetCheckerStateTable.$inferSelect;

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
