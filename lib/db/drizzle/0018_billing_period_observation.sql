CREATE TABLE IF NOT EXISTS "api_billing_period_observation" (
  "id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "consecutive_count" integer DEFAULT 1 NOT NULL,
  "observed_at" timestamp with time zone NOT NULL
);