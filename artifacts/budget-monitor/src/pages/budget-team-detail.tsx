import React, { useState } from 'react';
import { useAuthContext } from '@/components/auth-context';
import { useGetBudgetTeamReport, getGetBudgetTeamReportQueryKey, type GetBudgetTeamReportParams, type ReportingDetail, type ReportingTeamHierarchyWorkspace, type ReportingTeamHierarchyGroup, type ReportingDetailMember, type SpendStatusParameter } from '@workspace/api-client-react';
import { MetricCard, BudgetMeter } from '@/components/journey-primitives';
import { formatUsd } from '@/pages/home-components/format';
import { Button } from '@/components/ui/button';
import { ChevronRight, ChevronDown, ArrowLeft, Search, AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { AdminDataQualityNote } from '@/components/admin-data-quality';

export function BudgetTeamDetail({ poolId, rangeParams, viewScope, onBack }: { poolId: string, rangeParams: { rangeType: string, startDate?: string, endDate?: string }, viewScope: string, onBack: () => void }) {
  const { authorizationKey } = useAuthContext();
  const queryParams = { ...rangeParams, viewScope, includeHierarchy: true, includeBudgetTracking: true } as GetBudgetTeamReportParams;
  const { data: report, isLoading, isError, refetch } = useGetBudgetTeamReport(poolId, queryParams, {
    query: { enabled: !!poolId, queryKey: [...getGetBudgetTeamReportQueryKey(poolId, queryParams), authorizationKey] }
  });

  const headerControls = (
    <div className="flex items-center gap-3 mb-6">
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 -ml-2 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Budgeted teams
      </Button>
    </div>
  );

  if (isLoading && !report) {
    return (
      <div>
        {headerControls}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({length:4}).map((_,i) => <div key={i} className="h-28 animate-pulse rounded-md bg-muted" />)}
        </div>
      </div>
    );
  }

  if (isError && !report) {
    return (
      <div>
        {headerControls}
        <div className="p-4 border text-sm text-destructive bg-destructive/10 rounded">
          Failed to load budget team details.
          <Button variant="outline" size="sm" onClick={() => refetch()} className="ml-4">Retry</Button>
        </div>
      </div>
    );
  }

  if (!report) return null;

  const budget = report.budgetTracking;
  const selectedObserved = report.headline.usageObserved ?? report.headline.isComplete;
  const complete = report.headline.isComplete;

  return (
    <div className="space-y-6">
      {headerControls}

      {isError && (
        <div className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <span>Showing cached data. Refresh failed.</span>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </div>
      )}

      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{report.name || decodeURIComponent(poolId.split(':').pop() || poolId)}</h2>
        <p className="text-sm text-muted-foreground mt-1">Selected period · {report.period.label}</p>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {report.sourceGroups.map((group) => (
            <Badge key={`${group.workspaceId}:${group.groupId}`} variant="outline" className="font-normal">
              {group.workspaceName || group.workspaceId} · {group.role}
            </Badge>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {budget ? (
          <>
            <MetricCard label="Annual allocation" value={formatUsd(budget.allocationUsd)} detail={`Full period · ${budget.periodLabel || 'loading'}`} />
            <MetricCard label="Budget-period spend" value={formatUsd(budget.spendUsd)} detail={budget.spendUsd != null ? budget.periodLabel : 'Unavailable'} />
            <MetricCard label="Budget remaining" value={budget.remainingUsd == null ? 'Unavailable' : formatUsd(budget.remainingUsd)} detail={budget.percentUsed != null ? `${budget.percentUsed.toFixed(1)}% used` : 'Full-period accounting'} />
          </>
        ) : (
          <>
            <MetricCard label="Annual allocation" value="Unavailable" detail="Full-period tracking disabled" />
            <MetricCard label="Budget-period spend" value="Unavailable" detail="Full-period tracking disabled" />
            <MetricCard label="Budget remaining" value="Unavailable" detail="Full-period tracking disabled" />
          </>
        )}
        <MetricCard label="Selected spend" value={formatUsd(selectedObserved ? report.headline.spendUsd : null)} detail={`${!complete && selectedObserved ? 'Known subtotal · ' : ''}${report.period.label}`} />
      </div>

      <AdminDataQualityNote title="Budget team qualifications">
        <p>Canonical Agent usage is shown for the selected period.</p>
        {!complete && selectedObserved && <p>Selected-period values are a known subtotal with partial coverage.</p>}
        {report.metadata.qualifications.map((q, i) => <p key={i}>{q}</p>)}
      </AdminDataQualityNote>

      <HierarchyTable report={report} />
    </div>
  );
}

type MemberSort = 'name' | 'spend' | 'agent' | 'current';

function HierarchyTable({ report }: { report: ReportingDetail }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MemberSort>('name');
  const [ascending, setAscending] = useState(true);
  const normalizedSearch = search.trim().toLowerCase();

  const handleSort = (field: MemberSort) => {
    if (sort === field) setAscending(!ascending);
    else {
      setSort(field);
      setAscending(field === 'name');
    }
  };

  const sortButton = (field: MemberSort, label: string) => (
    <button type="button" onClick={() => handleSort(field)} className="font-medium hover:text-foreground text-left">
      {label}{sort === field ? (ascending ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <Card className="shadow-none border rounded-md">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b bg-muted/20 pb-4">
        <div>
          <CardTitle className="text-base">Team Hierarchy</CardTitle>
          <CardDescription>Nested breakdown of workspaces, groups, and members.</CardDescription>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search members" aria-label="Search members" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left border-collapse min-w-[1000px]">
          <thead className="bg-muted/50 text-muted-foreground border-b">
            <tr>
              <th className="px-4 py-2 font-medium">{sortButton('name', 'Name')}</th>
              <th className="px-4 py-2 font-medium text-right">{sortButton('spend', 'Selected Total')}</th>
              <th className="px-4 py-2 font-medium text-right">{sortButton('agent', 'Selected Agent')}</th>
              <th className="px-4 py-2 font-medium text-right">Selected Other</th>
              <th className="px-4 py-2 font-medium text-right">Current-cycle Limit</th>
              <th className="px-4 py-2 font-medium text-right">{sortButton('current', 'Current-cycle Agent')}</th>
              <th className="px-4 py-2 font-medium text-right">Current-cycle Remaining</th>
              <th className="px-4 py-2 font-medium text-right">Current-cycle Used</th>
            </tr>
          </thead>
          <tbody>
            {(report.hierarchyUnattributedSpendUsd != null && report.hierarchyUnattributedSpendUsd !== 0) && (
              <tr className="border-b bg-muted/10">
                <td className="px-4 py-3 font-medium italic">Team unattributed</td>
                <td className="px-4 py-3 text-right font-mono">{formatUsd(report.hierarchyUnattributedSpendUsd)}</td>
                <td colSpan={6}></td>
              </tr>
            )}
            {(report.hierarchy || []).map((ws) => (
               <WorkspaceRow key={ws.workspaceId} workspace={ws} search={normalizedSearch} sort={sort} ascending={ascending} />
            ))}
            {(!report.hierarchy || report.hierarchy.length === 0) && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">No hierarchy data available.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function WorkspaceRow({ workspace, search, sort, ascending }: { workspace: ReportingTeamHierarchyWorkspace, search: string, sort: MemberSort, ascending: boolean }) {
  const hasMatchingMembers = search ? workspace.groups.some(g => g.members.some(m => (m.name||m.username||m.email||m.userId||'').toLowerCase().includes(search))) : false;
  const [expanded, setExpanded] = useState(false);

  const isExpanded = search ? hasMatchingMembers : expanded;

  if (search && !hasMatchingMembers) return null;
  const observed = workspace.usageObserved ?? workspace.isComplete;

  return (
    <>
      <tr className="border-b hover:bg-muted/10 transition-colors">
        <td className="px-4 py-2 font-semibold">
          <button type="button" onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-foreground focus:outline-none" aria-expanded={isExpanded}>
            {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
            <span className="truncate">{workspace.workspaceName || workspace.workspaceId}</span>
            {!workspace.isComplete && observed && <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded ml-2 font-normal">Partial</span>}
          </button>
        </td>
        <td className="px-4 py-2 text-right font-mono font-medium">{observed ? formatUsd(workspace.spendUsd) : 'Unavailable'}</td>
        <td className="px-4 py-2 text-right font-mono">{observed ? formatUsd(workspace.agentSpendUsd) : 'Unavailable'}</td>
        <td className="px-4 py-2 text-right font-mono">{observed ? formatUsd(workspace.otherServicesUsd) : 'Unavailable'}</td>
        <td colSpan={4}></td>
      </tr>
      {isExpanded && workspace.groups.map(group => (
        <GroupRow key={group.groupId} group={group} search={search} sort={sort} ascending={ascending} />
      ))}
      {isExpanded && workspace.unattributedSpendUsd !== 0 && (
        <tr className="bg-muted/5 border-b">
          <td className="px-4 py-2 pl-12 italic text-muted-foreground text-xs border-l-[3px] border-transparent">Workspace unattributed</td>
          <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">{formatUsd(workspace.unattributedSpendUsd)}</td>
          <td colSpan={6}></td>
        </tr>
      )}
    </>
  );
}

function GroupRow({ group, search, sort, ascending }: { group: ReportingTeamHierarchyGroup, search: string, sort: MemberSort, ascending: boolean }) {
  const matchingMembers = search ? group.members.filter(m => (m.name||m.username||m.email||m.userId||'').toLowerCase().includes(search)) : group.members;
  const [expanded, setExpanded] = useState(false);

  const isExpanded = search ? matchingMembers.length > 0 : expanded;
  if (search && matchingMembers.length === 0) return null;

  const observed = group.usageObserved ?? group.isComplete;

  const sortedMembers = [...matchingMembers].sort((a, b) => {
      let left: string | number;
      let right: string | number;
      if (sort === 'name') {
        left = a.name || a.username || a.email || a.userId;
        right = b.name || b.username || b.email || b.userId;
      } else if (sort === 'agent') {
        left = a.agentSpendUsd; right = b.agentSpendUsd;
      } else if (sort === 'current') {
        left = a.currentCycleAgentSpendUsd ?? -1; right = b.currentCycleAgentSpendUsd ?? -1;
      } else {
        left = a.spendUsd; right = b.spendUsd;
      }
      const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      return ascending ? result : -result;
  });

  return (
    <>
      <tr className="border-b border-dashed hover:bg-muted/10 transition-colors">
        <td className="px-4 py-2 pl-8 border-l-[3px] border-primary/20">
          <button type="button" onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 font-medium text-foreground focus:outline-none" aria-expanded={isExpanded}>
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
            <span className="truncate">{group.name || group.groupId}</span>
            {!group.isComplete && observed && <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded ml-2 font-normal">Partial</span>}
          </button>
        </td>
        <td className="px-4 py-2 text-right font-mono text-sm">{observed ? formatUsd(group.spendUsd) : 'Unavailable'}</td>
        <td className="px-4 py-2 text-right font-mono text-sm">{observed ? formatUsd(group.agentSpendUsd) : 'Unavailable'}</td>
        <td className="px-4 py-2 text-right font-mono text-sm">{observed ? formatUsd(group.otherServicesUsd) : 'Unavailable'}</td>
        <td colSpan={4}></td>
      </tr>
      {isExpanded && sortedMembers.map(member => (
        <tr key={member.userId} className="hover:bg-muted/10 transition-colors bg-muted/5 border-b border-muted/50">
          <td className="px-4 py-2 pl-14 border-l-[3px] border-primary/20">
            <div className="text-sm font-medium">{member.name || member.username || member.userId}</div>
            <div className="text-xs text-muted-foreground truncate max-w-[200px]">{member.email || 'Email unavailable'}</div>
          </td>
          <td className="px-4 py-2 text-right font-mono text-sm">{observed ? formatUsd(member.spendUsd) : 'Unavailable'}</td>
          <td className="px-4 py-2 text-right font-mono text-sm">{observed ? formatUsd(member.agentSpendUsd) : 'Unavailable'}</td>
          <td className="px-4 py-2 text-right font-mono text-sm">{observed ? formatUsd(member.otherServicesUsd) : 'Unavailable'}</td>
          <td className="px-4 py-2 text-right font-mono text-sm text-muted-foreground">{member.limitState === 'no_limit' ? 'Not set' : formatUsd(member.limitUsd)}</td>
          <td className="px-4 py-2 text-right font-mono text-sm">{formatUsd(member.currentCycleAgentSpendUsd)}</td>
          <td className="px-4 py-2 text-right font-mono text-sm text-muted-foreground">{formatUsd(member.remainingUsd)}</td>
          <td className="px-4 py-2 text-right font-mono text-sm text-muted-foreground">
            {member.percentUsed != null ? `${member.percentUsed.toFixed(1)}%` : '—'}
          </td>
        </tr>
      ))}
      {isExpanded && !search && group.unattributedSpendUsd !== 0 && (
        <tr className="bg-muted/10 border-b border-muted/50">
          <td className="px-4 py-2 pl-14 italic text-muted-foreground text-xs border-l-[3px] border-primary/20">Group unattributed</td>
          <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">{formatUsd(group.unattributedSpendUsd)}</td>
          <td colSpan={6}></td>
        </tr>
      )}
    </>
  );
}
