import React from "react";
import { useParams, useLocation } from "wouter";
import { useSearch as useRawSearch } from "wouter/use-browser-location";
import { 
  useListUserOwnedProjects, 
  getListUserOwnedProjectsQueryKey,
  type ListUserOwnedProjectsParams,
} from "@workspace/api-client-react";
import { AlertTriangle, RefreshCw, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sanitizeSpendReturnTo, spendDetailHref, updateSpendParams } from "@/lib/spend-exploration";
import { useRange } from "@/components/range-context";
import { AdminDataQualityNote } from "@/components/admin-data-quality";
import { formatObservedCurrency, isUnknownSpendTotal } from "@/lib/spend-presentation";
import { DeploymentChip, ProjectDataFreshness, ProjectDate, StaleSpendingChip } from "@/components/project-observation";

export default function UserProjects() {
  const { userId } = useParams();
  const rawSearch = useRawSearch();
  const searchString = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  const [location, setLocation] = useLocation();
  const { rangeType, startDate, endDate } = useRange();

  const searchParams = new URLSearchParams(rawSearch);
  const page = parseInt(searchParams.get('page') || '1', 10);
  const pageSize = 25;
  const sort = (searchParams.get('sort') || 'spend_desc') as ListUserOwnedProjectsParams['sort'];

  const queryParams: ListUserOwnedProjectsParams = {
    rangeType,
    viewScope: (searchParams.get("viewScope") || undefined) as ListUserOwnedProjectsParams['viewScope'],
    workspaceId: searchParams.get("workspaceId") || undefined,
    poolId: searchParams.get("poolId") || undefined,
    page, 
    pageSize, 
    sort 
  };
  if (rangeType === 'custom') {
    queryParams.startDate = startDate;
    queryParams.endDate = endDate;
  }

  const query = useListUserOwnedProjects(userId!, queryParams, { 
    query: { enabled: !!userId, queryKey: getListUserOwnedProjectsQueryKey(userId!, queryParams) } 
  });

  const data = query.data;

  const returnTo = sanitizeSpendReturnTo(searchParams.get("returnTo"), '/my-team');
  const currentPath = `${location}${searchString ? `?${searchString}` : ""}`;
  const setPage = (nextPage: number) => {
    const next = updateSpendParams(searchString, { page: String(nextPage) });
    setLocation(`${location}?${next}`);
  };
  const totalPages = Math.max(1, Math.ceil((data?.projects.filteredRows ?? 0) / pageSize));

  if (query.isError && !query.data) {
    return (
      <div className="flex flex-col items-center justify-center h-[50vh] space-y-4">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p role="alert">Owned projects are unavailable. This person may not exist or may be outside your current access.</p>
        <Button onClick={() => void query.refetch()} variant="outline"><RefreshCw className="mr-2 h-4 w-4"/>Retry</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8 space-y-8">
      <div>
        <Button variant="ghost" size="sm" onClick={() => setLocation(returnTo)} className="mb-4 -ml-2 text-muted-foreground">
          <ChevronLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        <h1 className="text-2xl font-bold tracking-tight mb-1">
          {data?.user.name || data?.user.username || userId}
        </h1>
        <p className="text-muted-foreground text-sm">
          {data?.user.email || 'Currently owned projects'}
        </p>
      </div>

      {!data ? (
        <div className="space-y-4 animate-pulse" role="status" aria-label="Loading owned projects">
          <div className="h-8 bg-muted rounded w-1/3"></div>
          <div className="h-32 bg-muted rounded"></div>
        </div>
      ) : (
        <div className="space-y-6">
          <AdminDataQualityNote title="User projects data quality">
            <p>Spend uses the selected range; ownership is current.</p>
          </AdminDataQualityNote>
          <ProjectDataFreshness metadata={data.projects.metadata} />
          
          <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
             <div className="p-4 border-b border-border flex flex-wrap gap-4 items-center justify-between">
                <div className="text-sm font-medium">Projects</div>
                <div className="text-xs text-muted-foreground font-mono">
                   Total Spend: <span className="text-foreground">{formatObservedCurrency(data.projects.totals.spendUsd, !isUnknownSpendTotal(data.projects.metadata))}</span>
                </div>
             </div>
             {data.projects.rows.length === 0 ? (
               <div className="p-8 text-center text-sm text-muted-foreground">
                 {data.projects.personalProjectCatalog?.coverage === 'missing' ? 'Projects unavailable.' : 'No projects found.'}
               </div>
             ) : (
               <div className="overflow-x-auto">
                 <table className="w-full text-sm text-left border-collapse [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-3">
                   <thead className="bg-muted/50 font-semibold text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                     <tr>
                       <th>Project</th>
                       <th>Workspace</th>
                       <th className="text-right">Spend</th>
                       <th className="text-right">Agent</th>
                       <th className="text-center">Deployed</th>
                       <th>Last Updated</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-border">
                     {data.projects.rows.map(row => (
                       <tr key={row.id} className="hover:bg-muted/30">
                         <td className="font-medium text-foreground">
                            <a href={spendDetailHref(`/workspaces/${encodeURIComponent(row.workspaceId)}/projects/${encodeURIComponent(row.projectId)}`, currentPath)} className="hover:text-primary hover:underline">
                             {row.name}
                           </a>
                         </td>
                         <td className="text-muted-foreground">{row.workspaceName || row.workspaceId}</td>
                          <td className="text-right font-mono">{formatObservedCurrency(row.spendUsd, row.usageObserved)}</td>
                          <td className="text-right font-mono text-muted-foreground">{formatObservedCurrency(row.agentSpendUsd, row.usageObserved)}</td>
                         <td className="text-center">
                            <DeploymentChip value={row.hasDeployment} availability={row.deploymentAvailability} />
                            <span className="ml-2"><StaleSpendingChip visible={row.staleButSpending} /></span>
                         </td>
                         <td className="text-muted-foreground text-xs">
                            <ProjectDate value={row.updatedAt} />
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
             {data.projects.filteredRows > 0 && (
               <div className="flex items-center justify-between border-t border-border p-3 text-xs text-muted-foreground">
                 <span>Page {page} of {totalPages}</span>
                 <div className="flex gap-1">
                   <Button aria-label="Previous page" variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                   <Button aria-label="Next page" variant="outline" size="icon" disabled={page >= totalPages} onClick={() => setPage(page + 1)}><ChevronLeft className="h-4 w-4 rotate-180" /></Button>
                 </div>
               </div>
             )}
           </div>
             )}
          </div>
        </div>
      )}
    </div>
  );
}
