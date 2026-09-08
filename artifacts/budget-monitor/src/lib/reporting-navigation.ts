/** Carry view context, not ledger pagination or filters, between reporting pages. */
export function reportingNavigationHref(path: string, search: string): string {
  const [pathname, destinationSearch] = path.split('?');
  if (pathname === '/org-insights') return path;
  if (!['/', '/overview', '/my-team', '/my-projects'].includes(pathname) && !pathname.startsWith('/teams/')) return path;
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const key of [
    'rangeType', 'startDate', 'endDate', 'granularity', 'trendMode',
    'projectionHorizon', 'planningEndDate',
  ]) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  new URLSearchParams(destinationSearch).forEach((value, key) => params.set(key, value));
  return params.size ? `${pathname}?${params}` : pathname;
}

export function reportingNavigationKey(path: string, search: string): string {
  if (path === '/my-team') return '/my-team';
  return path;
}

/** Canonical funded-team URL. The canonical ID is encoded exactly once here. */
export function teamOverviewHref(poolId: string, search = ''): string {
  return reportingNavigationHref(`/teams/${encodeURIComponent(poolId)}`, search);
}

export function legacyReportingDestination(
  search: string,
  canViewAccountUsage: boolean,
): string {
  const params = new URLSearchParams(search);
  const poolId = params.get('poolId');
  if (poolId !== null) return teamOverviewHref(poolId, search);
  const tab = params.get('tab') ?? params.get('view');
  if (tab === 'projects' && params.get('viewScope') === 'my') {
    const next = new URLSearchParams(params);
    next.delete('tab');
    next.delete('view');
    next.delete('viewScope');
    next.delete('poolId');
    return `/my-projects${next.size ? `?${next}` : ''}`;
  }
  return reportingNavigationHref(canViewAccountUsage ? '/org-insights' : '/my-team', search);
}
