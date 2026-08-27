---
name: Billing anchor startup
description: Startup and rollover rules for choosing the Enterprise billing window before account-total verification.
---

Live-refresh Enterprise billing metadata before queuing the startup account-total anchor. Hydrated metadata is a resilience fallback only while its verified interval is still active; once its end has passed, range, status, pace, and banner semantics must all use the cutoff fallback.

**Why:** Persisted metadata can be stale or contaminated by test fixtures. Verifying against it first can heal the wrong interval and publish a misleading headline; separately resolving the range while still describing the expired period as active creates contradictory UI.

**How to apply:** Any startup or rollover change must resolve active billing eligibility once, use that result consistently across verification and presentation, and place the single account anchor ahead of bulk cold-scope warm-up.