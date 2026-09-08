CREATE TABLE IF NOT EXISTS "api_project_creator_evidence" (
  "workspace_id" text NOT NULL,
  "project_id" text NOT NULL,
  "creator_id" text NOT NULL,
  "provenance" text DEFAULT 'current_catalog_observation' NOT NULL,
  "first_observed_at" timestamp with time zone NOT NULL,
  "last_observed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "api_project_creator_evidence_pkey"
    PRIMARY KEY ("workspace_id", "project_id", "creator_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_project_creator_evidence_workspace_project_idx"
  ON "api_project_creator_evidence" USING btree ("workspace_id", "project_id");
--> statement-breakpoint
INSERT INTO "api_project_creator_evidence" (
  "workspace_id", "project_id", "creator_id", "provenance",
  "first_observed_at", "last_observed_at"
)
SELECT
  "workspace_id", "project_id", "creator_id",
  'current_catalog_observation', "fetched_at", "fetched_at"
FROM "api_project_metadata"
WHERE "creator_id" IS NOT NULL
ON CONFLICT ("workspace_id", "project_id", "creator_id") DO UPDATE
SET "first_observed_at" = LEAST(
  "api_project_creator_evidence"."first_observed_at",
  excluded."first_observed_at"
),
"last_observed_at" = GREATEST(
  "api_project_creator_evidence"."last_observed_at",
  excluded."last_observed_at"
);