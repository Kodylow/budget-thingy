---
name: Scoped spend reconciliation
description: Authorization rule for publishing gross, excluded, and eligible spend components.
---

Gross, excluded, and eligible spend must always be derived from the same authorized accounting units and active filters. A viewer with full workspace access may receive workspace components; a group-scoped viewer may receive only components attributed to visible groups.

**Why:** Combining workspace-wide gross or excluded spend with group-scoped eligible rows both breaks the accounting identity and discloses out-of-scope financial information.

**How to apply:** Whenever a response adds reconciliation fields, calculate all components from the exact same workspace/group/filter selection and verify `gross - excluded = eligible`.