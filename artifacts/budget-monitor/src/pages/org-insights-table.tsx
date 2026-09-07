import React, { useState, useEffect } from "react";
import { useListSpendPeople, getListSpendPeopleQueryKey } from "@workspace/api-client-react";
import { useRange } from "@/components/range-context";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Search, ChevronLeft, ChevronRight, AlertTriangle, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatObservedCurrency, isUnknownSpendTotal } from "@/lib/spend-presentation";
import { AdminDataQualityNote } from "@/components/admin-data-quality";

export function OrgInsightsPeopleTable() {
  const { rangeType, startDate, endDate } = useRange();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [search, setSearch] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  
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
    <div className="flex flex-col h-full bg-card border border-border shadow-sm rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Users by Period Spend</h2>
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
      
      <div className="flex-1 overflow-auto min-h-[300px] relative">
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
          <Table>
            <TableHeader className="bg-muted/50 sticky top-0 z-10 shadow-sm">
              <TableRow>
                <TableHead className="w-16 text-xs text-muted-foreground uppercase tracking-wider font-semibold">Rank</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">User</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Workspace</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground uppercase tracking-wider font-semibold">Period Total</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground uppercase tracking-wider font-semibold">Current Cycle Agent</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground uppercase tracking-wider font-semibold">Agent Limit</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground uppercase tracking-wider font-semibold">Cycle Remaining</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground uppercase tracking-wider font-semibold">Cycle % Used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row, idx) => (
                <TableRow key={row.id} className="hover:bg-muted/30">
                  <TableCell className="font-mono text-xs text-muted-foreground">#{(page - 1) * pageSize + idx + 1}</TableCell>
                  <TableCell className="font-medium text-sm text-foreground">{row.name || "Unknown User"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.workspaceName || row.workspaceId}</TableCell>
                  <TableCell className="text-right font-mono text-sm text-foreground">
                    {formatObservedCurrency(row.spendUsd, knownTotal && row.usageObserved !== false)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    {row.currentCycleAgentSpendUsd != null ? formatObservedCurrency(row.currentCycleAgentSpendUsd, true) : "Unavailable"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    {row.limitState === "no_limit" ? "No limit" : row.allocationUsd != null ? formatObservedCurrency(row.allocationUsd, true) : "Unavailable"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {row.currentCycleRemainingUsd != null ? formatObservedCurrency(row.currentCycleRemainingUsd, true) : "Unavailable"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {row.currentCyclePercentUsed != null ? (
                      <span className={row.currentCyclePercentUsed > 100 ? "text-[var(--budget-over)]" : row.currentCyclePercentUsed >= 90 ? "text-[var(--budget-near)]" : "text-[var(--budget-within)]"}>
                        {row.currentCyclePercentUsed.toFixed(1)}%
                      </span>
                    ) : "Unavailable"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
