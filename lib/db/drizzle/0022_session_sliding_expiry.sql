ALTER TABLE "sessions"
ADD COLUMN IF NOT EXISTS "last_extended_at" timestamp with time zone;