import { useMemo } from 'react';
import { Link } from 'wouter';
import { useSearch } from 'wouter/use-browser-location';
import {
  getGetDashboardQueryKey,
  getListSpendPeopleQueryKey,
  getListSpendProjectsQueryKey,
  useGetDashboard,
  useListSpendPeople,
  useListSpendProjects,
  type SpendTableRow,
} from '@workspace/api-client-react';
import { Activity, DollarSign, RefreshCw, Users } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { TrendAreaChart } from '@/components/Charts';
import { RangeFilter } from '@/components/range-filter';
import { useRange } from '@/components/range-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { reportingNavigationHref } from '@/lib/reporting-navigation';
import { dashboardTotalSpend } from '@/lib/spend-presentation';
import { formatUsd } from '@/pages/home-components/format';

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

function SummaryCard({ icon: Icon, label, value, detail }: {
  icon: typeof Users;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="font-mono text-2xl font-semibold">{value}</div>
      <p className="mt-1.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function TablePanel({ title, caption, viewAllHref, children }: {
  title: string;
  caption: string;
  viewAllHref: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
        </div>
        <Link href={viewAllHref} className="shrink-0 text-xs font-medium text-primary hover:underline">View all</Link>
      </div>
      <div aria-label={`${title} table`} className="max-w-full overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>div]:overflow-visible" tabIndex={0}>
        {children}
      </div>
    </section>
  );
}

function PeopleTable({ rows }: { rows: SpendTableRow[] }) {
  if (rows.length === 0) return <p className="p-6 text-sm text-muted-foreground">No people with recorded spend were found in this scope and period.</p>;
  return (
    <Table className="min-w-[480px]">
      <TableHeader><TableRow>
        <TableHead>Member</TableHead>
        <TableHead className="text-right">Selected spend</TableHead>
        <TableHead className="text-right">Billing-cycle Agent</TableHead>
        <TableHead className="text-right">Billing-cycle limit</TableHead>
      </TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={row.id}>
        <TableCell><span className="font-medium">{row.name}</span><span className="block text-xs text-muted-foreground">{row.workspaceName || 'Workspace unavailable'}</span></TableCell>
        <TableCell className="text-right font-mono">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.spendUsd)}</TableCell>
        <TableCell className="text-right font-mono">{formatUsd(row.currentCycleAgentSpendUsd)}</TableCell>
        <TableCell className="text-right font-mono">
          {row.limitState === 'no_limit' ? 'No limit' : formatUsd(row.allocationUsd)}
          {row.limitObservationStatus === 'refreshing' && <span className="block font-sans text-[10px] text-muted-foreground">Refreshing</span>}
          {row.limitObservationStatus === 'failed' && <span className="block font-sans text-[10px] text-muted-foreground">{row.allocationUsd != null ? 'Last known · refresh failed' : 'Observation failed'}</span>}
          {row.limitObservationStatus === 'unavailable' && <span className="block font-sans text-[10px] text-muted-foreground">Observation unavailable</span>}
        </TableCell>
      </TableRow>)}</TableBody>
    </Table>
  );
}

