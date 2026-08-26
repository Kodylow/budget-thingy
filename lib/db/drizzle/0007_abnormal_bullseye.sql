CREATE TABLE "api_billing_period_cache" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
