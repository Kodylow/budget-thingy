WITH duplicate_keys AS (
	SELECT "family_key"
	FROM "family_team_mappings"
	WHERE "is_legacy" = false
	GROUP BY "family_key"
	HAVING count(DISTINCT "workspace_id") > 1
),
draft_inferred_targets AS (
	SELECT target."workspace_id", target."group_id"
	FROM "team_limit_targets" AS target
	JOIN "family_team_mappings" AS mapping
		ON mapping."workspace_id" = target."workspace_id"
		AND mapping."team_name" = target."team_name"
		AND mapping."team_name" =
			mapping."family_name" || ' [' || mapping."workspace_id" || ']'
	JOIN duplicate_keys ON duplicate_keys."family_key" = mapping."family_key"
	WHERE target."assignment_source" = 'automatic'
	GROUP BY target."workspace_id", target."group_id"
	HAVING count(*) = 1
)
UPDATE "team_limit_targets" AS target
SET "assignment_source" = 'unconfirmed'
FROM draft_inferred_targets AS inferred
WHERE target."workspace_id" = inferred."workspace_id"
	AND target."group_id" = inferred."group_id"
	AND target."assignment_source" = 'automatic';