CREATE TABLE IF NOT EXISTS "ingest_cursor" (
  "stage" text PRIMARY KEY NOT NULL,
  "cursor" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "api_project_metadata_state"
  ADD COLUMN IF NOT EXISTS "last_successful_at" timestamp with time zone;

UPDATE "api_project_metadata_state"
SET "last_successful_at" = "completed_at"
WHERE "last_successful_at" IS NULL
  AND "status" IN ('success', 'complete');

ALTER TABLE "ingest_run"
  ADD COLUMN IF NOT EXISTS "remaining" integer;