CREATE TABLE IF NOT EXISTS "group_user_limit_policies" (
	"workspace_id" text NOT NULL,
	"group_id" text NOT NULL,
	"amount_usd" double precision,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_user_limit_policies_pkey" PRIMARY KEY("workspace_id","group_id"),
	CONSTRAINT "group_user_limit_policies_positive_amount" CHECK ("group_user_limit_policies"."amount_usd" is null or "group_user_limit_policies"."amount_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_limit_policy_assignments" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_amount_usd" double precision NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_limit_policy_assignments_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "member_limit_policy_assignments_positive_amount" CHECK ("member_limit_policy_assignments"."last_amount_usd" > 0)
);
--> statement-breakpoint
ALTER TABLE "alert_delivery_claims" ADD COLUMN IF NOT EXISTS "alert_type" text DEFAULT 'allocation_threshold' NOT NULL;
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "alert_type" text DEFAULT 'allocation_threshold' NOT NULL;
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "blocked_member_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_class index_class
		JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
		JOIN pg_index index_metadata ON index_metadata.indexrelid = index_class.oid
		WHERE index_namespace.nspname = current_schema()
			AND index_class.relname = 'alert_delivery_claims_unique'
			AND NOT EXISTS (
				SELECT 1
				FROM unnest(index_metadata.indkey) AS indexed_column(attnum)
				JOIN pg_attribute table_column
					ON table_column.attrelid = index_metadata.indrelid
					AND table_column.attnum = indexed_column.attnum
				WHERE table_column.attname = 'alert_type'
			)
	) THEN
		DROP INDEX "alert_delivery_claims_unique";
	END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS "alert_delivery_claims_unique" ON "alert_delivery_claims" USING btree ("entity_type","entity_id","alert_type","billing_period","threshold");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_budget_allocation_audits" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "team_budget_allocation_audits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"team_name" text NOT NULL,
	"field" text NOT NULL,
	"old_value" jsonb NOT NULL,
	"new_value" jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_budget_allocation_audits_team_created_idx" ON "team_budget_allocation_audits" USING btree ("team_name","created_at","id");