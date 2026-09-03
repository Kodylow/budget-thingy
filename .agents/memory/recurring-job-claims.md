---
name: Recurring job claims
description: Durable rules for coordinating recurring work safely across autoscaled API replicas.
---

Recurring work must use a database-time lease with an opaque owner token, a separate next-cadence deadline, and owner-checked renewal, cursor updates, and release. Crash recovery applies only to an expired row that still has an owner; normal release clears the owner and remains blocked until the cadence deadline. Every successful recovery starts a fresh cadence deadline.

**Why:** Treating every expired lease as recoverable after normal release allows polling replicas to rerun daily or hourly work at the poll interval. Silently ignoring renewal loss can also let a stale worker report success after a replacement owner has recovered the job.

**How to apply:** Keep network work outside claim transactions. Use database time for acquisition, renew bounded leases during longer work, expose ownership loss cooperatively to the worker, check it around external operations, and persist fair-work cursors only with the current owner token.