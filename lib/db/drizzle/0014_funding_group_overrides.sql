CREATE TABLE IF NOT EXISTS "funding_group_overrides" (
	"workspace_id" text NOT NULL,
	"group_id" text NOT NULL,
	"team_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_group_overrides_pkey" PRIMARY KEY("workspace_id","group_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_group_overrides_team_name_idx"
ON "funding_group_overrides" USING btree ("team_name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funding_group_override_audits" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" text NOT NULL,
	"group_id" text NOT NULL,
	"previous_team_name" text,
	"new_team_name" text,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_group_override_audits_identity_created_idx"
ON "funding_group_override_audits" USING btree
("workspace_id","group_id","created_at","id");
--> statement-breakpoint
-- Repeat the stable trigger function definition so this additive delta remains
-- valid in contract-generator fixtures and repaired histories where the
-- relation baseline exists without migration 0008's function object.
CREATE OR REPLACE FUNCTION "advance_configuration_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE "configuration_revision"
	SET "revision" = "revision" + 1
	WHERE "singleton" = true;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "funding_group_overrides_configuration_dml" ON "funding_group_overrides";
CREATE TRIGGER "funding_group_overrides_configuration_dml"
AFTER INSERT OR UPDATE OR DELETE ON "funding_group_overrides"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
DROP TRIGGER IF EXISTS "funding_group_overrides_configuration_truncate" ON "funding_group_overrides";
CREATE TRIGGER "funding_group_overrides_configuration_truncate"
AFTER TRUNCATE ON "funding_group_overrides"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();