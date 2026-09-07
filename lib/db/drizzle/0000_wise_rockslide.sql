DROP SCHEMA IF EXISTS "public" CASCADE;
--> statement-breakpoint
CREATE SCHEMA "public";
--> statement-breakpoint
CREATE TABLE "group_budgets" (
	"group_id" text PRIMARY KEY NOT NULL,
	"amount_usd" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_emails_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "alert_delivery_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"billing_period" text NOT NULL,
	"threshold" integer NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"group_name" text NOT NULL,
	"entity_type" text DEFAULT 'group' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"entity_name" text DEFAULT '' NOT NULL,
	"workspace_ids" text[] DEFAULT '{}' NOT NULL,
	"threshold" integer NOT NULL,
	"spend_usd" double precision NOT NULL,
	"budget_usd" double precision NOT NULL,
	"recipients" text[] NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"data_as_of" timestamp with time zone,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fired_thresholds" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"entity_type" text DEFAULT 'group' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"billing_period" text NOT NULL,
	"threshold" integer NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_team_mappings" (
	"workspace_id" text NOT NULL,
	"family_key" text NOT NULL,
	"family_name" text NOT NULL,
	"team_name" text,
	"is_legacy" boolean NOT NULL,
	CONSTRAINT "family_team_mappings_pkey" PRIMARY KEY("workspace_id","family_key")
);
--> statement-breakpoint
CREATE TABLE "team_budget_adjustments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "team_budget_adjustments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source" text DEFAULT 'airtable' NOT NULL,
	"source_record_id" text NOT NULL,
	"source_team_status" text,
	"source_team_name" text,
	"team_name" text,
	"amount_usd" double precision,
	"submission_period" text,
	"match_state" text NOT NULL,
	"error_message" text,
	"source_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_budget_allocation_audits" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "team_budget_allocation_audits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"team_name" text NOT NULL,
	"field" text NOT NULL,
	"old_value" jsonb NOT NULL,
	"new_value" jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_budget_sync_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"last_error" text,
	"record_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"issue_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_budget_upstream_sync" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "team_budget_upstream_sync_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"team_name" text NOT NULL,
	"workspace_id" text,
	"target_group_id" text,
	"target_group_name" text,
	"target_type" text DEFAULT 'group' NOT NULL,
	"desired_amount_usd" double precision NOT NULL,
	"upstream_amount_usd" double precision,
	"status" text DEFAULT 'failed' NOT NULL,
	"reason" text,
	"last_attempt_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_budget_upstream_sync_target_idx" UNIQUE NULLS NOT DISTINCT("workspace_id","target_type","target_group_id")
);
--> statement-breakpoint
CREATE TABLE "team_budgets" (
	"team_name" text PRIMARY KEY NOT NULL,
	"original_amount_usd" double precision DEFAULT 0 NOT NULL,
	"amount_usd" double precision NOT NULL,
	"monthly_limit_usd" double precision,
	"monthly_limit_source" text DEFAULT 'derived' NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_limit_targets" (
	"team_name" text NOT NULL,
	"workspace_id" text NOT NULL,
	"group_id" text NOT NULL,
	"group_name" text NOT NULL,
	"assignment_source" text DEFAULT 'manual' NOT NULL,
	"monthly_limit_usd" double precision,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "team_limit_targets_pkey" PRIMARY KEY("workspace_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_default_limit_targets" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"monthly_limit_usd" double precision DEFAULT 1 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_billing_period_cache" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_billing_period_observation" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"consecutive_count" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_directory_cache" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"directory_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_project_metadata_state" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_project_metadata" (
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text,
	"creator_id" text,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_project_metadata_workspace_id_project_id_pk" PRIMARY KEY("workspace_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "budget_checker_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"last_successful_evaluation_at" timestamp with time zone,
	"last_evaluated_data_as_of" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_skip_reason" text
);
--> statement-breakpoint
CREATE TABLE "recurring_job_claims" (
	"job_key" text PRIMARY KEY NOT NULL,
	"owner_token" text,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"cursor" text,
	"claimed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_admins" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL,
	"last_extended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "group_roster_snapshot_days" (
	"snapshot_date" date PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_roster_snapshots" (
	"group_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"workspace_id" text NOT NULL,
	"user_ids" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_roster_snapshots_group_id_snapshot_date_pk" PRIMARY KEY("group_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "spend_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"billing_period" text NOT NULL,
	"spend_usd" double precision NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_limit_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"operator_user_id" text NOT NULL,
	"operator_email" text,
	"operator_name" text,
	"workspace_id" text NOT NULL,
	"workspace_name" text,
	"member_user_id" text NOT NULL,
	"member_email" text,
	"member_name" text,
	"action" text NOT NULL,
	"operation" text DEFAULT 'individual' NOT NULL,
	"requested_amount_usd" double precision,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_reconciliation" (
	"month_start" date NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"upstream_usd" double precision NOT NULL,
	"stored_usd" double precision NOT NULL,
	"delta_usd" double precision NOT NULL,
	"mismatch_count" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ingest_reconciliation_month_start_scope_scope_id_pk" PRIMARY KEY("month_start","scope","scope_id")
);
--> statement-breakpoint
CREATE TABLE "ingest_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"units" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "ingest_run_kind_check" CHECK ("ingest_run"."kind" in ('live', 'backfill', 'reconcile'))
);
--> statement-breakpoint
CREATE TABLE "usage_account_day" (
	"usage_date" date PRIMARY KEY NOT NULL,
	"total_cost_usd" double precision NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_account_observation" (
	"billing_period_start" date PRIMARY KEY NOT NULL,
	"total_cost_usd" double precision,
	"interval_start" timestamp with time zone NOT NULL,
	"interval_end" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"source_status" text NOT NULL,
	"error" text,
	CONSTRAINT "usage_account_observation_source_status_check" CHECK ("usage_account_observation"."source_status" in ('complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "usage_member_day" (
	"workspace_id" text NOT NULL,
	"usage_date" date NOT NULL,
	"user_id" text NOT NULL,
	"total_cost_usd" double precision NOT NULL,
	"ai_cost_usd" double precision NOT NULL,
	"metrics_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_member_day_workspace_id_usage_date_user_id_pk" PRIMARY KEY("workspace_id","usage_date","user_id")
);
--> statement-breakpoint
CREATE TABLE "usage_project_day" (
	"workspace_id" text NOT NULL,
	"usage_date" date NOT NULL,
	"project_id" text NOT NULL,
	"total_cost_usd" double precision NOT NULL,
	"metrics_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_project_day_workspace_id_usage_date_project_id_pk" PRIMARY KEY("workspace_id","usage_date","project_id")
);
--> statement-breakpoint
CREATE TABLE "usage_workspace_day" (
	"workspace_id" text NOT NULL,
	"usage_date" date NOT NULL,
	"total_cost_usd" double precision NOT NULL,
	"member_attributable_usd" double precision NOT NULL,
	"member_unattributable_usd" double precision NOT NULL,
	"metrics_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"error" text,
	CONSTRAINT "usage_workspace_day_workspace_id_usage_date_pk" PRIMARY KEY("workspace_id","usage_date"),
	CONSTRAINT "usage_workspace_day_status_check" CHECK ("usage_workspace_day"."status" in ('complete', 'stale', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" varchar PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"automated_email_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alert_delivery_claims_unique" ON "alert_delivery_claims" USING btree ("entity_type","entity_id","billing_period","threshold");--> statement-breakpoint
CREATE UNIQUE INDEX "fired_thresholds_unique" ON "fired_thresholds" USING btree ("entity_type","entity_id","billing_period","threshold");--> statement-breakpoint
CREATE INDEX "family_team_mappings_family_key_idx" ON "family_team_mappings" USING btree ("family_key");--> statement-breakpoint
CREATE INDEX "family_team_mappings_team_name_idx" ON "family_team_mappings" USING btree ("team_name");--> statement-breakpoint
CREATE UNIQUE INDEX "team_budget_adjustments_source_identity_idx" ON "team_budget_adjustments" USING btree ("source","source_record_id");--> statement-breakpoint
CREATE INDEX "team_budget_allocation_audits_team_created_idx" ON "team_budget_allocation_audits" USING btree ("team_name","created_at","id");--> statement-breakpoint
CREATE INDEX "api_project_metadata_workspace_idx" ON "api_project_metadata" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "group_roster_snapshots_day_idx" ON "group_roster_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_snapshots_group_day_idx" ON "spend_snapshots" USING btree ("group_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "spend_snapshots_group_period_idx" ON "spend_snapshots" USING btree ("group_id","billing_period");--> statement-breakpoint
CREATE INDEX "usage_limit_audits_workspace_created_idx" ON "usage_limit_audits" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_member_day_usage_date_idx" ON "usage_member_day" USING btree ("usage_date");