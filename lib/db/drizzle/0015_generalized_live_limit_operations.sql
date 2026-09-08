CREATE TABLE IF NOT EXISTS "limit_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text,
  "kind" text DEFAULT 'change' NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "state" text DEFAULT 'prepared' NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_email" text,
  "actor_name" text,
  "amount_usd_cents" integer,
  "clear_policy_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
  "committed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "limit_operation_targets" (
  "operation_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "target_type" text DEFAULT 'workspace_user_limit' NOT NULL,
  "target_id" text NOT NULL,
  "user_id" text,
  "group_id" text,
  "member_name" text,
  "member_email" text,
  "old_amount_usd_cents" integer,
  "new_amount_usd_cents" integer,
  "state" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "attempt_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error_stage" text,
  "error_code" text,
  "error_message" text,
  "upstream_request_id" text,
  "queued_at" timestamp with time zone,
  "applying_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "limit_operation_targets_operation_id_limit_operations_id_fk"
    FOREIGN KEY ("operation_id") REFERENCES "limit_operations"("id") ON DELETE cascade
);--> statement-breakpoint
ALTER TABLE "limit_operations" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'change' NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_operations" ADD COLUMN IF NOT EXISTS "clear_policy_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_operations" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_operations" ALTER COLUMN "amount_usd_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_operation_targets" ADD COLUMN IF NOT EXISTS "target_type" text DEFAULT 'workspace_user_limit' NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_operation_targets" ADD COLUMN IF NOT EXISTS "target_id" text;--> statement-breakpoint
ALTER TABLE "limit_operation_targets" ADD COLUMN IF NOT EXISTS "group_id" text;--> statement-breakpoint
UPDATE "limit_operation_targets" SET "target_id" = "user_id" WHERE "target_id" IS NULL;--> statement-breakpoint
ALTER TABLE "limit_operation_targets" ALTER COLUMN "target_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_operation_targets" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_operation_targets" ALTER COLUMN "new_amount_usd_cents" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "limit_operation_targets_operation_user_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "limit_operation_targets_active_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "limit_operation_targets_operation_identity_idx" ON "limit_operation_targets" ("operation_id","workspace_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "limit_operation_targets_active_identity_idx" ON "limit_operation_targets" ("workspace_id","target_type","target_id") WHERE "state" in ('queued', 'applying', 'verification_pending');