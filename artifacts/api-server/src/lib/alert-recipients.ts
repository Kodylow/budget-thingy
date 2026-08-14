import { db, adminEmailsTable } from "@workspace/db";

import { BOOTSTRAP_EDITOR_EMAIL, isAdminRole, normalizeEmail } from "./authz";
import { getDirectory } from "./enterprise";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function addEmail(target: Set<string>, value: string | null | undefined): void {
  if (!value) return;
  const normalized = normalizeEmail(value);
  if (EMAIL_PATTERN.test(normalized)) target.add(normalized);
}

/**
 * Resolve the intended production recipients for a group/team alert.
 * Actual environment-specific routing is applied only by the email adapter.
 */
export async function resolveAlertRecipients(
  workspaceIds: readonly string[],
): Promise<string[]> {
  const [dir, configured] = await Promise.all([
    getDirectory(),
    db.select().from(adminEmailsTable),
  ]);
  return collectAlertRecipients(dir, configured, workspaceIds);
}

export function collectAlertRecipients(
  dir: Awaited<ReturnType<typeof getDirectory>>,
  configured: readonly { email: string }[],
  workspaceIds: readonly string[],
): string[] {
  const relevantWorkspaces = new Set(workspaceIds);
  const recipients = new Set<string>();

  // The verified bootstrap identity is a mandatory recipient even before its
  // directory record is available.
  addEmail(recipients, BOOTSTRAP_EDITOR_EMAIL);

  for (const member of dir.members.values()) {
    if (member.isAccountAdmin) {
      addEmail(recipients, member.email);
      continue;
    }
    for (const workspaceId of relevantWorkspaces) {
      const membership = member.workspaces.get(workspaceId);
      if (
        membership &&
        !membership.isDisabled &&
        isAdminRole(membership.role)
      ) {
        addEmail(recipients, member.email);
        break;
      }
    }
  }

  for (const entry of configured) addEmail(recipients, entry.email);
  return [...recipients].sort();
}