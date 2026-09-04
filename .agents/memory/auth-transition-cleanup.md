---
name: Auth transition cleanup
description: Why protected-state cleanup must distinguish terminal identity changes from transient authorization resolution.
---

Authorization hooks may intentionally clear the current user, authorization,
and capabilities before resolving a preview or retry. Identity or capability
cleanup must not interpret that temporary empty state as logout, revocation, or
a reason to reset the selected preview.

**Why:** A preview request correctly returned a scoped authorization (and later
an invalid-preview 400), but cleanup observed an intermediate empty identity
and immediately restored real access. This masked the invalid-preview gate and
made valid preview selection race-dependent.

**How to apply:** Ignore unresolved loading, unavailable, and invalid-preview
states when comparing identities. Run logout/revocation cleanup only after a
terminal identity result, and only auto-reset a preview from a fully resolved
authorization that explicitly identifies itself as a preview.