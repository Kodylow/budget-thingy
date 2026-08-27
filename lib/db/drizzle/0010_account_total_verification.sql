CREATE TABLE "api_account_total_verification" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"error_message" text,
	"range_key" text NOT NULL,
	"range_start" timestamp with time zone NOT NULL,
	"range_end" timestamp with time zone NOT NULL,
	"upstream_total_usd" double precision,
	"stored_total_usd" double precision,
	"delta_usd" double precision
);