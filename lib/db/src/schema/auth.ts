import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessionsTable = pgTable(
  'sessions',
  {
    sid: varchar('sid').primaryKey(),
    sess: jsonb('sess').notNull(),
    expire: timestamp('expire').notNull(),
    lastExtendedAt: timestamp('last_extended_at', { withTimezone: true }),
  },
  (table) => [index('IDX_session_expire').on(table.expire)],
);

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const usersTable = pgTable('users', {
  id: varchar('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: varchar('email').unique(),
  firstName: varchar('first_name'),
  lastName: varchar('last_name'),
  profileImageUrl: varchar('profile_image_url'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;

/**
 * Managed allowlist of account-wide application admins, keyed by the stable
 * Replit user ID (the OIDC `sub` claim) so access survives email or
 * display name changes. `email` is a human-readable snapshot captured when the
 * row is created; `createdBy` records the stable user ID of the account admin
 * who granted access (nullable for system-bootstrapped rows).
 */
export const appAdminsTable = pgTable('app_admins', {
  userId: varchar('user_id').primaryKey(),
  email: varchar('email').notNull(),
  createdBy: varchar('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppAdminEntry = typeof appAdminsTable.$inferSelect;

export type InsertAppAdminEntry = typeof appAdminsTable.$inferInsert;
