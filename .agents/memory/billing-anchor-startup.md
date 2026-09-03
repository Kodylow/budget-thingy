---
name: Billing anchor startup
description: Startup and rollover rules for choosing the Enterprise billing window before account-total verification.
---

Begin listening from hydrated metadata only; perform live billing discovery later under the cross-replica scheduler claim. A changed interval becomes authoritative only after two identical consecutive persisted observations. Hydrated metadata is a resilience fallback only while its interval is active; once its end has passed, range, status, pace, and banner semantics must all use the cutoff fallback until the new interval is confirmed.

**Why:** Persisted metadata can be stale or contaminated by test fixtures. Verifying against it first can heal the wrong interval and publish a misleading headline; separately resolving the range while still describing the expired period as active creates contradictory UI.

**How to apply:** Any startup or rollover change must resolve active billing eligibility once, use that result consistently across verification and presentation, and refresh billing before planning range-bound scheduler work without delaying the listening socket.

Cache-hydration tests must not run startup revalidation or persist mocked billing/verification singleton records.

**Why:** The test suite shares the development database with the preview. A mocked startup fetch can overwrite the live billing interval or verified account total even when ordinary fixture rows use unique IDs.

**How to apply:** Use hydration-only initialization in tests, keep billing refresh persistence disabled for mocked interval checks, and keep test verification status in memory while production continues persisting it.