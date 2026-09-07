import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type LimitTargetAttempt = {
  at: string;
  stage: "authorization" | "membership" | "reconcile" | "write" | "verification" | "audit";
  outcome: string;
  requestId?: string;
  retryAfterMs?: number;
  message?: string;
};

export const limitOperationsTable = pgTable(
  "limit_operations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    state: text("state").notNull().default("prepared"),
    actorUserId: text("actor_user_id").notNull(),
    actorEmail: text("actor_email"),
    actorName: text("actor_name"),
    amountUsdCents: integer("amount_usd_cents").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("limit_operations_actor_idempotency_idx").on(
      table.actorUserId,
      table.idempotencyKey,
    ),
    index("limit_operations_state_updated_idx").on(table.state, table.updatedAt),
    index("limit_operations_workspace_created_idx").on(
      table.workspaceId,
      table.preparedAt,
    ),
  ],
);

export const limitOperationTargetsTable = pgTable(
  "limit_operation_targets",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => limitOperationsTable.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    memberName: text("member_name"),
    memberEmail: text("member_email"),
    oldAmountUsdCents: integer("old_amount_usd_cents"),
    newAmountUsdCents: integer("new_amount_usd_cents").notNull(),
    state: text("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    attemptHistory: jsonb("attempt_history")
      .$type<LimitTargetAttempt[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    errorStage: text("error_stage"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    upstreamRequestId: text("upstream_request_id"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    applyingAt: timestamp("applying_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("limit_operation_targets_operation_user_idx").on(
      table.operationId,
      table.userId,
    ),
    index("limit_operation_targets_state_updated_idx").on(table.state, table.updatedAt),
    uniqueIndex("limit_operation_targets_active_user_idx")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.state} in ('queued', 'applying', 'verification_pending')`),
  ],
);

export const insertLimitOperationSchema = createInsertSchema(limitOperationsTable);
export const insertLimitOperationTargetSchema = createInsertSchema(
  limitOperationTargetsTable,
);
export type LimitOperation = typeof limitOperationsTable.$inferSelect;
export type LimitOperationTarget = typeof limitOperationTargetsTable.$inferSelect;
export type InsertLimitOperation = z.infer<typeof insertLimitOperationSchema>;
export type InsertLimitOperationTarget = z.infer<
  typeof insertLimitOperationTargetSchema
>;