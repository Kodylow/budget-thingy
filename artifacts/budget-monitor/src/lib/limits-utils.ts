import { SetLimitsMember, SetLimitsGroup } from '@workspace/api-client-react';

export interface LimitsUrlContext {
  workspaceId: string | null;
  groupIds: string[];
}

export function parseLimitsUrlContext(search: string): LimitsUrlContext {
  const params = new URLSearchParams(search);
  const workspaceId = params.get('workspaceId')?.trim() || null;
  const groupIds = [
    ...params.getAll('groupId'),
    ...(params.get('groupIds')?.split(',') ?? []),
  ].map((id) => id.trim()).filter(Boolean);

  return { workspaceId, groupIds: [...new Set(groupIds)] };
}

export function resolveLimitsWorkspaceId(
  requestedWorkspaceId: string | null,
  currentWorkspaceId: string | null,
  availableWorkspaces: string[],
): string | null {
  if (requestedWorkspaceId && availableWorkspaces.includes(requestedWorkspaceId)) {
    return requestedWorkspaceId;
  }
  if (currentWorkspaceId && availableWorkspaces.includes(currentWorkspaceId)) {
    return currentWorkspaceId;
  }
  return availableWorkspaces.length === 1 ? availableWorkspaces[0] : null;
}

export function isValidAmount(val: string): boolean {
  if (!val) return false;
  // Must be positive USD, max two decimals, no blank/zero
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(val)) return false;
  const num = parseFloat(val);
  if (!Number.isFinite(num) || num <= 0) return false;
  return true;
}

export function isMemberSelectable(member: SetLimitsMember): boolean {
  return Boolean(member.eligible && !member.isInternal && !member.isDisabled);
}

export function getSelectableGroupUserIds(group: SetLimitsGroup, members: SetLimitsMember[]): string[] {
  const membersById = new Map(members.map(m => [m.userId, m]));
  return group.eligibleUserIds.filter(id => {
    const m = membersById.get(id);
    return m && isMemberSelectable(m);
  });
}

export function getSelectableContextUserIds(
  groupIds: string[],
  groups: SetLimitsGroup[],
  members: SetLimitsMember[],
): string[] {
  if (groupIds.length === 0) return [];
  const requested = new Set(groupIds);
  const visibleIds = new Set<string>();
  for (const group of groups) {
    if (!requested.has(group.groupId)) continue;
    for (const userId of getSelectableGroupUserIds(group, members)) visibleIds.add(userId);
  }
  return [...visibleIds];
}

export function getContextSelectionUpdate(
  previousContextKey: string | null,
  groupIds: string[],
  groups: SetLimitsGroup[],
  members: SetLimitsMember[],
): { contextKey: string; userIds: string[] } | null {
  const contextKey = groupIds.join('\0');
  if (previousContextKey === contextKey) return null;
  // A first render without context is the ordinary manual-selection workflow.
  if (previousContextKey === null && contextKey === '') return null;
  return {
    contextKey,
    userIds: contextKey
      ? getSelectableContextUserIds(groupIds, groups, members)
      : [],
  };
}
