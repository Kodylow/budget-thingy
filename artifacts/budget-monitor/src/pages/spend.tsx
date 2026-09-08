import React from "react";
import { useMemo, useState, useEffect } from 'react';
import { useLocation, Link } from 'wouter';
import { useSearch } from 'wouter/use-browser-location';
import {
  useListSpendPools,
  useListSpendGroups,
  useListSpendPeople,
  useListSpendProjects,
  SpendTableRow,
  SpendProjectRow,
  getExportSpendPoolsCsvUrl,
  getExportSpendGroupsCsvUrl,
  getExportSpendPeopleCsvUrl,
  getExportSpendProjectsTableCsvUrl,
  getListSpendPoolsQueryKey,
  getListSpendGroupsQueryKey,
  getListSpendPeopleQueryKey,
  getListSpendProjectsQueryKey,
  SpendSortParameter,
  ProjectSortParameter,
  SpendStatusParameter
} from '@workspace/api-client-react';
import { useAuthContext } from '@/components/auth-context';
import { useRange } from '@/components/range-context';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RangeFilter } from '@/components/range-filter';
import { Search, Download, ChevronRight, ArrowUpDown, ChevronUp, ChevronDown, ChevronLeft, RefreshCw, Filter, Settings2, X, Check } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SortableHead } from '@/components/SortableHead';
import { VirtualizedTableRows } from '@/components/virtualized-table-rows';
import {
  resolveSpendViewScope,
  spendScopeOptions,
  type SpendViewScope,
} from '@/lib/spend-scope';
import { downloadAuthenticatedBlob } from '@/lib/download';
import { BudgetMeter, MetricCard } from '@/components/journey-primitives';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { spendColumns, spendDetailHref, updateSpendParams } from '@/lib/spend-exploration';
import {
  formatObservedCurrency,
  isUnknownSelectedRangeValue,
  isUnknownSpendTotal,
} from '@/lib/spend-presentation';
import { DeploymentChip, DeploymentLink, StaleSpendingChip } from '@/components/project-observation';
import { BudgetTeamDetail } from '@/pages/budget-team-detail';

export function getAvailableSpendViews({
  isAccountAdmin,
  isWorkspaceAdmin,
  isTeamAdmin,
  canEditAllocations,
}: {
  isAccountAdmin: boolean;
  isWorkspaceAdmin: boolean;
  isTeamAdmin: boolean;
  canEditAllocations: boolean;
}) {
  const views: Array<'pools' | 'groups' | 'people' | 'projects'> = [];
  if (isAccountAdmin || isWorkspaceAdmin || isTeamAdmin || canEditAllocations) views.push('pools');
  if (isAccountAdmin || isWorkspaceAdmin || isTeamAdmin) views.push('groups');
  views.push('people', 'projects');
  return views;
}

