import React from "react";
import { useParams, useLocation } from "wouter";
import { useSearch as useRawSearch } from "wouter/use-browser-location";
import { 
  useGetWorkspaceProject, 
  getGetWorkspaceProjectQueryKey,
  type GetWorkspaceProjectParams,
} from "@workspace/api-client-react";
import { AlertTriangle, RefreshCw, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRange } from "@/components/range-context";
import { AdminDataQualityNote } from "@/components/admin-data-quality";
import { formatObservedCurrency } from "@/lib/spend-presentation";
import { spendDetailHref, sanitizeSpendReturnTo } from "@/lib/spend-exploration";
import { DeploymentChip, DeploymentLink, ProjectDataFreshness, ProjectDate, StaleSpendingChip } from "@/components/project-observation";

export default function ProjectDetail() {
  const { workspaceId, projectId } = useParams();
  const rawSearch = useRawSearch();
  const searchString = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  const [location, setLocation] = useLocation();
  const { rangeType, startDate, endDate } = useRange();

  const searchParams = new URLSearchParams(rawSearch);
  const poolId = searchParams.get("poolId") || undefined;
  const queryParams: GetWorkspaceProjectParams = {
    rangeType,
    viewScope: (searchParams.get("viewScope") || undefined) as GetWorkspaceProjectParams['viewScope'],
    poolId,
  };
  if (rangeType === 'custom') {
    queryParams.startDate = startDate;
    queryParams.endDate = endDate;
  }

  const query = useGetWorkspaceProject(workspaceId!, projectId!, queryParams, { 
    query: { enabled: !!workspaceId && !!projectId, queryKey: getGetWorkspaceProjectQueryKey(workspaceId!, projectId!, queryParams) } 
  });

  const data = query.data;
  const returnTo = sanitizeSpendReturnTo(searchParams.get("returnTo"), '/my-projects');
  const currentPath = `${location}${searchString ? `?${searchString}` : ""}`;

  if (query.isError && !query.data) {
    return (
      <div className="flex flex-col items-center justify-center h-[50vh] space-y-4">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p role="alert">Project details are unavailable. The project may not exist or may be outside your current access.</p>
        <Button onClick={() => void query.refetch()} variant="outline"><RefreshCw className="mr-2 h-4 w-4"/>Retry</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8 space-y-8">
      <div>
        <Button variant="ghost" size="sm" onClick={() => setLocation(returnTo)} className="mb-4 -ml-2 text-muted-foreground">
          <ChevronLeft className="mr-1 h-4 w-4" /> Back
        </Button>
      </div>

      {!data ? (
        <div className="space-y-4 animate-pulse" role="status" aria-label="Loading project details">
          <div className="h-10 bg-muted rounded w-1/2"></div>
          <div className="h-4 bg-muted rounded w-1/4"></div>
          <div className="h-64 bg-muted rounded mt-8"></div>
        </div>
      ) : (
        <div className="space-y-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">
              {data.project.name}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="bg-secondary/10 text-secondary border border-secondary/25 px-2 py-0.5 rounded-full text-xs">
                {data.project.workspaceName || data.project.workspaceId}
              </span>
               <span>Owner: {data.project.ownerId ? <a className="text-primary hover:underline" href={spendDetailHref(`/users/${encodeURIComponent(data.project.ownerId)}`, currentPath)}>{data.project.ownerName || data.project.ownerId}</a> : 'Unknown'}</span>
              <span>Created: <ProjectDate value={data.project.createdAt} /></span>
              <span>Updated: <ProjectDate value={data.project.updatedAt} /></span>
              <DeploymentChip value={data.project.hasDeployment} availability={data.project.deploymentAvailability} />
              <StaleSpendingChip visible={data.project.staleButSpending} />
            </div>
          </div>

          <AdminDataQualityNote title="Project data quality">
            <p>Selected-period spend and current-month spend use separate ranges.</p>
            {data.metadata.qualifications?.map(qualification => <p key={qualification}>{qualification}</p>)}
          </AdminDataQualityNote>
          <ProjectDataFreshness metadata={data.metadata} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
               <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Selected Period Spend</h2>
               <div className="space-y-3">
                 <div className="flex justify-between border-b border-border pb-2">
                   <span className="text-muted-foreground text-sm">Total</span>
                    <span className="font-mono font-medium">{formatObservedCurrency(data.project.spendUsd, data.project.usageObserved)}</span>
                 </div>
                 <div className="flex justify-between border-b border-border pb-2">
                   <span className="text-muted-foreground text-sm">Agent</span>
                    <span className="font-mono text-muted-foreground">{formatObservedCurrency(data.project.agentSpendUsd, data.project.usageObserved)}</span>
                 </div>
                 <div className="flex justify-between border-b border-border pb-2">
                   <span className="text-muted-foreground text-sm">Other Services</span>
                    <span className="font-mono text-muted-foreground">{formatObservedCurrency(data.project.otherServicesUsd, data.project.usageObserved)}</span>
                 </div>
               </div>
            </div>
            
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
               <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">This month spend</h2>
               <div className="space-y-3">
                 <div className="flex justify-between border-b border-border pb-2">
                   <span className="text-muted-foreground text-sm">Current Month Total</span>
                   <span className="font-mono font-medium">{data.project.currentMonthSpendUsd != null ? formatObservedCurrency(data.project.currentMonthSpendUsd, true) : 'Unavailable'}</span>
                 </div>
                 <div className="flex justify-between border-b border-border pb-2">
                   <span className="text-muted-foreground text-sm">Usage Availability</span>
                   <span className="text-sm text-muted-foreground capitalize">{data.project.currentMonthUsageAvailability}</span>
                 </div>
               </div>
            </div>
          </div>
          
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Deployments</h2>
            </div>
             {data.project.deploymentAvailability === 'unavailable' ? (
               <div className="p-6 text-center text-sm text-muted-foreground">Deployment observation unavailable.</div>
             ) : data.project.deployments && data.project.deployments.length > 0 ? (
               <div className="overflow-x-auto">
                 <table className="w-full text-sm text-left border-collapse [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-3">
                   <thead className="bg-muted/50 font-semibold text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                     <tr>
                       <th>URL</th>
                       <th>Status</th>
                       <th>Privacy</th>
                       <th>Last Updated</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-border">
                     {data.project.deployments.map(d => (
                       <tr key={d.id} className="hover:bg-muted/30">
                         <td className="font-medium text-primary">
                            <DeploymentLink url={d.url} />
                         </td>
                         <td className="text-muted-foreground">{d.status || '—'}</td>
                         <td className="text-muted-foreground">{d.privacy || '—'}</td>
                          <td className="text-muted-foreground text-xs"><ProjectDate value={d.updatedAt} unknown="—" /></td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
            ) : (
               <div className="p-6 text-center text-sm text-muted-foreground">
                 No deployments recorded for this project.
               </div>
            )}
          </div>
          
        </div>
      )}
    </div>
  );
}
