CREATE TABLE "group_budgets" (
	"group_id" text PRIMARY KEY NOT NULL,
	"amount_usd" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_emails_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"group_name" text NOT NULL,
	"threshold" integer NOT NULL,
	"spend_usd" double precision NOT NULL,
	"budget_usd" double precision NOT NULL,
	"recipients" text[] NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fired_thresholds" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"billing_period" text NOT NULL,
	"threshold" integer NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_teams" (
	"group_name" text PRIMARY KEY NOT NULL,
	"team_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_budgets" (
	"team_name" text PRIMARY KEY NOT NULL,
	"amount_usd" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_directory_cache" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"directory_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_spend_cache" (
	"range_key" text NOT NULL,
	"group_id" text NOT NULL,
	"spend_usd" double precision NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_spend_cache_range_key_group_id_pk" PRIMARY KEY("range_key","group_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fired_thresholds_unique" ON "fired_thresholds" USING btree ("group_id","billing_period","threshold");