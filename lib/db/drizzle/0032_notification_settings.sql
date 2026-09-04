CREATE TABLE IF NOT EXISTS "notification_settings" (
  "id" varchar PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "automated_email_enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "notification_settings" ("id", "automated_email_enabled")
VALUES ('singleton', false)
ON CONFLICT ("id") DO NOTHING;