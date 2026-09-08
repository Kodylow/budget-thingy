import type { AuthAvailability } from '@workspace/replit-auth-web';

const LOGIN_RETURN_ROUTES = new Set([
  '/',
  '/overview',
  '/org-insights',
  '/spend',
  '/my-team',
  '/reports',
  '/limits',
  '/allocations',
  '/alerts',
  '/access',
  '/settings',
  '/help',
  '/clusters',
  '/trends',
  '/team-budgets',
  '/workspace-admins',
  '/workspace-directory',
  '/user-guide',
]);

export function resolvedRootDestination(
  availability: AuthAvailability,
  canViewAccountUsage: boolean,
): '/' | '/org-insights' | null {
  if (availability !== 'authorized') return null;
  return canViewAccountUsage ? '/org-insights' : '/';
}

export function safeLoginReturnTarget(search: string): string {
  const candidate = new URLSearchParams(search).get('returnTo');
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return '/';
  }

  try {
    const target = new URL(candidate, window.location.origin);
    if (target.origin !== window.location.origin || target.username || target.password) return '/';
    const isKnownRoute = LOGIN_RETURN_ROUTES.has(target.pathname)
      || /^\/groups\/[^/]+$/.test(target.pathname)
      || /^\/users\/[^/]+$/.test(target.pathname)
      || /^\/workspaces\/[^/]+\/projects\/[^/]+$/.test(target.pathname);
    if (!isKnownRoute || target.pathname === '/login') return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}