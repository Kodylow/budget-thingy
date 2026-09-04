ALTER TABLE "usage_workspace_day" DROP CONSTRAINT IF EXISTS "usage_workspace_day_status_check";
--> statement-breakpoint
ALTER TABLE "usage_workspace_day" ADD CONSTRAINT "usage_workspace_day_status_check"
  CHECK ("status" in ('complete', 'stale', 'failed'));
--> statement-breakpoint
ALTER TABLE "ingest_reconciliation"
  ADD COLUMN IF NOT EXISTS "mismatch_count" integer DEFAULT 0 NOT NULL;