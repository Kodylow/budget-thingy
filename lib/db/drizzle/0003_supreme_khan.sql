CREATE TABLE "editor_allowlist" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "fired_thresholds_unique";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "entity_type" text DEFAULT 'group' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "entity_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "entity_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "workspace_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "fired_thresholds" ADD COLUMN "entity_type" text DEFAULT 'group' NOT NULL;--> statement-breakpoint
ALTER TABLE "fired_thresholds" ADD COLUMN "entity_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "alerts" SET "entity_id" = "group_id", "entity_name" = "group_name"
  WHERE "entity_id" = '';--> statement-breakpoint
UPDATE "fired_thresholds" SET "entity_id" = "group_id"
  WHERE "entity_id" = '';--> statement-breakpoint
CREATE UNIQUE INDEX "fired_thresholds_unique" ON "fired_thresholds" USING btree ("entity_type","entity_id","billing_period","threshold");