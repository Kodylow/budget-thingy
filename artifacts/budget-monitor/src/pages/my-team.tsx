import { type ReactNode, useMemo } from 'react';
import { Link } from 'wouter';
import { useSearch } from 'wouter/use-browser-location';
import {
  getGetDashboardQueryKey,
  getListSpendPeopleQueryKey,
  getListSpendProjectsQueryKey,
  useGetDashboard,
  useListSpendPeople,
  useListSpendProjects,
  type ReportingPeriod,
  type SpendTableRow,
} from '@workspace/api-client-react';
import { Activity, ArrowUpRight, DollarSign, RefreshCw, Users } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
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
import { reportingNavigationHref } from '@/lib/reporting-navigation';
import { dashboardTotalSpend } from '@/lib/spend-presentation';
import { formatUsd } from '@/pages/home-components/format';
import { PersonWorkspaceDetails } from '@/components/person-workspace-details';
import { formatBudgetDate } from '@/lib/budget-meter';

function periodDates(period: ReportingPeriod) {
  const inclusiveEnd = new Date(Date.parse(period.endExclusive) - 1).toISOString();
  return `${formatBudgetDate(period.start)}–${formatBudgetDate(inclusiveEnd)}`;
}

export function resolveMyTeamScope(
  role: ReturnType<typeof useAuthContext>['role'],
  canViewAccountUsage = false,
) {
  if (role === 'member') return { authorized: true, viewScope: 'my' as const };
  if (role === 'account' && canViewAccountUsage) {
    return { authorized: true, viewScope: 'all_authorized' as const };
  }
  if (role === 'team_admin' || role === 'workspace_admin' || role === 'account') {
    return { authorized: true, viewScope: 'managed' as const };
  }
  return { authorized: false, viewScope: 'managed' as const };
}

function TablePanel({ title, caption, viewAllHref, children }: {
  title: string;
  caption: string;
  viewAllHref: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 rounded-md shadow-none">
      <CardHeader className="border-b pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{caption}</CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs text-primary" asChild>
            <Link href={viewAllHref}>View all <ArrowUpRight className="ml-1 h-3.5 w-3.5" /></Link>
          </Button>
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

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

export function resolveLimitStatus(row: SpendTableRow): JourneyStatus | null {
  if (
    (row.workspaces?.length ?? 0) > 1
    || row.limitState === 'no_limit'
    || row.limitState === 'unavailable'
    || row.allocationUsd == null
    || row.currentCycleAgentSpendUsd == null
  ) return null;
  if (row.allocationUsd === 0) {
    return row.currentCycleAgentSpendUsd > 0 ? 'Over budget' : 'Within budget';
  }
  if (row.currentCycleAgentSpendUsd > row.allocationUsd) return 'Over budget';
  if (row.currentCycleAgentSpendUsd >= row.allocationUsd * 0.9) return 'Near limit';
  return 'Within budget';
}

export function PeopleTable({ rows, rangeType }: {
  rows: SpendTableRow[];
  rangeType: ReturnType<typeof useRange>['rangeType'];
}) {
  if (rows.length === 0) {
    return <EmptyState title="No recorded people spend" description="No people with recorded spend were found in this scope and period." />;
  }
  return (
    <DataTable
      caption="Top people by selected-period spend"
      columns={[
        { label: 'Member' },
        { label: 'Total', className: 'text-right' },
        { label: 'Projects', className: 'text-right' },
        { label: 'Agent', className: 'text-right' },
        { label: 'Agent Limit', className: 'text-right' },
      ]}
      rows={rows.map((row) => {
        const status = rangeType === 'billing' ? resolveLimitStatus(row) : null;
        return [
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">{initials(row.name)}</span>
            <div>
              <span className="block whitespace-nowrap font-medium">{row.name}</span>
              {(row.workspaces?.length ?? 0) > 1
                ? <PersonWorkspaceDetails workspaces={row.workspaces!} />
                : <span className="block whitespace-nowrap text-xs text-muted-foreground">{row.workspaceName || 'Workspace unavailable'}</span>}
            </div>
          </div>,
          <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.spendUsd)}</span>,
          <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.otherServicesUsd)}</span>,
          <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.agentSpendUsd)}</span>,
          <span className="flex flex-col items-end gap-1">
            <span className="whitespace-nowrap font-mono text-xs">{(row.workspaces?.length ?? 0) > 1 ? 'Per workspace' : row.limitState === 'no_limit' ? 'No limit' : formatUsd(row.allocationUsd)}</span>
            {status && <StatusBadge status={status} />}
            {row.limitObservationStatus === 'refreshing' && <span className="text-[10px] text-muted-foreground">Refreshing</span>}
            {row.limitObservationStatus === 'failed' && <span className="text-[10px] text-muted-foreground">{row.allocationUsd != null ? 'Last known · refresh failed' : 'Observation failed'}</span>}
            {row.limitObservationStatus === 'unavailable' && <span className="text-[10px] text-muted-foreground">Observation unavailable</span>}
          </span>,
        ];
      })}
    />
  );
}

