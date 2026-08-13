CREATE TABLE "editor_bootstrap_state" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"completed_by" varchar,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
