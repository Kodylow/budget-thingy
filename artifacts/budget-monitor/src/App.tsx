import { lazy, Suspense, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { AppShell } from '@/components/app-shell';
import { RangeProvider } from '@/components/range-context';
import { AuthProvider, useAuthContext } from '@/components/auth-context';
import { AuthGate } from '@/components/auth-gate';
import {
  DATA_REFRESH_INTERVAL_MS,
  pollingRetryDelay,
  QUERY_STALE_TIME_MS,
} from '@/lib/client-performance';
import { setForbiddenHandler, setUnauthorizedHandler } from '@workspace/api-client-react';
import { clearAuthCache } from '@workspace/replit-auth-web';
import { shouldRetryRequest, useApiErrorToasts } from '@/lib/errors';
import { previewScopedQueryHash } from '@/lib/preview-query-cache';

const Dashboard = lazy(() => import('@/pages/dashboard'));
const Spend = lazy(() => import('@/pages/spend'));
const Allocations = lazy(() => import('@/pages/team-budgets'));
const Alerts = lazy(() => import('@/pages/alerts'));
const Access = lazy(() => import('@/pages/access'));
const Settings = lazy(() => import('@/pages/settings'));
const Help = lazy(() => import('@/pages/user-guide'));
const GroupDetail = lazy(() => import('@/pages/group-detail'));
const ClusterDetail = lazy(() => import('@/pages/cluster-detail'));

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
  if (loginRedirectStarted || recentlyRedirectedToLogin()) return;
  loginRedirectStarted = true;
  try {
    window.sessionStorage.setItem(LOGIN_REDIRECT_DEBOUNCE_KEY, String(Date.now()));
  } catch {
    // The in-memory guard still deduplicates redirects when storage is blocked.
  }
  clearAuthCache();
  queryClient.clear();
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/api/login?returnTo=${encodeURIComponent(returnTo)}`);
});

function ApiErrorToasts() {
  useApiErrorToasts(queryClient);
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
  if (capabilities.canEditAllocations) return <Allocations />;
  return (
    <ForbiddenRoute
      testId="allocations-forbidden"
      message="Allocations are only available to budget editors."
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

function Router() {
  return (
    <AppShell>
      <Suspense fallback={<RouteLoading />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/spend" component={Spend} />
          <Route path="/allocations" component={AllocationsRoute} />
          <Route path="/alerts" component={AlertsRoute} />
          <Route path="/access" component={AccessRoute} />
          <Route path="/settings" component={SettingsRoute} />
          <Route path="/help" component={Help} />

          <Route path="/trends" component={() => <PreserveQueryRedirect to="/" />} />
          <Route path="/team-budgets" component={() => <PreserveQueryRedirect to="/allocations" />} />
          <Route path="/workspace-admins" component={() => <PreserveQueryRedirect to="/access" />} />
          <Route path="/workspace-directory" component={() => <PreserveQueryRedirect to="/spend" />} />
          <Route path="/user-guide" component={() => <PreserveQueryRedirect to="/help" />} />

          <Route path="/groups/:groupId" component={GroupDetail} />
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

function AuthorizationFailureBridge() {
  const { retryAuthorization } = useAuthContext();
  useEffect(() => {
    setForbiddenHandler(() => {
      void queryClient.cancelQueries();
      queryClient.clear();
      retryAuthorization();
    });
    return () => setForbiddenHandler(null);
  }, [retryAuthorization]);
  return null;
}

function App() {
  return (
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
            </WouterRouter>
          </RangeProvider>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
