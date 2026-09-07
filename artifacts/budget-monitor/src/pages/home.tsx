import { useState } from 'react';
import { useAuthContext } from '@/components/auth-context';
import { useRange } from '@/components/range-context';
import {
  useGetDashboard,
  useGetBillingCycleComparison,
  useGetTeamsBudgets,
  useGetBudgetTeamReport,
  getGetBudgetTeamReportQueryKey,
} from '@workspace/api-client-react';
import { formatInt } from './home-components/format';
import { SpendStoryChart, MonthMiniBars } from './home-components/spend-story-chart';
import {
  aggregatePersonalWorkspaceSpend,
  personalProjectCatalogMetrics,
} from './home-components/budget-logic';
import {
  PersonalBudgetPanel,
  TeamBudgetPanel,
  selectDefaultTeam,
  selectDefaultWorkspace,
  type CanonicalTeamBudget,
  type TeamBudgetTracking,
} from './home-components/budget-panels';
import { BudgetTrajectory } from './home-components/budget-trajectory';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link, useSearch } from 'wouter';
import { reportingNavigationHref } from '@/lib/reporting-navigation';
import { dashboardTotalSpend } from '@/lib/spend-presentation';
import { Button } from '@/components/ui/button';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import {
  BarChart3,
  Flame,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';

export default function Home() {
  const searchString = useSearch();
  const { user, authorizationKey } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const billingCyclesQuery = useGetBillingCycleComparison();

  const myDashboardQuery = useGetDashboard({
    viewScope: 'my',
    rangeType,
    startDate,
    endDate,
  });
  const { data: myDashboard, isLoading: myLoading } = myDashboardQuery;

  const teamBudgetsQuery = useGetTeamsBudgets({ scope: 'own', period: 'full-term' });
  const teamBudgets = (teamBudgetsQuery.data?.budgets ?? []) as CanonicalTeamBudget[];

  const mySpendUsd = dashboardTotalSpend(myDashboard);
  const changePct = myDashboard?.insights?.changePercent;
  const activeDays = myDashboard?.insights?.activeDays;
  const activity = activeDays != null ? activeDays : null;
  const personalSpendRows = myDashboard?.personalSpendByWorkspace ?? [];
  const personalSpendAggregate = aggregatePersonalWorkspaceSpend(personalSpendRows, mySpendUsd);
  const personalProjectCatalog = personalProjectCatalogMetrics(myDashboard?.personalProjectCatalog);
  const projectCount = personalProjectCatalog.projectCount;
  const personalLimits = myDashboard?.personalLimits ?? [];
  const [selection, setSelection] = useState(() => ({
    authorizationKey,
    workspaceId: null as string | null,
    poolId: null as string | null,
  }));
  const selectionIsCurrent = selection.authorizationKey === authorizationKey;
  const selectedWorkspaceId = selectionIsCurrent &&
    personalLimits.some((limit) => limit.workspaceId === selection.workspaceId)
    ? selection.workspaceId
    : selectDefaultWorkspace(personalLimits);
  const selectedPoolId = selectionIsCurrent &&
    teamBudgets.some((team) => team.poolId === selection.poolId)
    ? selection.poolId
    : selectDefaultTeam(teamBudgets);
  const selectWorkspace = (workspaceId: string) => setSelection((current) => ({
    authorizationKey,
    workspaceId,
    poolId: current.authorizationKey === authorizationKey ? current.poolId : null,
  }));
  const selectPool = (poolId: string) => setSelection((current) => ({
    authorizationKey,
    workspaceId: current.authorizationKey === authorizationKey ? current.workspaceId : null,
    poolId,
  }));
  const teamReportQuery = useGetBudgetTeamReport(selectedPoolId ?? '', {
    rangeType: 'full-term',
    includeBudgetTracking: true,
  }, {
    query: {
      enabled: Boolean(selectedPoolId),
      queryKey: getGetBudgetTeamReportQueryKey(selectedPoolId ?? '', {
        rangeType: 'full-term',
        includeBudgetTracking: true,
      }),
    },
  });
  const budgetTracking = ((teamReportQuery.data as (typeof teamReportQuery.data & { budgetTracking?: TeamBudgetTracking }) | undefined)?.budgetTracking ?? null);
  const greeting = new Date().getHours() < 12
    ? 'Good morning'
    : new Date().getHours() < 18
      ? 'Good afternoon'
      : 'Good evening';
  const billingCycles = billingCyclesQuery.data?.cycles ?? [];
  const currentCycle = billingCycles.find((cycle) => cycle.key === 'current');
  const billingPeriodLabel = currentCycle
    ? `${new Date(currentCycle.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}–${new Date(currentCycle.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
    : 'Current billing cycle';

  if (myLoading) {
    return (
      <div className="mx-auto max-w-[1280px] p-4 md:p-8 space-y-6">
        <Skeleton className="h-16 w-64 mb-8" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[140px] rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-72 rounded-2xl lg:col-span-2" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!myDashboard) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-[1280px] flex-col items-center justify-center p-8 text-center">
        <p className="font-medium">Your dashboard is unavailable.</p>
        <p className="mt-1 text-sm text-muted-foreground">No personal spend values are shown because the scoped request failed.</p>
        <Button variant="outline" className="mt-4" onClick={() => void myDashboardQuery.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      <section className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-2">
            <h1
              className="text-3xl font-semibold tracking-tight md:text-4xl"
              data-testid="text-dashboard-scope"
            >
              Overview
            </h1>
            <h2 className="text-sm font-normal text-muted-foreground">
              {greeting}{user?.firstName ? `, ${user.firstName}` : ''}. Your spend, budgets, and Replit activity in one place.
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {myDashboard?.metadata?.dataAsOf && (
              <p className="text-xs text-muted-foreground whitespace-nowrap">
                Updated {new Date(myDashboard.metadata.dataAsOf).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </p>
            )}
            <Link href={reportingNavigationHref('/overview?viewScope=my', searchString)} className="text-xs font-medium text-primary hover:underline">
              Forecast details
            </Link>
          </div>
        </div>

        <div aria-label="Personal and team budgets" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PersonalBudgetPanel
            limits={personalLimits}
            selectedId={selectedWorkspaceId}
            onSelect={selectWorkspace}
            billingPeriodLabel={billingPeriodLabel}
          />
          <TeamBudgetPanel
            teams={teamBudgets}
            selectedPoolId={selectedPoolId}
            onSelect={selectPool}
            tracking={budgetTracking}
            loading={teamBudgetsQuery.isLoading || teamReportQuery.isLoading}
            error={teamBudgetsQuery.isError || teamReportQuery.isError}
            onRetry={() => {
              void teamBudgetsQuery.refetch();
              if (selectedPoolId) void teamReportQuery.refetch();
            }}
            search={searchString}
          />
        </div>
        {personalSpendAggregate.complete && !personalSpendAggregate.reconcilesToCanonical && (
          <AdminDataQualityNote title="My Spend">
            Workspace values do not reconcile to the personal dashboard total.
          </AdminDataQualityNote>
        )}
      </section>

      {(myDashboardQuery.isError || teamBudgetsQuery.isError) && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <div className="flex-1">
            <strong className="text-foreground">Refresh failed; last available values are shown.</strong>
          </div>
          {(myDashboardQuery.isError || teamBudgetsQuery.isError) && (
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => {
              void myDashboardQuery.refetch();
              void teamBudgetsQuery.refetch();
            }}>Retry</button>
          )}
        </div>
      )}
      {myDashboard.metadata.qualifications.length > 0 && (
        <AdminDataQualityNote title="Home overview">
          {myDashboard.metadata.qualifications.join(' ')}
        </AdminDataQualityNote>
      )}

      <BudgetTrajectory
        teamName={teamBudgets.find((team) => team.poolId === selectedPoolId)?.teamName ?? null}
        tracking={budgetTracking}
        loading={teamBudgetsQuery.isLoading || teamReportQuery.isLoading}
        error={teamBudgetsQuery.isError || teamReportQuery.isError}
        onRetry={() => {
          void teamBudgetsQuery.refetch();
          if (selectedPoolId) void teamReportQuery.refetch();
        }}
      />

      <section id="monthly-context" className="grid scroll-mt-6 grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Billing-cycle spend comparisons">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold">My Spend Story</h2>
          <p className="mt-1 text-sm text-muted-foreground">Three billing cycles aligned by day, independent of the reporting range</p>
        </div>
        <Card className="rounded-md shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="w-4 h-4 text-primary" /> My spend
            </CardTitle>
            <CardDescription>{billingPeriodLabel} · Cumulative by billing-cycle day</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64 rounded-sm border bg-muted/25 p-3">
              {billingCyclesQuery.isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : billingCyclesQuery.isError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  Spend comparison unavailable
                  <Button size="sm" variant="outline" onClick={() => void billingCyclesQuery.refetch()} data-testid="button-retry-billing-cycles-personal">Retry</Button>
                </div>
              ) : (
                <SpendStoryChart cycles={billingCycles} scope="personal" />
              )}
            </div>
            {!billingCyclesQuery.isLoading && !billingCyclesQuery.isError && billingCycles.some((cycle) => !cycle.personalComplete) && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="status-personal-cycle-coverage">Known spend · gaps preserved</p>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-md shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="w-4 h-4 text-primary" /> Team spend
            </CardTitle>
            <CardDescription>{billingPeriodLabel} · Cumulative by billing-cycle day</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64 rounded-sm border bg-muted/25 p-3">
              {billingCyclesQuery.isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : billingCyclesQuery.isError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  Team comparison unavailable
                  <Button size="sm" variant="outline" onClick={() => void billingCyclesQuery.refetch()} data-testid="button-retry-billing-cycles-team">Retry</Button>
                </div>
              ) : !billingCyclesQuery.data?.hasTeams ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="status-team-cycle-unavailable">No team spend available</div>
              ) : (
                <SpendStoryChart cycles={billingCycles} scope="team" />
              )}
            </div>
            {!billingCyclesQuery.isLoading && !billingCyclesQuery.isError && billingCyclesQuery.data?.hasTeams && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="status-team-cycle-coverage">
                {billingCyclesQuery.data.teamScope === 'partial' || billingCycles.some((cycle) => !cycle.teamComplete)
                  ? 'Authorized team scope · known spend · gaps preserved'
                  : 'Complete authorized team scope'}
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="rounded-md shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="w-4 h-4 text-primary" /> My Last 6 Months
              </CardTitle>
              <CardDescription>My total spend per month</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-32">
              <MonthMiniBars monthly={myDashboard?.insights?.monthly} />
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-md shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Flame className="h-4 w-4 text-primary" /> Activity
              </CardTitle>
              <CardDescription>Operational context for this period</CardDescription>
            </CardHeader>
            <CardContent>
            {activity != null ? (
              <>
                <div className="text-2xl font-mono font-semibold">
                  {formatInt(activity)} <span className="text-sm text-muted-foreground font-sans font-normal">active days this period</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1.5">
                  Across {projectCount != null
                    ? `${personalProjectCatalog.projectCountQualified ? 'known ' : ''}${formatInt(projectCount)}`
                    : 'an unavailable number of'} active projects
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Activity unavailable for this period.</div>
            )}
            </CardContent>
          </Card>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5" />Values reflect the latest posted usage.</span>
        <span>Pending usage and refunds may not be reflected.</span>
      </div>
    </div>
  );
}