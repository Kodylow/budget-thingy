import {
  doublePrecision,
  index,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usageLimitAuditsTable = pgTable(
  "usage_limit_audits",
  {
    id: serial("id").primaryKey(),
    operatorUserId: text("operator_user_id").notNull(),
    operatorEmail: text("operator_email"),
    operatorName: text("operator_name"),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name"),
    memberUserId: text("member_user_id").notNull(),
    memberEmail: text("member_email"),
    memberName: text("member_name"),
    action: text("action").notNull(), // set | clear
    operation: text("operation").notNull().default("individual"), // individual | bulk
    requestedAmountUsd: doublePrecision("requested_amount_usd"),
    outcome: text("outcome").notNull(), // success | failed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("usage_limit_audits_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);

export const insertUsageLimitAuditSchema = createInsertSchema(
  usageLimitAuditsTable,
).omit({ id: true, createdAt: true });
export type InsertUsageLimitAudit = z.infer<typeof insertUsageLimitAuditSchema>;
export type UsageLimitAudit = typeof usageLimitAuditsTable.$inferSelect;