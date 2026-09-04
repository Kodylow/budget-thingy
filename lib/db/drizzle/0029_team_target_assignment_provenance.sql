ALTER TABLE "team_limit_targets"
	ADD COLUMN "assignment_source" text DEFAULT 'unconfirmed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_limit_targets"
	ALTER COLUMN "assignment_source" SET DEFAULT 'manual';