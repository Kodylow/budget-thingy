import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Alerts and fired-threshold bookkeeping cover BOTH allocated-pool entity kinds:
// raw Enterprise groups and cross-workspace teams. Rows carry an entityType
// discriminator plus entityId/entityName so history can tell them apart, and
// workspaceIds records the workspaces that contributed to the decision (a single
// workspace for a group, potentially several for a cross-workspace team) so the
// records can be scoped to the workspaces an admin can see.
export const alertsTable = pgTable("alerts", {
  id: serial("id").primaryKey(),
  // Legacy group columns are retained for backward compatibility with existing
  // readers. For team alerts they mirror the entity fields (groupId holds the
  // synthetic entity id, groupName holds the team name).
  groupId: text("group_id").notNull(),
  groupName: text("group_name").notNull(),
  entityType: text("entity_type").notNull().default("group"), // "group" | "team"
  entityId: text("entity_id").notNull().default(""),
  entityName: text("entity_name").notNull().default(""),
  // Workspaces whose spend contributed to this pool evaluation, used for scoping.
  workspaceIds: text("workspace_ids").array().notNull().default([]),
  threshold: integer("threshold").notNull(),
  spendUsd: doublePrecision("spend_usd").notNull(),
  budgetUsd: doublePrecision("budget_usd").notNull(),
  recipients: text("recipients").array().notNull(),
  status: text("status").notNull(), // "sent" | "failed"
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAlertSchema = createInsertSchema(alertsTable).omit({
  id: true,
  sentAt: true,
});
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Alert = typeof alertsTable.$inferSelect;

// One row per (entity type, entity, billing period, threshold) that has
// successfully alerted, so each threshold fires at most once per billing period
// per entity. groupId is retained for backward compatibility and mirrors
// entityId for group rows.
export const firedThresholdsTable = pgTable(
  "fired_thresholds",
  {
    id: serial("id").primaryKey(),
    groupId: text("group_id").notNull(),
    entityType: text("entity_type").notNull().default("group"), // "group" | "team"
    entityId: text("entity_id").notNull().default(""),
    billingPeriod: text("billing_period").notNull(), // ISO start of the billing period interval
    threshold: integer("threshold").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("fired_thresholds_unique").on(
      t.entityType,
      t.entityId,
      t.billingPeriod,
      t.threshold,
    ),
  ],
);

export type FiredThreshold = typeof firedThresholdsTable.$inferSelect;
