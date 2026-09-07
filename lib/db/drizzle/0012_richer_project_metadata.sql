ALTER TABLE "api_project_metadata"
ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;

ALTER TABLE "api_project_metadata"
ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;

ALTER TABLE "api_project_metadata"
ADD COLUMN IF NOT EXISTS "deployments" jsonb;

ALTER TABLE "api_project_metadata"
ADD COLUMN IF NOT EXISTS "deployments_observed_at" timestamp with time zone;