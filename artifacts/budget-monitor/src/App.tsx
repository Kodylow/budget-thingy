import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation, useSearch } from 'wouter';
import { AppShell } from '@/components/app-shell';
import { RangeProvider } from '@/components/range-context';
import { AuthProvider, useAuthContext } from '@/components/auth-context';
import { AuthGate } from '@/components/auth-gate';
import {
  DATA_REFRESH_INTERVAL_MS,
  pollingRetryDelay,
  QUERY_STALE_TIME_MS,
} from '@/lib/client-performance';
import { getDevelopmentUserId, setForbiddenHandler, setUnauthorizedHandler } from '@workspace/api-client-react';
import { clearAuthCache, getLoginUrl, isEmbeddedPreview, logAuthDebug } from '@workspace/replit-auth-web';
import { shouldRetryRequest, useApiErrorToasts } from '@/lib/errors';
import { previewScopedQueryHash } from '@/lib/preview-query-cache';
import { createForbiddenRevalidator } from '@/lib/auth-transition';
import { safeLoginReturnTarget } from '@/lib/login-navigation';

const Dashboard = lazy(() => import('@/pages/dashboard'));
const Home = lazy(() => import('@/pages/home'));
const OrgInsights = lazy(() => import('@/pages/org-insights'));
const Spend = lazy(() => import('@/pages/spend'));
const MyTeam = lazy(() => import('@/pages/my-team'));
const Allocations = lazy(() => import('@/pages/team-budgets'));
const Alerts = lazy(() => import('@/pages/alerts'));
const Access = lazy(() => import('@/pages/access'));
const Settings = lazy(() => import('@/pages/settings'));
const Help = lazy(() => import('@/pages/user-guide'));
const GroupDetail = lazy(() => import('@/pages/group-detail'));
const ClusterDetail = lazy(() => import('@/pages/cluster-detail'));

const ProjectDetail = lazy(() => import('@/pages/project-detail'));
const Limits = lazy(() => import('@/pages/limits'));
const Reports = lazy(() => import('@/pages/reports'));

const DevelopmentViewChip = import.meta.env.DEV
  ? lazy(() => import('@/components/dev-view-chip').then(module => ({ default: module.DevViewChip })))
  : null;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME_MS,
      refetchInterval: DATA_REFRESH_INTERVAL_MS,
      refetchOnWindowFocus: false,
      retry: shouldRetryRequest,
      retryDelay: 1_000,
      queryKeyHashFn: previewScopedQueryHash,
    },
    mutations: {
      retry: shouldRetryRequest,
      retryDelay: pollingRetryDelay,
    },
  },
});

let loginRedirectStarted = false;
const LOGIN_REDIRECT_DEBOUNCE_KEY = 'budget-monitor-login-redirect-at';
const LOGIN_REDIRECT_DEBOUNCE_MS = 10_000;

function recentlyRedirectedToLogin(): boolean {
  try {
    const redirectedAt = Number(window.sessionStorage.getItem(LOGIN_REDIRECT_DEBOUNCE_KEY));
    return Number.isFinite(redirectedAt) && Date.now() - redirectedAt < LOGIN_REDIRECT_DEBOUNCE_MS;
  } catch {
    return false;
  }
}

setUnauthorizedHandler(() => {
  logAuthDebug('api.unauthorized');
  if (getDevelopmentUserId()) {
    queryClient.clear();
    window.dispatchEvent(new Event('development-authorization-invalid'));
    return;
  }
  if (isEmbeddedPreview()) {
    logAuthDebug('login.redirect-skipped', { reason: 'embedded-requires-click' });
    // A background 401 cannot open a tab; show the explicit sign-in link instead.
    clearAuthCache();
    queryClient.clear();
    return;
  }
  if (loginRedirectStarted || recentlyRedirectedToLogin()) {
    logAuthDebug('login.redirect-skipped', { reason: 'debounced' });
    return;
  }
  loginRedirectStarted = true;
  try {
    window.sessionStorage.setItem(LOGIN_REDIRECT_DEBOUNCE_KEY, String(Date.now()));
  } catch {
    // The in-memory guard still deduplicates redirects when storage is blocked.
  }
  clearAuthCache();
  queryClient.clear();
  const returnTo = `${window.location.pathname}${window.location.search}`;
  logAuthDebug('login.redirect', { reason: 'api-401', target: '_self' });
  window.location.assign(getLoginUrl(returnTo));
});

function ApiErrorToasts() {
  useApiErrorToasts(queryClient);
  return null;
}

function AuthorizationFailureBridge() {
  const { availability, revalidateAuthorization, developmentView } = useAuthContext();

  useEffect(() => {
    if (!developmentView.enabled) return;
    const recover = () => { void revalidateAuthorization(); };
    window.addEventListener('development-authorization-invalid', recover);
    return () => window.removeEventListener('development-authorization-invalid', recover);
  }, [developmentView.enabled, revalidateAuthorization]);

  useEffect(() => {
    // Keep ordinary resource denials page-local. AuthProvider clears protected
    // state only when the complete access fingerprint changes or auth fails.
    setForbiddenHandler(availability === 'authorized'
      ? createForbiddenRevalidator(revalidateAuthorization)
      : null);
    return () => setForbiddenHandler(null);
  }, [availability, revalidateAuthorization]);

  return null;
}

function RouteLoading() {
  return (
    <div className="p-4 md:p-8" role="status" aria-label="Loading page">
      <div className="h-40 animate-pulse-glow rounded bg-muted" />
    </div>
  );
}

interface ForbiddenRouteProps {
  testId: string;
  message: string;
}

