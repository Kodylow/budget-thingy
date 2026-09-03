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
import { Redirect, useRoute, useSearch } from 'wouter';
import { canOpenGroupInView } from '@/lib/rbac-view';
import {
  pollingRetryDelay,
  QUERY_STALE_TIME_MS,
} from '@/lib/client-performance';

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
      refetchOnWindowFocus: false,
      retry: 1,
      retryDelay: pollingRetryDelay,
    },
  },
});

function RouteLoading() {
  return (
    <div className="p-4 md:p-8" role="status" aria-label="Loading page">
      <div className="h-40 animate-pulse-glow rounded bg-muted" />
    </div>
  );
}

function Router() {
  // Account-only routes (settings) are removed for workspace admins so a
  // direct URL cannot render the account-admin surface. The server still
  // enforces authorization on the underlying data.
  const { isAccountAdmin, isAccountWide, role, preview } = useAuthContext();

  function ScopedGroupRoute() {
    const [, params] = useRoute('/groups/:groupId');
    return canOpenGroupInView(params?.groupId ?? '', role, preview)
      ? <GroupDetail />
      : <Redirect to="/" />;
  }

  function ScopedClusterRoute() {
    const search = useSearch();
    const groupIds = new URLSearchParams(search)
      .get('ids')
      ?.split(',')
      .filter(Boolean) ?? [];
    const canOpen = groupIds.length > 0 &&
      groupIds.every((groupId) => canOpenGroupInView(groupId, role, preview));
    return canOpen ? <ClusterDetail /> : <Redirect to="/" />;
  }

  function AccountAdminGuideRoute() {
    return isAccountAdmin ? <UserGuide /> : <Redirect to="/" />;
  }

  return (
    <AppShell>
      <Suspense fallback={<RouteLoading />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/user-guide" component={AccountAdminGuideRoute} />
          <Route path="/alerts" component={Alerts} />
          {isAccountWide && <Route path="/trends" component={Trends} />}
          {isAccountAdmin && <Route path="/settings" component={Settings} />}
          {isAccountAdmin && <Route path="/workspace-admins" component={WorkspaceAdmins} />}
          {isAccountAdmin && <Route path="/workspace-directory" component={WorkspaceDirectory} />}
          {isAccountAdmin && <Route path="/team-budgets" component={TeamBudgets} />}
          <Route path="/groups/:groupId" component={ScopedGroupRoute} />
          <Route path="/clusters" component={ScopedClusterRoute} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
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
