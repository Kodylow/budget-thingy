ALTER TABLE "app_admins" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_admins" ADD COLUMN "revoked_by" varchar;