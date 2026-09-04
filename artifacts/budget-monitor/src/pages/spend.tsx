import React from "react";
import { useMemo, useState, useEffect } from 'react';
import { useLocation, Link, useSearch } from 'wouter';
import { 
  useListSpendPools, 
  useListSpendGroups, 
  useListSpendPeople, 
  useListSpendProjects,
  SpendTableRow,
  getExportSpendPoolsCsvUrl,
  getExportSpendGroupsCsvUrl,
  getExportSpendPeopleCsvUrl,
  getExportSpendProjectsTableCsvUrl,
  getListSpendPoolsQueryKey,
  getListSpendGroupsQueryKey,
  getListSpendPeopleQueryKey,
  getListSpendProjectsQueryKey,
  SpendSortParameter,
  SpendStatusParameter
} from '@workspace/api-client-react';
import { useAuthContext } from '@/components/auth-context';
import { useRange } from '@/components/range-context';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RangeFilter } from '@/components/range-filter';
import { Search, Download, ChevronRight, ArrowUpDown, ChevronUp, ChevronDown, ChevronLeft } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
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
  const viewScopeFromUrl = searchParams.get('viewScope') || auth?.viewScope || 'managed';
  
  // Tab determination aligned to capabilities
  const availableTabs = useMemo(() => {
    const tabs = [];
    if (isAccountAdmin || isWorkspaceAdmin || isTeamAdmin || capabilities.canEditAllocations) tabs.push('pools');
    if (isAccountAdmin || isWorkspaceAdmin || isTeamAdmin) tabs.push('groups');
    tabs.push('people');
    tabs.push('projects');
    return tabs;
  }, [isAccountAdmin, isWorkspaceAdmin, isTeamAdmin, capabilities.canEditAllocations]);
  
  const defaultTab = availableTabs[0] || 'projects';
  const activeTab = availableTabs.includes(activeTabFromUrl as string) ? activeTabFromUrl as string : defaultTab;
  
  const [search, setSearch] = useState(searchFromUrl);
  const debouncedSearch = useDebounce(search, 300);

  const updateUrlParams = (updates: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams(window.location.search);
    let changed = false;
    let shouldResetPage = false;
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) {
        if (params.has(key)) {
          params.delete(key);
          changed = true;
          if (['search', 'tab', 'pageSize', 'sort', 'status'].includes(key)) shouldResetPage = true;
        }
      } else {
        if (params.get(key) !== value) {
          params.set(key, value);
          changed = true;
          if (['search', 'tab', 'pageSize', 'sort', 'status'].includes(key)) shouldResetPage = true;
        }
      }
    }
    if (shouldResetPage && !updates.page) {
      params.delete('page');
    }
    if (changed) {
      setLocation(`${window.location.pathname}?${params.toString()}`);
    }
  };

  useEffect(() => {
    if (debouncedSearch !== searchFromUrl) {
      updateUrlParams({ search: debouncedSearch || null });
    }
  }, [debouncedSearch]);

  const handleExport = () => {
    try {
      const params: any = { rangeType };
      if (rangeType === "custom") {
        params.startDate = startDate;
        params.endDate = endDate;
      }
      if (debouncedSearch) params.search = debouncedSearch;
      if (viewScopeFromUrl) params.viewScope = viewScopeFromUrl;
      const sort = searchParams.get('sort');
      const status = searchParams.get('status');
      if (sort) params.sort = sort;
      if (status && status !== 'all') params.status = status;

      let url = '';
      if (activeTab === 'pools') url = getExportSpendPoolsCsvUrl(params);
      else if (activeTab === 'groups') url = getExportSpendGroupsCsvUrl(params);
      else if (activeTab === 'people') url = getExportSpendPeopleCsvUrl(params);
      else if (activeTab === 'projects') url = getExportSpendProjectsTableCsvUrl(params);
      
      if (url) {
        window.location.href = url;
      }
    } catch (err) {
      toast({ title: 'Export failed', description: 'Could not generate export URL', variant: 'destructive' });
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw] flex flex-col h-[calc(100vh-3.5rem)] md:h-[100vh]">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            {role === 'member' ? 'My usage' : 'Spend details'}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {role !== 'member' && (
            <Select value={viewScopeFromUrl} onValueChange={(val) => updateUrlParams({ viewScope: val })}>
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed">Managed scope</SelectItem>
                <SelectItem value="my">My usage</SelectItem>
                <SelectItem value="all_authorized">All authorized</SelectItem>
              </SelectContent>
            </Select>
          )}
          <RangeFilter selectedLabel="Reporting Period" />
        </div>
      </div>
      
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between shrink-0">
        <Tabs value={activeTab} onValueChange={(val) => updateUrlParams({ tab: val, status: null, sort: null })} className="w-full sm:w-auto">
          <TabsList>
            {availableTabs.includes('pools') && <TabsTrigger value="pools">Budget pools</TabsTrigger>}
            {availableTabs.includes('groups') && <TabsTrigger value="groups">Groups</TabsTrigger>}
            {availableTabs.includes('people') && <TabsTrigger value="people">People</TabsTrigger>}
            {availableTabs.includes('projects') && <TabsTrigger value="projects">Projects</TabsTrigger>}
          </TabsList>
        </Tabs>
        
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              type="search" 
              placeholder="Search..." 
              className="pl-9 h-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={densityFromUrl} onValueChange={(val) => updateUrlParams({ density: val })}>
            <SelectTrigger className="w-[120px] h-9 hidden md:flex">
              <SelectValue placeholder="Density" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comfortable">Comfortable</SelectItem>
              <SelectItem value="compact">Compact</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-9 shrink-0 gap-1.5 hidden md:flex" onClick={handleExport}>
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>
      
      <div className="flex-1 min-h-0 relative border rounded-md overflow-hidden bg-card">
        {activeTab === 'pools' && <SpendTable type="pools" search={debouncedSearch} density={densityFromUrl} updateUrlParams={updateUrlParams} />}
        {activeTab === 'groups' && <SpendTable type="groups" search={debouncedSearch} density={densityFromUrl} updateUrlParams={updateUrlParams} />}
        {activeTab === 'people' && <SpendTable type="people" search={debouncedSearch} density={densityFromUrl} updateUrlParams={updateUrlParams} />}
        {activeTab === 'projects' && <SpendTable type="projects" search={debouncedSearch} density={densityFromUrl} updateUrlParams={updateUrlParams} />}
      </div>
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

