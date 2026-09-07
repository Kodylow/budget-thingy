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
import { Activity, AlertCircle, BarChart3, Building2, DollarSign, Search, Users } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { useRange } from '@/components/range-context';
import { RangeFilter } from '@/components/range-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

function Tile({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: typeof Users;
}) {
  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 shadow-sm rounded-xl p-5">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-primary" />
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      </div>
      <div className="text-2xl font-mono font-semibold tabular-nums">{value}</div>
      <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
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
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 shadow-sm rounded-xl overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border/50 bg-muted/20 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">Team members ({report.members.length})</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Selected-period spend and current-cycle limits.
          </p>
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
      </div>
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
    </div>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card/50 border border-border/50 rounded-xl p-8 text-center">
      <BarChart3 className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
      <h2 className="font-semibold">{title}</h2>
      <div className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">{children}</div>
    </div>
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
      <div className="p-4 md:p-8">
        <Message title="Custom Reports is unavailable">
          You do not have an authorized budget-team view. Reports do not query account or team data without that existing access.
        </Message>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 p-4 md:p-8" data-testid="page-custom-reports">
      <div>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Custom Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Budget-team reporting.
        </p>
        <AdminDataQualityNote title="Custom Reports data quality">
          <p>Read-only budget-team reporting from authorized Airtable mappings.</p>
        </AdminDataQualityNote>
      </div>

      <div className="space-y-4 bg-card/50 backdrop-blur-sm border border-border/50 shadow-sm rounded-xl p-5">
        <div className="grid gap-4 md:grid-cols-[minmax(240px,1fr)_auto] md:items-end">
          <div>
            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Timeframe
            </label>
            <RangeFilter selectedLabel={report?.period.label} />
          </div>
        </div>
        {report && (
          <div className="border-t border-border/60 pt-3">
            <div className="mb-2 text-xs text-muted-foreground">
              Airtable team mapping · {report.sourceGroups.length} physical group{report.sourceGroups.length === 1 ? '' : 's'} across {sourceWorkspaces} workspace{sourceWorkspaces === 1 ? '' : 's'}
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
      </div>

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }, (_, index) => <div key={index} className="h-28 animate-pulse-glow rounded-xl bg-muted" />)}
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Tile icon={DollarSign} label="Annual allocation" value={formatUsd(budget.allocationUsd)}
              sub={`Full period · ${fullReport?.period.label ?? 'loading budget period'}`} />
            <Tile icon={DollarSign} label="Budget-period spend" value={formatUsd(budget.spendUsd)}
              sub={fullReport
                ? `${!fullReport.headline.isComplete && reportUsageObserved(fullReport) ? 'Known subtotal · Partial · ' : ''}${fullReport.period.label}`
                : 'Loading full-period spend'} />
            <Tile icon={Activity} label="Budget remaining / used"
              value={budget.remainingUsd == null ? 'Unavailable' : formatUsd(budget.remainingUsd)}
              sub={`${percent(budget.percentUsed)} used · full-period accounting`} />
            <Tile icon={DollarSign} label="Selected spend"
              value={formatUsd(selectedObserved ? report.headline.spendUsd : null)}
              sub={`${!report.headline.isComplete && selectedObserved ? 'Known subtotal · Partial · ' : ''}${report.period.label}`} />
            <Tile icon={Activity} label="Selected Agent"
              value={formatUsd(selectedObserved ? report.headline.agentSpendUsd : null)}
              sub={`${!report.headline.isComplete && selectedObserved ? 'Known subtotal · Partial · ' : ''}${report.period.label}`} />
            <Tile icon={Activity} label="Selected other services"
              value={formatUsd(selectedObserved ? report.headline.otherServicesUsd : null)}
              sub={`${!report.headline.isComplete && selectedObserved ? 'Known subtotal · Partial · ' : ''}${report.period.label}`} />
            <Tile icon={Users} label="Unique members" value={String(report.headline.memberCount)}
              sub="Current visible mapped members" />
            <Tile icon={Users} label="People with recorded spend" value={String(recordedPeople)}
              sub="Current mapped members with selected-period spend" />
            <Tile icon={Building2} label="Mapped groups" value={String(report.sourceGroups.length)}
              sub={`${sourceWorkspaces} mapped workspace${sourceWorkspaces === 1 ? '' : 's'}`} />
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
          <MembersTable report={report} />
        </>
      )}
    </div>
  );
}