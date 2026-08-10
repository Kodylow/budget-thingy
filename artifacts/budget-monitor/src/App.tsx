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

const queryClient = new QueryClient();

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/alerts" component={Alerts} />
        <Route path="/settings" component={Settings} />
        <Route path="/trends" component={Trends} />
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
        <RangeProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </RangeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
