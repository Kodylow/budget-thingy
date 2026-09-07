CREATE TABLE IF NOT EXISTS "configuration_revision" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "configuration_revision_singleton" CHECK ("configuration_revision"."singleton" = true)
);
--> statement-breakpoint
INSERT INTO "configuration_revision" ("singleton", "revision")
VALUES (true, 0)
ON CONFLICT ("singleton") DO NOTHING;
--> statement-breakpoint
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
DROP TRIGGER IF EXISTS "group_budgets_configuration_dml" ON "group_budgets";
CREATE TRIGGER "group_budgets_configuration_dml"
AFTER INSERT OR UPDATE OR DELETE ON "group_budgets"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
DROP TRIGGER IF EXISTS "group_budgets_configuration_truncate" ON "group_budgets";
CREATE TRIGGER "group_budgets_configuration_truncate"
AFTER TRUNCATE ON "group_budgets"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_limit_targets_configuration_dml" ON "team_limit_targets";
CREATE TRIGGER "team_limit_targets_configuration_dml"
AFTER INSERT OR UPDATE OR DELETE ON "team_limit_targets"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
DROP TRIGGER IF EXISTS "team_limit_targets_configuration_truncate" ON "team_limit_targets";
CREATE TRIGGER "team_limit_targets_configuration_truncate"
AFTER TRUNCATE ON "team_limit_targets"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_budgets_configuration_dml" ON "team_budgets";
CREATE TRIGGER "team_budgets_configuration_dml"
AFTER INSERT OR UPDATE OR DELETE ON "team_budgets"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
DROP TRIGGER IF EXISTS "team_budgets_configuration_truncate" ON "team_budgets";
CREATE TRIGGER "team_budgets_configuration_truncate"
AFTER TRUNCATE ON "team_budgets"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_budget_adjustments_configuration_dml" ON "team_budget_adjustments";
CREATE TRIGGER "team_budget_adjustments_configuration_dml"
AFTER INSERT OR UPDATE OR DELETE ON "team_budget_adjustments"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
DROP TRIGGER IF EXISTS "team_budget_adjustments_configuration_truncate" ON "team_budget_adjustments";
CREATE TRIGGER "team_budget_adjustments_configuration_truncate"
AFTER TRUNCATE ON "team_budget_adjustments"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "family_team_mappings_configuration_dml" ON "family_team_mappings";
CREATE TRIGGER "family_team_mappings_configuration_dml"
AFTER INSERT OR UPDATE OR DELETE ON "family_team_mappings"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();
DROP TRIGGER IF EXISTS "family_team_mappings_configuration_truncate" ON "family_team_mappings";
CREATE TRIGGER "family_team_mappings_configuration_truncate"
AFTER TRUNCATE ON "family_team_mappings"
FOR EACH STATEMENT EXECUTE FUNCTION "advance_configuration_revision"();