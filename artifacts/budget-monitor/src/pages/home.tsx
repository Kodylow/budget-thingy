import { useCallback, useEffect, useRef } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  getGetBillingCycleComparisonQueryKey,
  getGetBudgetTeamReportQueryKey,
  getGetDashboardQueryKey,
  getGetTeamsBudgetsQueryKey,
  getGetMyMembershipContextQueryKey,
  useGetBillingCycleComparison,
  useGetBudgetTeamReport,
  useGetDashboard,
  useGetTeamsBudgets,
  useGetMyMembershipContext,
} from '@workspace/api-client-react';
import { BarChart3, Flame, RefreshCw, TrendingUp, Users } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { RangeFilter } from '@/components/range-filter';
import { useRange } from '@/components/range-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { reportingNavigationHref } from '@/lib/reporting-navigation';
import { formatInt } from './home-components/format';
import { PersonalBudgetPanel, TeamBudgetPanel, type CanonicalTeamBudget, type TeamBudgetTracking } from './home-components/budget-panels';
import { BudgetTrajectory } from './home-components/budget-trajectory';
import { SpendStoryChart } from './home-components/spend-story-chart';
import TrendChart from './dashboard-chart';
import {
  MembershipContextSummary,
  resolvePersonalWorkspace,
  searchAfterEffectiveIdentityChange,
} from './home-components/membership-context';

