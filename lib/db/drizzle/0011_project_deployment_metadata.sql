ALTER TABLE "api_project_metadata"
ADD COLUMN IF NOT EXISTS "has_deployment" boolean;

ALTER TABLE "api_project_metadata_state"
ADD COLUMN IF NOT EXISTS "deployment_status_observed" boolean NOT NULL DEFAULT false;