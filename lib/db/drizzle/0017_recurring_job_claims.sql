CREATE TABLE IF NOT EXISTS "recurring_job_claims" (
  "job_key" text PRIMARY KEY NOT NULL,
  "owner_token" text,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "not_before" timestamp with time zone NOT NULL,
  "cursor" text,
  "claimed_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);