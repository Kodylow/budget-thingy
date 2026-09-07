import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useSearch } from 'wouter/use-browser-location';
import { useQueries } from '@tanstack/react-query';
import {
  getListSpendPoolsQueryKey,
  getGetBudgetTeamReportQueryKey,
  listSpendPools,
  useGetBudgetTeamReport,
  useListSpendPools,
  type ReportingDetail,
  type ReportingDetailMember,
  type ListSpendPoolsParams,
  type SpendTableRow,
} from '@workspace/api-client-react';
import { AlertCircle, BarChart3, FileText, Search, SlidersHorizontal, Users } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { MetricCard } from '@/components/journey-primitives';
import { useRange } from '@/components/range-context';
import { RangeFilter } from '@/components/range-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUsd } from '@/pages/home-components/format';
import { getAvailableSpendViews } from '@/pages/spend';

const PAGE_SIZE = 100;
const REPORT_POOL_SCOPE = 'all_authorized' as const;

export function reportPoolQueryParams(
  range: Pick<ListSpendPoolsParams, 'rangeType' | 'startDate' | 'endDate'>,
  page: number,
): ListSpendPoolsParams {
  return {
    ...range,
    viewScope: REPORT_POOL_SCOPE,
    page,
    pageSize: PAGE_SIZE,
  };
}

