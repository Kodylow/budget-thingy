export type ServerRole =
  | 'account_admin'
  | 'account_delegate'
  | 'account_editor'
  | 'workspace_admin';

export type PreviewSelection =
  | { role: 'account_admin' | 'account_editor'; groupId: null; groupName: null }
  | { role: 'workspace_admin'; groupId: string; groupName: string };

export function canUseRbacPreview(role: ServerRole | null | undefined): boolean {
  return role === 'account_admin' || role === 'account_delegate';
}

export function sanitizePreview(
  realRole: ServerRole | null | undefined,
  requested: PreviewSelection | null,
): PreviewSelection | null {
  if (!canUseRbacPreview(realRole) || !requested) return null;
  if (requested.role === 'workspace_admin') {
    return requested.groupId.trim() && requested.groupName.trim() ? requested : null;
  }
  return requested.role === 'account_admin' || requested.role === 'account_editor'
    ? requested
    : null;
}

export function isAccountWideView(role: ServerRole | 'denied' | null): boolean {
  return role === 'account_admin' || role === 'account_delegate' || role === 'account_editor';
}

export function filterGroupsForView<T extends { groupId: string }>(
  groups: T[],
  role: ServerRole | 'denied' | null,
  preview: PreviewSelection | null,
): T[] {
  if (role !== 'workspace_admin' || !preview?.groupId) return groups;
  return groups.filter((group) => group.groupId === preview.groupId);
}

export function canOpenGroupInView(
  groupId: string,
  role: ServerRole | 'denied' | null,
  preview: PreviewSelection | null,
): boolean {
  return role !== 'workspace_admin' || !preview?.groupId || preview.groupId === groupId;
}