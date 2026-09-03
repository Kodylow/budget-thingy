CREATE TABLE IF NOT EXISTS "canonical_monthly_group_user_rollups" (
  "month_start" date NOT NULL,
  "group_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "user_key" text NOT NULL,
  "ai_spend_usd" double precision DEFAULT 0 NOT NULL,
  "non_ai_spend_usd" double precision DEFAULT 0 NOT NULL,
  "residual_spend_usd" double precision DEFAULT 0 NOT NULL,
  "authoritative_spend_usd" double precision DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "canonical_monthly_group_user_rollups_month_start_group_id_user_key_pk"
    PRIMARY KEY("month_start","group_id","user_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_monthly_rollups_group_idx"
  ON "canonical_monthly_group_user_rollups" USING btree ("group_id","month_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_monthly_rollups_user_idx"
  ON "canonical_monthly_group_user_rollups" USING btree ("user_key","month_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_monthly_rollups_workspace_idx"
  ON "canonical_monthly_group_user_rollups" USING btree ("workspace_id","month_start");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canonical_monthly_rollup_state" (
  "month_start" date PRIMARY KEY NOT NULL,
  "range_start" timestamp with time zone NOT NULL,
  "range_end" timestamp with time zone NOT NULL,
  "input_fingerprint" text NOT NULL,
  "status" text DEFAULT 'success' NOT NULL,
  "completed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_monthly_rollup_state_status_idx"
  ON "canonical_monthly_rollup_state" USING btree ("status","month_start");