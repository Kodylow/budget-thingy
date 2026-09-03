export type ServerRole =
  | 'account_admin'
  | 'account_delegate'
  | 'account_editor'
  | 'workspace_admin';

export type PreviewSelection =
  | { role: 'account_admin' | 'account_editor'; groupId: null; groupName: null }
  | {
      role: 'workspace_admin';
      /** Canonical scope identifier; legacy persisted previews contain a raw group ID here. */
      groupId: string;
      /** Every raw Replit group included in the simulated logical scope. */
      groupIds: string[];
      groupName: string;
    };

export function canUseRbacPreview(role: ServerRole | null | undefined): boolean {
  return role === 'account_admin' || role === 'account_delegate';
}

export function sanitizePreview(
  realRole: ServerRole | null | undefined,
  requested: PreviewSelection | null,
): PreviewSelection | null {
  if (!canUseRbacPreview(realRole) || !requested) return null;
  if (requested.role === 'workspace_admin') {
    const groupId = typeof requested.groupId === 'string' ? requested.groupId.trim() : '';
    const groupName = typeof requested.groupName === 'string' ? requested.groupName.trim() : '';
    if (!groupId || !groupName) return null;
    const requestedIds = Array.isArray(requested.groupIds) ? requested.groupIds : [];
    const normalizedIds = [...new Set(
      requestedIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    )];
    const groupIds = normalizedIds.length > 0 ? normalizedIds : [groupId];
    return { role: 'workspace_admin', groupId, groupIds, groupName };
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
  const allowedIds = new Set(preview.groupIds);
  return groups.filter((group) => allowedIds.has(group.groupId));
}

export function canOpenGroupInView(
  groupId: string,
  role: ServerRole | 'denied' | null,
  preview: PreviewSelection | null,
): boolean {
  return role !== 'workspace_admin' || !preview?.groupId || preview.groupIds.includes(groupId);
}

export function filterAlertsForView<T extends { entityType: string; entityId: string }>(
  alerts: T[],
  preview: PreviewSelection | null,
): T[] {
  if (preview?.role !== 'workspace_admin') return alerts;
  const allowedIds = new Set(preview.groupIds);
  return alerts.filter(
    (alert) => alert.entityType === 'group' && allowedIds.has(alert.entityId),
  );
}
