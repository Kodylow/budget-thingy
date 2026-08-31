ALTER TABLE "team_budgets" ADD COLUMN "original_amount_usd" double precision DEFAULT 0 NOT NULL;
UPDATE "team_budgets" SET "original_amount_usd" = "amount_usd";
UPDATE "group_teams" SET "team_name" = 'DXP' WHERE "team_name" = 'Growth Strategy & Operations';
INSERT INTO "team_budgets" ("team_name", "amount_usd", "original_amount_usd", "is_hidden")
VALUES ('DXP', 18736.77, 18736.77, false), ('Non-DXP', 0, 0, false)
ON CONFLICT ("team_name") DO UPDATE SET
  "amount_usd" = EXCLUDED."amount_usd",
  "original_amount_usd" = EXCLUDED."original_amount_usd";
DELETE FROM "team_budgets" WHERE "team_name" = 'Growth Strategy & Operations';

CREATE TABLE "team_budget_adjustments" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
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
CREATE UNIQUE INDEX "team_budget_adjustments_source_identity_idx"
  ON "team_budget_adjustments" ("source", "source_record_id");

CREATE TABLE "team_budget_sync_state" (
  "id" integer PRIMARY KEY,
  "last_attempt_at" timestamp with time zone,
  "last_successful_at" timestamp with time zone,
  "last_error" text,
  "record_count" integer DEFAULT 0 NOT NULL,
  "accepted_count" integer DEFAULT 0 NOT NULL,
  "issue_count" integer DEFAULT 0 NOT NULL
);