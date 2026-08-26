CREATE TABLE "group_roster_snapshot_days" (
	"snapshot_date" date PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_roster_snapshots" (
	"group_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"workspace_id" text NOT NULL,
	"user_ids" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_roster_snapshots_group_id_snapshot_date_pk" PRIMARY KEY("group_id","snapshot_date")
);
--> statement-breakpoint
CREATE INDEX "group_roster_snapshots_day_idx" ON "group_roster_snapshots" USING btree ("snapshot_date");