function HomeTeamReport({
  team,
  workspaceId,
  rangeType,
  startDate,
  endDate,
  selectedPeriodLabel,
  search,
  authorizationKey,
  multipleTeams,
}: {
  team: CanonicalTeamBudget;
  workspaceId: string;
  rangeType: ReturnType<typeof useRange>['rangeType'];
  startDate?: string;
  endDate?: string;
  selectedPeriodLabel: string;
  search: string;
  authorizationKey: string;
  multipleTeams: boolean;
}) {
  const trackingRange = rangeType === 'full-term'
    ? 'budget' as const
    : rangeType === 'billing'
      ? 'billing' as const
      : 'selected' as const;
  const params = {
    workspaceId,
    rangeType,
    startDate,
    endDate,
    includeBudgetTracking: true,
    trackingRange,
    scope: 'own' as const,
  };
  const report = useGetBudgetTeamReport(team.poolId, params, {
    query: {
      enabled: Boolean(team.poolId && workspaceId),
      queryKey: [...getGetBudgetTeamReportQueryKey(team.poolId, params), authorizationKey],
    },
  });
  const tracking: TeamBudgetTracking | null = report.data?.budgetTracking ?? null;
  const comparisonsMatchBudgetWindow = tracking?.comparisonsMatchBudgetWindow === true;
  const hasTrajectory = !report.isError && Boolean(
    tracking?.points.some((point) => Number.isFinite(point.spendUsd)) ||
    (
      tracking?.benchmarkEligible &&
      tracking.periodStart &&
      tracking.periodEnd &&
      tracking.allocationUsd != null
    ),
  );

  if (!report.isLoading && !report.isError && !tracking) return null;

  const panel = (
    <TeamBudgetPanel
        team={team}
        tracking={tracking}
        loading={report.isLoading}
        error={report.isError}
        onRetry={() => void report.refetch()}
        search={search}
        selectedPeriodLabel={selectedPeriodLabel}
        comparisonsMatchBudgetWindow={comparisonsMatchBudgetWindow}
        wholeBudgetMode={trackingRange !== 'selected'}
    />
  );
  const trajectory = (
    <BudgetTrajectory
          teamName={team.teamName}
          tracking={tracking}
          loading={report.isLoading}
          error={report.isError}
          onRetry={() => void report.refetch()}
          comparisonsMatchBudgetWindow={comparisonsMatchBudgetWindow}
    />
  );

  if (multipleTeams) {
    return (
      <section className="space-y-4 lg:col-span-2" aria-label={`${team.teamName} budget and trajectory`}>
        {panel}
        {hasTrajectory && trajectory}
      </section>
    );
  }

  return (
    <>
      {panel}
      {hasTrajectory && <div className="lg:col-span-2">{trajectory}</div>}
    </>
  );
}
function OverviewHeader({
  workspaces,
  workspaceId,
  selectedPeriodLabel,
  onWorkspaceChange,
}: {
  workspaces: Array<{ workspaceId: string; workspaceName: string }>;
  workspaceId: string | null;
  selectedPeriodLabel: string;
  onWorkspaceChange: (workspaceId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl" data-testid="text-dashboard-scope">Overview</h1>
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Workspace</span>
          <Select value={workspaceId ?? ''} onValueChange={onWorkspaceChange} disabled={workspaces.length === 0}>
            <SelectTrigger className="h-11 w-full bg-background sm:h-8 sm:w-[220px]" aria-label="Workspace">
              <SelectValue placeholder={workspaces.length === 0 ? 'Loading workspaces' : 'Choose a workspace'} />
            </SelectTrigger>
            <SelectContent>{workspaces.map((workspace) => <SelectItem key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.workspaceName}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Period</span>
          <RangeFilter selectedLabel={selectedPeriodLabel} />
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  useSearch(); // Keep raw window.location.search parsing reactive across Wouter navigation.
  const [, setLocation] = useLocation();
  const searchString = window.location.search;
  const searchParams = new URLSearchParams(searchString);
  const requestedWorkspaceId = searchParams.get('workspaceId');
  const { user, authorizationKey, isAccountAdmin, capabilities, preview, availability } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const effectiveUserId = preview?.startsWith('member:')
    ? preview.slice('member:'.length)
    : user?.id ?? null;
  const lastEffectiveUserIdRef = useRef<string | null>(null);
  let previousEffectiveUserId = lastEffectiveUserIdRef.current;
  if (availability === 'authorized' && effectiveUserId) {
    try {
      previousEffectiveUserId = window.sessionStorage.getItem('budget-monitor:home-effective-user-id') ?? previousEffectiveUserId;
    } catch {
      // Fall back to the in-memory identity for preview transitions.
    }
  }
  const identityWorkspaceResetRequired = Boolean(
    availability === 'authorized' &&
    effectiveUserId &&
    previousEffectiveUserId &&
    previousEffectiveUserId !== effectiveUserId &&
    requestedWorkspaceId,
  );

  const membershipQuery = useGetMyMembershipContext({
    query: {
      queryKey: [...getGetMyMembershipContextQueryKey(), authorizationKey],
    },
  });
  const membershipContext = membershipQuery.data;
  const workspaces = membershipContext?.workspaces ?? [];
  const workspaceResolution = resolvePersonalWorkspace(membershipContext, requestedWorkspaceId);
  const selectedWorkspace = identityWorkspaceResetRequired ? null : workspaceResolution.workspace;
  const defaultWorkspace = membershipContext?.defaultWorkspaceId
    ? workspaces.find((workspace) => workspace.workspaceId === membershipContext.defaultWorkspaceId) ?? null
    : null;
  const invalidWorkspace = workspaceResolution.status === 'invalid';
  const chooseWorkspace = workspaceResolution.status === 'choose';
  const workspaceId = selectedWorkspace?.workspaceId ?? null;

  const setWorkspaceId = useCallback((nextWorkspaceId: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('workspaceId', nextWorkspaceId);
    params.delete('page');
    setLocation(`${window.location.pathname}?${params.toString()}`);
  }, [setLocation]);

  useEffect(() => {
    if (availability !== 'authorized' || !effectiveUserId) return;
    const storageKey = 'budget-monitor:home-effective-user-id';
    let previousUserId = previousEffectiveUserId;
    try {
      previousUserId = window.sessionStorage.getItem(storageKey) ?? previousUserId;
      window.sessionStorage.setItem(storageKey, effectiveUserId);
    } catch {
      // The in-memory identity still protects preview transitions when storage is blocked.
    }
    lastEffectiveUserIdRef.current = effectiveUserId;
    const nextSearch = searchAfterEffectiveIdentityChange(
      window.location.search,
      previousUserId,
      effectiveUserId,
    );
    if (nextSearch !== window.location.search) {
      setLocation(`${window.location.pathname}${nextSearch}`);
    }
  }, [availability, effectiveUserId, previousEffectiveUserId, setLocation]);

  useEffect(() => {
    if (!requestedWorkspaceId && membershipContext?.defaultWorkspaceId && selectedWorkspace) {
      setWorkspaceId(membershipContext.defaultWorkspaceId);
    }
  }, [membershipContext?.defaultWorkspaceId, requestedWorkspaceId, selectedWorkspace, setWorkspaceId]);

  const dashboardParams = {
    viewScope: 'my' as const,
    workspaceId: workspaceId ?? undefined,
    rangeType,
    startDate,
    endDate,
  };
  const myDashboardQuery = useGetDashboard(dashboardParams, {
    query: {
      enabled: Boolean(workspaceId),
      queryKey: [...getGetDashboardQueryKey(dashboardParams), authorizationKey],
    },
  });
  const comparisonParams = {
    workspaceId: workspaceId ?? undefined,
    rangeType,
    startDate,
    endDate,
  };
  const billingCyclesQuery = useGetBillingCycleComparison(comparisonParams, {
    query: {
      enabled: Boolean(workspaceId),
      queryKey: [...getGetBillingCycleComparisonQueryKey(comparisonParams), authorizationKey],
    },
  });
  const teamBudgetParams = {
    scope: 'own' as const,
    period: 'full-term' as const,
    workspaceId: workspaceId ?? undefined,
  };
  const teamBudgetsQuery = useGetTeamsBudgets(teamBudgetParams, {
    query: {
      enabled: Boolean(workspaceId),
      queryKey: [...getGetTeamsBudgetsQueryKey(teamBudgetParams), authorizationKey],
    },
  });

  const myDashboard = myDashboardQuery.data;
  const selectedPeriodLabel = myDashboard?.period.label ?? 'Selected period';
  const personalSpend = myDashboard?.personalSpendByWorkspace?.find((row) => row.workspaceId === workspaceId) ?? null;
  const personalLimit = myDashboard?.personalLimits?.find((limit) => limit.workspaceId === workspaceId) ?? null;
  const selectedBudgetTeamIds = new Set(selectedWorkspace?.budgetTeams.map((team) => team.poolId) ?? []);
  const teams = ((teamBudgetsQuery.data?.budgets ?? []) as CanonicalTeamBudget[])
    .filter((team) => Boolean(team.poolId) && selectedBudgetTeamIds.has(team.poolId));
  const activity = myDashboard?.insights?.activeDays ?? null;
  const cycles = billingCyclesQuery.data?.cycles ?? [];
  const hasPersonalComparison = cycles.some((cycle) => cycle.points.some((point) => Number.isFinite(point.personalSpendUsd)));
  const hasTeamComparison = billingCyclesQuery.data?.hasTeams === true &&
    cycles.some((cycle) => cycle.points.some((point) => Number.isFinite(point.teamSpendUsd)));
  const showSpendStory = billingCyclesQuery.isLoading || billingCyclesQuery.isError || hasPersonalComparison || hasTeamComparison;
  const hasTrend = myDashboard?.trend.buckets.some((bucket) => Number.isFinite(bucket.spendUsd)) === true;
  const selectedCycle = cycles.find((cycle) => cycle.key === 'current');
  const showCurrentCycleComparison = rangeType === 'billing';
  const billingPeriodLabel = showCurrentCycleComparison && selectedCycle
    ? `${new Date(selectedCycle.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}–${new Date(selectedCycle.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
    : 'Current billing period';
  const overviewHeader = (
    <OverviewHeader
      workspaces={workspaces}
      workspaceId={workspaceId}
      selectedPeriodLabel={selectedPeriodLabel}
      onWorkspaceChange={setWorkspaceId}
    />
  );

  if (identityWorkspaceResetRequired || membershipQuery.isLoading || (workspaceId && myDashboardQuery.isLoading)) {
    return (
      <div className="mx-auto max-w-[1280px] space-y-6 p-4 md:p-8">
        {overviewHeader}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-[310px] rounded-xl" />
          <Skeleton className="h-[310px] rounded-xl" />
          <Skeleton className="h-80 rounded-xl lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (membershipQuery.isError || !selectedWorkspace || !myDashboard) {
    return (
      <div className="mx-auto max-w-[1280px] space-y-6 p-4 md:p-8">
        {overviewHeader}
        <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
          <p className="font-medium">{invalidWorkspace ? 'That workspace is not available.' : chooseWorkspace ? 'Choose a workspace.' : 'Your workspace dashboard is unavailable.'}</p>
          {membershipContext?.qualification && <AdminDataQualityNote title="Workspace membership">{membershipContext.qualification}</AdminDataQualityNote>}
          {!invalidWorkspace && !chooseWorkspace && (
          <Button variant="outline" className="mt-4" onClick={() => {
            void membershipQuery.refetch();
            if (workspaceId) void myDashboardQuery.refetch();
          }}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      <section className="space-y-6">
        {overviewHeader}
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <MembershipContextSummary
            workspace={selectedWorkspace}
            qualification={membershipContext?.qualification ?? null}
            isAccountAdmin={isAccountAdmin}
            canViewAccountUsage={capabilities.canViewAccountUsage === true}
            defaultWorkspace={defaultWorkspace}
          />
          <div className="flex items-center gap-3">
            {myDashboard.metadata?.dataAsOf && <span>Updated {new Date(myDashboard.metadata.dataAsOf).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
            <Link href={reportingNavigationHref('/overview?viewScope=my', searchString)} className="font-medium text-primary hover:underline">Forecast details</Link>
          </div>
        </div>

        <div aria-label="Personal and team budgets" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className={teams.length !== 1 ? 'lg:col-span-2' : undefined}>
            <PersonalBudgetPanel
              workspaceName={selectedWorkspace?.workspaceName ?? workspaceId}
              selectedAgentSpendUsd={personalSpend?.agentSpendUsd ?? null}
              limit={personalLimit}
              selectedPeriodLabel={selectedPeriodLabel}
              billingPeriodLabel={billingPeriodLabel}
              showCurrentCycleComparison={showCurrentCycleComparison}
            />
          </div>
          {teams.map((team) => (
            <HomeTeamReport
              key={team.poolId}
              team={team}
              workspaceId={selectedWorkspace.workspaceId}
              rangeType={rangeType}
              startDate={startDate}
              endDate={endDate}
              selectedPeriodLabel={selectedPeriodLabel}
              search={searchString}
              authorizationKey={authorizationKey}
              multipleTeams={teams.length > 1}
            />
          ))}
        </div>
      </section>

      {(myDashboardQuery.isError || teamBudgetsQuery.isError) && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <strong className="flex-1 text-foreground">Couldn’t refresh data.</strong>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => {
            void myDashboardQuery.refetch();
            void teamBudgetsQuery.refetch();
          }}>Retry</button>
        </div>
      )}
      {myDashboard.metadata.qualifications.length > 0 && <AdminDataQualityNote title="Home overview">{myDashboard.metadata.qualifications.join(' ')}</AdminDataQualityNote>}

      {showSpendStory && <section id="monthly-context" className="grid scroll-mt-6 grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Selected-period spend comparisons">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold">My Spend Story</h2>
        </div>
        {(hasPersonalComparison || billingCyclesQuery.isLoading || billingCyclesQuery.isError) && <Card className={`rounded-md shadow-none ${!hasTeamComparison ? 'lg:col-span-2' : ''}`}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="h-4 w-4 text-primary" /> My spend</CardTitle>
            <CardDescription>{selectedPeriodLabel}</CardDescription>
          </CardHeader>
          <CardContent><div className="h-64 rounded-sm border bg-muted/25 p-3">
            {billingCyclesQuery.isLoading ? <Skeleton className="h-full w-full" /> : billingCyclesQuery.isError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">Spend comparison unavailable<Button size="sm" variant="outline" onClick={() => void billingCyclesQuery.refetch()}>Retry</Button></div>
            ) : <SpendStoryChart cycles={cycles} scope="personal" />}
          </div></CardContent>
        </Card>}
        {hasTeamComparison && <Card className={`rounded-md shadow-none ${!hasPersonalComparison ? 'lg:col-span-2' : ''}`}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4 text-primary" /> Team spend</CardTitle>
            <CardDescription>{selectedPeriodLabel}</CardDescription>
          </CardHeader>
          <CardContent><div className="h-64 rounded-sm border bg-muted/25 p-3">
            <SpendStoryChart cycles={cycles} scope="team" />
          </div></CardContent>
        </Card>}
      </section>}

      {(hasTrend || activity != null) && <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {hasTrend && <Card className={`rounded-md shadow-none ${activity == null ? 'lg:col-span-2' : ''}`}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="h-4 w-4 text-primary" /> Selected-period trend</CardTitle>
            <CardDescription>{selectedPeriodLabel}</CardDescription>
          </CardHeader>
          <CardContent><div className="h-56"><TrendChart trend={myDashboard.trend} onClick={() => setLocation(reportingNavigationHref('/spend?viewScope=my', searchString))} /></div></CardContent>
        </Card>}
        {activity != null && <Card className={`rounded-md shadow-none ${!hasTrend ? 'lg:col-span-2' : ''}`}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Flame className="h-4 w-4 text-primary" /> Activity</CardTitle>
            <CardDescription>{selectedPeriodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
              <div className="font-mono text-2xl font-semibold">{formatInt(activity)} <span className="font-sans text-sm font-normal text-muted-foreground">active days</span></div>
          </CardContent>
        </Card>}
      </section>}

    </div>
  );
}
