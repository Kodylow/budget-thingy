import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  integer,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const groupTeamsTable = pgTable("group_teams", {
  groupName: text("group_name").primaryKey(),
  teamName: text("team_name").notNull(),
});

export const teamBudgetsTable = pgTable("team_budgets", {
  teamName: text("team_name").primaryKey(),
  /** Immutable spreadsheet allocation. Current budget is derived from this plus accepted adjustments. */
  originalAmountUsd: doublePrecision("original_amount_usd").notNull().default(0),
  /** Legacy mirror of the original allocation, retained for a safe rolling migration. */
  amountUsd: doublePrecision("amount_usd").notNull(),
  isHidden: boolean("is_hidden").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const teamBudgetUpstreamSyncTable = pgTable(
  "team_budget_upstream_sync",
  {
    teamName: text("team_name").primaryKey(),
    workspaceId: text("workspace_id"),
    targetGroupId: text("target_group_id"),
    targetGroupName: text("target_group_name"),
    desiredAmountUsd: doublePrecision("desired_amount_usd").notNull(),
    upstreamAmountUsd: doublePrecision("upstream_amount_usd"),
    status: text("status")
      .$type<"pending" | "synced" | "unresolved" | "failed">()
      .notNull()
      .default("pending"),
    reason: text("reason"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const teamBudgetAdjustmentsTable = pgTable(
  "team_budget_adjustments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    source: text("source").notNull().default("airtable"),
    sourceRecordId: text("source_record_id").notNull(),
    sourceTeamStatus: text("source_team_status"),
    sourceTeamName: text("source_team_name"),
    teamName: text("team_name"),
    amountUsd: doublePrecision("amount_usd"),
    submissionPeriod: text("submission_period"),
    matchState: text("match_state").notNull(),
    errorMessage: text("error_message"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("team_budget_adjustments_source_identity_idx").on(
      table.source,
      table.sourceRecordId,
    ),
  ],
);
export const insertGroupTeamSchema = createInsertSchema(groupTeamsTable);
export type InsertGroupTeam = z.infer<typeof insertGroupTeamSchema>;
export type GroupTeam = typeof groupTeamsTable.$inferSelect;

export const insertTeamBudgetSchema = createInsertSchema(teamBudgetsTable).omit({
  updatedAt: true,
});
export type InsertTeamBudget = z.infer<typeof insertTeamBudgetSchema>;
export type TeamBudget = typeof teamBudgetsTable.$inferSelect;
export type TeamBudgetUpstreamSync =
  typeof teamBudgetUpstreamSyncTable.$inferSelect;

export type TeamBudgetAdjustment = typeof teamBudgetAdjustmentsTable.$inferSelect;

export const teamBudgetSyncStateTable = pgTable("team_budget_sync_state", {
  id: integer("id").primaryKey(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
  lastError: text("last_error"),
  recordCount: integer("record_count").notNull().default(0),
  acceptedCount: integer("accepted_count").notNull().default(0),
  issueCount: integer("issue_count").notNull().default(0),
});
