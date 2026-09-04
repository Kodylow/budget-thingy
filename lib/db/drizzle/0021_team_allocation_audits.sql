CREATE TABLE "team_budget_allocation_audits" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "team_name" text NOT NULL,
  "field" text NOT NULL,
  "old_value" jsonb NOT NULL,
  "new_value" jsonb NOT NULL,
  "actor_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "team_budget_allocation_audits_team_created_idx"
  ON "team_budget_allocation_audits" ("team_name", "created_at", "id");