import { useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  getExportSpendProjectsTableCsvUrl,
  getListSpendProjectsQueryKey,
  useListSpendProjects,
  type ProjectSortParameter,
} from '@workspace/api-client-react';
import { ChevronLeft, ChevronRight, Download, RefreshCw, Search } from 'lucide-react';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { RangeFilter } from '@/components/range-filter';
import { DeploymentChip, ProjectDate, StaleSpendingChip } from '@/components/project-observation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRange } from '@/components/range-context';
import { downloadAuthenticatedBlob } from '@/lib/download';
import { spendDetailHref, updateSpendParams } from '@/lib/spend-exploration';
import { formatObservedCurrency, isUnknownSpendTotal } from '@/lib/spend-presentation';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from '@/components/auth-context';
import { isBlockingQueryError, isReportingUsageRefreshing } from '@/lib/errors';

const PAGE_SIZES = [10, 25, 50, 100];

export default function MyProjects() {
  const searchString = useSearch();
  const [location, setLocation] = useLocation();
  const { rangeType, startDate, endDate } = useRange();
  const { toast } = useToast();
  const { authorizationKey } = useAuthContext();
  const params = new URLSearchParams(searchString);
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const requestedPageSize = Number(params.get('pageSize'));
  const pageSize = PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 25;
  const sort = (params.get('sort') || 'spend_desc') as ProjectSortParameter;
  const searchFromUrl = params.get('search') || '';
  const workspaceId = params.get('workspaceId') || undefined;
  const deployedOnly = params.get('deployedOnly') === 'true';
  const staleButSpending = params.get('staleButSpending') === 'true';
  const [searchDraft, setSearchDraft] = useState(searchFromUrl);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => setSearchDraft(searchFromUrl), [searchFromUrl]);

  const updateParams = (updates: Record<string, string | null | undefined>) => {
    const next = updateSpendParams(searchString, updates);
    setLocation(`${location}${next ? `?${next}` : ''}`);
  };

  useEffect(() => {
    if (searchDraft === searchFromUrl) return;
    const timer = window.setTimeout(
      () => updateParams({ search: searchDraft.trim() || null }),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [searchDraft, searchFromUrl]);

  const queryParams: any = {
    rangeType,
    viewScope: 'my',
    page,
    pageSize,
    sort,
    search: searchFromUrl || undefined,
    workspaceId,
    deployedOnly: deployedOnly || undefined,
    staleButSpending: staleButSpending || undefined,
  };
  if (rangeType === 'custom') {
    queryParams.startDate = startDate;
    queryParams.endDate = endDate;
  }

  const query = useListSpendProjects(queryParams, {
    query: { queryKey: [...getListSpendProjectsQueryKey(queryParams), authorizationKey] },
  });
  const refreshPending = isReportingUsageRefreshing(query.failureReason ?? query.error);
  const data = isBlockingQueryError(query.error) ? undefined : query.data;
  const totalPages = Math.max(1, Math.ceil((data?.filteredRows ?? 0) / pageSize));

  useEffect(() => {
    if (data && page > totalPages) updateParams({ page: String(totalPages) });
  }, [data, page, totalPages]);

  const exportProjects = async () => {
    if (!data || query.isFetching || isExporting) return;
    setIsExporting(true);
    try {
      await downloadAuthenticatedBlob(getExportSpendProjectsTableCsvUrl(queryParams), {
        filename: `my-projects-${new Date().toISOString().slice(0, 10)}.csv`,
      });
    } catch (error) {
      toast({
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'Could not download the export.',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const currentPath = `${location}${searchString ? `?${searchString}` : ''}`;
  const projectDetailHref = (workspaceId: string, projectId: string) => {
    const href = spendDetailHref(
      `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`,
      currentPath,
      '/my-projects',
    );
    const [pathname, search = ''] = href.split('?');
    const detailParams = new URLSearchParams(search);
    detailParams.set('viewScope', 'my');
    return `${pathname}?${detailParams}`;
  };
  const workspaces = data?.facets?.workspaces ?? [];
  const activeFilters = Boolean(searchFromUrl || workspaceId || deployedOnly || staleButSpending);
  const clearFilters = () => {
    setSearchDraft('');
    updateParams({
      search: null,
      workspaceId: null,
      deployedOnly: null,
      staleButSpending: null,
    });
  };

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-6 px-4 py-6 md:px-8 md:py-8" data-testid="page-my-projects">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">My Projects</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your current project catalog · selected-period spend</p>
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Reporting period</p>
          <RangeFilter />
        </div>
      </header>

      {data && (
        <AdminDataQualityNote title="Project data quality">
          <p>
            Current project catalog coverage is {data.personalProjectCatalog?.coverage ?? 'unavailable'}.
            {' '}Spend uses the selected reporting period; catalog metadata is current.
          </p>
          {data.metadata.qualifications?.map((qualification) => <p key={qualification}>{qualification}</p>)}
        </AdminDataQualityNote>
      )}

      <section className="overflow-hidden rounded-md border bg-card" aria-label="My projects">
        <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              className="pl-9"
              aria-label="Search my projects"
              placeholder="Search projects"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </div>
          <Select value={workspaceId || 'all'} onValueChange={(value) => updateParams({ workspaceId: value === 'all' ? null : value })}>
            <SelectTrigger className="w-full lg:w-52" aria-label="Filter by workspace"><SelectValue placeholder="All workspaces" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workspaces</SelectItem>
              {workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId) && <SelectItem value={workspaceId}>{workspaceId}</SelectItem>}
              {workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.count})</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(value) => updateParams({ sort: value })}>
            <SelectTrigger className="w-full lg:w-52" aria-label="Sort my projects"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="spend_desc">Spend: high to low</SelectItem>
              <SelectItem value="spend_asc">Spend: low to high</SelectItem>
              <SelectItem value="name_asc">Name: A–Z</SelectItem>
              <SelectItem value="name_desc">Name: Z–A</SelectItem>
              <SelectItem value="updated_at_desc">Last updated: newest</SelectItem>
              <SelectItem value="updated_at_asc">Last updated: oldest</SelectItem>
            </SelectContent>
          </Select>
          <Button variant={deployedOnly ? 'secondary' : 'outline'} onClick={() => updateParams({ deployedOnly: deployedOnly ? null : 'true' })}>
            Deployed
          </Button>
          <Button variant={staleButSpending ? 'secondary' : 'outline'} onClick={() => updateParams({ staleButSpending: staleButSpending ? null : 'true' })}>
            Stale/spending
          </Button>
          <Button variant="outline" onClick={() => void exportProjects()} disabled={!data || query.isFetching || isExporting}>
            {isExporting ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Export CSV
          </Button>
        </div>

        {!data ? query.isError && !refreshPending ? (
          <div className="space-y-3 p-10 text-center" role="alert">
            <p>My projects are unavailable. Your filters and reporting period are preserved.</p>
            <Button variant="outline" onClick={() => void query.refetch()}>Retry</Button>
          </div>
        ) : (
          <div className="h-56 animate-pulse bg-muted/30" role="status" aria-label="Loading my projects" />
        ) : data.rows.length === 0 ? (
          <div className="space-y-3 p-10 text-center">
            <p className="font-medium">{data.personalProjectCatalog?.coverage === 'missing' ? 'Projects unavailable' : activeFilters ? 'No matching projects' : 'No projects found'}</p>
            {activeFilters && <Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Project</th>
                  <th className="px-4 py-3">Workspace</th>
                  <th className="px-4 py-3 text-right">Spend</th>
                  <th className="px-4 py-3 text-right">Agent</th>
                  <th className="px-4 py-3 text-center">Deployed</th>
                  <th className="px-4 py-3">Last updated</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.rows.map((project) => (
                  <tr key={project.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">
                      <Link href={projectDetailHref(project.workspaceId, project.projectId)} className="hover:text-primary hover:underline">
                        {project.name}
                      </Link>
                      <StaleSpendingChip visible={project.staleButSpending} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{project.workspaceName || project.workspaceId}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatObservedCurrency(project.spendUsd, project.usageObserved)}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatObservedCurrency(project.agentSpendUsd, project.usageObserved)}</td>
                    <td className="px-4 py-3 text-center"><DeploymentChip value={project.hasDeployment} availability={project.deploymentAvailability} /></td>
                    <td className="px-4 py-3 text-muted-foreground"><ProjectDate value={project.updatedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/10 p-3 text-xs text-muted-foreground">
            <span>
              {data.filteredRows} project{data.filteredRows === 1 ? '' : 's'} · Total spend{' '}
              <strong className="font-mono text-foreground">{formatObservedCurrency(data.totals.spendUsd, !isUnknownSpendTotal(data.metadata))}</strong>
            </span>
            <div className="flex items-center gap-2">
              <Select value={String(pageSize)} onValueChange={(value) => updateParams({ pageSize: value })}>
                <SelectTrigger className="h-8 w-20" aria-label="Rows per page"><SelectValue /></SelectTrigger>
                <SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent>
              </Select>
              <span>Page {page} of {totalPages}</span>
              <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Previous page" disabled={page <= 1} onClick={() => updateParams({ page: String(page - 1) })}><ChevronLeft className="h-4 w-4" /></Button>
              <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Next page" disabled={page >= totalPages} onClick={() => updateParams({ page: String(page + 1) })}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}