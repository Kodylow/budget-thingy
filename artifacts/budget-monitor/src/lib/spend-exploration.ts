/** Preserve the result URL separately from the detail page's reporting window. */
export function spendDetailHref(path: string, returnTo: string): string {
  const safeReturnTo = sanitizeSpendReturnTo(returnTo);
  const source = new URLSearchParams(safeReturnTo.split('?')[1]);
  const params = new URLSearchParams({ returnTo: safeReturnTo });
  for (const key of ['rangeType', 'startDate', 'endDate', 'viewScope', 'workspaceId']) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  return `${path}?${params}`;
}

const SAFE_RETURN_PATHS = ['/spend', '/org-insights', '/overview', '/home', '/users/', '/workspaces/'];

export function sanitizeSpendReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/spend';
  try {
    const parsed = new URL(value, 'https://budget-monitor.invalid');
    if (parsed.origin !== 'https://budget-monitor.invalid') return '/spend';
    if (!SAFE_RETURN_PATHS.some((path) => parsed.pathname === path || (path.endsWith('/') && parsed.pathname.startsWith(path)))) {
      return '/spend';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/spend';
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