function SpendTable({ 
  type, 
  search, 
  density,
  updateUrlParams
}: { 
  type: 'pools' | 'groups' | 'people' | 'projects', 
  search: string, 
  density: string,
  updateUrlParams: (updates: Record<string, string | null | undefined>) => void 
}) {
  const { rangeType, startDate, endDate } = useRange();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  
  const viewScope = searchParams.get('viewScope') || undefined;
  const page = parseInt(searchParams.get('page') || '1', 10);
  const pageSize = parseInt(searchParams.get('pageSize') || '25', 10);
  const sort = searchParams.get('sort') as SpendSortParameter | undefined;
  const status = searchParams.get('status') as SpendStatusParameter | undefined;
  
  const queryParams: any = { rangeType, search: search || undefined, viewScope, page, pageSize };
  if (sort) queryParams.sort = sort;
  if (status && status !== 'all') queryParams.status = status;
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

  if (query.isLoading) return <TableSkeleton />;
  if (query.isError || !query.data) return <div className="p-8 text-center text-muted-foreground">Failed to load data.</div>;

  const data = query.data;

  let columns: string[] = [];
  if (type === 'pools') columns = ['name', 'spendUsd', 'allocationUsd', 'remainingUsd', 'percentUsed', 'status'];
  else if (type === 'groups') columns = ['name', 'memberCount', 'spendUsd', 'agentSpendUsd', 'otherServicesUsd', 'allocationUsd'];
  else if (type === 'people') columns = ['name', 'workspaceName', 'spendUsd', 'agentSpendUsd', 'limitState'];
  else columns = ['name', 'ownerName', 'workspaceName', 'spendUsd', 'agentSpendUsd', 'otherServicesUsd'];

  const totalPages = Math.max(1, Math.ceil(data.filteredRows / pageSize));
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  const statuses = data.facets?.statuses || {};
  const statusOptions = ['all', ...Object.keys(statuses)];

  const startRow = data.filteredRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(page * pageSize, data.filteredRows);

  const getStatusLabel = (s: string) => {
    if (s === 'all') return 'All statuses';
    return s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-2 border-b shrink-0 bg-muted/10">
        <div className="flex items-center gap-2">
          {Object.keys(statuses).length > 0 && (
            <Select value={status || 'all'} onValueChange={(val) => updateUrlParams({ status: val === 'all' ? null : val })}>
              <SelectTrigger className="w-[160px] h-8 text-xs">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map(s => (
                  <SelectItem key={s} value={s}>
                    {getStatusLabel(s)} {s !== 'all' ? `(${statuses[s]})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <GenericSpendTable 
          rows={data.rows} 
          columns={columns} 
          density={density} 
          sort={sort}
          onSort={(col) => {
            let newSort: string | null = null;
            if (col === 'name') {
              newSort = sort === 'name_asc' ? 'name_desc' : 'name_asc';
            } else if (col === 'spendUsd') {
              newSort = sort === 'spend_desc' ? 'spend_asc' : 'spend_desc';
            } else if (col === 'status') {
              newSort = 'status';
            }
            if (newSort) updateUrlParams({ sort: newSort });
          }}
        />
      </div>
      <div className="border-t p-3 bg-muted/30 flex flex-col sm:flex-row items-center justify-between text-sm text-muted-foreground shrink-0 gap-3">
        <div className="flex items-center gap-4">
          <span className="tabular-nums">
            Showing {startRow}–{endRow} of {data.filteredRows} results
            {data.filteredRows < data.totalRows && ` (filtered from ${data.totalRows})`}
          </span>
          <div className="flex items-center gap-2 border-l pl-4">
            <span>Rows per page:</span>
            <Select value={pageSize.toString()} onValueChange={(val) => updateUrlParams({ pageSize: val })}>
              <SelectTrigger className="h-7 w-[70px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map(v => (
                  <SelectItem key={v} value={v.toString()}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="font-mono tabular-nums font-medium text-foreground">
            Filtered Total: ${data.totals.spendUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">Page {page} of {totalPages}</span>
            <Button 
              variant="outline" 
              size="icon" 
              className="h-7 w-7" 
              disabled={!hasPrev} 
              onClick={() => updateUrlParams({ page: String(page - 1) })}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button 
              variant="outline" 
              size="icon" 
              className="h-7 w-7" 
              disabled={!hasNext} 
              onClick={() => updateUrlParams({ page: String(page + 1) })}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GenericSpendTable({ 
  rows, 
  columns, 
  density, 
  sort,
  onSort
}: { 
  rows: SpendTableRow[], 
  columns: string[], 
  density: string,
  sort: string | undefined,
  onSort: (col: string) => void
}) {
  if (rows.length === 0) {
    return <div className="p-12 text-center text-muted-foreground">No data available for this view.</div>;
  }

  const formatCurrency = (val: number | null) => {
    if (val === null) return '—';
    if (val === 0) return '$0.00';
    return '$' + val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const colLabel = (col: string) => {
    const labels: Record<string, string> = {
      name: 'Name', spendUsd: 'Spend', allocationUsd: 'Allocation', remainingUsd: 'Remaining',
      percentUsed: 'Used %', status: 'Status', memberCount: 'Members', agentSpendUsd: 'Agent Spend',
      otherServicesUsd: 'Other Services', workspaceName: 'Workspace', ownerName: 'Owner', limitState: 'Limit State'
    };
    return labels[col] || col;
  };

  const rowClass = density === 'compact' ? 'h-12' : 'h-14';

  const getLimitStateLabel = (val: string) => {
    if (val === 'not_applicable') return 'Not applicable';
    if (val === 'no_limit') return 'No limit';
    if (val === 'unavailable') return 'Unavailable';
    if (val === 'inherited') return 'Inherited';
    return val;
  };

  const isSortable = (col: string) => ['name', 'spendUsd', 'status'].includes(col);
  
  const getSortIcon = (col: string) => {
    if (!isSortable(col)) return null;
    if (col === 'name') {
      if (sort === 'name_asc') return <ChevronUp className="h-3 w-3 ml-1" />;
      if (sort === 'name_desc') return <ChevronDown className="h-3 w-3 ml-1" />;
    }
    if (col === 'spendUsd') {
      if (sort === 'spend_asc') return <ChevronUp className="h-3 w-3 ml-1" />;
      if (sort === 'spend_desc') return <ChevronDown className="h-3 w-3 ml-1" />;
    }
    if (col === 'status' && sort === 'status') {
      return <ChevronDown className="h-3 w-3 ml-1" />;
    }
    return <ArrowUpDown className="h-3 w-3 ml-1 opacity-20 group-hover:opacity-50 transition-opacity" />;
  };

  return (
    <table className="w-full min-w-max text-sm text-left">
      <thead className="sticky top-0 bg-background z-10 text-xs uppercase text-muted-foreground border-b shadow-sm">
        <tr>
          {columns.map((col, i) => {
            const sortable = isSortable(col);
            return (
              <th 
                key={col} 
                className={`px-4 py-3 font-medium ${i > 0 && !['status', 'limitState', 'workspaceName', 'ownerName'].includes(col) ? 'text-right' : ''} ${sortable ? 'cursor-pointer hover:bg-muted/50 transition-colors select-none' : ''}`}
                onClick={() => sortable && onSort(col)}
              >
                <div className={`flex items-center gap-1 ${i > 0 && !['status', 'limitState', 'workspaceName', 'ownerName'].includes(col) ? 'justify-end' : ''}`}>
                  {colLabel(col)}
                  {getSortIcon(col)}
                </div>
              </th>
            );
          })}
          <th className="px-4 py-3 w-10"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => (
          <tr key={row.id} className={`hover:bg-muted/30 transition-colors group ${rowClass}`}>
            {columns.map((col, i) => {
              const val = (row as any)[col];
              const isNumeric = col.includes('Usd') || col === 'percentUsed' || col === 'memberCount';
              
              let displayVal: React.ReactNode = val;
              if (col.includes('Usd')) displayVal = formatCurrency(val);
              if (col === 'percentUsed') displayVal = val !== null ? `${val.toFixed(1)}%` : '—';
              
              if (col === 'name') {
                 let href = '';
                 if (row.kind === 'group') {
                   const parts = row.id.split(':');
                   href = `/groups/${parts[parts.length - 1]}`;
                 }
                 const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
                 
                 displayVal = href ? (
                   <Link href={`${href}?returnTo=${returnTo}`} className="font-medium text-primary hover:underline">
                     {val}
                   </Link>
                 ) : (
                   <span className="font-medium">{val}</span>
                 );
                 if (row.sharedPool) {
                   displayVal = <div className="flex flex-col">{displayVal}<span className="text-xs text-muted-foreground">Shared pool</span></div>
                 }
                 if (row.allocationUsd === null && row.kind === 'group') {
                   // This may be "No allocation"
                   displayVal = <div className="flex flex-col">{displayVal}<span className="text-xs text-muted-foreground">No allocation</span></div>
                 }
              }

              return (
                <td key={col} className={`px-4 ${isNumeric ? 'text-right font-mono tabular-nums' : ''} ${col === 'name' ? 'sticky left-0 bg-background group-hover:bg-muted/30' : ''}`}>
                  {col === 'status' ? (
                    <Badge variant="outline" className="text-[10px] uppercase font-semibold">{val || '—'}</Badge>
                  ) : col === 'limitState' ? (
                    <span className="text-muted-foreground text-xs">{getLimitStateLabel(val)}</span>
                  ) : displayVal}
                </td>
              );
            })}
            <td className="px-4 text-right">
              {['group'].includes(row.kind) && (
                 <Link href={`/groups/${row.id.split(':').pop()}?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}>
                   <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                     <ChevronRight className="h-4 w-4" />
                   </Button>
                 </Link>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
