CREATE TABLE "api_project_metadata_state" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_project_metadata" (
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text,
	"creator_id" text,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_project_metadata_workspace_id_project_id_pk" PRIMARY KEY("workspace_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "usage_sync_state" ADD COLUMN "status" text DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_sync_state" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "usage_sync_state" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "api_project_metadata_workspace_idx" ON "api_project_metadata" USING btree ("workspace_id");