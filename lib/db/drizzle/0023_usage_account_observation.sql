CREATE TABLE IF NOT EXISTS "usage_account_observation" (
  "billing_period_start" date PRIMARY KEY NOT NULL,
  "total_cost_usd" double precision,
  "interval_start" timestamp with time zone NOT NULL,
  "interval_end" timestamp with time zone NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "source_status" text NOT NULL,
  "error" text,
  CONSTRAINT "usage_account_observation_source_status_check"
    CHECK ("usage_account_observation"."source_status" in ('complete', 'failed'))
);