export type AllocationDraft = {
  teamName: string;
  month: string;
  amountUsd: number;
};

export function getAllocationPermissions(capabilities: {
  canEditAllocations: boolean;
  canManageAccess: boolean;
}, isReadOnly = false) {
  return {
    canEdit: !isReadOnly && capabilities.canEditAllocations,
    canManageVisibility: !isReadOnly && capabilities.canManageAccess,
    canViewAudit: !isReadOnly && capabilities.canEditAllocations,
  };
}

export function filterVisibleTeams<T extends { isHidden: boolean }>(
  teams: T[],
  canManageVisibility: boolean,
): T[] {
  return canManageVisibility ? teams : teams.filter((team) => !team.isHidden);
}

export function filterVisibleAudits<T extends { teamName: string }>(
  changes: T[],
  visibleTeamNames: Set<string>,
  canManageVisibility: boolean,
): T[] {
  return canManageVisibility
    ? changes
    : changes.filter((change) => visibleTeamNames.has(change.teamName));
}

const USD_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseAllocationAmount(
  value: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): { value?: number; error?: string } {
  const trimmed = value.trim();
  if (!USD_PATTERN.test(trimmed)) {
    return { error: 'Enter a dollar amount with no more than two decimal places.' };
  }
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || (allowZero ? amount < 0 : amount <= 0)) {
    return { error: allowZero ? 'Amount cannot be negative.' : 'Amount must be greater than zero.' };
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents)) {
    return { error: 'Amount is too large.' };
  }
  return { value: cents / 100 };
}

export function normalizeMonthlyAllocation(
  teamName: string,
  month: string,
  amount: string,
): { draft?: AllocationDraft; error?: string } {
  if (!teamName) return { error: 'Select a team.' };
  if (!MONTH_PATTERN.test(month)) return { error: 'Select a valid month.' };
  const parsed = parseAllocationAmount(amount);
  return parsed.error
    ? { error: parsed.error }
    : { draft: { teamName, month, amountUsd: parsed.value! } };
}

export function allocationPayloadFingerprint(draft: AllocationDraft): string {
  return JSON.stringify([draft.teamName, draft.month, draft.amountUsd]);
}