ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "data_as_of" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_checker_state" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "last_successful_evaluation_at" timestamp with time zone,
  "last_evaluated_data_as_of" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "last_skip_reason" text
);