export function selectBudgetTeamPools(rows: SpendTableRow[]): SpendTableRow[] {
  return rows
    .filter((row) => row.kind === 'pool' && row.id.startsWith('pool:team:'))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function reportAccessAllowed(input: {
  isAccountAdmin: boolean;
  isWorkspaceAdmin: boolean;
  isTeamAdmin: boolean;
  canEditAllocations: boolean;
}): boolean {
  return getAvailableSpendViews(input).includes('pools');
}

export function budgetMetrics(report: ReportingDetail | undefined) {
  if (!report) return { allocationUsd: null, spendUsd: null, remainingUsd: null, percentUsed: null };
  const observed = reportUsageObserved(report);
  return {
    allocationUsd: report.headline.allocationUsd,
    spendUsd: observed ? report.headline.spendUsd : null,
    remainingUsd: report.headline.isComplete ? report.headline.remainingUsd : null,
    percentUsed: report.headline.isComplete ? report.headline.percentUsed : null,
  };
}

export function reportUsageObserved(report: ReportingDetail): boolean {
  const headline = report.headline as ReportingDetail['headline'] & { usageObserved?: boolean };
  return headline.usageObserved ?? headline.isComplete;
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

function percent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'Unavailable' : `${value.toFixed(1)}%`;
}

type MemberSort = 'name' | 'spend' | 'agent' | 'current';

function MembersTable({ report }: { report: ReportingDetail }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MemberSort>('spend');
  const [ascending, setAscending] = useState(false);
  const normalized = search.trim().toLocaleLowerCase();
  const rows = useMemo(() => {
    const value = (member: ReportingDetailMember): string | number => {
      if (sort === 'name') return member.name || member.username || member.email || member.userId;
      if (sort === 'agent') return member.agentSpendUsd;
      if (sort === 'current') return member.currentCycleAgentSpendUsd ?? -1;
      return member.spendUsd;
    };
    return report.members
      .filter((member) => !normalized || [
        member.name, member.username, member.email, member.userId,
      ].some((item) => item?.toLocaleLowerCase().includes(normalized)))
      .sort((a, b) => {
        const left = value(a);
        const right = value(b);
        const result = typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
        return ascending ? result : -result;
      });
  }, [ascending, normalized, report.members, sort]);
  const changeSort = (next: MemberSort) => {
    if (next === sort) setAscending((value) => !value);
    else {
      setSort(next);
      setAscending(next === 'name');
    }
  };
  const sortButton = (field: MemberSort, label: string) => (
    <button type="button" className="ml-auto font-medium hover:text-foreground" onClick={() => changeSort(field)}>
      {label}{sort === field ? (ascending ? ' ↑' : ' ↓') : ''}
    </button>
  );
  const workspaceNames = new Map(
    report.sourceGroups.map((group) => [group.workspaceId, group.workspaceName || group.workspaceId]),
  );

  return (
    <Card className="overflow-hidden rounded-md shadow-none">
      <CardHeader className="flex flex-col gap-3 border-b bg-muted/20 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            Team members ({report.members.length})
          </CardTitle>
          <CardDescription className="mt-1">
            Selected-period spend and current-cycle limits.
          </CardDescription>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
            placeholder="Search members"
            aria-label="Search team members"
          />
        </div>
      </CardHeader>
      <div className="overflow-x-auto [&>div]:overflow-visible" tabIndex={0} aria-label="Budget team members">
        <Table className="min-w-[1120px]">
          <TableHeader>
            <TableRow>
              <TableHead>{sortButton('name', 'Member')}</TableHead>
              <TableHead>Workspace</TableHead>
              <TableHead className="text-right">Current-cycle limit</TableHead>
              <TableHead className="text-right">{sortButton('current', 'Current-cycle Agent')}</TableHead>
              <TableHead className="text-right">Current-cycle remaining</TableHead>
              <TableHead className="text-right">{sortButton('spend', 'Selected total')}</TableHead>
              <TableHead className="text-right">{sortButton('agent', 'Selected Agent')}</TableHead>
              <TableHead className="text-right">Selected other</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((member) => (
              <TableRow key={`${member.workspaceId}:${member.userId}`}>
                <TableCell>
                  <div className="font-medium">{member.name || member.username || member.userId}</div>
                  <div className="text-xs text-muted-foreground">{member.email || 'Email unavailable'}</div>
                  {member.isDisabled && <Badge variant="secondary" className="mt-1 text-[10px]">Disabled</Badge>}
                </TableCell>
                <TableCell className="text-xs">{workspaceNames.get(member.workspaceId) || member.workspaceId}</TableCell>
                <TableCell className="text-right font-mono">
                  {member.limitState === 'no_limit' ? 'Not set' : formatUsd(member.limitUsd)}
                </TableCell>
                <TableCell className="text-right font-mono">{formatUsd(member.currentCycleAgentSpendUsd)}</TableCell>
                <TableCell className="text-right font-mono">{formatUsd(member.remainingUsd)}</TableCell>
                <TableCell className="text-right font-mono">{formatUsd(report.headline.isComplete || member.spendUsd !== 0 ? member.spendUsd : null)}</TableCell>
                <TableCell className="text-right font-mono">{formatUsd(report.headline.isComplete || member.spendUsd !== 0 ? member.agentSpendUsd : null)}</TableCell>
                <TableCell className="text-right font-mono">{formatUsd(report.headline.isComplete || member.spendUsd !== 0 ? member.otherServicesUsd : null)}</TableCell>
              </TableRow>
            ))}
            {report.headline.unattributedSpendUsd > 0 && (
              <TableRow className="bg-muted/20">
                <TableCell colSpan={5}>
                  <div className="font-medium italic">Unattributed residual</div>
                  <div className="text-xs text-muted-foreground">Canonical team spend not assignable to a current displayed member</div>
                </TableCell>
                <TableCell className="text-right font-mono">{formatUsd(report.headline.unattributedSpendUsd)}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            )}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {report.members.length ? 'No members match this search.' : 'No mapped members.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="border-dashed rounded-md shadow-none">
      <CardContent className="px-6 py-12 text-center">
        <BarChart3 className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
        <h2 className="font-semibold">{title}</h2>
        <div className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">{children}</div>
      </CardContent>
    </Card>
  );
}

export default function Reports() {
  const auth = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const canAccess = reportAccessAllowed({
    isAccountAdmin: auth.isAccountAdmin,
    isWorkspaceAdmin: auth.isWorkspaceAdmin,
    isTeamAdmin: auth.isTeamAdmin,
    canEditAllocations: auth.capabilities.canEditAllocations,
  });
  const selectedPoolId = new URLSearchParams(search).get('poolId');
  const rangeParams = {
    rangeType,
    ...(rangeType === 'custom' ? { startDate, endDate } : {}),
  };
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (!params.has('viewScope')) return;
    params.delete('viewScope');
    const path = location.split('?')[0];
    setLocation(`${path}${params.size ? `?${params.toString()}` : ''}`, { replace: true });
  }, [location, search, setLocation]);
  const firstPageParams = reportPoolQueryParams(rangeParams, 1);
  const firstPage = useListSpendPools(
    firstPageParams,
    { query: { enabled: canAccess, queryKey: getListSpendPoolsQueryKey(firstPageParams) } },
  );
  const pageCount = Math.ceil((firstPage.data?.totalRows ?? 0) / PAGE_SIZE);
  const additionalPages = useQueries({
    queries: Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => {
      const params = reportPoolQueryParams(rangeParams, index + 2);
      return {
        queryKey: getListSpendPoolsQueryKey(params),
        queryFn: () => listSpendPools(params),
        enabled: canAccess,
      };
    }),
  });
  const allPagesReady = additionalPages.every((query) => query.data);
  const pageGenerations = [
    firstPage.data?.metadata.generationId,
    ...additionalPages.map((query) => query.data?.metadata.generationId),
  ].filter(Boolean);
  const generationMismatch = new Set(pageGenerations).size > 1;
  const poolRows = !generationMismatch && firstPage.data && allPagesReady
    ? [firstPage.data, ...additionalPages.map((query) => query.data!)]
        .flatMap((page) => page.rows)
    : [];
  const pools = selectBudgetTeamPools(poolRows);
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId);
  const poolLoadError = firstPage.isError || additionalPages.some((query) => query.isError);
  const poolLoading = canAccess && (firstPage.isLoading || !allPagesReady);
  const selectedUnknown = Boolean(selectedPoolId && !poolLoading && !poolLoadError && !generationMismatch && !selectedPool);

  const selectedReport = useGetBudgetTeamReport(selectedPool?.id ?? '', rangeParams, {
    query: {
      enabled: Boolean(selectedPool),
      queryKey: getGetBudgetTeamReportQueryKey(selectedPool?.id ?? '', rangeParams),
    },
  });
  const budgetReport = useGetBudgetTeamReport(selectedPool?.id ?? '', { rangeType: 'full-term' }, {
    query: {
      enabled: Boolean(selectedPool) && rangeType !== 'full-term',
      queryKey: getGetBudgetTeamReportQueryKey(selectedPool?.id ?? '', { rangeType: 'full-term' }),
    },
  });
  const report = selectedReport.data;
  const fullReport = rangeType === 'full-term' ? report : budgetReport.data;
  const budget = budgetMetrics(fullReport);
  const selectedObserved = report ? reportUsageObserved(report) : false;
  const updatePool = (poolId: string) => {
    const params = new URLSearchParams(search);
    params.set('poolId', poolId);
    setLocation(`${location.split('?')[0]}?${params.toString()}`);
  };
  const sourceWorkspaces = report
    ? new Set(report.sourceGroups.map((group) => group.workspaceId)).size
    : 0;
  const recordedPeople = new Set(report?.members.filter((member) => member.spendUsd > 0).map((member) => member.userId) ?? []).size;
  const reportDenied = [403, 404].includes(errorStatus(selectedReport.error) ?? 0);

  if (!canAccess) {
    return (
      <div className="mx-auto max-w-[1280px] p-4 md:p-8">
        <Message title="Custom Reports is unavailable">
          You do not have an authorized budget-team view. Reports do not query account or team data without that existing access.
        </Message>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8" data-testid="page-custom-reports">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Custom Reports</h1>
        <p className="text-sm text-muted-foreground">Budget-team reporting.</p>
        <AdminDataQualityNote title="Custom Reports data quality">
          <p>Read-only budget-team reporting from authorized Airtable mappings.</p>
        </AdminDataQualityNote>
      </div>

      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/[0.045] px-4 py-3.5">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-1 text-sm">
            <p className="font-semibold">Custom Reports data quality</p>
            <p className="text-muted-foreground">Read-only budget-team reporting from authorized Airtable mappings.</p>
          </div>
          <Badge variant="outline" className="ml-auto hidden shrink-0 sm:inline-flex">Verified source</Badge>
        </div>

        <Card className="rounded-md shadow-none">
          <CardHeader className="border-b pb-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <SlidersHorizontal className="h-4 w-4 text-primary" />
                  Build a custom report
                </CardTitle>
                <CardDescription className="mt-1">Choose the authorized scope and accounting window for this view.</CardDescription>
              </div>
              <span className="hidden text-xs font-medium text-muted-foreground sm:block">Report controls</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div className="grid gap-4 md:grid-cols-[minmax(240px,1fr)_auto] md:items-end">
              <div>
                <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  Budget team
                </label>
                <Select value={selectedPool?.id ?? ''} onValueChange={updatePool} disabled={poolLoading || poolLoadError || generationMismatch}>
                  <SelectTrigger aria-label="Budget team" data-testid="select-budget-team">
                    <SelectValue placeholder={poolLoading ? 'Loading budget teams…' : 'Choose a budget team'} />
                  </SelectTrigger>
                  <SelectContent>
                    {pools.map((pool) => (
                      <SelectItem key={pool.id} value={pool.id}>{pool.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  Timeframe
                </label>
                <RangeFilter selectedLabel={report?.period.label} />
              </div>
            </div>
            {report && (
              <div className="rounded-md bg-muted/45 px-3 py-2.5 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Scope resolved</span><br />
                {report.sourceGroups.length} physical group{report.sourceGroups.length === 1 ? '' : 's'} across {sourceWorkspaces} workspace{sourceWorkspaces === 1 ? '' : 's'}
              </div>
            )}
          </CardContent>
        </Card>

        {report && (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">{selectedPool?.name}</h2>
              <p className="mt-1 text-xs text-muted-foreground">Selected period · {report.period.label}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {report.sourceGroups.map((group) => (
                <Badge key={`${group.workspaceId}:${group.groupId}`} variant="outline" className="font-normal">
                  {group.workspaceName || group.workspaceId} · {group.role}
                </Badge>
              ))}
            </div>
          </div>
        )}

      {poolLoadError && (
        <Message title="Budget teams couldn’t be loaded">
          <p>Try again when the reporting service is available.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              void firstPage.refetch();
              additionalPages.forEach((query) => void query.refetch());
            }}
          >
            Retry
          </Button>
        </Message>
      )}
      {generationMismatch && (
        <Message title="Budget teams are updating">
          <p>The team list changed while loading. Reload the authorized pages before selecting a report.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              void firstPage.refetch();
              additionalPages.forEach((query) => void query.refetch());
            }}
          >
            Reload team list
          </Button>
        </Message>
      )}
      {!poolLoading && !poolLoadError && !generationMismatch && pools.length === 0 && (
        <Message title="No authorized budget teams">
          No Airtable-defined budget team is mapped into your current spend scope. Unbudgeted and generic group rows are not treated as budget teams.
        </Message>
      )}
      {selectedUnknown && (
        <Message title="Budget team unavailable">
          The selected budget-team ID is not in your authorized pool list. Choose an available team instead.
        </Message>
      )}
      {!selectedPoolId && pools.length > 0 && (
        <Message title="Build a custom report">Choose an authorized budget team and reporting timeframe.</Message>
      )}
      {selectedPool && selectedReport.isLoading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-28 animate-pulse-glow rounded-md bg-muted" />)}
        </div>
      )}
      {selectedPool && selectedReport.isError && !report && (
        <Message title={reportDenied ? 'Budget team unavailable' : 'Report couldn’t be loaded'}>
          <p>{reportDenied
            ? 'This team is no longer in your authorized reporting scope.'
            : 'The reporting service is temporarily unavailable.'}</p>
          {!reportDenied && (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void selectedReport.refetch()}>
              Retry
            </Button>
          )}
        </Message>
      )}

      {report && (
        <>
          {selectedReport.isError && (
            <div className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <span>Showing the last available selected-period report. Refresh failed.</span>
              <Button variant="outline" size="sm" onClick={() => void selectedReport.refetch()}>Retry</Button>
            </div>
          )}
          {rangeType !== 'full-term' && budgetReport.isError && (
            <div className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <span>Full-period budget facts are unavailable. Selected-period reporting remains visible.</span>
              <Button variant="outline" size="sm" onClick={() => void budgetReport.refetch()}>Retry</Button>
            </div>
          )}
          {report.sourceGroups.length === 0 && (
            <div className="flex items-start gap-2 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="status">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              This budget team currently has no mapped workspaces or groups. Its allocation remains visible, while spend and people are empty.
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Annual allocation" value={formatUsd(budget.allocationUsd)}
              detail={`Full period · ${fullReport?.period.label ?? 'loading budget period'}`} />
            <MetricCard label="Budget-period spend" value={formatUsd(budget.spendUsd)}
              detail={fullReport
                ? `${!fullReport.headline.isComplete && reportUsageObserved(fullReport) ? 'Known subtotal · Partial · ' : ''}${fullReport.period.label}`
                : 'Loading full-period spend'} />
            <MetricCard label="Budget remaining / used"
              value={budget.remainingUsd == null ? 'Unavailable' : formatUsd(budget.remainingUsd)}
              detail={`${percent(budget.percentUsed)} used · full-period accounting`} />
            <MetricCard label="Selected spend"
              value={formatUsd(selectedObserved ? report.headline.spendUsd : null)}
              detail={`${!report.headline.isComplete && selectedObserved ? 'Known subtotal · Partial · ' : ''}${report.period.label}`} />
            <MetricCard label="Selected Agent"
              value={formatUsd(selectedObserved ? report.headline.agentSpendUsd : null)}
              detail={`${!report.headline.isComplete && selectedObserved ? 'Known subtotal · Partial · ' : ''}${report.period.label}`} />
            <MetricCard label="Selected other services"
              value={formatUsd(selectedObserved ? report.headline.otherServicesUsd : null)}
              detail={`${!report.headline.isComplete && selectedObserved ? 'Known subtotal · Partial · ' : ''}${report.period.label}`} />
            <MetricCard label="Unique members" value={String(report.headline.memberCount)}
              detail="Current visible mapped members" />
            <MetricCard label="People with recorded spend" value={String(recordedPeople)}
              detail="Current mapped members with selected-period spend" />
            <MetricCard label="Mapped groups" value={String(report.sourceGroups.length)}
              detail={`${sourceWorkspaces} mapped workspace${sourceWorkspaces === 1 ? '' : 's'}`} />
          </div>

          <AdminDataQualityNote title="Custom Reports qualifications">
            <p>Canonical Agent usage is shown for the selected period. Other services includes hosting, storage, and other selected-period costs.</p>
            {!report.headline.isComplete && selectedObserved && <p>Selected-period values are a known subtotal with partial coverage.</p>}
            {fullReport && !fullReport.headline.isComplete && reportUsageObserved(fullReport) && <p>Full-budget-period values are a known subtotal with partial coverage.</p>}
            {(report.metadata.qualifications.length > 0 || (fullReport?.metadata.qualifications.length ?? 0) > 0) && (
              <div className="space-y-2">
              {report.metadata.qualifications.map((qualification) => (
                <p key={`selected:${qualification}`}><strong>Selected period:</strong> {qualification}</p>
              ))}
              {fullReport !== report && fullReport?.metadata.qualifications.map((qualification) => (
                <p key={`budget:${qualification}`}><strong>Full budget period:</strong> {qualification}</p>
              ))}
              </div>
            )}
          </AdminDataQualityNote>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <MembersTable report={report} />
            <Card className="h-fit rounded-md shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Report qualifications</CardTitle>
                <CardDescription>How to read this report</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="border-l-2 border-primary pl-3">
                  <p className="font-medium">Canonical Agent usage</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Shown for the selected period. Other services includes hosting, storage, and other costs.</p>
                </div>
                {!report.headline.isComplete && selectedObserved && (
                  <div className="border-l-2 border-amber-500 pl-3">
                    <p className="font-medium">Partial coverage</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">Selected-period values are a known subtotal.</p>
                  </div>
                )}
                {report.metadata.qualifications.map((qualification) => (
                  <div key={`visible:selected:${qualification}`} className="border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
                    {qualification}
                  </div>
                ))}
                {fullReport !== report && fullReport?.metadata.qualifications.map((qualification) => (
                  <div key={`visible:budget:${qualification}`} className="border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
                    <span className="font-medium text-foreground">Full period:</span> {qualification}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
      </div>
    </div>
  );
}