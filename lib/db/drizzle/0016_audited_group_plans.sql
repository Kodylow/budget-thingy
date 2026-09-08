CREATE TABLE IF NOT EXISTS "group_plans" (
  "workspace_id" text NOT NULL,
  "group_id" text NOT NULL,
  "team_name" text NOT NULL,
  "funding_period_start" date NOT NULL,
  "funding_period_end" date NOT NULL,
  "mapping_identity" text NOT NULL,
  "amount_usd_cents" bigint NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "group_plans_pkey" PRIMARY KEY("workspace_id","group_id"),
  CONSTRAINT "group_plans_nonnegative_amount" CHECK ("amount_usd_cents" >= 0),
  CONSTRAINT "group_plans_safe_integer_amount" CHECK ("amount_usd_cents" <= 9007199254740991),
  CONSTRAINT "group_plans_positive_revision" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_plans_team_name_idx"
ON "group_plans" USING btree ("team_name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_plan_audits" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "workspace_id" text NOT NULL,
  "group_id" text NOT NULL,
  "team_name" text NOT NULL,
  "funding_period_start" date NOT NULL,
  "funding_period_end" date NOT NULL,
  "mapping_identity" text NOT NULL,
  "previous_amount_usd_cents" bigint,
  "new_amount_usd_cents" bigint NOT NULL,
  "previous_revision" integer,
  "new_revision" integer NOT NULL,
  "actor_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_plan_audits_identity_created_idx"
ON "group_plan_audits" USING btree
("workspace_id","group_id","created_at","id");