function ForbiddenRoute({ testId, message }: ForbiddenRouteProps) {
  const { isPreviewing, resetPreview } = useAuthContext();

  return (
    <div className="p-4 md:p-8" data-testid={testId}>
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
        403 · Access denied
      </h1>
      <p className="mt-2 text-muted-foreground mb-4">{message}</p>
      {isPreviewing && (
        <button
          onClick={resetPreview}
          className="text-sm text-primary hover:underline underline-offset-4"
        >
          Reset to your real view
        </button>
      )}
    </div>
  );
}

function SettingsRoute() {
  const { capabilities } = useAuthContext();
  if (capabilities.canManageSystem || capabilities.canManageNotifications) return <Settings />;
  return (
    <ForbiddenRoute
      testId="settings-forbidden"
      message="Settings are only available to system or notification administrators."
    />
  );
}

function AccessRoute() {
  const { capabilities } = useAuthContext();
  if (capabilities.canManageAccess) return <Access />;
  return (
    <ForbiddenRoute
      testId="access-forbidden"
      message="Access is only available to access administrators."
    />
  );
}

function AlertsRoute() {
  const { role } = useAuthContext();
  if (role !== 'member') return <Alerts />;
  return (
    <ForbiddenRoute
      testId="alerts-forbidden"
      message="Alert history is only available to managers and administrators."
    />
  );
}

function AllocationsRoute() {
  const { capabilities } = useAuthContext();
  if (capabilities.canViewAccountUsage) return <Allocations />;
  return (
    <ForbiddenRoute
      testId="allocations-forbidden"
      message="Budget allocations are only available to account viewers."
    />
  );
}

function LimitsRoute() {
  const { capabilities, isPreviewing } = useAuthContext();
  if (capabilities.canWriteUserLimitsIn && capabilities.canWriteUserLimitsIn.length > 0) return <Limits />;
  return (
    <ForbiddenRoute
      testId="limits-forbidden"
      message={isPreviewing ? "Setting limits is not available in preview mode." : "Setting limits is only available to authorized workspace administrators."}
    />
  );
}

function PreserveQueryRedirect({ to }: { to: string }) {
  const [, setLocation] = useLocation();
  useEffect(() => {
    const search = window.location.search;
    setLocation(to + search, { replace: true });
  }, [to, setLocation]);
  return null;
}

function AuthenticatedLoginRoute() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation(safeLoginReturnTarget(search), { replace: true });
  }, [search, setLocation]);
  return <RouteLoading />;
}

function Router() {
  const [location] = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Overview',
      '/spend': 'Spend',
      '/my-team': 'My Team',
      '/limits': 'Limits',
      '/allocations': 'Budget allocations',
      '/alerts': 'Email activity',
      '/access': 'Access',
      '/settings': 'Settings',
      '/reports': 'Custom Reports',
      '/help': 'Help',
      '/clusters': 'Planning pool detail',
    };
    const title = titles[location] ?? (location.startsWith('/groups/') ? 'Group detail' : 'Page not found');
    document.title = `${title} · Budget Monitor`;
  }, [location]);
  return (
    <AppShell>
      <Suspense fallback={<RouteLoading />}>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/overview" component={Dashboard} />
          <Route path="/org-insights" component={OrgInsights} />
          <Route path="/spend" component={Spend} />
          <Route path="/my-team" component={MyTeam} />
          <Route path="/reports" component={Reports} />
          <Route path="/limits" component={LimitsRoute} />
          <Route path="/allocations" component={AllocationsRoute} />
          <Route path="/alerts" component={AlertsRoute} />
          <Route path="/access" component={AccessRoute} />
          <Route path="/settings" component={SettingsRoute} />
          <Route path="/help" component={Help} />
          <Route path="/login" component={AuthenticatedLoginRoute} />

          <Route path="/trends" component={() => <PreserveQueryRedirect to="/" />} />
          <Route path="/team-budgets" component={() => <PreserveQueryRedirect to="/allocations" />} />
          <Route path="/workspace-admins" component={() => <PreserveQueryRedirect to="/access" />} />
          <Route path="/workspace-directory" component={() => <PreserveQueryRedirect to="/spend" />} />
          <Route path="/user-guide" component={() => <PreserveQueryRedirect to="/help" />} />

          <Route path="/groups/:groupId" component={GroupDetail} />
          <Route path="/workspaces/:workspaceId/projects/:projectId" component={ProjectDetail} />
          <Route path="/users/:userId" component={UserProjects} />
          <Route path="/clusters" component={ClusterDetail} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </AppShell>
  );
}

function AuthorizedRouter() {
  const { authorizationKey } = useAuthContext();
  return <Router key={authorizationKey} />;
}

interface RootErrorBoundaryState {
  error: Error | null;
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ui_render_failed', {
      errorType: error instanceof TypeError ? 'TypeError' : 'RenderError',
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm" role="alert" data-testid="root-render-error">
          <h1 className="text-xl font-semibold">Budget Monitor couldn&apos;t load</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            An unexpected page or application error occurred. Reload to retry from a clean state.
          </p>
          <pre className="mt-4 max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" data-testid="root-error-diagnostics">
            UI_RENDER_FAILED — recent request IDs are available in API diagnostics.
          </pre>
          <button
            type="button"
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload and retry
          </button>
        </div>
      </main>
    );
  }
}

function App() {
  return (
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ApiErrorToasts />
        <TooltipProvider>
          <AuthProvider>
            <AuthorizationFailureBridge />
            <RangeProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
                <AuthGate>
                  <AuthorizedRouter />
                </AuthGate>
                {DevelopmentViewChip && <Suspense fallback={null}><DevelopmentViewChip /></Suspense>}
              </WouterRouter>
            </RangeProvider>
          </AuthProvider>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </RootErrorBoundary>
  );
}

export default App;

const UserProjects = lazy(() => import('@/pages/user-projects'));
