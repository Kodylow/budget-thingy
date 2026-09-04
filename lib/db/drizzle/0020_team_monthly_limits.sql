ALTER TABLE "team_budgets"
  ADD COLUMN IF NOT EXISTS "monthly_limit_usd" double precision,
  ADD COLUMN IF NOT EXISTS "monthly_limit_source" text DEFAULT 'derived' NOT NULL;

CREATE TABLE IF NOT EXISTS "team_limit_targets" (
  "team_name" text NOT NULL,
  "workspace_id" text NOT NULL,
  "group_id" text NOT NULL,
  "group_name" text NOT NULL,
  "monthly_limit_usd" double precision,
  "is_enabled" boolean DEFAULT true NOT NULL,
  PRIMARY KEY ("workspace_id", "group_id")
);

INSERT INTO "team_limit_targets" ("team_name", "workspace_id", "group_id", "group_name")
VALUES
  ('Comcast Advertising', 'h7b8kqg88e', '8BGWR2yj', 'AZ-Replit - Comcast Advertising - Member'),
  ('Comcast Business Consumer Solutions', '66ox9cntlf', 'biqK255d', 'AZ-Replit - Comcast Business Customer Solutions - Member'),
  ('Comcast Business Marketing', '66ox9cntlf', 'Wbmoq9om', 'AZ-Replit - Comcast Business Marketing - Member'),
  ('Content Acquisition', '5hkg15xcxd', 'bVhKuOQM', 'AZ-Replit - Content Acquisition - Member'),
  ('Corporate Communications', 'stk0jl35jw', 'qDIUFV0h', 'AZ-Replit - Corporate Communications - Member'),
  ('DXP', 'ntcqubwqvl', 'gzeQpyya', 'AZ-Replit - Growth Strategy & Operations - Member'),
  ('EBI AI ML', 'nu6ymuuhox', 'vvH4cngU', 'AZ-Replit - EBI AI ML - Member'),
  ('EBI Enterprise Analytics', 'nu6ymuuhox', 'OmRC2GN1', 'AZ-Replit - EBI Enterprise Analytics - Member'),
  ('Finance', '8h7pfz', '59T5lQxS', 'AZ-Replit - Finance - Member'),
  ('Finance', 'ha7tj2', 'tT7F9xlt', 'AZ-Replit - Finance - Member'),
  ('Freewheel', 'ysf55yjzku', '9X1LGLv2', 'AZ-Replit - Freewheel - Member'),
  ('GPO Connected Living', 'zigw1yqwrb', 'NSZwFPKE', 'AZ-Replit - GPO Connected Living - Member'),
  ('GPO Creative Services', 'zigw1yqwrb', 'V0wOlcBL', 'AZ-Replit - GPO Creative Services - Member'),
  ('GPO CTS', 'zigw1yqwrb', 'q68m2wbl', 'AZ-Replit - GPO CTS - Member'),
  ('Growth CXSO Account Mgmt', 'ntcqubwqvl', '32m70Gl8', 'AZ-Replit - Growth CXSO Account Mgmt - Member'),
  ('Growth MDU', 'ntcqubwqvl', 'ePu7SSUX', 'AZ-Replit - Growth MDU - Member'),
  ('Growth Xfinity Consumer Product Marketing', 'ntcqubwqvl', 'KBE16XLQ', 'AZ-Replit - Growth Xfinity Consumer Product Marketing - Member'),
  ('HR Compensation', 'znvqc2gqxf', 'RQ7HKxG4', 'AZ-Replit - HR Compensation - Member'),
  ('NBCU', 'hewdniynr3', 'pPymZapr', 'AZ-Replit - NBCU - Member'),
  ('Strategic Development LIFT Labs', '6g8nnwm9cc', 'BHEytHnP', 'AZ-Replit - Strategic Development LIFT Labs - Member'),
  ('Strategic Development Mosaic', '6g8nnwm9cc', 'C4ZqSTcM', 'AZ-Replit - Strategic Development Mosaic - Member'),
  ('Talent and Learning', '5b0iso4ru5', 'n9GetIm5', 'AZ-Replit - Talent and Learning - Member'),
  ('TPX IT', 'rpyg1v7i9q', 'ac7UK3Ql', 'AZ-Replit - TPX IT - Member'),
  ('Wireless', 'hyjfq2n04a', 'mEEk0Sgn', 'AZ-Replit - Wireless - Member')
ON CONFLICT ("workspace_id", "group_id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "workspace_default_limit_targets" (
  "workspace_id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "monthly_limit_usd" double precision DEFAULT 1 NOT NULL,
  "is_enabled" boolean DEFAULT true NOT NULL
);
INSERT INTO "workspace_default_limit_targets"
  ("workspace_id", "display_name", "monthly_limit_usd")
VALUES ('1awqan', 'Legacy workspace per-user cap', 1)
ON CONFLICT ("workspace_id") DO NOTHING;

ALTER TABLE "team_budget_upstream_sync"
  DROP CONSTRAINT IF EXISTS "team_budget_upstream_sync_pkey";
ALTER TABLE "team_budget_upstream_sync"
  ADD COLUMN IF NOT EXISTS "id" integer GENERATED ALWAYS AS IDENTITY;
ALTER TABLE "team_budget_upstream_sync"
  ADD CONSTRAINT "team_budget_upstream_sync_pkey" PRIMARY KEY ("id");
ALTER TABLE "team_budget_upstream_sync"
  ADD COLUMN IF NOT EXISTS "target_type" text DEFAULT 'group' NOT NULL;
UPDATE "team_budget_upstream_sync"
  SET "status" = 'drift'
  WHERE "status" = 'pending';
UPDATE "team_budget_upstream_sync"
  SET "status" = 'failed'
  WHERE "status" = 'unresolved';
ALTER TABLE "team_budget_upstream_sync"
  ALTER COLUMN "status" SET DEFAULT 'failed';
-- This table stores the latest state for each upstream target rather than an
-- append-only history. A partially upgraded database can contain more than one
-- legacy row for the same all-null target identity. Retain the newest state
-- deterministically and remove only the superseded states before installing
-- the exact-target uniqueness constraint.
WITH "ranked_target_states" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workspace_id", "target_type", "target_group_id"
      ORDER BY
        "last_attempt_at" DESC NULLS LAST,
        "updated_at" DESC,
        "id" DESC
    ) AS "target_state_rank"
  FROM "team_budget_upstream_sync"
)
DELETE FROM "team_budget_upstream_sync" AS "sync"
USING "ranked_target_states" AS "ranked"
WHERE "sync"."id" = "ranked"."id"
  AND "ranked"."target_state_rank" > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "team_budget_upstream_sync_target_idx"
  ON "team_budget_upstream_sync" ("workspace_id", "target_type", "target_group_id")
  NULLS NOT DISTINCT;

DROP TABLE IF EXISTS "group_teams";
