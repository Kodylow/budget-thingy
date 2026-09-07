import { boolean, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const notificationSettingsTable = pgTable("notification_settings", {
  id: varchar("id").primaryKey().default("singleton"),
  automatedEmailEnabled: boolean("automated_email_enabled")
    .notNull()
    .default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertNotificationSettingsSchema = createInsertSchema(
  notificationSettingsTable,
).omit({ updatedAt: true });

export type InsertNotificationSettings = z.infer<
  typeof insertNotificationSettingsSchema
>;
export type NotificationSettings =
  typeof notificationSettingsTable.$inferSelect;