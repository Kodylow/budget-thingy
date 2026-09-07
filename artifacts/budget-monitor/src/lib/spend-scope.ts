import type { ViewScopeParameter } from '@workspace/api-client-react';

export type SpendViewScope = Extract<ViewScopeParameter, 'my' | 'managed' | 'all_authorized'>;

const VIEW_SCOPES = new Set<SpendViewScope>(['my', 'managed', 'all_authorized']);

export function resolveSpendViewScope(
  value: string | null | undefined,
  fallback: SpendViewScope = 'managed',
): SpendViewScope {
  return VIEW_SCOPES.has(value as SpendViewScope) ? value as SpendViewScope : fallback;
}

export function spendScopeLabel(
  scope: SpendViewScope,
  canViewAccountUsage: boolean,
): string {
  if (scope === 'my') return 'My spend';
  if (scope === 'managed') return 'Teams and workspaces I manage';
  return canViewAccountUsage ? 'Account spend' : 'All spend I can access';
}

export function spendScopeOptions(canViewAccountUsage: boolean): Array<{
  value: SpendViewScope;
  label: string;
}> {
  return (['managed', 'my', 'all_authorized'] as const).map((value) => ({
    value,
    label: spendScopeLabel(value, canViewAccountUsage),
  }));
}