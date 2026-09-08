import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useBrowserLocation as useLocation, useSearch } from 'wouter/use-browser-location';
import {
  getGetBudgetTeamReportQueryKey,
  useGetBudgetTeamReport,
  type ReportingPeriod,
  type SpendTableRow,
  type ReportingDetailMember,
  type RangeTypeParameter,
} from '@workspace/api-client-react';
import { Activity, DollarSign, RefreshCw, Users, AlertTriangle } from 'lucide-react';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { TrendAreaChart } from '@/components/Charts';
import {
  DataTable,
  EmptyState,
  MetricCard,
  StatusBadge,
  type JourneyStatus,
} from '@/components/journey-primitives';
import { RangeFilter } from '@/components/range-filter';
import { useRange } from '@/components/range-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUsd } from '@/pages/home-components/format';
import { formatBudgetDate } from '@/lib/budget-meter';
import { BudgetTrajectory } from '@/pages/home-components/budget-trajectory';
import { useAuthContext } from '@/components/auth-context';
import { spendDetailHref } from '@/lib/spend-exploration';
import { isBlockingQueryError, isReportingUsageRefreshing } from '@/lib/errors';

function periodDates(period: ReportingPeriod) {
  const inclusiveEnd = new Date(Date.parse(period.endExclusive) - 1).toISOString();
  return `${formatBudgetDate(period.start)}–${formatBudgetDate(inclusiveEnd)}`;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

function TablePanel({ title, caption, isExpanded, onToggleExpand, children }: {
  title: string;
  caption: string;
  isExpanded: boolean;
  onToggleExpand?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-w-0 rounded-md shadow-none">
      <CardHeader className="border-b pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{caption}</CardDescription>
          </div>
          {onToggleExpand && (
            <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs text-primary" onClick={onToggleExpand}>
              {isExpanded ? 'Show less' : 'View all'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div aria-label={`${title} table`} className="max-w-full overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>div]:overflow-visible" tabIndex={0}>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

export function PeopleTable({ rows, rangeType, poolId }: {
  rows: ReportingDetailMember[];
  rangeType: string;
  poolId: string;
}) {
  const [location] = useLocation();
  const search = useSearch();
  const returnTo = location + search;
  
  if (rows.length === 0) {
    return <EmptyState title="No recorded people spend" description="No people with recorded spend were found in this team." />;
  }
  return (
    <DataTable
      caption="Top people by selected-period spend"
      columns={[
        { label: 'Member' },
        { label: 'Total', className: 'text-right' },
        { label: 'Agent', className: 'text-right' },
        { label: 'Agent Limit', className: 'text-right' },
      ]}
      rows={rows.map((row) => {
        const isUnavailable = row.limitState === 'unavailable';
        const isNoLimit = row.limitState === 'no_limit';
        let status: JourneyStatus | null = null;
        if (rangeType === 'billing' && !isUnavailable && !isNoLimit && row.limitUsd != null && row.currentCycleAgentSpendUsd != null) {
            if (row.limitUsd === 0) {
                status = row.currentCycleAgentSpendUsd > 0 ? 'Over budget' : 'Within budget';
            } else if (row.currentCycleAgentSpendUsd > row.limitUsd) {
                status = 'Over budget';
            } else if (row.currentCycleAgentSpendUsd >= row.limitUsd * 0.9) {
                status = 'Near limit';
            } else {
                status = 'Within budget';
            }
        }
        
        const personHref = `${spendDetailHref(`/users/${encodeURIComponent(row.userId!)}`, returnTo)}&poolId=${encodeURIComponent(poolId)}`;
        
        return [
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">{initials(row.name || row.username || row.email || row.userId || '')}</span>
            <div>
              {row.userId ? (
                 <Link href={personHref} className="block whitespace-nowrap font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">{row.name || row.username || row.userId}</Link>
              ) : (
                 <span className="block whitespace-nowrap font-medium">{row.name || row.username || row.userId}</span>
              )}
              <span className="block whitespace-nowrap text-xs text-muted-foreground truncate max-w-[200px]">{row.email || 'Email unavailable'}</span>
            </div>
          </div>,
          <span className="whitespace-nowrap font-mono text-xs">{formatUsd(row.spendUsd)}</span>,
          <span className="whitespace-nowrap font-mono text-xs">{formatUsd(row.agentSpendUsd)}</span>,
          <span className="flex flex-col items-end gap-1">
            <span className="whitespace-nowrap font-mono text-xs">{isNoLimit ? 'No limit' : formatUsd(row.limitUsd)}</span>
            {status && <StatusBadge status={status} />}
            {row.limitObservationStatus === 'failed' && row.limitUsd == null && <span className="text-[10px] text-muted-foreground">Observation failed</span>}
            {row.limitObservationStatus === 'unavailable' && <span className="text-[10px] text-muted-foreground">Observation unavailable</span>}
          </span>,
        ];
      })}
    />
  );
}

export function ProjectsTable({ rows, poolId }: { rows: SpendTableRow[], poolId: string }) {
  const [location] = useLocation();
  const search = useSearch();
  const returnTo = location + search;
  
  if (rows.length === 0) {
    return <EmptyState title="No recorded project spend" description="No projects with recorded spend were found." />;
  }
  return (
    <DataTable
      caption="Top apps by selected-period spend"
      columns={[
        { label: 'App / project' },
        { label: 'Total', className: 'text-right' },
        { label: 'Agent', className: 'text-right' },
        { label: 'Cloud Services', className: 'text-right' },
      ]}
      rows={rows.map((row) => {
        const projectHref = `${spendDetailHref(`/workspaces/${encodeURIComponent(row.workspaceId!)}/projects/${encodeURIComponent(row.projectId ?? row.id)}`, returnTo)}&poolId=${encodeURIComponent(poolId)}`;
        return [
        <div>
            <Link href={projectHref} className="block whitespace-nowrap font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">{row.name}</Link>
            <span className="block whitespace-nowrap text-xs text-muted-foreground">{row.ownerName || 'Owner unavailable'} · {row.workspaceName || 'Workspace unavailable'}</span>
        </div>,
        <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.spendUsd)}</span>,
        <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.agentSpendUsd)}</span>,
        <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.otherServicesUsd)}</span>,
      ]})}
    />
  );
}

