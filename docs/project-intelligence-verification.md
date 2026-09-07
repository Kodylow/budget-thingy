# Project intelligence verification

Verified in development on 2026-09-07.

## Completed checks

- OpenAPI generation and workspace TypeScript checks passed.
- Focused API checks covered metadata and deployment pagination/fallback, legacy
  observations, exact stale boundaries, workspace/personal/group authorization,
  ownership transfers, zero-spend inventory, list/card reconciliation, and cached
  group membership.
- The additive migration was applied to development. A separate migration test
  upgrades an old-shape table containing a legacy row, applies the migration twice,
  and confirms existing facts survive while new fields remain null. The checker
  fixture was upgraded with the same migration; its focused run passed.
- The dashboard unit suite passed except for an obsolete Published-column
  expectation. That expectation was updated for the new deployment and
  last-updated columns, and the affected suite passed. Additional scope,
  capability, route-workspace and owner-link regressions passed.
- The separate project-intelligence browser specification verified all six flows:
  project-to-owner navigation; persisted filters/sorting; stale-card drill-through;
  keyboard-accessible group expansion; denied preview reads; and removal of
  previously visible groups after an effective-identity change. A scope propagation
  failure was fixed and only that affected journey was rerun successfully.
- The API and web workflows started cleanly; the health endpoint returned 200.
  Scheduled enrichment completed successfully without a page-triggered refresh.

## Completion-gate repairs

The full API run reported 142 failing tests. Fourteen failures came from an
old-shape in-memory checker fixture and were fixed and verified with the real
additive migration. The remaining authorization/team-budget failures initially
came from missing request loggers in two existing test harnesses. Minimal logger
stubs were added to unblock required completion validation. Three export
assertions were then updated to preserve workspace-qualified history while
expecting only the newest UUID destination in the current project export; formula
escaping and workspace filtering remain tested.

Completion reconciliation also exposed broken web/mobile OIDC code in the shared
authentication changes. Fresh PKCE/nonce/state generation and new session issuance
were restored without dropping the concurrent diagnostics or admin bootstrap.
Four simulated HTTP regressions and a non-incremental API typecheck passed.
No actual OIDC credentials or live sessions were used.

A subsequent full run had 607 passing tests and three timer-exhaustion failures
during concurrent database-fixture startup and a multi-request performance test.
Worker concurrency was bounded rather than removing tests or relaxing endpoint
latency assertions.

The existing broad browser regression suite was not repaired or rerun.

## Live and release boundaries

Browser journey checks used explicitly labeled sample API responses. The
development auth endpoint and preview were signed out, so authenticated read-only
checks across the configured workspaces were not available. Sample browser checks
do not establish live permissions, deployment reachability, or production behavior.

No production database migration or deployment was performed. Use the guarded
release process in `docs/database-setup.md` for the additive metadata migration
before releasing code that reads the new columns.