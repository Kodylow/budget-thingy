CREATE TABLE "usage_sync_chunks" (
	"mode" text NOT NULL,
	"range_key" text NOT NULL,
	"scope_key" text NOT NULL,
	"chunk_start" timestamp with time zone NOT NULL,
	"chunk_end" timestamp with time zone NOT NULL,
	"payload_json" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_sync_chunks_mode_range_key_scope_key_chunk_start_pk" PRIMARY KEY("mode","range_key","scope_key","chunk_start")
);
--> statement-breakpoint
CREATE TABLE "usage_sync_state" (
	"mode" text NOT NULL,
	"range_key" text NOT NULL,
	"scope_key" text NOT NULL,
	"range_start" timestamp with time zone NOT NULL,
	"synced_through" timestamp with time zone NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_sync_state_mode_range_key_scope_key_pk" PRIMARY KEY("mode","range_key","scope_key")
);
--> statement-breakpoint
CREATE INDEX "usage_sync_chunks_scope_idx" ON "usage_sync_chunks" USING btree ("mode","range_key","scope_key");