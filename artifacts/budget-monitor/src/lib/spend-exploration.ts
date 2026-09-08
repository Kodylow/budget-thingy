import { teamOverviewHref } from './reporting-navigation';

/** Preserve the result URL separately from the detail page's reporting window. */
export function spendDetailHref(path: string, returnTo: string, fallback = '/my-projects'): string {
  const safeReturnTo = sanitizeSpendReturnTo(returnTo, fallback);
  const source = new URLSearchParams(safeReturnTo.split('?')[1]);
  const params = new URLSearchParams({ returnTo: safeReturnTo });
  for (const key of ['rangeType', 'startDate', 'endDate', 'viewScope', 'workspaceId', 'poolId']) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  return `${path}?${params}`;
}

const SAFE_RETURN_PATHS = ['/my-projects', '/my-team', '/org-insights', '/overview', '/', '/teams/', '/groups/', '/clusters', '/users/', '/workspaces/'];

export function sanitizeSpendReturnTo(value: string | null | undefined, fallback = '/my-projects'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const parsed = new URL(value, 'https://budget-monitor.invalid');
    if (parsed.origin !== 'https://budget-monitor.invalid') return fallback;
    if (['/spend', '/reports', '/workspace-directory'].includes(parsed.pathname)) {
      const poolId = parsed.searchParams.get('poolId');
      if (poolId !== null) return teamOverviewHref(poolId, parsed.search);
      const tab = parsed.searchParams.get('tab') ?? parsed.searchParams.get('view');
      if (tab === 'projects' && parsed.searchParams.get('viewScope') === 'my') {
        parsed.searchParams.delete('tab');
        parsed.searchParams.delete('view');
        parsed.searchParams.delete('viewScope');
        return `/my-projects${parsed.searchParams.size ? `?${parsed.searchParams}` : ''}`;
      }
      return fallback;
    }
    if (!SAFE_RETURN_PATHS.some((path) => parsed.pathname === path || (path !== '/' && path.endsWith('/') && parsed.pathname.startsWith(path)))) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function updateSpendParams(search: string, updates: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams(search);
  const resetKeys = ['search', 'tab', 'pageSize', 'sort', 'status', 'workspaceId', 'viewScope', 'deployedOnly', 'staleButSpending'];
  let resetPage = false;
  for (const [key, value] of Object.entries(updates)) {
    if (params.get(key) === (value ?? null)) continue;
    if (value == null) params.delete(key);
    else params.set(key, value);
    if (resetKeys.includes(key)) resetPage = true;
  }
  if (resetPage && !updates.page) params.delete('page');
  return params.toString();
}

export function spendColumns(all: string[], defaults: string[], requested: string | null): string[] {
  const selected = requested === null ? defaults : requested.split(',');
  return all.filter((column) => column === 'name' || column === 'spendUsd' || selected.includes(column));
}