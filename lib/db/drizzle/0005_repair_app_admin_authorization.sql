CREATE TABLE IF NOT EXISTS "app_admins" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "app_admins" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_admins" ADD COLUMN IF NOT EXISTS "revoked_by" varchar;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_admins_bootstrap_email_unique" ON "app_admins" USING btree (lower(btrim("email"))) WHERE "app_admins"."created_by" is null;