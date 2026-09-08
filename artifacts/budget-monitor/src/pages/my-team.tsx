import { type ReactNode, useId, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useLocation } from 'wouter';
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
import { Activity, ChevronRight, DollarSign, RefreshCw, Users } from 'lucide-react';
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
import { spendDetailHref } from '@/lib/spend-exploration';
import { formatUsd } from '@/pages/home-components/format';
import { PersonWorkspaceDetails } from '@/components/person-workspace-details';
import { formatBudgetDate } from '@/lib/budget-meter';
import { isBlockingQueryError, isReportingUsageRefreshing } from '@/lib/errors';

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

function TablePanel({ title, caption, isExpanded, onToggleExpand, children }: {
  title: string;
  caption: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
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
          <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs text-primary" onClick={onToggleExpand}>
            {isExpanded ? 'Show less' : 'View all'}
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
  const [location] = useLocation();
  const search = useSearch();
  const returnTo = location + search;
  const detailsId = useId();
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(() => new Set());

  if (rows.length === 0) {
    return <EmptyState title="No recorded people spend" description="No people with recorded spend were found in this scope and period." />;
  }
  return (
    <DataTable
      caption="Top people by selected-period spend"
      rowKeys={rows.map(row => row.userId ?? row.id)}
      rowDetails={index => {
        const row = rows[index];
        const memberKey = row.userId ?? row.id;
        return expandedMembers.has(memberKey) && (row.workspaces?.length ?? 0) > 1
          ? <PersonWorkspaceDetails id={`${detailsId}-${encodeURIComponent(memberKey)}`} memberName={row.name} workspaces={row.workspaces!} />
          : null;
      }}
      columns={[
        { label: 'Member' },
        { label: 'Total', className: 'text-right' },
        { label: 'Projects', className: 'text-right' },
        { label: 'Agent', className: 'text-right' },
        { label: 'Agent Limit', className: 'text-right' },
      ]}
      rows={rows.map((row) => {
        const status = rangeType === 'billing' ? resolveLimitStatus(row) : null;
        const memberKey = row.userId ?? row.id;
        const isOpen = expandedMembers.has(memberKey);
        return [
          <div key="member" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">{initials(row.name)}</span>
            <div>
              {row.userId ? (
                  <Link href={spendDetailHref(`/users/${encodeURIComponent(row.userId)}`, returnTo)} className="block whitespace-nowrap font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">{row.name}</Link>
              ) : (
                  <span className="block whitespace-nowrap font-medium">{row.name}</span>
              )}
              {(row.workspaces?.length ?? 0) > 1
                ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? `${detailsId}-${encodeURIComponent(memberKey)}` : undefined}
                    aria-label={`${row.workspaces!.length} workspaces for ${row.name}`}
                    className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setExpandedMembers(current => {
                      const next = new Set(current);
                      if (next.has(memberKey)) next.delete(memberKey);
                      else next.add(memberKey);
                      return next;
                    })}
                  >
                    <ChevronRight aria-hidden="true" className={`h-3 w-3 shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                    {row.workspaces!.length} workspaces
                  </button>
                )
                : <span className="block whitespace-nowrap text-xs text-muted-foreground">{row.workspaceName || 'Workspace unavailable'}</span>}
            </div>
          </div>,
          <span key="spend" className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.spendUsd)}</span>,
          <span key="projects" className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.otherServicesUsd)}</span>,
          <span key="agent" className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.agentSpendUsd)}</span>,
          <span key="limit" className="flex flex-col items-end gap-1">
            <span className="whitespace-nowrap font-mono text-xs">{(row.workspaces?.length ?? 0) > 1 ? 'Per workspace' : row.limitState === 'no_limit' ? 'No limit' : formatUsd(row.allocationUsd)}</span>
            {status && <StatusBadge status={status} />}
            {row.limitObservationStatus === 'failed' && row.allocationUsd == null && <span className="text-[10px] text-muted-foreground">Observation failed</span>}
            {row.limitObservationStatus === 'unavailable' && <span className="text-[10px] text-muted-foreground">Observation unavailable</span>}
          </span>,
        ];
      })}
    />
  );
}

export function ProjectsTable({ rows }: { rows: SpendTableRow[] }) {
  const [location] = useLocation();
  const search = useSearch();
  const returnTo = location + search;

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
        <div key="project">
            <Link href={spendDetailHref(`/workspaces/${encodeURIComponent(row.workspaceId!)}/projects/${encodeURIComponent(row.projectId ?? row.id)}`, returnTo)} className="block whitespace-nowrap font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">{row.name}</Link>
            <span className="block whitespace-nowrap text-xs text-muted-foreground">{row.ownerName || 'Owner unavailable'} · {row.workspaceName || 'Workspace unavailable'}</span>
        </div>,
        <span key="spend" className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.spendUsd)}</span>,
        <span key="agent" className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.agentSpendUsd)}</span>,
        <span key="cloud" className="whitespace-nowrap font-mono text-xs">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.otherServicesUsd)}</span>,
      ])}
    />
  );
}

export function PaginatedPeopleTable({ params, rangeType, authorizationKey }: { params: any, rangeType: any, authorizationKey: string }) {
  const [page, setPage] = useState(1);
  const [isExpanded, setIsExpanded] = useState(false);
  const peopleParams = { ...params, page: isExpanded ? page : 1, pageSize: 10, sort: 'spend_desc' as const };
  const people = useListSpendPeople(peopleParams, { query: { enabled: true, queryKey: [...getListSpendPeopleQueryKey(peopleParams), authorizationKey] } });

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
    if (isExpanded) setPage(1);
  };

  const hasMore = people.data ? people.data.filteredRows > page * 10 : false;

  return (
    <TablePanel title="Top People" caption="Selected-period spend · Projects excludes Agent · Agent Limit is per billing cycle." isExpanded={isExpanded} onToggleExpand={handleToggleExpand}>
      {(people.isLoading || isReportingUsageRefreshing(people.error ?? people.failureReason)) && !people.data ? (
        <div className="p-4 text-sm text-muted-foreground text-center">Loading...</div>
      ) : people.data && !isBlockingQueryError(people.error ?? people.failureReason) ? (
        <>
          <PeopleTable key={JSON.stringify([params, rangeType, peopleParams.page, authorizationKey])} rows={people.data.rows} rangeType={rangeType} />
          {isExpanded && (
            <div className="flex items-center justify-center gap-3 border-t p-3">
              <Button variant="outline" size="sm" disabled={page === 1 || people.isFetching} onClick={() => setPage(p => p - 1)}>Previous people</Button>
              <span className="text-xs text-muted-foreground">Page {page}</span>
              <Button variant="outline" size="sm" disabled={!hasMore || people.isFetching} onClick={() => setPage(p => p + 1)}>Next people</Button>
            </div>
          )}
        </>
      ) : (
        <div className="p-4 text-sm text-destructive text-center">Failed to load people</div>
      )}
    </TablePanel>
  );
}

export function PaginatedProjectsTable({ params, authorizationKey }: { params: any, authorizationKey: string }) {
  const [page, setPage] = useState(1);
  const [isExpanded, setIsExpanded] = useState(false);
  const projectsParams = { ...params, page: isExpanded ? page : 1, pageSize: 10, sort: 'spend_desc' as const };
  const projects = useListSpendProjects(projectsParams, { query: { enabled: true, queryKey: [...getListSpendProjectsQueryKey(projectsParams), authorizationKey] } });

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
    if (isExpanded) setPage(1);
  };

  const hasMore = projects.data ? projects.data.filteredRows > page * 10 : false;

  return (
    <TablePanel title="Top Apps" caption="Projects ranked by selected-period scoped spend." isExpanded={isExpanded} onToggleExpand={handleToggleExpand}>
      {(projects.isLoading || isReportingUsageRefreshing(projects.error ?? projects.failureReason)) && !projects.data ? (
        <div className="p-4 text-sm text-muted-foreground text-center">Loading...</div>
      ) : projects.data && !isBlockingQueryError(projects.error ?? projects.failureReason) ? (
        <>
          <ProjectsTable rows={projects.data.rows} />
          {isExpanded && (
            <div className="flex items-center justify-center gap-3 border-t p-3">
              <Button variant="outline" size="sm" disabled={page === 1 || projects.isFetching} onClick={() => setPage(p => p - 1)}>Previous projects</Button>
              <span className="text-xs text-muted-foreground">Page {page}</span>
              <Button variant="outline" size="sm" disabled={!hasMore || projects.isFetching} onClick={() => setPage(p => p + 1)}>Next projects</Button>
            </div>
          )}
        </>
      ) : (
        <div className="p-4 text-sm text-destructive text-center">Failed to load projects</div>
      )}
    </TablePanel>
  );
}

import { useQueryClient } from '@tanstack/react-query';

export default function MyTeam() {
  const search = useSearch();
  const { role, capabilities, authorizationKey } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const { authorized, viewScope } = resolveMyTeamScope(role, capabilities.canViewAccountUsage);
  const queryClient = useQueryClient();
  const params = { viewScope, rangeType, startDate, endDate };
  const dashboard = useGetDashboard(params, { query: { enabled: authorized, queryKey: [...getGetDashboardQueryKey(params), authorizationKey] } });

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
  const refreshAll = () => {
    void dashboard.refetch();
    void queryClient.invalidateQueries({ queryKey: getListSpendPeopleQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListSpendProjectsQueryKey() });
  };
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
  const dashboardError = dashboard.error ?? dashboard.failureReason;
  if (isBlockingQueryError(dashboardError)) {
    const status = (dashboardError as any)?.status;
    if (status === 401 || status === 403 || status === 404) {
      return <div className="p-8" data-testid="my-team-forbidden"><h1 className="text-2xl font-semibold">{status} · Access denied or not found</h1><p className="mt-2 text-sm text-muted-foreground">You do not have access to this usage scope.</p></div>;
    }
    return <div className="mx-auto max-w-[1280px] p-4 md:p-8"><EmptyState title="Unable to load activity" description="No values are shown because the scoped dashboard request failed." action={<Button variant="outline" onClick={refreshAll}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>} /></div>;
  }
  if (dashboard.isLoading || (!dashboard.data && isReportingUsageRefreshing(dashboardError))) {
    return <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">{pageHeader}{rangePanel}<div className="grid gap-4 sm:grid-cols-3">{[1,2,3].map(i => <Skeleton key={i} className="h-28 rounded-md" />)}</div><Skeleton className="h-72 rounded-md" /></div>;
  }
  if (!dashboard.data) {
    return <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">{pageHeader}{rangePanel}<EmptyState title="Unable to load activity" description="No values are shown because the scoped dashboard request failed." action={<Button variant="outline" onClick={refreshAll}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>} /></div>;
  }

  const insights = dashboard.data.insights;
  const recordedPeople = insights?.activeUsers ?? null;
  const totalSpend = dashboardTotalSpend(dashboard.data);
  const spendCard = dashboard.data.cards.find(card => card.key === 'eligible_spend' || card.key === 'spend');
  const qualifications = Array.from(new Set([
    ...dashboard.data.metadata.qualifications,
    ...(spendCard?.qualification ? [spendCard.qualification] : []),
  ]));
  const incomplete = dashboard.data.metadata.status !== 'complete' || dashboard.data.metadata.stale;

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
        <PaginatedPeopleTable key={`people:${JSON.stringify(params)}:${authorizationKey}`} params={params} rangeType={rangeType} authorizationKey={authorizationKey} />
        <PaginatedProjectsTable key={`projects:${JSON.stringify(params)}:${authorizationKey}`} params={params} authorizationKey={authorizationKey} />
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