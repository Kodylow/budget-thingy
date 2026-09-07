CREATE TABLE "group_user_limit_policies" (
	"workspace_id" text NOT NULL,
	"group_id" text NOT NULL,
	"amount_usd" double precision,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_user_limit_policies_pkey" PRIMARY KEY("workspace_id","group_id"),
	CONSTRAINT "group_user_limit_policies_positive_amount" CHECK ("group_user_limit_policies"."amount_usd" is null or "group_user_limit_policies"."amount_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "member_limit_policy_assignments" (
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
DROP INDEX "alert_delivery_claims_unique";--> statement-breakpoint
ALTER TABLE "alert_delivery_claims" ADD COLUMN "alert_type" text DEFAULT 'allocation_threshold' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "alert_type" text DEFAULT 'allocation_threshold' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "blocked_member_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_delivery_claims_unique" ON "alert_delivery_claims" USING btree ("entity_type","entity_id","alert_type","billing_period","threshold");