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
 * Managed allowlist of account-wide editors, keyed by the *stable Replit user
 * ID* (the OIDC `sub` claim) so an editor keeps access even if their email or
 * display name changes. `email` is a human-readable snapshot captured when the
 * row is created; `createdBy` records the stable user ID of the account admin
 * who granted access (nullable for system-bootstrapped rows).
 */
export const editorAllowlistTable = pgTable('editor_allowlist', {
  userId: varchar('user_id').primaryKey(),
  email: varchar('email').notNull(),
  createdBy: varchar('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EditorAllowlistEntry = typeof editorAllowlistTable.$inferSelect;
export type InsertEditorAllowlistEntry =
  typeof editorAllowlistTable.$inferInsert;

/**
 * Durable record that the one-time designated-editor bootstrap has been
 * consumed for a stable Replit identity. This row intentionally survives
 * removal from the active allowlist so a later login cannot undo an account
 * admin's revocation.
 */
export const editorBootstrapStateTable = pgTable('editor_bootstrap_state', {
  userId: varchar('user_id').primaryKey(),
  email: varchar('email').notNull(),
  completedBy: varchar('completed_by'),
  completedAt: timestamp('completed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
