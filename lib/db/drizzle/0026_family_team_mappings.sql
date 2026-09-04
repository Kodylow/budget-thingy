CREATE TABLE "family_team_mappings" (
	"workspace_id" text NOT NULL,
	"family_key" text NOT NULL,
	"family_name" text NOT NULL,
	"team_name" text,
	"is_legacy" boolean NOT NULL,
	CONSTRAINT "family_team_mappings_pkey" PRIMARY KEY("workspace_id","family_key")
);
--> statement-breakpoint
CREATE INDEX "family_team_mappings_family_key_idx" ON "family_team_mappings" USING btree ("family_key");
--> statement-breakpoint
CREATE INDEX "family_team_mappings_team_name_idx" ON "family_team_mappings" USING btree ("team_name");