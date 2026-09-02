CREATE TABLE "team_budget_upstream_sync" (
  "team_name" text PRIMARY KEY NOT NULL,
  "workspace_id" text,
  "target_group_id" text,
  "target_group_name" text,
  "desired_amount_usd" double precision NOT NULL,
  "upstream_amount_usd" double precision,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text,
  "last_attempt_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);