CREATE TABLE IF NOT EXISTS "usage_daily_facts" (
  "mode" text NOT NULL,
  "scope_key" text NOT NULL,
  "usage_date" date NOT NULL,
  "payload_json" jsonb NOT NULL,
  "source" text DEFAULT 'enterprise_api' NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  CONSTRAINT "usage_daily_facts_mode_scope_key_usage_date_pk"
    PRIMARY KEY("mode","scope_key","usage_date")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_daily_facts_range_idx"
  ON "usage_daily_facts" USING btree ("usage_date","mode","scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_daily_facts_scope_idx"
  ON "usage_daily_facts" USING btree ("mode","scope_key","usage_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_fact_months" (
  "mode" text NOT NULL,
  "scope_key" text NOT NULL,
  "month_start" date NOT NULL,
  "is_closed" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'success' NOT NULL,
  "error_message" text,
  "synced_through" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "usage_fact_months_mode_scope_key_month_start_pk"
    PRIMARY KEY("mode","scope_key","month_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_fact_months_open_idx"
  ON "usage_fact_months" USING btree ("is_closed","month_start");