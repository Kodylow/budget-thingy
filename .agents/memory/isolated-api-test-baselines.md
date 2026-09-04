---
name: Isolated API test baselines
description: Why isolated API integration tests must explicitly install canonical seed data.
---

API integration tests that use fresh storage must install the application's
canonical baseline seed before file fixtures run. Tests must never depend on
rows that happen to exist in a developer's database. Test bootstrapping must
also inspect migrations for explicit shared-schema DDL rather than assuming a
worker search path redirects every statement.

**Why:** Moving the API suite to isolated storage exposed suites whose expected
baseline came from shared development fixtures. Isolation is only deterministic
when both schema and seed state are explicit. A bootstrap migration that
explicitly reset `public` bypassed search-path isolation and could erase shared
development data.

**How to apply:** When adding a new test database or schema, run migrations and
the idempotent canonical seed first, but reject or safely rewrite any migration
statement that names a shared schema. Then add suite-specific fixtures. Keep
cleanup scoped to isolated storage rather than preserving and restoring
development rows, and verify isolation with a sentinel in the shared schema.