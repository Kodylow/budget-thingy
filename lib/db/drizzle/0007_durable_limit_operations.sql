CREATE TABLE "limit_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "state" text DEFAULT 'prepared' NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_email" text,
  "actor_name" text,
  "amount_usd_cents" integer NOT NULL,
  "prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
  "committed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "limit_operations_state_check" CHECK ("state" IN ('prepared', 'queued', 'running', 'completed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "limit_operations_actor_idempotency_idx" ON "limit_operations" USING btree ("actor_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "limit_operations_state_updated_idx" ON "limit_operations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "limit_operations_workspace_created_idx" ON "limit_operations" USING btree ("workspace_id","prepared_at");--> statement-breakpoint
CREATE TABLE "limit_operation_targets" (
  "operation_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "user_id" text NOT NULL,
  "member_name" text,
  "member_email" text,
  "old_amount_usd_cents" integer,
  "new_amount_usd_cents" integer NOT NULL,
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
  CONSTRAINT "limit_operation_targets_operation_id_limit_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "limit_operations"("id") ON DELETE cascade,
  CONSTRAINT "limit_operation_targets_state_check" CHECK ("state" IN ('queued', 'applying', 'verified', 'failed', 'verification_pending'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "limit_operation_targets_operation_user_idx" ON "limit_operation_targets" USING btree ("operation_id","user_id");--> statement-breakpoint
CREATE INDEX "limit_operation_targets_state_updated_idx" ON "limit_operation_targets" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "limit_operation_targets_active_user_idx" ON "limit_operation_targets" USING btree ("workspace_id","user_id") WHERE "state" in ('queued', 'applying', 'verification_pending');