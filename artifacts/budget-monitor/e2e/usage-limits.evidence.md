# Usage Limits focused browser evidence

Run: focused browser pass only; all `/api/**` requests intercepted with fixture responses. No application code or database was changed.

## Main group flow

- Desktop navigation and page use **Usage Limits**; account group editors land on Group limits.
- Team search, local proposal edit ($100 to $150), and refresh persistence passed. The live fixture remained $75 until explicit apply.
- Exact review showed workspace/group IDs, old $75 and new $150. The intercepted apply body contained only that single reviewed target; confirmed outcome rendered.
- At 390px the page had no horizontal overflow; mobile navigation and review dialog controls were accessible.
- Representative screenshots: `zt2akp` (persisted proposal), `puyeoa` (confirmed exact-target apply), `w8knsn` (mobile group review).

## Completed blocked checks

- Cleared poisoned `localStorage` before retrying Individual limits. The prior `activeOperations` value came from an incomplete prepare mock.
- With the full operation fixture (`counts`, `targets[]`, `history`, timestamps, error fields, fingerprint, actor), Individual limits rendered its review dialog at 390px.
- Review dialog showed Alex Explicit, current `$100.00`, proposed `$150.00`, operation `00000000`, and `Review only — no limits have been changed`. No commit was made.
- Fresh account fixture with failed group apply retained `failed — Reviewed value changed`, `Retry exact target`, and `Renew review`.
- Retry issued another exact mocked apply request and retained the failure state.
- Renew issued the mocked reconcile request and returned a clean review dialog for the same exact target.
- Fresh `team_admin`, `member`, and preview/read-only contexts each rendered `403 · Access denied`.
- Permission request logs for all three contained only auth requests; none issued `/api/admin/team-budgets/targets`, `/api/admin/team-budgets/sync`, or `/api/admin/team-budgets/apply`.

## Evidence screenshots

- `93fk1x`: mobile Individual review dialog after clearing localStorage.
- `387ner`: failed group apply with Retry/Renew controls.
- `o7pssi`: failed state retained after retry.
- `p3t7r4`: clean review state after renewal.
- `o3h7l3`: team-admin forbidden state.
- `6ad2ua`: member forbidden state.
- `qtpwuy`: preview/read-only forbidden state.

## Automated checks and limits of verification

- Focused Usage Limits UI/navigation/individual-operation tests passed. Both frontend and API TypeScript checks passed.
- Focused backend team-target, authorization, allocation-isolation, and individual operation/policy tests passed. Additional regressions cover lost-response retries, invalid mappings, and a zero proposal's existing clear-cap semantics.
- Workspace-admin and delegate capability/deep-link boundaries are covered by UI and backend tests; browser permission evidence above covers team-admin/member/preview fixtures.
- The initial broad frontend invocation exposed unrelated failures outside Usage Limits (3 suites, 8 failures, including Dashboard and Spend expectations). Those pre-existing dirty-tree changes were not repaired as part of this work.
- These browser checks validate fixture-backed UI contracts, not live financial writes. No real Replit limits were applied and the unchanged individual commit flow was not browser-submitted.