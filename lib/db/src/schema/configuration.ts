import { bigint, boolean, check, pgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * A singleton commit clock for budget/accounting configuration.
 *
 * Database triggers advance this row in the same transaction as every
 * configuration-table mutation, so readers never observe a revision for a
 * rolled-back change.
 */
export const configurationRevisionTable = pgTable(
  "configuration_revision",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => [
    check("configuration_revision_singleton", sql`${table.singleton} = true`),
  ],
);

export type ConfigurationRevision =
  typeof configurationRevisionTable.$inferSelect;