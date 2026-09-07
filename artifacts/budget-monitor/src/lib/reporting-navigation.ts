/** Carry view context, not ledger pagination or filters, between reporting pages. */
export function reportingNavigationHref(path: string, search: string): string {
  const [pathname, destinationSearch] = path.split('?');
  if (!['/', '/spend', '/reports', '/org-insights', '/overview', '/my-team'].includes(pathname)) return path;
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const key of [
    'rangeType', 'startDate', 'endDate', 'viewScope', 'granularity', 'trendMode',
    'projectionHorizon', 'planningEndDate',
  ]) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  new URLSearchParams(destinationSearch).forEach((value, key) => params.set(key, value));
  return params.size ? `${pathname}?${params}` : pathname;
}

/** One active destination even when several navigation intents share Spend. */
export function reportingNavigationKey(path: string, search: string): string {
  if (path === '/my-team') return '/my-team';
  if (path !== '/spend') return path;
  const params = new URLSearchParams(search);
  if (params.get('tab') === 'projects' && params.get('viewScope') === 'my') {
    return '/spend?tab=projects&viewScope=my';
  }
  if (params.get('tab') === 'people' && params.get('viewScope') === 'managed') {
    return '/my-team';
  }
  return path;
}