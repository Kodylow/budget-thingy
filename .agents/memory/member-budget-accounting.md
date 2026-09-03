---
name: Member budget accounting
description: Source-of-truth and fail-closed rules for Replit workspace user budgets and Remaining.
---

Treat a Replit member limit as one workspace/user value, regardless of how many role groups display that user. Compute Remaining only from a complete current-billing-cycle workspace member observation filtered to the Agent metric. If the metric breakdown or sync completeness is unavailable, show usage and Remaining as unknown rather than zero. The configured Enterprise budgets credential is already provisioned for budget writes and may be used directly.

**Why:** Group-cluster spend includes broader metrics and follows the selected reporting range, while role-group observations can repeat a user. Either source can produce a misleading Remaining value for a workspace-scoped Replit limit. The credential's grants are managed upstream; a second local permission check can contradict them and incorrectly disable usage limits.

**How to apply:** Join limits by stable workspace/user identity; keep the member-budget query independent of reporting-range parameters; accept negative Remaining; fail closed on conflicting limits, partial usage, or missing metrics. When the Enterprise budgets credential is configured, use it for reads and writes without a second local feature flag or connector-metadata scope check; let upstream 401/403 responses enforce authorization. For bulk writes, validate the complete deduplicated workspace roster before the first mutation and return per-user upstream outcomes. Use connector capability discovery only when no Enterprise budgets credential is configured.