CREATE TABLE IF NOT EXISTS "app_admins" (
  "user_id" varchar PRIMARY KEY NOT NULL,
  "email" varchar NOT NULL,
  "created_by" varchar,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
DECLARE
  legacy_table text := 'editor_' || 'allowlist';
BEGIN
  IF to_regclass('public.' || legacy_table) IS NOT NULL THEN
    EXECUTE format(
      'INSERT INTO app_admins (user_id, email, created_by, created_at)
       SELECT user_id, email, created_by, created_at FROM %I
       ON CONFLICT (user_id) DO NOTHING',
      legacy_table
    );
  END IF;
END
$$;