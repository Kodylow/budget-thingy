---
name: Billing anchor startup
description: Startup and rollover rules for choosing the Enterprise billing window before account-total verification.
---

Live-refresh Enterprise billing metadata before queuing the startup account-total anchor. Hydrated metadata is a resilience fallback only while its verified interval is still active; once its end has passed, range, status, pace, and banner semantics must all use the cutoff fallback.

**Why:** Persisted metadata can be stale or contaminated by test fixtures. Verifying against it first can heal the wrong interval and publish a misleading headline; separately resolving the range while still describing the expired period as active creates contradictory UI.

**How to apply:** Any startup or rollover change must resolve active billing eligibility once, use that result consistently across verification and presentation, and place the single account anchor ahead of bulk cold-scope warm-up.

Cache-hydration tests must not run startup revalidation or persist mocked billing/verification singleton records.

**Why:** The test suite shares the development database with the preview. A mocked startup fetch can overwrite the live billing interval or verified account total even when ordinary fixture rows use unique IDs.

**How to apply:** Use hydration-only initialization in tests, keep billing refresh persistence disabled for mocked interval checks, and keep test verification status in memory while production continues persisting it.