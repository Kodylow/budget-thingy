WITH duplicate_keys AS (
	SELECT "family_key"
	FROM "family_team_mappings"
	WHERE "is_legacy" = false
	GROUP BY "family_key"
	HAVING count(DISTINCT "workspace_id") > 1
)
UPDATE "family_team_mappings" AS mapping
SET "team_name" = mapping."family_name" || ' [' || mapping."workspace_id" || ']'
FROM duplicate_keys
WHERE mapping."family_key" = duplicate_keys."family_key"
	AND mapping."is_legacy" = false
	AND lower(regexp_replace(trim(mapping."team_name"), '\s+', ' ', 'g')) =
		lower(regexp_replace(trim(mapping."family_name"), '\s+', ' ', 'g'))
	AND mapping."family_key" NOT IN (
		'finance',
		'growth strategy & operations',
		'strategic development mosaic',
		'preprod'
	)
	AND NOT EXISTS (
		SELECT 1
		FROM "team_limit_targets" AS target
		WHERE target."workspace_id" = mapping."workspace_id"
			AND target."team_name" = mapping."team_name"
	);
--> statement-breakpoint
INSERT INTO "team_budgets" ("team_name", "original_amount_usd", "amount_usd")
SELECT DISTINCT mapping."team_name", 0, 0
FROM "family_team_mappings" AS mapping
LEFT JOIN "team_budgets" AS budget ON budget."team_name" = mapping."team_name"
WHERE mapping."is_legacy" = false
	AND mapping."team_name" IS NOT NULL
	AND budget."team_name" IS NULL
ON CONFLICT ("team_name") DO NOTHING;