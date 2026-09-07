/** Preserve the result URL separately from the detail page's reporting window. */
export function spendDetailHref(path: string, returnTo: string): string {
  const source = new URLSearchParams(returnTo.split('?')[1]);
  const params = new URLSearchParams({ returnTo });
  for (const key of ['rangeType', 'startDate', 'endDate']) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  return `${path}?${params}`;
}

export function updateSpendParams(search: string, updates: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams(search);
  const resetKeys = ['search', 'tab', 'pageSize', 'sort', 'status', 'workspaceId', 'viewScope'];
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