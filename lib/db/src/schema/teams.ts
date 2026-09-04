import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  integer,
  primaryKey,
  uniqueIndex,
  index,
  unique,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const teamLimitTargetsTable = pgTable(
  "team_limit_targets",
  {
    teamName: text("team_name").notNull(),
    workspaceId: text("workspace_id").notNull(),
    groupId: text("group_id").notNull(),
    groupName: text("group_name").notNull(),
    assignmentSource: text("assignment_source")
      .$type<"unconfirmed" | "automatic" | "manual">()
      .notNull()
      .default("manual"),
    monthlyLimitUsd: doublePrecision("monthly_limit_usd"),
    // Disabled rows still attribute usage to a team; only limit split,
    // reconciliation, and apply operations exclude them.
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
  (table) => [
    primaryKey({
      name: "team_limit_targets_pkey",
      columns: [
      table.workspaceId,
      table.groupId,
      ],
    }),
  ],
);

export const familyTeamMappingsTable = pgTable(
  "family_team_mappings",
  {
    workspaceId: text("workspace_id").notNull(),
    familyKey: text("family_key").notNull(),
    familyName: text("family_name").notNull(),
    teamName: text("team_name"),
    isLegacy: boolean("is_legacy").notNull(),
  },
  (table) => [
    primaryKey({
      name: "family_team_mappings_pkey",
      columns: [table.workspaceId, table.familyKey],
    }),
    index("family_team_mappings_family_key_idx").on(table.familyKey),
    index("family_team_mappings_team_name_idx").on(table.teamName),
  ],
);

export const workspaceDefaultLimitTargetsTable = pgTable(
  "workspace_default_limit_targets",
  {
    workspaceId: text("workspace_id").primaryKey(),
    displayName: text("display_name").notNull(),
    monthlyLimitUsd: doublePrecision("monthly_limit_usd").notNull().default(1),
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
);

export const teamBudgetsTable = pgTable("team_budgets", {
  teamName: text("team_name").primaryKey(),
  /** Immutable spreadsheet allocation. Current budget is derived from this plus accepted adjustments. */
  originalAmountUsd: doublePrecision("original_amount_usd").notNull().default(0),
  /** Legacy mirror of the original allocation, retained for a safe rolling migration. */
  amountUsd: doublePrecision("amount_usd").notNull(),
  monthlyLimitUsd: doublePrecision("monthly_limit_usd"),
  monthlyLimitSource: text("monthly_limit_source")
    .$type<"derived" | "manual">()
    .notNull()
    .default("derived"),
  isHidden: boolean("is_hidden").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const teamBudgetAllocationAuditsTable = pgTable(
  "team_budget_allocation_audits",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    teamName: text("team_name").notNull(),
    field: text("field")
      .$type<"annualAllocationUsd" | "isHidden">()
      .notNull(),
    oldValue: jsonb("old_value").$type<number | boolean>().notNull(),
    newValue: jsonb("new_value").$type<number | boolean>().notNull(),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("team_budget_allocation_audits_team_created_idx").on(
      table.teamName,
      table.createdAt,
      table.id,
    ),
  ],
);

export const teamBudgetUpstreamSyncTable = pgTable(
  "team_budget_upstream_sync",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    teamName: text("team_name").notNull(),
    workspaceId: text("workspace_id"),
    targetGroupId: text("target_group_id"),
    targetGroupName: text("target_group_name"),
    targetType: text("target_type")
      .$type<"group" | "workspace_default">()
      .notNull()
      .default("group"),
    desiredAmountUsd: doublePrecision("desired_amount_usd").notNull(),
    upstreamAmountUsd: doublePrecision("upstream_amount_usd"),
    status: text("status")
      .$type<"synced" | "drift" | "failed">()
      .notNull()
      .default("failed"),
    reason: text("reason"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("team_budget_upstream_sync_target_idx").on(
      table.workspaceId,
      table.targetType,
      table.targetGroupId,
    ).nullsNotDistinct(),
  ],
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
export type TeamLimitTarget = typeof teamLimitTargetsTable.$inferSelect;
export type FamilyTeamMapping = typeof familyTeamMappingsTable.$inferSelect;

export const insertTeamBudgetSchema = createInsertSchema(teamBudgetsTable).omit({
  updatedAt: true,
});
export type InsertTeamBudget = z.infer<typeof insertTeamBudgetSchema>;
export type TeamBudget = typeof teamBudgetsTable.$inferSelect;
export type TeamBudgetAllocationAudit =
  typeof teamBudgetAllocationAuditsTable.$inferSelect;
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
