import React, { useState } from 'react';
import { useAuthContext } from '@/components/auth-context';
import { useRange } from '@/components/range-context';
import {
  getGetDashboardQueryKey,
  useGetDashboard,
  useListSpendProjects,
} from '@workspace/api-client-react';
import { formatUsd, formatInt } from './home-components/format';
import { SpendStoryChart, MonthMiniBars } from './home-components/spend-story-chart';
import {
  aggregatePersonalLimits,
  aggregatePersonalWorkspaceSpend,
  personalProjectCatalogMetrics,
  personalLimitBudgetRows,
} from './home-components/budget-logic';
import { Skeleton } from '@/components/ui/skeleton';
import { Link, useSearch } from 'wouter';
import { reportingNavigationHref } from '@/lib/reporting-navigation';
import { dashboardAllocatedBudget, dashboardTotalSpend } from '@/lib/spend-presentation';
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
  icon: Icon,
  children,
  sub,
  delay = 0,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  sub?: React.ReactNode;
  delay?: number;
}) {
  return (
    <div
      className="bg-card border border-border shadow-sm rounded-xl p-5 relative overflow-hidden transition-colors hover:border-primary/30"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-3.5 h-3.5 text-primary" />
        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</div>
      </div>
      <div className="text-3xl font-mono font-semibold text-foreground tracking-tight">{children}</div>
      <div className="flex items-end justify-between gap-2 mt-1.5 min-h-[28px]">
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
    </div>
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
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(92vw,26rem)] p-0"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}

export default function Home() {
  const searchString = useSearch();
  const { user, role, capabilities } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const isManager = role === 'team_admin' || role === 'workspace_admin' || role === 'account';
  const isOrganization = role === 'account' && capabilities.canViewAccountUsage;

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

  const managedDashboardParams = {
    viewScope: isOrganization ? 'all_authorized' as const : 'managed' as const,
    rangeType,
    startDate,
    endDate,
  };
  const managedDashboardQuery = useGetDashboard(managedDashboardParams, {
    query: {
      enabled: isManager,
      queryKey: getGetDashboardQueryKey(managedDashboardParams),
    },
  });
  const managedDashboard = managedDashboardQuery.data;
  const managedFullTermParams = {
    viewScope: managedDashboardParams.viewScope,
    rangeType: 'full-term' as const,
  };
  const managedFullTermQuery = useGetDashboard(managedFullTermParams, {
    query: {
      enabled: isManager && rangeType !== 'full-term',
      queryKey: getGetDashboardQueryKey(managedFullTermParams),
    },
  });
  const managedBudgetDashboard = rangeType === 'full-term'
    ? managedDashboard
    : managedFullTermQuery.data;
  const managedAllocationUsd = dashboardAllocatedBudget(managedBudgetDashboard);

  const mySpendUsd = dashboardTotalSpend(myDashboard);
  const managedSpendUsd = dashboardTotalSpend(managedDashboard);
  const changePct = myDashboard?.insights?.changePercent;
  const activeDays = myDashboard?.insights?.activeDays;
  const activity = activeDays != null ? activeDays : null;
  const personalSpendRows = myDashboard?.personalSpendByWorkspace ?? [];
  const personalSpendAggregate = aggregatePersonalWorkspaceSpend(personalSpendRows, mySpendUsd);
  const personalProjectCatalog = personalProjectCatalogMetrics(myDashboard?.personalProjectCatalog);
  const projectCount = personalProjectCatalog.projectCount;
  const personalSpendHeadline = mySpendUsd ??
    (personalSpendAggregate.workspaceCount > personalSpendAggregate.unknownCount
      ? personalSpendAggregate.knownSubtotalUsd
      : null);
  const personalLimits = myDashboard?.personalLimits ?? [];
  const budgetRows = personalLimitBudgetRows(personalLimits);
  const budgetAggregate = aggregatePersonalLimits(personalLimits);
  const budgetIsFiniteOnly = budgetAggregate.finiteCount > 0 &&
    budgetAggregate.unlimitedCount === 0 &&
    budgetAggregate.unknownLimitCount === 0;
  const budgetConsumptionPrefix = budgetAggregate.consumptionComplete ? '' : 'Known ';
  const greeting = new Date().getHours() < 12
    ? 'Good morning'
    : new Date().getHours() < 18
      ? 'Good afternoon'
      : 'Good evening';

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
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6">
      <section className="space-y-5">
        <div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
            {greeting}{user?.firstName ? <>, <span className="text-primary">{user.firstName}</span></> : ''}
          </h1>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground mt-1.5">
              Your Replit world for {myDashboard?.period?.label || 'this period'} — your apps, your spend, your story.
            </p>
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 lg:grid-cols-4">
          <HeroTile
            label={`My Spend (${rangeType === 'mtd' ? 'MTD' : 'Period'})`}
            icon={DollarSign}
            sub={<span className="flex flex-wrap items-center gap-2">
              <span>{myDashboard.period.label}</span>
              {personalSpendAggregate.unknownCount > 0 && <span>Known subtotal · {personalSpendAggregate.unknownCount} workspace{personalSpendAggregate.unknownCount === 1 ? '' : 's'} unknown</span>}
              <DeltaBadge pct={changePct} />
            </span>}
          >
            {personalSpendRows.length > 0
              ? <BreakdownPopover
                  label="Show selected-period spend by workspace"
                  content={<div>
                    <div className="border-b border-border p-4">
                      <p className="font-semibold">Selected-period spend by workspace</p>
                       <p className="mt-1 text-xs text-muted-foreground">{myDashboard.period.label}</p>
                    </div>
                    <div className="max-h-72 overflow-y-auto p-2">
                      {personalSpendRows.map((row) => (
                        <div key={row.workspaceId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md px-2 py-2 text-xs">
                          <span className="truncate font-medium">{row.workspaceName || row.workspaceId}</span>
                          <span className="font-mono">
                            {row.usageObserved && row.spendUsd != null ? formatUsd(row.spendUsd) : 'Unavailable'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>}
                >
                  <span>{mySpendUsd == null && personalSpendHeadline != null && 'Known '}{formatUsd(personalSpendHeadline)}</span>
                </BreakdownPopover>
              : formatUsd(mySpendUsd)}
          </HeroTile>
          <AdminDataQualityNote title="My Spend">
            Gross personal spend across all services.
            {personalSpendAggregate.complete && !personalSpendAggregate.reconcilesToCanonical && (
              <> Workspace values do not reconcile to the dashboard total.</>
            )}
          </AdminDataQualityNote>

          <HeroTile
            label="My Replit Budget"
            icon={Target}
            delay={30}
            sub={budgetRows.length > 0
              ? <span>
                  Current billing cycle · {budgetAggregate.workspaceCount} workspace{budgetAggregate.workspaceCount === 1 ? '' : 's'}
                  {budgetAggregate.unknownConsumptionCount > 0 && ` · ${budgetAggregate.unknownConsumptionCount} usage unknown`}
                  {budgetAggregate.unlimitedCount > 0 && ` · ${budgetAggregate.unlimitedCount} no-limit`}
                  {budgetAggregate.unknownLimitCount > 0 && ` · ${budgetAggregate.unknownLimitCount} limit unknown`}
                </span>
              : 'Current-cycle limits unavailable'}
          >
            {budgetRows.length > 0
              ? <BreakdownPopover
                  label="Show current-cycle budget by workspace"
                  content={<div>
                    <div className="border-b border-border p-4">
                      <p className="font-semibold">Current-cycle Agent usage by workspace</p>
                    </div>
                    <div className="max-h-72 overflow-y-auto p-2">
                      {budgetRows.map((row) => (
                        <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 rounded-md px-2 py-2 text-xs">
                          <span className="truncate font-medium">{row.workspaceName || row.workspaceId}</span>
                          <span className="font-mono">{formatUsd(row.currentCycleAgentSpendUsd)} used</span>
                          <span className="font-mono text-muted-foreground">
                            {row.limitState === 'no_limit' ? 'No limit' : row.allocationUsd == null ? 'Limit unknown' : `${formatUsd(row.allocationUsd)} limit`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>}
                >
                  <span>
                    {budgetAggregate.observedConsumptionCount > 0
                      ? <>{budgetConsumptionPrefix}{formatUsd(budgetAggregate.knownConsumptionUsd)}</>
                      : 'Unavailable'}
                    {budgetAggregate.observedConsumptionCount > 0 && budgetIsFiniteOnly && <span className="ml-1 text-xs font-sans font-normal text-muted-foreground">of {formatUsd(budgetAggregate.finiteBudgetUsd)}</span>}
                    {budgetAggregate.observedConsumptionCount > 0 && !budgetIsFiniteOnly && <span className="ml-1 text-xs font-sans font-normal text-muted-foreground">current-cycle Agent</span>}
                  </span>
                </BreakdownPopover>
              : 'Unavailable'}
          </HeroTile>
          <AdminDataQualityNote title="My Replit Budget">
            Workspace limits are separate and are not a transferable pooled budget.
          </AdminDataQualityNote>

          <HeroTile
            label="My Projects"
            icon={Box}
            delay={120}
            sub={<span>
              {personalProjectCatalog.publishedProjectCount == null
                ? 'Published unavailable'
                : `${personalProjectCatalog.publishedCountQualified ? 'Known ' : ''}${formatInt(personalProjectCatalog.publishedProjectCount)} published`}
              {myDashboard.personalProjectCatalog?.publicationUnknownProjectCount
                ? ` · ${formatInt(myDashboard.personalProjectCatalog.publicationUnknownProjectCount)} publication states unknown`
                : ''}
                {myDashboard.personalProjectCatalog?.coverage !== 'complete' && (
                  <AdminDataQualityNote title="My Projects">
                    The current project catalog is {myDashboard.personalProjectCatalog?.coverage ?? 'unavailable'}.
                    {myDashboard.personalProjectCatalog?.publicationUnknownProjectCount
                      ? ` Publication state is unknown for ${formatInt(myDashboard.personalProjectCatalog.publicationUnknownProjectCount)} projects.`
                      : ''}
                 </AdminDataQualityNote>
               )}
            </span>}
          >
            {projectCount != null
              ? <>{personalProjectCatalog.projectCountQualified && 'Known '}{formatInt(projectCount)}</>
              : 'Unavailable'}
          </HeroTile>

          {isManager ? (
            <Link href={reportingNavigationHref(`/my-team?viewScope=${isOrganization ? 'all_authorized' : 'managed'}`, searchString)} className="contents">
              <HeroTile
                label={isOrganization ? 'My Organization Spend' : "My Team's Spend"}
                icon={Users}
                delay={180}
                sub={<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-primary">
                  <span>{managedDashboard?.insights?.activeUsers != null
                      ? `${managedDashboard.insights.activeUsers} active users`
                      : isOrganization ? 'Organization scope' : 'Managed scope'}</span>
                  {rangeType !== 'full-term' && managedAllocationUsd != null && (
                    <span className="text-muted-foreground">Budget is full-term</span>
                  )}
                  <ArrowRight className="w-3 h-3" />
                </span>}
              >
                {managedDashboardQuery.isLoading || (rangeType !== 'full-term' && managedFullTermQuery.isLoading)
                  ? <Skeleton className="inline-block h-8 w-24" />
                  : <>{formatUsd(managedSpendUsd)}
                      {managedAllocationUsd != null && (
                        <span className="ml-1 text-xs font-sans font-normal text-muted-foreground">
                          of {formatUsd(managedAllocationUsd)} {rangeType === 'full-term' ? 'allocated' : 'full-term allocated'}
                        </span>
                      )}
                    </>}
              </HeroTile>
            </Link>
          ) : (
            <HeroTile label="Active Days" icon={Activity} delay={180} sub="days with usage in this period">
              {activity != null ? formatInt(activity) : '—'}
            </HeroTile>
          )}
        </div>
      </section>

      {(myDashboardQuery.isError || managedDashboardQuery.isError || managedFullTermQuery.isError) && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <div className="flex-1">
            <strong className="text-foreground">Refresh failed; last available values are shown.</strong>
          </div>
          {(myDashboardQuery.isError || managedDashboardQuery.isError || managedFullTermQuery.isError) && (
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => {
              void myDashboardQuery.refetch();
              if (isManager) void managedDashboardQuery.refetch();
               if (isManager && rangeType !== 'full-term') void managedFullTermQuery.refetch();
            }}>Retry</button>
          )}
        </div>
      )}
      {myDashboard.metadata.qualifications.length > 0 && (
        <AdminDataQualityNote title="Home overview">
          {myDashboard.metadata.qualifications.join(' ')}
        </AdminDataQualityNote>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-card border border-border shadow-sm rounded-2xl p-5 lg:col-span-2 space-y-3">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" /> My Spend Story · {myDashboard?.period?.label || 'This period'}
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Cumulative spend, day by day</p>
          </div>
          <div className="h-56">
            <SpendStoryChart trend={myDashboard?.trend} />
          </div>
        </div>
        <div className="space-y-4">
          <div className="bg-card border border-border shadow-sm rounded-2xl p-5 space-y-3">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-primary" /> My Last 6 Months
              </h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">My total spend per month</p>
            </div>
            <div className="h-32">
              <MonthMiniBars monthly={myDashboard?.insights?.monthly} />
            </div>
          </div>
          <div className="bg-card border border-border shadow-sm rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Flame className="w-3.5 h-3.5 text-primary" />
              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Activity</div>
            </div>
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
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-card border border-border shadow-sm rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Box className="w-4 h-4 text-primary" /> My Replit World
          </h2>
          {myProjects?.rows?.length ? (
            <div className="space-y-2">
              {myProjects.rows.slice(0, 4).map((project) => (
                <div key={project.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
                  <span className="text-sm font-medium truncate">{project.name || 'Untitled project'}</span>
                  <span className="text-xs font-mono shrink-0">{formatUsd(project.spendUsd)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No projects with spend in this period.</p>
          )}
        </div>

        <div className="bg-card border border-border shadow-sm rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" /> {isOrganization ? 'Me vs My Organization' : 'Me vs My Team'}
            </h2>
            {isManager && capabilities?.canViewAccountUsage === true && (
              <Link
                href={reportingNavigationHref('/org-insights?viewScope=all_authorized', searchString)}
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                Org Insights <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-muted/40 p-3 min-w-0">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Me</div>
              <div className="text-lg font-mono font-semibold">{formatUsd(mySpendUsd)}</div>
              <div className="text-[10px] text-muted-foreground">period spend</div>
              <div className="mt-1"><DeltaBadge pct={changePct} /></div>
            </div>
            <div className="rounded-lg bg-muted/40 p-3 min-w-0">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{isOrganization ? 'My Organization' : 'My Team'}</div>
              <div className="text-lg font-mono font-semibold">
                {isManager
                  ? formatUsd(managedDashboard?.insights?.avgSpendPerActiveUserUsd ?? null)
                  : '—'}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {isManager ? 'avg / active user' : 'manager access required'}
              </div>
              {isManager && <div className="mt-1"><DeltaBadge pct={managedDashboard?.insights?.changePercent} /></div>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}