export function ProjectsTable({ rows }: { rows: SpendTableRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No recorded project spend" description="No projects with recorded spend were found in this scope and period." />;
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
      rows={rows.map((row) => [
        <div><span className="block whitespace-nowrap font-medium">{row.name}</span><span className="block whitespace-nowrap text-xs text-muted-foreground">{row.ownerName || 'Owner unavailable'} · {row.workspaceName || 'Workspace unavailable'}</span></div>,
        <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.spendUsd)}</span>,
        <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.agentSpendUsd)}</span>,
        <span className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.otherServicesUsd)}</span>,
      ])}
    />
  );
}

export default function MyTeam() {
  const search = useSearch();
  const { role, capabilities } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const { authorized, viewScope } = resolveMyTeamScope(role, capabilities.canViewAccountUsage);
  const params = { viewScope, rangeType, startDate, endDate };
  const peopleParams = { ...params, page: 1, pageSize: 10, sort: 'spend_desc' as const };
  const projectsParams = { ...params, page: 1, pageSize: 10, sort: 'spend_desc' as const };
  const dashboard = useGetDashboard(params, { query: { enabled: authorized, queryKey: getGetDashboardQueryKey(params) } });
  const people = useListSpendPeople(peopleParams, { query: { enabled: authorized, queryKey: getListSpendPeopleQueryKey(peopleParams) } });
  const projects = useListSpendProjects(projectsParams, { query: { enabled: authorized, queryKey: getListSpendProjectsQueryKey(projectsParams) } });

  const monthly = useMemo(() => (dashboard.data?.insights?.monthly ?? []).slice(-6).map((month) => ({
    month: month.start,
    spendUsd: month.isMissing ? null : month.spendUsd,
    activeUsers: month.isMissing ? null : ((month as typeof month & { activeUsers?: number | null }).activeUsers ?? null),
  })), [dashboard.data]);
  const hasPartialMonth = (dashboard.data?.insights?.monthly ?? []).slice(-6).some(month => month.isPartial);
  const isOrganization = viewScope === 'all_authorized';
  const scopeCopy = role === 'member'
    ? 'Your activity'
    : isOrganization
      ? 'Organization activity'
      : 'Activity across your teams and workspaces';
  const refreshAll = () => void Promise.all([dashboard.refetch(), people.refetch(), projects.refetch()]);
  const pageHeader = (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{isOrganization ? 'My Organization' : 'My Team'}</h1>
        <p className="text-sm text-muted-foreground">{scopeCopy}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={refreshAll}>
          <RefreshCw className="mr-2 h-4 w-4" />Refresh data
        </Button>
        <Button size="sm" asChild>
          <Link href={reportingNavigationHref(`/spend?viewScope=${viewScope}`, search)}>
            <ArrowUpRight className="mr-2 h-4 w-4" />View spend details
          </Link>
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
          {rangeType === 'full-term'
            ? dashboard.data?.contractTerm ? periodDates(dashboard.data.contractTerm) : 'Term dates unavailable'
            : dashboard.data?.period ? periodDates(dashboard.data.period) : 'Billing dates unavailable'}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Recorded actuals to date · No forecasts</p>
    </div>
  );

  if (!authorized) {
    return <div className="p-8" data-testid="my-team-forbidden"><h1 className="text-2xl font-semibold">403 · Access denied</h1><p className="mt-2 text-sm text-muted-foreground">Your role does not include personal or managed usage access.</p></div>;
  }
  if (dashboard.isLoading || people.isLoading || projects.isLoading) {
    return <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">{pageHeader}{rangePanel}<div className="grid gap-4 sm:grid-cols-3">{[1,2,3].map(i => <Skeleton key={i} className="h-28 rounded-md" />)}</div><Skeleton className="h-72 rounded-md" /></div>;
  }
  if (!dashboard.data || !people.data || !projects.data) {
    return <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">{pageHeader}{rangePanel}<EmptyState title="Unable to load activity" description="No values are shown because one or more scoped requests failed." action={<Button variant="outline" onClick={refreshAll}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>} /></div>;
  }

  const insights = dashboard.data.insights;
  const recordedPeople = insights?.activeUsers ?? null;
  const totalSpend = dashboardTotalSpend(dashboard.data);
  const spendCard = dashboard.data.cards.find(card => card.key === 'eligible_spend' || card.key === 'spend');
  const peopleHref = reportingNavigationHref(`/spend?tab=people&viewScope=${viewScope}`, search);
  const projectsHref = reportingNavigationHref(`/spend?tab=projects&viewScope=${viewScope}`, search);
  const qualifications = Array.from(new Set([
    ...dashboard.data.metadata.qualifications,
    ...people.data.metadata.qualifications,
    ...projects.data.metadata.qualifications,
    ...(spendCard?.qualification ? [spendCard.qualification] : []),
  ]));
  const incomplete = [dashboard.data.metadata, people.data.metadata, projects.data.metadata]
    .some(metadata => metadata.status !== 'complete' || metadata.stale);

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      {pageHeader}
      {rangePanel}
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard label="People with recorded spend" value={recordedPeople == null ? 'Unavailable' : recordedPeople.toLocaleString()} detail="Positive recorded spend" />
        <MetricCard label={role === 'member' ? 'My spend' : isOrganization ? 'Organization spend' : 'Team spend'} value={formatUsd(totalSpend)} />
        <MetricCard label="Average per active user" value={totalSpend == null ? 'Unavailable' : formatUsd(insights?.avgSpendPerActiveUserUsd)} detail="Among people with positive recorded spend" />
      </div>
      <AdminDataQualityNote title={isOrganization ? 'Organization activity' : 'Team activity'}>
        {incomplete && <p>{dashboard.data.metadata.status === 'partial' ? 'Partial coverage.' : 'Data may be stale or incomplete.'}</p>}
        {qualifications.map(qualification => <p key={qualification}>{qualification}</p>)}
        <p>Limit columns use the current billing cycle. Six-month activity is independent of the selected period; missing months remain gaps.{hasPartialMonth && ' Partial months show known values only.'}</p>
      </AdminDataQualityNote>
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <TablePanel title="Top People" caption="Selected-period spend · Projects excludes Agent · Agent Limit is per billing cycle." viewAllHref={peopleHref}><PeopleTable rows={people.data.rows} rangeType={rangeType} /></TablePanel>
        <TablePanel title="Top Apps" caption="Projects ranked by selected-period scoped spend." viewAllHref={projectsHref}><ProjectsTable rows={projects.data.rows} /></TablePanel>
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