function ProjectsTable({ rows }: { rows: SpendTableRow[] }) {
  if (rows.length === 0) return <p className="p-6 text-sm text-muted-foreground">No projects with recorded spend were found in this scope and period.</p>;
  return (
    <Table className="min-w-[480px]">
      <TableHeader><TableRow>
        <TableHead>App / project</TableHead>
        <TableHead className="text-right">Selected spend</TableHead>
        <TableHead className="text-right">Agent</TableHead><TableHead className="text-right">Other services</TableHead>
      </TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={row.id}>
        <TableCell><span className="font-medium">{row.name}</span><span className="block text-xs text-muted-foreground">{row.ownerName || 'Owner unavailable'} · {row.workspaceName || 'Workspace unavailable'}</span></TableCell>
        <TableCell className="text-right font-mono">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.spendUsd)}</TableCell>
        <TableCell className="text-right font-mono">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.agentSpendUsd)}</TableCell>
        <TableCell className="text-right font-mono">{row.usageObserved === false ? 'Unavailable' : formatUsd(row.otherServicesUsd)}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
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
    ? 'Your activity.'
    : isOrganization
      ? 'Organization activity.'
      : 'Activity across your teams and workspaces.';
  const pageHeader = (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">{isOrganization ? 'My Organization' : 'My Team'}</h1><p className="mt-1 text-sm text-muted-foreground">{scopeCopy}{dashboard.data?.period?.label ? ` Selected period: ${dashboard.data.period.label}` : ''}</p></div>
      <RangeFilter />
    </header>
  );

  if (!authorized) {
    return <div className="p-8" data-testid="my-team-forbidden"><h1 className="text-2xl font-semibold">403 · Access denied</h1><p className="mt-2 text-sm text-muted-foreground">Your role does not include personal or managed usage access.</p></div>;
  }
  if (dashboard.isLoading || people.isLoading || projects.isLoading) {
    return <div className="mx-auto max-w-[1280px] space-y-5 p-4 md:p-8">{pageHeader}<div className="grid gap-4 sm:grid-cols-3">{[1,2,3].map(i => <Skeleton key={i} className="h-28 rounded-lg" />)}</div><Skeleton className="h-72 rounded-lg" /></div>;
  }
  if (!dashboard.data || !people.data || !projects.data) {
    return <div className="mx-auto max-w-[1280px] space-y-5 p-4 md:p-8">{pageHeader}<div className="flex min-h-[35vh] flex-col items-center justify-center text-center"><p className="font-medium">Unable to load activity.</p><p className="mt-1 text-sm text-muted-foreground">No values are shown because one or more scoped requests failed.</p><Button variant="outline" className="mt-4" onClick={() => void Promise.all([dashboard.refetch(), people.refetch(), projects.refetch()])}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></div></div>;
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
  const requestFailed = dashboard.isError || people.isError || projects.isError;
  const incomplete = [dashboard.data.metadata, people.data.metadata, projects.data.metadata]
    .some(metadata => metadata.status !== 'complete' || metadata.stale);

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-6 px-4 py-6 md:px-8">
      {pageHeader}
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard icon={Users} label="People with recorded spend" value={recordedPeople == null ? 'Unavailable' : recordedPeople.toLocaleString()} detail={`People with positive recorded spend in ${dashboard.data.period.label}`} />
        <SummaryCard icon={DollarSign} label={role === 'member' ? 'My spend' : isOrganization ? 'Organization spend' : 'Team spend'} value={formatUsd(totalSpend)} detail={dashboard.data.period.label} />
        <SummaryCard icon={Activity} label="Average per active user" value={totalSpend == null ? 'Unavailable' : formatUsd(insights?.avgSpendPerActiveUserUsd)} detail="Average among people with positive recorded spend in the selected period" />
      </div>
      {requestFailed && <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"><span>Refresh failed; last available values are shown.</span><button type="button" className="font-medium text-primary hover:underline" onClick={() => void Promise.all([dashboard.refetch(), people.refetch(), projects.refetch()])}>Retry</button></div>}
      <AdminDataQualityNote title={isOrganization ? 'Organization activity' : 'Team activity'}>
        {incomplete && <p>{dashboard.data.metadata.status === 'partial' ? 'Partial coverage.' : 'Data may be stale or incomplete.'}</p>}
        {qualifications.map(qualification => <p key={qualification}>{qualification}</p>)}
        <p>Activity follows your current permissions. Managed scope may include your own usage.</p>
        <p>People rows are workspace memberships; cycle columns use the current billing cycle, independent of the selected period.</p>
        <p>The latest six months are independent of the selected period. Missing months remain gaps.{hasPartialMonth && ' Partial months show known spend and users only.'}</p>
      </AdminDataQualityNote>
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <TablePanel title="Top People" caption="Selected-period spend and current-cycle limits." viewAllHref={peopleHref}><PeopleTable rows={people.data.rows} /></TablePanel>
        <TablePanel title="Top Apps" caption="Projects ranked by selected-period scoped spend." viewAllHref={projectsHref}><ProjectsTable rows={projects.data.rows} /></TablePanel>
      </div>
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-5 shadow-sm"><h2 className="text-sm font-semibold uppercase tracking-wider">Latest 6 months · Spend</h2><div className="mt-3 h-64"><TrendAreaChart data={monthly} dataKey="spendUsd" valueLabel="Scoped spend" /></div></section>
        <section className="rounded-lg border border-border bg-card p-5 shadow-sm"><h2 className="text-sm font-semibold uppercase tracking-wider">Latest 6 months · Active users</h2><div className="mt-3 h-64"><TrendAreaChart data={monthly} dataKey="activeUsers" valueKind="count" valueLabel="Active users" /></div></section>
      </div>
    </div>
  );
}