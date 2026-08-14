CREATE TABLE "alert_delivery_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"billing_period" text NOT NULL,
	"threshold" integer NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "alert_delivery_claims_unique" ON "alert_delivery_claims" ("entity_type","entity_id","billing_period","threshold");