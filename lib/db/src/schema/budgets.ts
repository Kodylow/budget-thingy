import { pgTable, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const groupBudgetsTable = pgTable("group_budgets", {
  groupId: text("group_id").primaryKey(),
  amountUsd: doublePrecision("amount_usd").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertGroupBudgetSchema = createInsertSchema(
  groupBudgetsTable,
).omit({ updatedAt: true });
export type InsertGroupBudget = z.infer<typeof insertGroupBudgetSchema>;
export type GroupBudget = typeof groupBudgetsTable.$inferSelect;