export default function Spend() {
  const { role, isAccountAdmin, isWorkspaceAdmin, isTeamAdmin, capabilities, auth } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const [location, setLocation] = useLocation();
  const { toast } = useToast();

  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);

  useEffect(() => {
    if (searchParams.has('view')) {
      const newParams = new URLSearchParams(searchString);
      const viewVal = newParams.get('view');
      newParams.delete('view');
      if (viewVal && !newParams.has('tab')) {
        newParams.set('tab', viewVal);
      }
      setLocation(`${location}?${newParams.toString()}`, { replace: true });
    }
  }, [searchString, location, setLocation]);

  const activeTabFromUrl = searchParams.get('tab') || searchParams.get('view');
  const searchFromUrl = searchParams.get('search') || '';
  const densityFromUrl = searchParams.get('density') || 'comfortable';
  const viewScope = resolveSpendViewScope(
    searchParams.get('viewScope') || auth?.viewScope,
    role === 'member' ? 'my' : 'managed',
  );
  const scopeOptions = spendScopeOptions(capabilities.canViewAccountUsage === true);

  const availableTabs = useMemo(() => {
    return getAvailableSpendViews({
      isAccountAdmin,
      isWorkspaceAdmin,
      isTeamAdmin,
      canEditAllocations: capabilities.canEditAllocations,
    });
  }, [isAccountAdmin, isWorkspaceAdmin, isTeamAdmin, capabilities.canEditAllocations]);

  const defaultTab = availableTabs[0] || 'projects';
  const requestedTab = activeTabFromUrl as (typeof availableTabs)[number];

  const tabFromUrl = searchParams.get('tab');
  const viewScopeFromUrl = searchParams.get('viewScope');
  const poolIdFromUrl = searchParams.get('poolId');
  const isMyProjects = tabFromUrl === 'projects' && viewScopeFromUrl === 'my';
  const isMyTeam = tabFromUrl === 'people' && viewScopeFromUrl === 'managed';
  let pageTitle = role === 'member' ? 'My spend' : 'Spend';
  if (isMyProjects) pageTitle = 'My Projects';
  else if (isMyTeam) pageTitle = 'My Team';
  else if (tabFromUrl === 'pools' || (poolIdFromUrl && defaultTab === 'pools')) pageTitle = 'Budgeted teams';

  const activeTab = availableTabs.includes(requestedTab) ? requestedTab : defaultTab;

  const [searchDraft, setSearchDraft] = useState({ source: searchString, value: searchFromUrl });
  const search = searchDraft.source === searchString ? searchDraft.value : searchFromUrl;
  const setSearch = (value: string) => setSearchDraft({ source: searchString, value });
  const [isExporting, setIsExporting] = useState(false);
  const debouncedSearch = searchFromUrl;

  const updateUrlParams = (updates: Record<string, string | null | undefined>) => {
    const next = updateSpendParams(window.location.search, updates);
    if (next !== new URLSearchParams(window.location.search).toString()) {
      setLocation(`${location}${next ? `?${next}` : ''}`);
    }
  };

  useEffect(() => {
    if (search === searchFromUrl) return;
    const timer = setTimeout(() => updateUrlParams({ search: search || null }), 300);
    return () => clearTimeout(timer);
  }, [search, searchFromUrl, searchString]);

  const handleExport = async () => {
    if (isExporting || search !== searchFromUrl) return;
    setIsExporting(true);
    try {
      const params: any = { rangeType, sort: searchParams.get('sort') || 'spend_desc' };
      if (rangeType === "custom") {
        params.startDate = startDate;
        params.endDate = endDate;
      }
      if (debouncedSearch) params.search = debouncedSearch;
      params.viewScope = viewScope;
      const sort = searchParams.get('sort');
      const status = searchParams.get('status');
      const workspaceId = searchParams.get('workspaceId');
      if (sort) params.sort = sort;
      if (status && status !== 'all') params.status = status;
      if (workspaceId) params.workspaceId = workspaceId;

      let url = '';
      if (activeTab === 'pools') url = getExportSpendPoolsCsvUrl(params);
      else if (activeTab === 'groups') url = getExportSpendGroupsCsvUrl(params);
      else if (activeTab === 'people') url = getExportSpendPeopleCsvUrl(params);
      else if (activeTab === 'projects') url = getExportSpendProjectsTableCsvUrl(params);

      if (url) {
        await downloadAuthenticatedBlob(url, {
          filename: `spend-${activeTab}-${new Date().toISOString().slice(0, 10)}.csv`,
        });
      } else {
        throw new Error('Could not generate export URL');
      }
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : 'Could not download the export.',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">{pageTitle}</h1>
            <p className="text-sm text-muted-foreground">
              {activeTab === 'projects'
                ? `${scopeOptions.find((option) => option.value === viewScope)?.label || 'Current scope'} · Current projects · selected-period spend`
                : `${scopeOptions.find((option) => option.value === viewScope)?.label || 'Current scope'} · reporting-period ledger`}
            </p>
          </div>
          <div className="w-full shrink-0 sm:w-auto">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Reporting period</p>
            <RangeFilter />
          </div>
      </header>

      <section aria-label="Spend ledger">
          {activeTab === 'pools' && searchParams.get('poolId') ? (
            <BudgetTeamDetail
              poolId={searchParams.get('poolId')!}
              rangeParams={{ rangeType, startDate, endDate }}
              viewScope={viewScope}
              onBack={() => updateUrlParams({ poolId: null })}
            />
          ) : (
            <>
              {activeTab === 'pools' && <SpendTable type="pools" search={debouncedSearch} searchValue={search} setSearch={setSearch} density={densityFromUrl} viewScope={viewScope} scopeOptions={scopeOptions} availableTabs={availableTabs} onExport={handleExport} isExporting={isExporting} updateUrlParams={updateUrlParams} />}
              {activeTab === 'groups' && <SpendTable type="groups" search={debouncedSearch} searchValue={search} setSearch={setSearch} density={densityFromUrl} viewScope={viewScope} scopeOptions={scopeOptions} availableTabs={availableTabs} onExport={handleExport} isExporting={isExporting} updateUrlParams={updateUrlParams} />}
              {activeTab === 'people' && <SpendTable type="people" search={debouncedSearch} searchValue={search} setSearch={setSearch} density={densityFromUrl} viewScope={viewScope} scopeOptions={scopeOptions} availableTabs={availableTabs} onExport={handleExport} isExporting={isExporting} updateUrlParams={updateUrlParams} />}
              {activeTab === 'projects' && <SpendTable type="projects" search={debouncedSearch} searchValue={search} setSearch={setSearch} density={densityFromUrl} viewScope={viewScope} scopeOptions={scopeOptions} availableTabs={availableTabs} onExport={handleExport} isExporting={isExporting} updateUrlParams={updateUrlParams} />}
            </>
          )}
      </section>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="p-4 space-y-4">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

const columnSets: Record<'pools' | 'groups' | 'people' | 'projects', { defaults: string[]; all: string[] }> = {
  pools: {
    defaults: ['name', 'spendUsd', 'allocationUsd', 'remainingUsd', 'percentUsed', 'status'],
    all: ['name', 'spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'allocationUsd', 'remainingUsd', 'percentUsed', 'status'],
  },
  groups: {
    defaults: ['name', 'memberCount', 'spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'allocationUsd'],
    all: ['name', 'memberCount', 'spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'allocationUsd'],
  },
  people: {
    defaults: ['name', 'workspaceName', 'spendUsd', 'agentSpendUsd'],
    all: ['name', 'workspaceName', 'spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'currentCycleAgentSpendUsd', 'allocationUsd', 'currentCycleRemainingUsd', 'currentCyclePercentUsed', 'limitState', 'limitObservationStatus'],
  },
  projects: {
    defaults: ['name', 'hasDeployment', 'deployments', 'ownerName', 'workspaceName', 'spendUsd', 'agentSpendUsd', 'updatedAt'],
    all: ['name', 'isPublished', 'hasDeployment', 'deployments', 'ownerName', 'workspaceName', 'spendUsd', 'currentMonthSpendUsd', 'agentSpendUsd', 'otherServicesUsd', 'updatedAt'],
  },
};

  const viewLabels: Record<string, string> = {
    groups: 'Groups',
    people: 'Members',
    projects: 'Projects',
    pools: 'Budgeted teams',
  };

  function columnLabel(column: string, tableType: 'pools' | 'groups' | 'people' | 'projects') {
    const labels: Record<string, string> = {
      name: tableType === 'groups' ? 'Group' : tableType === 'people' ? 'Member' : tableType === 'projects' ? 'Project' : 'Budgeted team',
    spendUsd: 'Total spend',
    allocationUsd: tableType === 'people' ? 'Monthly Agent limit' : 'Allocation',
    remainingUsd: 'Remaining allocation',
    percentUsed: 'Used %',
    status: 'Status',
    memberCount: 'Members',
    agentSpendUsd: 'Agent',
    currentCycleAgentSpendUsd: 'Current-cycle Agent usage',
    currentCycleRemainingUsd: 'Current-cycle remaining',
    currentCyclePercentUsed: 'Current-cycle utilization',
    otherServicesUsd: 'Other services',
    workspaceName: 'Workspace',
    ownerName: 'Owner',
    isPublished: 'Published',
    hasDeployment: 'Deployed',
    deployments: 'Deployments',
    limitState: 'Limit state',
    limitObservationStatus: 'Observation status',
    currentMonthSpendUsd: 'Current month total',
    updatedAt: 'Last updated',
  };
  return labels[column] || column;
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-sm border border-border bg-muted/40 pl-2.5 pr-1 text-xs">
      {label}
      <button type="button" className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onRemove} aria-label={`Remove ${label} filter`}>
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

  function SpendTable({
    type,
    search,
    searchValue,
    setSearch,
    density,
    viewScope,
    scopeOptions,
    availableTabs,
    onExport,
    isExporting,
    updateUrlParams
  }: {
    type: 'pools' | 'groups' | 'people' | 'projects',
    search: string,
    searchValue: string,
    setSearch: (value: string) => void,
    density: string,
    viewScope: SpendViewScope,
    scopeOptions: Array<{ value: SpendViewScope; label: string }>,
    availableTabs: string[],
    onExport: () => void,
    isExporting: boolean,
    updateUrlParams: (updates: Record<string, string | null | undefined>) => void
  }) {
    const { rangeType, startDate, endDate } = useRange();
    const searchString = useSearch();
    const searchParams = new URLSearchParams(searchString);

  const requestedPage = Number(searchParams.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const requestedPageSize = Number(searchParams.get('pageSize'));
  const pageSize = [10, 25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 25;
  const sort = (searchParams.get('sort') || 'spend_desc') as SpendSortParameter;
  const status = searchParams.get('status') as SpendStatusParameter | undefined;
  const workspaceId = searchParams.get('workspaceId') || undefined;
  const deployedOnly = searchParams.get('deployedOnly') === 'true';
  const staleButSpending = searchParams.get('staleButSpending') === 'true';
  const visibleColumns = spendColumns(columnSets[type].all, columnSets[type].defaults, searchParams.get(`columns_${type}`));

  const queryParams: any = { rangeType, search: search || undefined, viewScope, workspaceId, page, pageSize };
  if (sort) queryParams.sort = sort;
  if (status && status !== 'all') queryParams.status = status;
  if (type === 'projects') {
    if (deployedOnly) queryParams.deployedOnly = true;
    if (staleButSpending) queryParams.staleButSpending = true;
  }
  if (rangeType === "custom") {
    queryParams.startDate = startDate;
    queryParams.endDate = endDate;
  }

  const poolsQuery = useListSpendPools(queryParams, { query: { enabled: type === 'pools', queryKey: getListSpendPoolsQueryKey(queryParams) } });
  const groupsQuery = useListSpendGroups(queryParams, { query: { enabled: type === 'groups', queryKey: getListSpendGroupsQueryKey(queryParams) } });
  const peopleQuery = useListSpendPeople(queryParams, { query: { enabled: type === 'people', queryKey: getListSpendPeopleQueryKey(queryParams) } });
  const projectsQuery = useListSpendProjects(queryParams, { query: { enabled: type === 'projects', queryKey: getListSpendProjectsQueryKey(queryParams) } });

  const query =
    type === 'pools' ? poolsQuery :
    type === 'groups' ? groupsQuery :
    type === 'people' ? peopleQuery :
    projectsQuery;

  const queryTotalPages = Math.max(1, Math.ceil((query.data?.filteredRows ?? 0) / pageSize));
  useEffect(() => {
    if (query.data && page > queryTotalPages) {
      updateUrlParams({ page: String(queryTotalPages) });
    }
  }, [page, query.data, queryTotalPages, updateUrlParams]);

  const denied = query.isError && [403, 404].includes(Number((query.error as { status?: number })?.status));
  const data = denied ? undefined : query.data;

  const columns = columnSets[type].all.filter((column) => visibleColumns.includes(column));

  const totalPages = Math.max(1, Math.ceil((data?.filteredRows ?? 0) / pageSize));
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  const statuses = data?.facets?.statuses || {};
  const workspaces = data?.facets?.workspaces || [];
  const statusOptions = [...new Set(['all', ...Object.keys(statuses), ...(status ? [status] : [])])];

  const startRow = !data?.filteredRows ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(page * pageSize, data?.filteredRows ?? 0);

  const getStatusLabel = (s: string) => {
    if (s === 'all') return 'All statuses';
    return s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };
  const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name;
  const activeFilterCount = Number(Boolean(status && status !== 'all')) + Number(Boolean(workspaceId)) + Number(Boolean(searchValue)) + Number(deployedOnly) + Number(staleButSpending);
  const clearFilters = () => {
    setSearch('');
    updateUrlParams({ search: null, status: null, workspaceId: null, deployedOnly: null, staleButSpending: null });
  };
  const exportDisabled = isExporting || searchValue !== search || !data || query.isFetching || query.isError;

  const totalsObserved = Boolean(data && !isUnknownSpendTotal(data.metadata));

  return (
    <div className="space-y-3">
      {data && (
        <section aria-label="Spend summary" className="grid gap-3 sm:grid-cols-3">
          <MetricCard
            label="Total spend"
            value={formatObservedCurrency(data.totals.spendUsd, totalsObserved)}
            detail={`${data.filteredRows} ${viewLabels[type].toLowerCase()} in view`}
          />
          <MetricCard
            label="Agent"
            value={formatObservedCurrency(data.totals.agentSpendUsd, totalsObserved)}
            detail="Selected reporting period"
          />
          <MetricCard
            label="Other services"
            value={formatObservedCurrency(data.totals.otherServicesUsd, totalsObserved)}
            detail="Hosting, storage, and other costs"
          />
        </section>
      )}
      <section aria-label={`${viewLabels[type]} spend ledger`} className="overflow-hidden rounded-md border bg-card">
      <div className="flex-none border-b border-border px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <div className="flex w-full gap-2 sm:w-auto">
            <Select value={type} onValueChange={(value) => updateUrlParams({ tab: value })}>
              <SelectTrigger className="h-10 flex-1 sm:h-9 sm:w-[150px] sm:flex-none" aria-label="Spend view">
                <span className="mr-1 text-muted-foreground">View:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableTabs.map((tab) => <SelectItem key={tab} value={tab}>{viewLabels[tab]}</SelectItem>)}
              </SelectContent>
            </Select>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-10 w-10 shrink-0 sm:h-9 sm:w-9" aria-label="Table options"><Settings2 className="h-4 w-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>Columns · name and total required</DropdownMenuLabel>
                {columnSets[type].all.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column}
                    checked={visibleColumns.includes(column)}
                    disabled={column === 'name' || column === 'spendUsd'}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => updateUrlParams({ [`columns_${type}`]: (checked ? [...visibleColumns, column] : visibleColumns.filter((value) => value !== column)).join(',') })}
                  >
                    {columnLabel(column, type)}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuItem onSelect={() => updateUrlParams({ [`columns_${type}`]: null })}>Reset columns</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Density</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => updateUrlParams({ density: 'comfortable' })}>{density === 'comfortable' && <Check className="mr-2 h-4 w-4" />}Comfortable</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => updateUrlParams({ density: 'compact' })}>{density === 'compact' && <Check className="mr-2 h-4 w-4" />}Compact</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={exportDisabled} onSelect={onExport}>
                  {isExporting ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                  {isExporting ? 'Exporting…' : 'Export filtered CSV'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="relative w-full sm:max-w-sm sm:flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              className="h-10 pl-9 sm:h-9"
              aria-label={`Search ${viewLabels[type].toLowerCase()}`}
              placeholder={`Search ${viewLabels[type].toLowerCase()}`}
              value={searchValue}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-10 flex-1 sm:h-9 sm:flex-none gap-2">
                  <Filter className="h-4 w-4" />
                  Filters
                  {activeFilterCount > 0 && <span className="rounded-sm bg-primary px-1.5 text-xs text-primary-foreground">{activeFilterCount}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] space-y-4">
                <div>
                  <p className="font-semibold">Filter spend</p>
                  <p className="text-xs text-muted-foreground">Filters apply to this view and its export.</p>
                </div>
                {scopeOptions.length > 1 && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium" htmlFor="spend-scope-filter">Scope</label>
                    <Select value={viewScope} onValueChange={(value) => updateUrlParams({ viewScope: value })}>
                      <SelectTrigger id="spend-scope-filter"><SelectValue /></SelectTrigger>
                      <SelectContent>{scopeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                {(workspaces.length > 0 || workspaceId) && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium" htmlFor="spend-workspace-filter">Workspace</label>
                    <Select value={workspaceId || 'all'} onValueChange={(value) => updateUrlParams({ workspaceId: value === 'all' ? null : value })}>
                      <SelectTrigger id="spend-workspace-filter"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All workspaces</SelectItem>
                        {workspaceId && !workspaceName && <SelectItem value={workspaceId}>{workspaceId}</SelectItem>}
                        {workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.count})</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {(Object.keys(statuses).length > 0 || status) && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium" htmlFor="spend-status-filter">Status</label>
                    <Select value={status || 'all'} onValueChange={(value) => updateUrlParams({ status: value === 'all' ? null : value })}>
                      <SelectTrigger id="spend-status-filter"><SelectValue /></SelectTrigger>
                      <SelectContent>{statusOptions.map((value) => <SelectItem key={value} value={value}>{getStatusLabel(value)} {value !== 'all' ? `(${statuses[value] ?? 0})` : ''}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                {type === 'projects' && (
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Project status</label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={deployedOnly}
                          onChange={(e) => updateUrlParams({ deployedOnly: e.target.checked ? 'true' : null })}
                          className="rounded border-border text-primary focus:ring-primary"
                        />
                        Deployed only
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={staleButSpending}
                          onChange={(e) => updateUrlParams({ staleButSpending: e.target.checked ? 'true' : null })}
                          className="rounded border-border text-primary focus:ring-primary"
                        />
                        Stale but spending
                      </label>
                    </div>
                  </div>
                )}
                {activeFilterCount > 0 && <Button variant="ghost" size="sm" className="w-full" onClick={clearFilters}>Clear filters</Button>}
              </PopoverContent>
            </Popover>
            <Select value={sort} onValueChange={(value) => updateUrlParams({ sort: value })}>
              <SelectTrigger className="h-10 flex-1 sm:h-9 sm:flex-none sm:w-[180px]" aria-label="Sort spend"><ArrowUpDown className="mr-2 h-3.5 w-3.5 text-muted-foreground" /><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="spend_desc">Spend: high to low</SelectItem>
                <SelectItem value="spend_asc">Spend: low to high</SelectItem>
                <SelectItem value="name_asc">Name: A–Z</SelectItem>
                <SelectItem value="name_desc">Name: Z–A</SelectItem>
                {type === 'projects' && (
                  <>
                    <SelectItem value="updated_at_desc">Last updated: newest</SelectItem>
                    <SelectItem value="updated_at_asc">Last updated: oldest</SelectItem>
                  </>
                )}
                <SelectItem value="status">Status priority</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-10 gap-2 sm:h-9"
              disabled={exportDisabled}
              onClick={onExport}
            >
              {isExporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {isExporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </div>
          {query.isFetching && <span className="ml-auto inline-flex items-center text-xs text-muted-foreground" data-testid="status-spend-updating"><RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />Updating</span>}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {data?.scope?.label || scopeOptions.find((option) => option.value === viewScope)?.label || viewScope}
          {' · '}{data?.period.label || (rangeType === 'custom' ? `${startDate} – ${endDate}` : rangeType)}
          {' · '}{workspaceId ? (workspaceName || workspaceId) : 'All authorized workspaces'}
          {' · '}{status && status !== 'all' ? getStatusLabel(status) : 'All statuses'}
           {data?.metadata.status === 'partial' && ' · Partial'}
           {data?.metadata.stale && ' · Stale'}
           {type === 'projects' && data?.personalProjectCatalog?.coverage !== 'complete' && ` · Project catalog ${data?.personalProjectCatalog?.coverage ?? 'unavailable'}`}
          {' · Read-only'}
        </p>
        {activeFilterCount > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="Applied filters">
            {searchValue && <FilterChip label={`Search: ${searchValue}`} onRemove={() => { setSearch(''); updateUrlParams({ search: null }); }} />}
            {workspaceId && <FilterChip label={`Workspace: ${workspaceName || workspaceId}`} onRemove={() => updateUrlParams({ workspaceId: null })} />}
            {status && status !== 'all' && <FilterChip label={`Status: ${getStatusLabel(status)}`} onRemove={() => updateUrlParams({ status: null })} />}
            {deployedOnly && <FilterChip label="Deployed only" onRemove={() => updateUrlParams({ deployedOnly: null })} />}
            {staleButSpending && <FilterChip label="Stale but spending" onRemove={() => updateUrlParams({ staleButSpending: null })} />}
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearFilters}>Clear filters</Button>
          </div>
        )}
      </div>
      {data && query.isError && (
        <div
          className="flex-none border-b border-border bg-red-50 px-4 py-2 text-xs text-red-800"
          role="status"
          aria-live="polite"
        >
          <span className="font-medium">Refresh failed — showing the last successful data</span>
          <Button variant="link" size="sm" className="ml-2 h-auto p-0 text-xs text-red-800 underline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {data && <AdminDataQualityNote title="Spend ledger data quality">
        <p>
          {data.metadata.stale ? 'Stale data. ' : ''}
          {type === 'projects'
            ? `${data.personalProjectCatalog ? `Current project catalog coverage is ${data.personalProjectCatalog.coverage}. ` : 'Current project catalog metadata is unavailable. '}${data.metadata.status === 'empty' ? 'Selected-period spend observations are unavailable. ' : data.metadata.status === 'partial' ? 'Selected-period spend observations are partial. ' : ''}`
            : data.metadata.status === 'empty' ? 'No observations. ' : data.metadata.status === 'partial' ? 'Partial data. ' : ''}
          {data.metadata.dataAsOf && <>Data as of <time dateTime={data.metadata.dataAsOf}>{new Date(data.metadata.dataAsOf).toLocaleString()}</time>. </>}
          {data.metadata.qualifications?.join(' ')}
        </p>
        <dl>
          {[['Total spend', data.totals.spendUsd], ['Agent', data.totals.agentSpendUsd], ['Other services', data.totals.otherServicesUsd]].map(([label, value]) => (
            <div key={String(label)}><dt>{label}</dt><dd className="font-mono text-sm text-foreground">{formatObservedCurrency(value as number, !isUnknownSpendTotal(data.metadata))}</dd></div>
          ))}
        </dl>
        <p className="mt-2">All {data.filteredRows} filtered results, not just this page. Other services includes hosting, storage, and other non-Agent costs. CSV includes all filtered rows and export columns, regardless of column visibility.</p>
        <p className="mt-1">{type === 'projects' ? 'This is the current project catalog; spend columns use the selected reporting period. Project attribution is explanatory and workspace rollups remain authoritative.' : 'Workspace-qualified rollups are authoritative. Unattributed and reconciliation rows remain part of the results when they match your filters.'}</p>
        {type === 'people' && <p className="mt-1">Total, Agent, and other services use the selected reporting period. Optional limit and current-cycle columns refer to monthly Agent enforcement, not this reporting range.</p>}
        {type === 'pools' && <p className="mt-1">Allocations are planning baselines. Utilization applies to the full term, not a monthly Agent limit.</p>}
      </AdminDataQualityNote>}
      <div className="relative min-h-[240px] max-h-[60vh] overflow-auto bg-background" data-virtual-scroll tabIndex={0} aria-label="Spend results">
        {!data ? query.isError ? <div className="p-8 text-center space-y-3" role="status">
          <p>{type === 'projects'
            ? 'Projects unavailable. Your filters and selected spend period are preserved.'
            : [403, 404].includes(Number((query.error as { status?: number })?.status))
              ? 'This spend view is unavailable in your authorized scope.'
              : 'Could not load spend. Your filters are preserved.'}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button>
        </div> : <TableSkeleton /> : data.rows.length === 0 ? <div className="p-8 text-center space-y-3">
          <p className="font-medium">{activeFilterCount
            ? (type === 'projects' ? 'No matching projects' : 'No matching results')
            : type === 'projects'
              ? data.personalProjectCatalog?.coverage === 'missing' ? 'Projects unavailable' : 'No projects found'
              : 'No spend results for this view'}</p>
          <p className="text-sm text-muted-foreground">{activeFilterCount
            ? 'Try clearing search, workspace, or status filters. Your scope and dates will stay the same.'
            : type === 'projects'
              ? data.personalProjectCatalog?.coverage === 'missing'
                ? 'The current project catalog could not be observed for this authorized scope.'
                : 'No current projects were returned for this authorized scope.'
              : 'Try another reporting range or spend view. Missing observations are not zero spend.'}</p>
          {activeFilterCount > 0 && <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>}
        </div> :
        <GenericSpendTable
          rows={data.rows}
          logicalRowCount={data.filteredRows}
          logicalRowIndexOffset={(page - 1) * pageSize}
          columns={columns}
          tableType={type}
          density={density}
          sort={sort}
          updateUrlParams={updateUrlParams}
           rangeType={rangeType}
           dataThrough={data.metadata.dataAsOf}
           stale={Boolean(data.metadata.stale || query.isError)}
           incomplete={Boolean(data.metadata.status && data.metadata.status !== 'complete' && data.metadata.status !== 'stale')}
           onSort={(col) => {
            let newSort: string | null = null;
            if (col === 'name') {
              newSort = sort === 'name_asc' ? 'name_desc' : 'name_asc';
            } else if (col === 'spendUsd') {
              newSort = sort === 'spend_desc' ? 'spend_asc' : 'spend_desc';
            } else if (col === 'status') {
              newSort = 'status';
            } else if (col === 'updatedAt') {
              newSort = String(sort) === 'updated_at_desc' ? 'updated_at_asc' : 'updated_at_desc';
            }
            if (newSort) updateUrlParams({ sort: newSort });
          }}
        />}
      </div>

      {data && <><div className="flex-none border-t border-border bg-muted/10 p-3 flex flex-wrap items-center justify-between text-xs text-muted-foreground gap-3 z-10">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-mono">
            Showing {startRow}–{endRow} of {data.filteredRows} results
            {data.filteredRows < data.totalRows && ` (filtered from ${data.totalRows})`}
          </span>
          <div className="flex items-center gap-2 border-l border-border pl-4">
            <span>Rows:</span>
            <Select value={pageSize.toString()} onValueChange={(val) => updateUrlParams({ pageSize: val })}>
              <SelectTrigger className="h-11 w-[80px] sm:h-6 sm:w-[60px] text-sm sm:text-xs bg-transparent border-dashed" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map(v => (
                  <SelectItem key={v} value={v.toString()} className="text-sm sm:text-xs">{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex w-full sm:w-auto flex-wrap items-center justify-between sm:justify-end gap-3 mt-2 sm:mt-0">
          <div className="font-mono font-medium text-foreground flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground font-sans">
              Filtered total · {data.scope?.label || scopeOptions.find((option) => option.value === viewScope)?.label || 'Current scope'} · {data.period.label}
            </span>
            {isUnknownSpendTotal(data.metadata)
              ? 'Unavailable'
              : formatObservedCurrency(data.totals.spendUsd, true)}
          </div>
          <div className="flex items-center justify-between w-full sm:w-auto gap-2">
            <span className="font-mono text-sm sm:text-xs">Page {page} of {totalPages}</span>
            <div className="flex items-center ml-2 border border-border rounded-md overflow-hidden shadow-sm">
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 sm:h-7 sm:w-7 rounded-none bg-background hover:bg-muted"
                disabled={!hasPrev}
                 aria-label="Previous page"
                onClick={() => updateUrlParams({ page: String(page - 1) })}
              >
                <ChevronLeft className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </Button>
              <div className="w-px h-11 sm:h-7 bg-border" />
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 sm:h-7 sm:w-7 rounded-none bg-background hover:bg-muted"
                disabled={!hasNext}
                 aria-label="Next page"
                onClick={() => updateUrlParams({ page: String(page + 1) })}
              >
                <ChevronRight className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
      <p className="sr-only">
        Generated from {data.period.label}, generation {data.metadata.generationId}.
      </p></>}
      </section>
    </div>
  );
}


function GenericSpendTable({
  rows,
  logicalRowCount,
  logicalRowIndexOffset,
  columns,
  tableType,
  density,
  sort,
  onSort,
  dataThrough,
  stale,
  incomplete,
  rangeType,
  updateUrlParams,
}: {
  rows: SpendTableRow[] | SpendProjectRow[];
  logicalRowCount: number;
  logicalRowIndexOffset: number;
  columns: string[];
  tableType: 'pools' | 'groups' | 'people' | 'projects';
  density: string;
  sort: SpendSortParameter | ProjectSortParameter;
  onSort: (val: string) => void;
  dataThrough: string | null;
  stale: boolean;
  incomplete: boolean;
  rangeType: string;
  updateUrlParams: (updates: Record<string, string | null | undefined>) => void;
}) {
  const getLimitStateLabel = (val: string | number | boolean | null | undefined) => {
    if (val === 'unavailable') return 'Unavailable';
    if (val === 'no_limit') return 'Not set';
    if (val === 'failed' || val === 'refreshing') return 'Observation stale';
    return String(val);
  };

  const isSortable = (col: string) => ['name', 'spendUsd', 'status', 'updatedAt'].includes(col);

  const currentSortField = sort.replace(/_desc|_asc$/, '') === 'updated_at' ? 'updatedAt' : sort.replace(/_desc|_asc$/, '');
  const currentSortDir = sort.endsWith('_asc') ? 'asc' : 'desc';

  const handleSort = (field: string) => {
    if (!isSortable(field)) return;
    onSort(field);
  };

  return (
    <div className="min-w-max bg-card">
      <table className={`w-full min-w-max text-left text-sm border-collapse [&_td]:px-3 [&_th]:px-3 ${density === 'compact' ? '[&_td]:py-2' : '[&_td]:py-3'}`} aria-rowcount={logicalRowCount + 1}>
        <TableHeader className="sticky top-0 bg-background/95 backdrop-blur z-10">
          <TableRow>
            {columns.map((col) => {
              const sortable = isSortable(col);
              const isNumeric = ['spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'allocationUsd', 'remainingUsd', 'percentUsed', 'memberCount', 'currentCycleAgentSpendUsd', 'currentCycleRemainingUsd', 'currentCyclePercentUsed'].includes(col);

              if (sortable) {
                return (
                  <SortableHead
                    key={col}
                    field={col}
                    sortBy={currentSortField}
                    sortDir={currentSortDir}
                    onToggle={handleSort}
                    align={isNumeric ? 'right' : 'left'}
                  >
                    {columnLabel(col, tableType)}
                  </SortableHead>
                );
              }

              return (
                <TableHead key={col} className={isNumeric ? 'text-right' : ''}>
                  {columnLabel(col, tableType)}
                </TableHead>
              );
            })}
            <TableHead className="w-10 text-right" />
          </TableRow>
        </TableHeader>

        {/* We use VirtualizedTableRows as tbody but to match shadcn Table styling we just pass className */}
        <VirtualizedTableRows
          columnCount={columns.length + 1}
          logicalRowIndexOffset={logicalRowIndexOffset}
          className="[&_tr:last-child]:border-0"
        >
          {rows.map((row) => (
            <TableRow key={row.id} className="transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
              {columns.map((col) => {
                const isNumeric = ['spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'allocationUsd', 'remainingUsd', 'percentUsed', 'memberCount', 'currentCycleAgentSpendUsd', 'currentCycleRemainingUsd', 'currentCyclePercentUsed', 'currentMonthSpendUsd'].includes(col);
                const val = (row as any)[col];
                 const selectedRangeUnknown = isUnknownSelectedRangeValue(row.usageObserved, col);
                  let displayVal: React.ReactNode = selectedRangeUnknown ? 'Unavailable' : val == null ? 'Unavailable' : val;

                if (['spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'allocationUsd', 'remainingUsd', 'currentCycleAgentSpendUsd', 'currentCycleRemainingUsd', 'currentMonthSpendUsd'].includes(col)) {
                    displayVal = selectedRangeUnknown ? 'Unavailable' : val == null ? 'Unavailable' : formatObservedCurrency(val, true);
                } else if (col === 'percentUsed' || col === 'currentCyclePercentUsed') {
                    displayVal = selectedRangeUnknown ? 'Unavailable' : val == null ? 'Unavailable' : `${Number(val).toFixed(1)}%`;
                } else if (col === 'updatedAt') {
                    displayVal = val == null ? 'Unknown' : <time dateTime={val}>{new Date(val).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time>;
                } else if (col === 'ownerName' && row.kind === 'project' && (row as any).ownerId) {
                    displayVal = (
                      <Link href={spendDetailHref(`/users/${(row as any).ownerId}`, window.location.pathname + window.location.search)} className="hover:text-primary hover:underline transition-colors">
                        {val || (row as any).ownerId}
                      </Link>
                    );
                } else if (col === 'name' && row.kind === 'person') {
                    displayVal = (
                      <div className="flex items-center gap-2 min-w-0">
                        <Link href={spendDetailHref(`/users/${row.id.split(':').pop()}`, window.location.pathname + window.location.search)} className="font-medium hover:text-primary hover:underline transition-colors truncate">
                          {val}
                        </Link>
                      </div>
                    );
                }

                if (col === 'name') {
                   displayVal = (
                     <div className="flex items-center gap-2 min-w-0">
                       <span className="font-medium hover:text-primary transition-colors truncate">
                         {row.kind === 'project' ? (
                           <Link href={spendDetailHref(`/workspaces/${row.workspaceId}/projects/${(row as any).projectId}`, window.location.pathname + window.location.search)}>
                             {val}
                           </Link>
                         ) : row.kind === 'person' ? (
                           <Link href={spendDetailHref(`/users/${row.id.split(':').pop()}`, window.location.pathname + window.location.search)}>
                             {val}
                           </Link>
                         ) : row.kind === 'pool' ? (
                           row.id.startsWith('pool:team:') ? (
                             <button type="button" onClick={() => updateUrlParams({ poolId: row.id, tab: 'pools' })} className="hover:underline text-left">
                               {val}
                             </button>
                           ) : (
                             <div className="flex items-center gap-2">
                               <span className="text-muted-foreground">{val}</span>
                               <span className="text-[10px] text-muted-foreground uppercase tracking-widest bg-muted px-1.5 py-0.5 rounded-sm">Not assigned to funding team</span>
                             </div>
                           )
                         ) : val}
                       </span>
                       {row.workspaceName && !columns.includes('workspaceName') && (
                         <span className="text-[10px] bg-secondary/10 text-secondary border border-secondary/25 px-1.5 py-0.5 rounded-full shrink-0">
                           {row.workspaceName}
                         </span>
                       )}
                       {row.sharedPool && (
                         <span className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded-full font-mono leading-none">
                           SHARED
                         </span>
                       )}
                       {row.allocationUsd === null && row.kind === 'group' && (
                         <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full font-mono leading-none">
                           NO LIMIT
                         </span>
                       )}
                        {row.kind === 'project' && <StaleSpendingChip visible={(row as SpendProjectRow).staleButSpending} />}
                     </div>
                   );
                }

                return (
                  <TableCell key={col} className={`${isNumeric ? 'text-right font-mono' : ''} ${col === 'spendUsd' ? 'font-medium' : ''}`}>
                     {col === 'deployments' && row.kind === 'project' ? (
                       <div className="flex flex-col gap-1 items-start justify-center">
                          {(row as SpendProjectRow).deploymentAvailability === 'unavailable'
                            ? <span className="text-xs text-muted-foreground">Deployment observation unavailable</span>
                            : (val as any[] | null | undefined)?.length ? (val as any[]).map((d: any) => (
                              <span key={d.id} className="text-xs text-primary" onClick={(e) => e.stopPropagation()}>
                                <DeploymentLink url={d.url} />
                              </span>
                            )) : <span className="text-xs text-muted-foreground">{(row as SpendProjectRow).hasDeployment ? 'Observed, URL unavailable' : 'No deployments'}</span>}
                       </div>
                     ) : col === 'hasDeployment' ? (
                        <DeploymentChip value={val as boolean | null} availability={row.kind === 'project' ? (row as SpendProjectRow).deploymentAvailability : undefined} />
                     ) : col === 'percentUsed' && row.kind === 'pool' ? (
                       rangeType === 'full-term' ? (
                         <BudgetMeter
                           actualUsd={row.usageObserved === false ? null : row.spendUsd}
                           budgetUsd={row.allocationUsd}
                           dataThrough={dataThrough}
                           stale={stale}
                           incomplete={incomplete}
                           label="Full-term pool utilization"
                           compact
                         />
                       ) : <span className="text-xs text-muted-foreground font-mono">Full-term only</span>
                     ) : col === 'currentCyclePercentUsed' && row.kind === 'person' ? (
                       <BudgetMeter
                         actualUsd={row.limitObservationStatus === 'unavailable' ? null : row.currentCycleAgentSpendUsd ?? null}
                         budgetUsd={row.limitState === 'unavailable' ? null : row.allocationUsd}
                         stale={row.limitObservationStatus === 'failed' || row.limitObservationStatus === 'refreshing'}
                         incomplete={row.limitObservationStatus === 'unavailable'}
                         label="Current-cycle Agent utilization"
                         compact
                       />
                     ) : col === 'status' ? (
                      <span className={`inline-flex items-center gap-1 text-[10px] ${val === 'over_budget' ? 'bg-destructive/15 text-destructive border-destructive/25' : 'bg-muted text-muted-foreground'} px-1.5 py-0.5 rounded-full font-mono leading-none uppercase`}>
                        {typeof val === 'string' ? val.replaceAll('_', ' ') : '—'}
                      </span>
                     ) : col === 'isPublished' ? (
                       <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium ${val === true ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                         {val === true ? 'Published' : val === false ? 'Not published' : 'Unknown'}
                       </span>
                     ) : col === 'limitState' || col === 'limitObservationStatus' ? (
                      <span className="text-muted-foreground text-xs font-mono">{getLimitStateLabel(val)}</span>
                    ) : displayVal}
                  </TableCell>
                );
              })}
              <TableCell className="text-right pr-4">
                {['group', 'pool'].includes(row.kind) && (
                   row.kind === 'pool' ? (
                     row.id.startsWith('pool:team:') ? (
                       <button type="button" onClick={() => updateUrlParams({ poolId: row.id, tab: 'pools' })} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary transition-colors">
                         Explore <ChevronRight className="w-3.5 h-3.5" />
                       </button>
                     ) : null
                   ) : (
                     <Link href={spendDetailHref(groupDetailHref(row.id), window.location.pathname + window.location.search)} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary transition-colors">
                       Explore <ChevronRight className="w-3.5 h-3.5" />
                     </Link>
                   )
                )}
              </TableCell>
            </TableRow>
          ))}
        </VirtualizedTableRows>
      </table>
    </div>
  );
}

export function groupDetailHref(qualifiedId: string): string {
  const [, , ...groupIdParts] = qualifiedId.split(':');
  return `/groups/${encodeURIComponent(groupIdParts.join(':'))}`;
}
