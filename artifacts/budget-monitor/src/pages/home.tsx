import React from 'react';
import { useAuthContext } from '@/components/auth-context';
import { useRange } from '@/components/range-context';
import {
  useGetDashboard,
  useGetTeamsBudgets,
  useListSpendProjects,
  type TeamBudget,
} from '@workspace/api-client-react';
import { formatUsd, formatInt } from './home-components/format';
import { SpendStoryChart, MonthMiniBars } from './home-components/spend-story-chart';
import {
  aggregatePersonalLimits,
  aggregatePersonalWorkspaceSpend,
  personalProjectCatalogMetrics,
  personalLimitBudgetRows,
} from './home-components/budget-logic';
import { MyBudgetSummary } from './home-components/my-budget-summary';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  BudgetMeter,
  DataTable,
  EmptyState,
  MetricCard,
  type JourneyTableColumn,
} from '@/components/journey-primitives';
import { Link, useSearch } from 'wouter';
import { reportingNavigationHref } from '@/lib/reporting-navigation';
import { dashboardTotalSpend } from '@/lib/spend-presentation';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Box,
  DollarSign,
  Flame,
  RefreshCw,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';

// Presentation ported from usage-dashboard home.tsx; API data is adapted only at this page boundary.
function HeroTile({
  label,
  children,
  sub,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  sub?: React.ReactNode;
  delay?: number;
}) {
  return (
    <MetricCard label={label} value={children} detail={sub} />
  );
}

function DeltaBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-xs text-muted-foreground font-mono">—</span>;
  const up = pct > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-mono font-medium ${up ? 'text-destructive' : 'text-success'}`}>
      {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function BreakdownPopover({
  label,
  children,
  content,
}: {
  label: string;
  children: React.ReactNode;
  content: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,26rem)] p-0">
        {content}
      </PopoverContent>
    </Popover>
  );
}

function TeamBudgetDetails({ teams }: { teams: TeamBudget[] }) {
  return (
    <>
      <div className="border-b border-border p-4">
        <p className="font-semibold">Funding teams</p>
        <p className="mt-1 text-xs text-muted-foreground">{teams[0]?.spendPeriodLabel ?? 'Full term'} · Annual allocation</p>
      </div>
      <div className="max-h-72 overflow-y-auto p-2">
        {teams.map((team) => (
          <div key={team.teamName} className="border-t border-border px-2 py-3 first:border-t-0">
            <p className="truncate text-xs font-medium">{team.teamName}</p>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Spend</dt>
                <dd className="mt-0.5 font-mono">{formatUsd(team.spendUsd)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Annual budget</dt>
                <dd className="mt-0.5 font-mono">{formatUsd(team.amountUsd)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

export default function Home() {
  const searchString = useSearch();
  const { user } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();

  const myDashboardQuery = useGetDashboard({
    viewScope: 'my',
    rangeType,
    startDate,
    endDate,
  });
  const { data: myDashboard, isLoading: myLoading } = myDashboardQuery;
  const { data: myProjects } = useListSpendProjects({
    viewScope: 'my',
    rangeType,
    startDate,
    endDate,
    pageSize: 5,
    sort: 'spend_desc',
  });

  const teamBudgetsQuery = useGetTeamsBudgets({ scope: 'own', period: 'full-term' });
  const teamBudgets = teamBudgetsQuery.data?.budgets ?? [];
  const knownTeamSpend = teamBudgets.filter((team) => team.spendUsd != null);
  const knownTeamBudgets = teamBudgets.filter((team) => team.amountUsd != null);
  const teamSpendUsd = knownTeamSpend.length
    ? knownTeamSpend.reduce((sum, team) => sum + team.spendUsd!, 0)
    : null;
  const teamBudgetUsd = knownTeamBudgets.length
    ? knownTeamBudgets.reduce((sum, team) => sum + team.amountUsd!, 0)
    : null;

  const mySpendUsd = dashboardTotalSpend(myDashboard);
  const changePct = myDashboard?.insights?.changePercent;
  const activeDays = myDashboard?.insights?.activeDays;
  const activity = activeDays != null ? activeDays : null;
  const personalSpendRows = myDashboard?.personalSpendByWorkspace ?? [];
  const personalSpendAggregate = aggregatePersonalWorkspaceSpend(personalSpendRows, mySpendUsd);
  const personalProjectCatalog = personalProjectCatalogMetrics(myDashboard?.personalProjectCatalog);
  const projectCount = personalProjectCatalog.projectCount;
  const personalLimits = myDashboard?.personalLimits ?? [];
  const personalLimitAggregate = aggregatePersonalLimits(personalLimits);
  const budgetRows = personalLimitBudgetRows(personalLimits);
  const greeting = new Date().getHours() < 12
    ? 'Good morning'
    : new Date().getHours() < 18
      ? 'Good afternoon'
      : 'Good evening';
  const projectColumns: JourneyTableColumn[] = [
    { label: 'Project', className: 'min-w-[220px]' },
    { label: 'Spend', className: 'text-right' },
  ];

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

        <div className="rounded-md border bg-card p-4 shadow-none">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">Personal and team</p>
            </div>
            <div className="text-xs text-muted-foreground">
              Reporting period <span className="ml-1 font-medium text-foreground">{myDashboard.period.label}</span>
            </div>
          </div>
        </div>

        <div aria-label="Primary spend and budget metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <HeroTile
            label="My Spend"
            icon={DollarSign}
            sub={`Agent · This billing cycle${personalLimitAggregate.consumptionComplete ? '' : ' · Known subtotal'}`}
          >
            {personalLimitAggregate.observedConsumptionCount
              ? formatUsd(personalLimitAggregate.knownConsumptionUsd)
              : 'Unavailable'}
          </HeroTile>
          <MyBudgetSummary limits={personalLimits} />

          <HeroTile
            label="My Team Spend"
            icon={Users}
            sub={`${teamBudgets[0]?.spendPeriodLabel ?? 'Full term'}${teamBudgets.some((team) => team.spendScope === 'partial') ? ' · Partial authorized scope' : ''}${knownTeamSpend.length < teamBudgets.length ? ' · Known subtotal' : ''}`}
          >
            {teamBudgets.length > 0
              ? <BreakdownPopover label="Show funding team spend" content={<TeamBudgetDetails teams={teamBudgets} />}>
                  {formatUsd(teamSpendUsd)}
                </BreakdownPopover>
              : formatUsd(teamSpendUsd)}
          </HeroTile>

          <HeroTile
            label="Team Budget"
            icon={Target}
            sub={<Link href={reportingNavigationHref('/my-team?viewScope=managed', searchString)} className="inline-flex items-center gap-1 text-primary hover:underline">
              {knownTeamBudgets.length < teamBudgets.length && 'Known subtotal · '}
              Annual allocation · My Team <ArrowRight className="h-3 w-3" />
            </Link>}
          >
            {teamBudgets.length > 0
              ? <BreakdownPopover label="Show funding team budgets" content={<TeamBudgetDetails teams={teamBudgets} />}>
                  {formatUsd(teamBudgetUsd)}
                </BreakdownPopover>
              : formatUsd(teamBudgetUsd)}
          </HeroTile>
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

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
        <Card className="rounded-md shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="w-4 h-4 text-primary" /> My Spend Story · {myDashboard?.period?.label || 'This period'}
            </CardTitle>
            <CardDescription>Cumulative posted spend, day by day</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-56 rounded-sm border bg-muted/25 p-2">
              <SpendStoryChart trend={myDashboard?.trend} />
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card className="rounded-md shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Target className="h-4 w-4 text-primary" /> Budget health
              </CardTitle>
              <CardDescription>Current-cycle workspace limit consumption</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {budgetRows.length > 0 ? budgetRows.slice(0, 4).map((row) => (
                <BudgetMeter
                  key={row.id}
                  label={row.workspaceName || row.workspaceId}
                  actualUsd={row.currentCycleAgentSpendUsd}
                  budgetUsd={row.allocationUsd}
                  incomplete={row.limitState === 'unavailable' || row.allocationUsd == null}
                  compact
                />
              )) : (
                <p className="text-sm text-muted-foreground">Current-cycle limits unavailable.</p>
              )}
            </CardContent>
          </Card>
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
        </div>
      </section>

      <section>
        <Card className="rounded-md shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Box className="w-4 h-4 text-primary" /> My Replit World
            </CardTitle>
            <CardDescription>Highest-spend projects in the selected period</CardDescription>
          </CardHeader>
          <CardContent>
          {myProjects?.rows?.length ? (
            <DataTable
              columns={projectColumns}
              caption="Highest-spend projects"
              rows={myProjects.rows.slice(0, 4).map((project) => [
                <span className="block truncate font-medium">{project.name || 'Untitled project'}</span>,
                <span className="block whitespace-nowrap text-right font-mono">{formatUsd(project.spendUsd)}</span>,
              ])}
            />
          ) : (
            <EmptyState
              title="No project spend"
              description="No projects with spend were found in this period."
            />
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