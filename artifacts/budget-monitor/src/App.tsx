import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppShell } from '@/components/app-shell';
import Dashboard from '@/pages/dashboard';
import Alerts from '@/pages/alerts';
import Settings from '@/pages/settings';
import GroupDetail from '@/pages/group-detail';
import ClusterDetail from '@/pages/cluster-detail';
import Trends from '@/pages/trends';
import { RangeProvider } from '@/components/range-context';
import { AuthProvider, useAuthContext } from '@/components/auth-context';
import { AuthGate } from '@/components/auth-gate';

const queryClient = new QueryClient();

function Router() {
  // Account-only routes (settings) are removed for workspace admins so a
  // direct URL cannot render the account-admin surface. The server still
  // enforces authorization on the underlying data.
  const { isAccountAdmin } = useAuthContext();

  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/alerts" component={Alerts} />
        <Route path="/trends" component={Trends} />
        {isAccountAdmin && <Route path="/settings" component={Settings} />}
        <Route path="/groups/:groupId" component={GroupDetail} />
        <Route path="/clusters" component={ClusterDetail} />
        <Route component={NotFound} />
      </Switch>
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
