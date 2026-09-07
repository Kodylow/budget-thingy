import React, { useState, useEffect } from "react";
import { useListSpendPeople, getListSpendPeopleQueryKey } from "@workspace/api-client-react";
import { useRange } from "@/components/range-context";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Search, ChevronLeft, ChevronRight, AlertTriangle, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatObservedCurrency, isUnknownSpendTotal } from "@/lib/spend-presentation";
import { AdminDataQualityNote } from "@/components/admin-data-quality";
import { DataTable } from "@/components/journey-primitives";
import { Link, useSearch } from "wouter";
import { spendDetailHref } from "@/lib/spend-exploration";

export function OrgInsightsPeopleTable() {
  const { rangeType, startDate, endDate } = useRange();
  const searchString = useSearch();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [search, setSearch] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => new URLSearchParams(searchString).get("workspaceId"));
  
  const queryParams: any = { rangeType, search: search || undefined, viewScope: "all_authorized", workspaceId, page, pageSize, sort: "spend_desc" };
  if (rangeType === "custom") {
    queryParams.startDate = startDate;
    queryParams.endDate = endDate;
  }

  const query = useListSpendPeople(queryParams, { query: { queryKey: getListSpendPeopleQueryKey(queryParams) } });
  
  const data = query.data;
  const totalPages = Math.max(1, Math.ceil((data?.filteredRows ?? 0) / pageSize));
  
  useEffect(() => {
    if (data && page > totalPages) {
      setPage(totalPages);
    }
  }, [data, page, totalPages]);

  const workspaces = data?.facets?.workspaces || [];
  const knownTotal = data ? !isUnknownSpendTotal(data.metadata) : false;
  
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border bg-card">
      <div className="flex flex-col justify-between gap-4 border-b p-4 sm:flex-row sm:items-center">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Users by period spend</h3>
        <div className="flex flex-col sm:flex-row gap-2">
          {workspaces.length > 0 && (
             <Select value={workspaceId || "all"} onValueChange={v => { setWorkspaceId(v === "all" ? null : v); setPage(1); }}>
                <SelectTrigger className="h-8 w-[180px] text-xs">
                   <SelectValue placeholder="All workspaces" />
                </SelectTrigger>
                <SelectContent>
                   <SelectItem value="all">All workspaces</SelectItem>
                   {workspaces.map(w => <SelectItem key={w.id} value={w.id}>{w.name} ({w.count})</SelectItem>)}
                </SelectContent>
             </Select>
          )}
          <div className="relative w-full sm:w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input 
              type="search" 
              placeholder="Search user..." 
              value={search} 
              onChange={e => { setSearch(e.target.value); setPage(1); }} 
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </div>
      
      <div className="relative min-h-[300px] flex-1 overflow-auto">
        {!data ? (
           query.isError ? (
             <div className="flex flex-col items-center justify-center h-full p-8 text-center text-muted-foreground">
               <AlertTriangle className="h-8 w-8 mb-3 text-destructive" />
               <p className="text-sm text-foreground font-medium mb-1">Failed to load users</p>
               <Button variant="outline" size="sm" onClick={() => void query.refetch()}><RefreshCw className="w-3 h-3 mr-2" /> Retry</Button>
             </div>
           ) : (
             <div className="p-4 space-y-3">
               {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
             </div>
           )
        ) : data.rows.length === 0 ? (
           <div className="flex items-center justify-center h-full p-8 text-sm text-muted-foreground">
             No matching users found.
           </div>
        ) : (
           <DataTable
             caption="Organization users and spend"
             columns={[
               { label: "Rank" },
               { label: "Person" },
               { label: "Workspace" },
               { label: "Period total", className: "text-right" },
               { label: "Current cycle agent", className: "text-right" },
               { label: "Agent limit", className: "text-right" },
               { label: "Cycle remaining", className: "text-right" },
               { label: "Cycle % used", className: "text-right" },
             ]}
             rows={data.rows.map((row, idx) => [
               <span className="font-mono text-xs text-muted-foreground">#{(page - 1) * pageSize + idx + 1}</span>,
                <Link href={spendDetailHref(`/users/${row.id.split(':').pop()}`, window.location.pathname + window.location.search)} className="font-medium hover:text-primary hover:underline">
                  {row.name || "Unknown User"}
                </Link>,
               <span className="text-muted-foreground">{row.workspaceName || row.workspaceId}</span>,
               <span className="font-mono">{formatObservedCurrency(row.spendUsd, knownTotal && row.usageObserved !== false)}</span>,
               <span className="font-mono text-muted-foreground">{row.currentCycleAgentSpendUsd != null ? formatObservedCurrency(row.currentCycleAgentSpendUsd, true) : "Unavailable"}</span>,
               <span className="font-mono text-muted-foreground">{row.limitState === "no_limit" ? "No limit" : row.allocationUsd != null ? formatObservedCurrency(row.allocationUsd, true) : "Unavailable"}</span>,
               <span className="font-mono">{row.currentCycleRemainingUsd != null ? formatObservedCurrency(row.currentCycleRemainingUsd, true) : "Unavailable"}</span>,
               <span className={`font-mono ${row.currentCyclePercentUsed != null ? row.currentCyclePercentUsed > 100 ? "text-[var(--budget-over)]" : row.currentCyclePercentUsed >= 90 ? "text-[var(--budget-near)]" : "text-[var(--budget-within)]" : ""}`}>
                 {row.currentCyclePercentUsed != null ? `${row.currentCyclePercentUsed.toFixed(1)}%` : "Unavailable"}
               </span>,
             ])}
           />
        )}
      </div>

      {data && query.isError && (
        <div className="border-t border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">User refresh failed; last available rows are shown.</strong>
          <Button variant="link" size="sm" className="ml-2 h-auto p-0 text-xs" onClick={() => void query.refetch()}>Retry</Button>
        </div>
      )}
      {data && (data.metadata.status !== 'complete' || data.metadata.stale || data.metadata.qualifications.length > 0) && <AdminDataQualityNote title="Organization user table data quality">
        <p>{data.metadata.status === 'partial' ? 'Partial user coverage.' : data.metadata.stale ? 'User data may be stale.' : 'About these rows.'}</p>
        {data.metadata.qualifications.map((qualification) => <p key={qualification}>{qualification}</p>)}
      </AdminDataQualityNote>}
      
      {data && data.filteredRows > 0 && (
        <div className="p-3 border-t border-border/50 flex items-center justify-between text-xs text-muted-foreground bg-muted/20">
          <div>
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, data.filteredRows)} of {data.filteredRows}
             {data.metadata.status === 'partial' && ' · Partial'}
             {data.metadata.stale && ' · Stale'}
          </div>
          <div className="flex gap-1">
            <Button aria-label="Previous page" variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <Button aria-label="Next page" variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
