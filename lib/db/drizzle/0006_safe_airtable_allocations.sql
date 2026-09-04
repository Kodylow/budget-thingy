ALTER TABLE "team_budget_adjustments" ADD COLUMN "source_kind" text DEFAULT 'approved_credit' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "source_base_id" text;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "source_table_id" text;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "source_record_url" text;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "retirement_reason" text;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "source_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_budget_adjustments" ADD COLUMN "ingested_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "source_base_id" text;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "source_table_id" text;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "source_available" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "unavailable_reason" text;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "fetched_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "approved_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "unmatched_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_budget_sync_state" ADD COLUMN "invalid_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "team_budget_adjustments"
SET "is_active" = false,
    "retired_at" = now(),
    "retirement_reason" = 'Legacy Airtable source retired; relationship to Finance Approval has not been verified'
WHERE "source" = 'airtable';--> statement-breakpoint