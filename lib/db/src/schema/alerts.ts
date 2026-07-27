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

export const alertsTable = pgTable("alerts", {
  id: serial("id").primaryKey(),
  groupId: text("group_id").notNull(),
  groupName: text("group_name").notNull(),
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

// One row per (group, billing period, threshold) that has successfully alerted,
// so each threshold fires at most once per billing period.
export const firedThresholdsTable = pgTable(
  "fired_thresholds",
  {
    id: serial("id").primaryKey(),
    groupId: text("group_id").notNull(),
    billingPeriod: text("billing_period").notNull(), // ISO start of the billing period interval
    threshold: integer("threshold").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("fired_thresholds_unique").on(
      t.groupId,
      t.billingPeriod,
      t.threshold,
    ),
  ],
);

export type FiredThreshold = typeof firedThresholdsTable.$inferSelect;
