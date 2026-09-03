---
name: Member budget accounting
description: Source-of-truth and fail-closed rules for Replit workspace user budgets and Remaining.
---

Treat a Replit member limit as one workspace/user value, regardless of how many role groups display that user. Compute Remaining only from a complete current-billing-cycle workspace member observation filtered to the Agent metric. If the metric breakdown or sync completeness is unavailable, show usage and Remaining as unknown rather than zero. Read and write limits only through the approved Replit connector; configured Enterprise API keys must never become a fallback.

**Why:** Group-cluster spend includes broader metrics and follows the selected reporting range, while role-group observations can repeat a user. Either source can produce a misleading Remaining value for a workspace-scoped Replit limit. Connector authorization is the permission boundary; API-key fallback would silently bypass missing `write:budgets` consent.

**How to apply:** Join limits by stable workspace/user identity; keep the member-budget query independent of reporting-range parameters; accept negative Remaining; fail closed on conflicting limits, partial usage, missing metrics, or connector capability uncertainty. For bulk writes, validate the complete deduplicated workspace roster before the first mutation and return per-user upstream outcomes. When discovering connector capabilities, list all connections with only the supported `connector` expansion and filter locally; the current API rejects connector-name filtering and the `integration` expansion with HTTP 400.