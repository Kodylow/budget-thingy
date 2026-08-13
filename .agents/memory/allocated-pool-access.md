---
name: Allocated pool access boundaries
description: Non-obvious authorization and workspace-isolation rules for pool editors and shared-team alerts.
---

Managed account editors are authorized by stable Replit user ID, not email. The designated bootstrap identity is persisted only once from an exact normalized email with a verified OIDC email claim. Bootstrap consumption survives allowlist deletion so later logins cannot undo a true admin's revocation. Only true Enterprise account admins may manage this allowlist; editors receive account-wide operational pool/check access but not recipient, system, or access settings.

**Why:** Enterprise roles remain the source of truth for ordinary users, while a narrow app role is needed without changing the Enterprise directory. Email alone is mutable and must not become the long-term authorization key.

**How to apply:** New operational controls may admit both account admins and account editors. Access management, notification recipients, and system settings must remain true-admin-only.

Workspace admins may see a shared team's configured pool and a rollup computed only from their visible groups. Do not expose an account-wide team alert when its contributing workspace list extends beyond the viewer's scope.

**Why:** The alert's spend is an account-wide deduplicated aggregate and would reveal out-of-scope workspace activity, even if one contributing workspace is visible.

**How to apply:** Scope shared-team displays from visible groups, but require all alert workspace IDs to be authorized before returning the account-wide alert record.