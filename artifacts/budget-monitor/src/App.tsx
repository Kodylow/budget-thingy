import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppShell } from '@/components/app-shell';
import Dashboard from '@/pages/dashboard';
import { RangeProvider } from '@/components/range-context';
import { AuthProvider, useAuthContext } from '@/components/auth-context';
import { AuthGate } from '@/components/auth-gate';
import {
  DATA_REFRESH_INTERVAL_MS,
  pollingRetryDelay,
  QUERY_STALE_TIME_MS,
} from '@/lib/client-performance';
import { setUnauthorizedHandler } from '@workspace/api-client-react';
import { clearAuthCache } from '@workspace/replit-auth-web';
import { shouldRetryRequest, useApiErrorToasts } from '@/lib/errors';
import { Redirect } from 'wouter';
import { previewScopedQueryHash } from '@/lib/preview-query-cache';

const Settings = lazy(() => import('@/pages/settings'));
const Trends = lazy(() => import('@/pages/trends'));
const Alerts = lazy(() => import('@/pages/alerts'));
const GroupDetail = lazy(() => import('@/pages/group-detail'));
const ClusterDetail = lazy(() => import('@/pages/cluster-detail'));
const WorkspaceAdmins = lazy(() => import('@/pages/workspace-admins'));
const WorkspaceDirectory = lazy(() => import('@/pages/workspace-directory'));
const TeamBudgets = lazy(() => import('@/pages/team-budgets'));
const UserGuide = lazy(() => import('@/pages/user-guide'));

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

function AccountAdminGuideRoute() {
  const { capabilities } = useAuthContext();
  return capabilities.canManageAccess ? <UserGuide /> : <Redirect to="/" />;
}

interface ForbiddenRouteProps {
  testId: string;
  message: string;
}

function ForbiddenRoute({ testId, message }: ForbiddenRouteProps) {
  return (
    <div className="p-4 md:p-8" data-testid={testId}>
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
        403 · Access denied
      </h1>
      <p className="mt-2 text-muted-foreground">{message}</p>
    </div>
  );
}

function SettingsRoute() {
  const { capabilities } = useAuthContext();
  if (capabilities.canManageAccess) return <Settings />;
  return (
    <ForbiddenRoute
      testId="settings-forbidden"
      message="Settings are only available to account administrators."
    />
  );
}

function WorkspaceAdminsRoute() {
  const { isAccountAdmin } = useAuthContext();
  if (isAccountAdmin) return <WorkspaceAdmins />;
  return (
    <ForbiddenRoute
      testId="workspace-admins-forbidden"
      message="Team Admins is only available to account administrators."
    />
  );
}

function WorkspaceDirectoryRoute() {
  const { capabilities } = useAuthContext();
  if (capabilities.canManageAccess) return <WorkspaceDirectory />;
  return (
    <ForbiddenRoute
      testId="workspace-directory-forbidden"
      message="Workspace Directory is only available to account administrators."
    />
  );
}

function TeamBudgetsRoute() {
  const { capabilities } = useAuthContext();
  if (capabilities.canEditAllocations) return <TeamBudgets />;
  return (
    <ForbiddenRoute
      testId="team-budgets-forbidden"
      message="Team allocations are only available to account administrators."
    />
  );
}

function Router() {
  return (
    <AppShell>
      <Suspense fallback={<RouteLoading />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/user-guide" component={AccountAdminGuideRoute} />
          <Route path="/alerts" component={Alerts} />
          <Route path="/trends" component={Trends} />
          <Route path="/settings" component={SettingsRoute} />
          <Route path="/workspace-admins" component={WorkspaceAdminsRoute} />
          <Route path="/workspace-directory" component={WorkspaceDirectoryRoute} />
          <Route path="/team-budgets" component={TeamBudgetsRoute} />
          <Route path="/groups/:groupId" component={GroupDetail} />
          <Route path="/clusters" component={ClusterDetail} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiErrorToasts />
      <TooltipProvider>
        <AuthProvider>
          <RangeProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <AuthGate>
                <Router />
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
