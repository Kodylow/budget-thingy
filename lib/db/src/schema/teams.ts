import { pgTable, text, doublePrecision, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const groupTeamsTable = pgTable("group_teams", {
  groupName: text("group_name").primaryKey(),
  teamName: text("team_name").notNull(),
});

export const teamBudgetsTable = pgTable("team_budgets", {
  teamName: text("team_name").primaryKey(),
  amountUsd: doublePrecision("amount_usd").notNull(),
  isHidden: boolean("is_hidden").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertGroupTeamSchema = createInsertSchema(groupTeamsTable);
export type InsertGroupTeam = z.infer<typeof insertGroupTeamSchema>;
export type GroupTeam = typeof groupTeamsTable.$inferSelect;

export const insertTeamBudgetSchema = createInsertSchema(teamBudgetsTable).omit({
  updatedAt: true,
});
export type InsertTeamBudget = z.infer<typeof insertTeamBudgetSchema>;
export type TeamBudget = typeof teamBudgetsTable.$inferSelect;
