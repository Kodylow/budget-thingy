CREATE TABLE "spend_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"billing_period" text NOT NULL,
	"spend_usd" double precision NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spend_snapshots_group_day_idx" ON "spend_snapshots" USING btree ("group_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "spend_snapshots_group_period_idx" ON "spend_snapshots" USING btree ("group_id","billing_period");