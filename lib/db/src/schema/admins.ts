import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const adminEmailsTable = pgTable("admin_emails", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAdminEmailSchema = createInsertSchema(
  adminEmailsTable,
).omit({ id: true, createdAt: true });
export type InsertAdminEmail = z.infer<typeof insertAdminEmailSchema>;
export type AdminEmail = typeof adminEmailsTable.$inferSelect;
