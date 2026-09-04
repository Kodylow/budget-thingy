CREATE TABLE IF NOT EXISTS "usage_member_day" (
  "workspace_id" text NOT NULL,
  "usage_date" date NOT NULL,
  "user_id" text NOT NULL,
  "total_cost_usd" double precision NOT NULL,
  "ai_cost_usd" double precision NOT NULL,
  "metrics_json" jsonb NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  CONSTRAINT "usage_member_day_workspace_id_usage_date_user_id_pk"
    PRIMARY KEY ("workspace_id", "usage_date", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_member_day_usage_date_idx"
  ON "usage_member_day" USING btree ("usage_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_project_day" (
  "workspace_id" text NOT NULL,
  "usage_date" date NOT NULL,
  "project_id" text NOT NULL,
  "total_cost_usd" double precision NOT NULL,
  "metrics_json" jsonb NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  CONSTRAINT "usage_project_day_workspace_id_usage_date_project_id_pk"
    PRIMARY KEY ("workspace_id", "usage_date", "project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_workspace_day" (
  "workspace_id" text NOT NULL,
  "usage_date" date NOT NULL,
  "total_cost_usd" double precision NOT NULL,
  "member_attributable_usd" double precision NOT NULL,
  "member_unattributable_usd" double precision NOT NULL,
  "metrics_json" jsonb NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "error" text,
  CONSTRAINT "usage_workspace_day_workspace_id_usage_date_pk"
    PRIMARY KEY ("workspace_id", "usage_date"),
  CONSTRAINT "usage_workspace_day_status_check"
    CHECK ("usage_workspace_day"."status" in ('complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_account_day" (
  "usage_date" date PRIMARY KEY NOT NULL,
  "total_cost_usd" double precision NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingest_run" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "units" integer DEFAULT 0 NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "failures" integer DEFAULT 0 NOT NULL,
  "error" text,
  CONSTRAINT "ingest_run_kind_check"
    CHECK ("ingest_run"."kind" in ('live', 'backfill', 'reconcile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingest_reconciliation" (
  "month_start" date NOT NULL,
  "scope" text NOT NULL,
  "scope_id" text NOT NULL,
  "upstream_usd" double precision NOT NULL,
  "stored_usd" double precision NOT NULL,
  "delta_usd" double precision NOT NULL,
  "checked_at" timestamp with time zone NOT NULL,
  CONSTRAINT "ingest_reconciliation_month_start_scope_scope_id_pk"
    PRIMARY KEY ("month_start", "scope", "scope_id")
);