export default function TeamOverview() {
  const [location] = useLocation();
  const { rangeType, startDate, endDate } = useRange();
  const { authorizationKey } = useAuthContext();
  
  const match = location.match(/^\/teams\/([^/?]+)/);
  let poolId = match?.[1] ?? '';
  try {
    poolId = decodeURIComponent(poolId);
  } catch {
    // Preserve malformed selectors for an explicit unavailable response, never widen.
  }
  
  const queryParams = { 
      rangeType: rangeType as RangeTypeParameter, 
      startDate, 
      endDate, 
      includeHierarchy: true, 
      includeBudgetTracking: true, 
      trackingRange: 'budget' as const, 
      includeOverview: true, 
      viewScope: 'all_authorized' as const 
  };
  
  const reportQuery = useGetBudgetTeamReport(poolId, queryParams, { 
      query: { 
          enabled: !!poolId, 
          queryKey: [...getGetBudgetTeamReportQueryKey(poolId, queryParams), authorizationKey] 
      } 
  });
  
  const [peopleExpanded, setPeopleExpanded] = useState(false);

  const refreshAll = () => void reportQuery.refetch();

  const isLoading = reportQuery.isLoading;
  const report = reportQuery.data;
  const queryError = reportQuery.error ?? reportQuery.failureReason;
  const refreshingUsage = isReportingUsageRefreshing(queryError);
  const blockingError = isBlockingQueryError(queryError);

  const overview = report?.overview;
  const budget = report?.budgetTracking;
  const selectedObserved = report?.headline.usageObserved ?? report?.headline.isComplete;
  const complete = report?.headline.isComplete;
  
  const monthly = (overview?.insights?.monthly ?? []).slice(-6).map((month) => ({
    month: month.start,
    spendUsd: month.isMissing ? null : month.spendUsd,
    activeUsers: month.isMissing ? null : month.activeUsers,
  }));
  const hasPartialMonth = (overview?.insights?.monthly ?? []).slice(-6).some(month => month.isPartial);

  const pageHeader = (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{report?.name || 'Team overview'}</h1>
        <p className="text-sm text-muted-foreground">Team overview</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={refreshAll}>
          <RefreshCw className="mr-2 h-4 w-4" />Refresh data
        </Button>
      </div>
    </header>
  );

  const rangePanel = (
    <div className="flex flex-col gap-4 rounded-md border bg-card p-4 shadow-none lg:flex-row lg:items-end lg:justify-between">
      <div className="w-full lg:w-auto">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Reporting period</span>
        <RangeFilter selectedLabel={rangeType === 'full-term' ? 'Full term' : 'Billing period'} />
        <p className="mt-2 text-xs text-muted-foreground" data-testid="text-reporting-dates">
          {report?.period ? periodDates(report.period) : 'Dates unavailable'}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Recorded actuals to date · No forecasts</p>
    </div>
  );

  if (blockingError) {
      const errorData = (queryError as any)?.status;
      if (errorData === 401 || errorData === 403 || errorData === 404) {
          return <div className="p-8" data-testid="team-overview-forbidden"><h1 className="text-2xl font-semibold">{errorData} · Access denied or not found</h1><p className="mt-2 text-sm text-muted-foreground">You do not have access to this team, or it does not exist.</p></div>;
      }
      return <div className="mx-auto max-w-[1280px] p-4 md:p-8"><EmptyState title="Unable to load team" description="The team report could not be loaded." action={<Button variant="outline" onClick={refreshAll}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>} /></div>;
  }

  if (isLoading || (!report && refreshingUsage)) {
    return <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">{pageHeader}{rangePanel}<div className="grid gap-4 sm:grid-cols-4">{[1,2,3,4].map(i => <Skeleton key={i} className="h-28 rounded-md" />)}</div><Skeleton className="h-72 rounded-md" /></div>;
  }

  if (!report) {
    return <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">{pageHeader}{rangePanel}<EmptyState title="Unable to load team" description="The team report could not be loaded." action={<Button variant="outline" onClick={refreshAll}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>} /></div>;
  }

  const rankedMembers = [...report.members].sort((a, b) =>
    b.spendUsd - a.spendUsd
    || a.userId.localeCompare(b.userId)
    || a.workspaceId.localeCompare(b.workspaceId));

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      {pageHeader}
      {rangePanel}
      
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {budget ? (
          <>
            <MetricCard label="Annual allocation" value={formatUsd(budget.allocationUsd)} detail={`Full period · ${budget.periodLabel || 'loading'}`} />
            <MetricCard label="Budget-period spend" value={formatUsd(budget.spendUsd)} detail={budget.spendUsd != null ? budget.periodLabel : 'Unavailable'} />
            <MetricCard label="Budget remaining" value={budget.remainingUsd == null ? 'Unavailable' : formatUsd(budget.remainingUsd)} detail={budget.percentUsed != null ? `${budget.percentUsed.toFixed(1)}% used` : 'Full-period accounting'} />
          </>
        ) : (
          <>
            <MetricCard label="Annual allocation" value="Unavailable" detail="Full-period tracking disabled" />
            <MetricCard label="Budget-period spend" value="Unavailable" detail="Full-period tracking disabled" />
            <MetricCard label="Budget remaining" value="Unavailable" detail="Full-period tracking disabled" />
          </>
        )}
        <MetricCard label="Selected spend" value={formatUsd(selectedObserved ? report.headline.spendUsd : null)} detail={`${!complete && selectedObserved ? 'Known subtotal · ' : ''}${report.period.label}`} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
         <MetricCard label="People with recorded spend" value={overview?.insights?.activeUsers == null ? 'Unavailable' : overview.insights.activeUsers.toLocaleString()} detail="Positive recorded spend" />
         <MetricCard label="Average per active user" value={overview?.insights?.avgSpendPerActiveUserUsd == null ? 'Unavailable' : formatUsd(overview.insights.avgSpendPerActiveUserUsd)} detail="Among people with positive recorded spend" />
      </div>

      <AdminDataQualityNote title="Team activity qualifications">
        {!complete && selectedObserved && <p>Known subtotal with partial coverage.</p>}
        {report.metadata.qualifications.map(qualification => <p key={qualification}>{qualification}</p>)}
        <p>Limit columns use the current billing cycle. Six-month activity is independent of the selected period; missing months remain gaps.{hasPartialMonth && ' Partial months show known values only.'}</p>
        {overview && !overview.projectAttributionComplete && <p>Project attribution is incomplete.</p>}
      </AdminDataQualityNote>
      
      {budget && (
        <Card className="rounded-md shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Budget trajectory</CardTitle>
            <CardDescription>Pacing over the full budget period.</CardDescription>
          </CardHeader>
          <CardContent>
            <BudgetTrajectory
              teamName={report.name || null}
              tracking={budget}
              loading={false}
              refreshingUsage={false}
              error={false}
              onRetry={refreshAll}
              comparisonsMatchBudgetWindow={budget.comparisonsMatchBudgetWindow === true}
            />
          </CardContent>
        </Card>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <TablePanel title="Top People" caption="Selected-period spend · Agent Limit is per billing cycle." isExpanded={peopleExpanded} onToggleExpand={report.members.length > 10 ? () => setPeopleExpanded(!peopleExpanded) : undefined}>
          <PeopleTable rows={peopleExpanded ? rankedMembers : rankedMembers.slice(0, 10)} rangeType={rangeType} poolId={poolId} />
        </TablePanel>
        <TablePanel title="Top Apps" caption="Projects ranked by selected-period scoped spend." isExpanded={false}>
          <ProjectsTable rows={overview?.projects || []} poolId={poolId} />
          {overview && !overview.projectAttributionComplete && (
            <div className="p-3 text-xs text-amber-600 bg-amber-50 flex items-center gap-2 border-t">
              <AlertTriangle className="h-4 w-4" /> Attribution incomplete
            </div>
          )}
        </TablePanel>
      </div>
      
      <Card className="rounded-md shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Six-month activity</CardTitle>
          <CardDescription>Scoped spend and active users, independent of the selected period.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-6 xl:grid-cols-2">
          <section className="min-w-0">
            <h2 className="flex items-center gap-2 text-xs font-medium"><DollarSign className="h-4 w-4 text-primary" />Spend</h2>
            <div className="mt-3 h-64"><TrendAreaChart data={monthly} dataKey="spendUsd" valueLabel="Scoped spend" /></div>
          </section>
          <section className="min-w-0">
            <h2 className="flex items-center gap-2 text-xs font-medium"><Users className="h-4 w-4 text-primary" />Active users</h2>
            <div className="mt-3 h-64"><TrendAreaChart data={monthly} dataKey="activeUsers" valueKind="count" valueLabel="Active users" /></div>
          </section>
          {hasPartialMonth && <p className="flex items-center gap-2 border-t pt-4 text-xs text-muted-foreground xl:col-span-2"><Activity className="h-3.5 w-3.5" />The latest month is partial; known spend and users are shown.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
