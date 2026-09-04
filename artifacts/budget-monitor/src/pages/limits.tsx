import React, { useMemo, useState, useEffect } from 'react';
import { useAuthContext } from '@/components/auth-context';
import {
  activeLimitOperationQueryOptions,
  useLimitsState,
} from '@/lib/limits-state';
import { 
  useGetSetLimitsWorkspace, 
  usePrepareLimitOperation, 
  useCommitLimitOperation, 
  useGetLimitOperation, 
  useRetryLimitOperationTargets,
  getGetSetLimitsWorkspaceQueryKey,
  getGetLimitOperationQueryKey,
  SetLimitsMember,
  LimitOperation,
  LimitOperationTarget,
  SetLimitsGroup
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Search, ShieldAlert, AlertTriangle, CheckCircle2, ChevronRight, XCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { VirtualizedTableRows } from '@/components/virtualized-table-rows';
import { useQueryClient } from '@tanstack/react-query';

export default function LimitsPage() {
  const { auth, isPreviewing } = useAuthContext();
  const { workspaceId, setWorkspaceId, activeOperationId, setActiveOperationId, availableWorkspaces } = useLimitsState();
  const isReadOnly = isPreviewing || auth?.previewReadOnly === true;

  if (availableWorkspaces.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground max-w-md mx-auto">
        <ShieldAlert className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
        <h2 className="text-lg font-semibold text-foreground mb-2">No Authorized Workspaces</h2>
        <p>You do not have permission to set user limits in any workspaces.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[100vw] flex flex-col h-[calc(100vh-3.5rem)] md:h-[100vh]">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Set Member Limits</h1>
          <p className="text-muted-foreground mt-1">Configure explicit Replit Agent limits for members.</p>
        </div>
        
        <div className="flex items-center gap-3">
          {isReadOnly && (
            <Badge variant="outline" className="border-amber-500 text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-900/30">
              Preview (Read-only)
            </Badge>
          )}
          <Select 
            value={workspaceId || undefined} 
            onValueChange={setWorkspaceId}
          >
            <SelectTrigger className="w-[240px]" data-testid="select-workspace">
              <SelectValue placeholder="Select workspace" />
            </SelectTrigger>
            <SelectContent>
              {availableWorkspaces.map(ws => (
                <SelectItem key={ws} value={ws} data-testid={`workspace-option-${ws}`}>
                  Workspace: {ws}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {workspaceId ? (
        <WorkspaceLimitsView 
          workspaceId={workspaceId} 
          activeOperationId={activeOperationId} 
          setActiveOperationId={setActiveOperationId}
          isReadOnly={isReadOnly}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center border rounded-md border-dashed">
          <div className="text-center text-muted-foreground">
            <p>Select a workspace to manage limits.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceLimitsView({ 
  workspaceId, 
  activeOperationId, 
  setActiveOperationId,
  isReadOnly 
}: { 
  workspaceId: string; 
  activeOperationId: string | null; 
  setActiveOperationId: (id: string | null) => void;
  isReadOnly: boolean;
}) {
  const { data: ws, isLoading, error } = useGetSetLimitsWorkspace(workspaceId, {
    query: {
      enabled: !!workspaceId,
      queryKey: getGetSetLimitsWorkspaceQueryKey(workspaceId)
    }
  });

  const { data: activeOp } = useGetLimitOperation(
    activeOperationId ?? '',
    activeLimitOperationQueryOptions(activeOperationId),
  );

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-[400px] w-full" /></div>;
  }

  if (error || !ws) {
    return (
      <div className="flex-1 flex items-center justify-center border rounded-md bg-destructive/5 text-destructive">
        <div className="text-center">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-80" />
          <p className="font-semibold">Failed to load workspace limits data</p>
        </div>
      </div>
    );
  }

  if (!ws.canWrite || ws.unavailableReason) {
    return (
      <div className="flex-1 flex items-center justify-center border rounded-md bg-muted/30">
        <div className="text-center max-w-md p-6">
          <ShieldAlert className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
          <h3 className="font-semibold text-lg mb-2">Workspace Unavailable</h3>
          <p className="text-muted-foreground text-sm">{ws.unavailableReason || 'You do not have write access to this workspace.'}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <LimitObservationWarning observation={ws.limitObservation} />
      <WorkspaceLimitsManager 
        ws={ws} 
        activeOp={activeOp}
        setActiveOperationId={setActiveOperationId}
        isReadOnly={isReadOnly}
      />
    </>
  );
}

function LimitObservationWarning({ observation }: { observation: any }) {
  if (observation.status === 'available') return null;
  return (
    <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-4 text-amber-900 dark:text-amber-200 text-sm shrink-0">
      <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-500" />
      <div>
        <p className="font-semibold mb-1">Limit observations are currently {observation.status}.</p>
        <p className="opacity-90">
          {observation.error || 'Recent limit changes may not be reflected in the current effective limits shown.'}
        </p>
      </div>
    </div>
  );
}

function WorkspaceLimitsManager({ 
  ws, 
  activeOp, 
  setActiveOperationId,
  isReadOnly 
}: { 
  ws: any; 
  activeOp: LimitOperation | undefined; 
  setActiveOperationId: (id: string | null) => void;
  isReadOnly: boolean;
}) {
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [amountUsd, setAmountUsd] = useState<string>('');
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  
  const { toast } = useToast();
  const prepareOp = usePrepareLimitOperation();
  const queryClient = useQueryClient();

  const handlePrepare = () => {
    if (isReadOnly) return;
    const amount = parseFloat(amountUsd);
    if (isNaN(amount) || amount < 0) {
      toast({ title: 'Invalid amount', description: 'Please enter a valid positive number.', variant: 'destructive' });
      return;
    }
    if (selectedUserIds.size === 0) {
      toast({ title: 'No members selected', description: 'Please select at least one member.', variant: 'destructive' });
      return;
    }

    const idempotencyKey = crypto.randomUUID();
    prepareOp.mutate({
      data: {
        workspaceId: ws.workspaceId,
        amountUsd: amount,
        userIds: Array.from(selectedUserIds),
        groupIds: [], // We resolve to exact user IDs for precision
        idempotencyKey
      }
    }, {
      onSuccess: (data) => {
        setActiveOperationId(data.id);
        queryClient.setQueryData(getGetLimitOperationQueryKey(data.id), data);
      },
      onError: (err: any) => {
        toast({ title: 'Failed to prepare', description: err.message || 'An error occurred', variant: 'destructive' });
      }
    });
  };

  const filteredMembers = useMemo(() => {
    let members: SetLimitsMember[] = ws.members;
    
    if (groupFilter !== 'all') {
      const group = ws.groups.find((g: SetLimitsGroup) => g.groupId === groupFilter);
      if (group) {
        const eligibleIds = new Set(group.eligibleUserIds);
        members = members.filter(m => eligibleIds.has(m.userId));
      }
    }
    
    if (search.trim()) {
      const query = search.toLowerCase();
      members = members.filter(m => 
        m.name?.toLowerCase().includes(query) || 
        m.username.toLowerCase().includes(query) || 
        m.email?.toLowerCase().includes(query)
      );
    }
    
    return members;
  }, [ws, search, groupFilter]);

  const toggleAll = () => {
    const allFiltered = new Set(filteredMembers.map(m => m.userId));
    const allSelected = filteredMembers.every(m => selectedUserIds.has(m.userId));
    const next = new Set(selectedUserIds);
    
    if (allSelected) {
      filteredMembers.forEach(m => next.delete(m.userId));
    } else {
      filteredMembers.forEach(m => next.add(m.userId));
    }
    setSelectedUserIds(next);
  };

  const toggleUser = (id: string) => {
    const next = new Set(selectedUserIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedUserIds(next);
  };

  if (activeOp && (activeOp.state === 'prepared' || activeOp.state === 'queued' || activeOp.state === 'running' || activeOp.state === 'completed')) {
    return (
      <OperationManager 
        ws={ws}
        op={activeOp} 
        onClose={() => setActiveOperationId(null)}
        isReadOnly={isReadOnly}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 border rounded-md bg-card overflow-hidden">
      <div className="p-4 border-b bg-muted/10 space-y-4 shrink-0">
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end justify-between">
          <div className="flex flex-wrap items-center gap-3 flex-1">
            <div className="relative w-full sm:w-64 shrink-0">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                type="search" 
                placeholder="Search members..." 
                className="pl-9 h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-search-members"
              />
            </div>
            
            {ws.groups.length > 0 && (
              <Select value={groupFilter} onValueChange={setGroupFilter}>
                <SelectTrigger className="w-full sm:w-[200px] h-9" data-testid="select-group-filter">
                  <SelectValue placeholder="Filter by group" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="group-filter-all">All members</SelectItem>
                  {ws.groups.map((g: SetLimitsGroup) => (
                    <SelectItem key={g.groupId} value={g.groupId} data-testid={`group-filter-${g.groupId}`}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          
          <div className="flex items-center gap-3 w-full sm:w-auto shrink-0 bg-background border p-1.5 rounded-lg shadow-sm">
            <div className="relative flex items-center">
              <span className="absolute left-3 text-muted-foreground text-sm">$</span>
              <Input
                type="number"
                min="0"
                step="1"
                placeholder="Amount (USD)"
                className="pl-7 h-9 w-[130px] border-none shadow-none focus-visible:ring-0"
                value={amountUsd}
                onChange={e => setAmountUsd(e.target.value)}
                disabled={isReadOnly}
                data-testid="input-limit-amount"
              />
            </div>
            <div className="h-6 w-px bg-border mx-1"></div>
            <Button 
              size="sm" 
              className="h-9 gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-4"
              disabled={selectedUserIds.size === 0 || !amountUsd || isReadOnly || prepareOp.isPending}
              onClick={handlePrepare}
              data-testid="button-prepare-limit"
            >
              {prepareOp.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Set Limit"}
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 bg-primary-foreground/20 text-primary-foreground border-none">
                {selectedUserIds.size}
              </Badge>
            </Button>
          </div>
        </div>
        
        {selectedUserIds.size > 0 && (
          <div className="flex items-center justify-between bg-primary/5 text-primary text-sm px-3 py-2 rounded-md border border-primary/20">
            <span className="font-medium">{selectedUserIds.size} member{selectedUserIds.size === 1 ? '' : 's'} selected across the workspace.</span>
            <Button variant="ghost" size="sm" className="h-7 text-primary hover:bg-primary/10 hover:text-primary" onClick={() => setSelectedUserIds(new Set())}>
              Clear selection
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm text-left relative" aria-rowcount={filteredMembers.length + 1}>
          <thead className="sticky top-0 bg-background z-10 text-xs uppercase text-muted-foreground border-b shadow-sm">
            <tr>
              <th className="px-4 py-3 w-12">
                <Checkbox 
                  checked={filteredMembers.length > 0 && filteredMembers.every(m => selectedUserIds.has(m.userId))}
                  onCheckedChange={toggleAll}
                  aria-label="Select all filtered members"
                />
              </th>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium">State</th>
              <th className="px-4 py-3 font-medium text-right">Cycle Spend</th>
              <th className="px-4 py-3 font-medium text-right">Current Limit</th>
            </tr>
          </thead>
          <VirtualizedTableRows
            className="divide-y divide-border"
            columnCount={5}
            estimatedRowHeight={52}
            logicalRowIndexOffset={0}
          >
            {filteredMembers.length === 0 ? (
              <tr className="h-32">
                <td colSpan={5} className="text-center text-muted-foreground">
                  No members match your filters.
                </td>
              </tr>
            ) : (
              filteredMembers.map((member) => {
                const isSelected = selectedUserIds.has(member.userId);
                return (
                  <tr key={member.userId} 
                    className={`hover:bg-muted/30 transition-colors h-14 ${isSelected ? 'bg-primary/5' : ''} ${member.isDisabled ? 'opacity-50 grayscale' : ''}`}
                    onClick={(e) => {
                      if (!(e.target instanceof HTMLInputElement)) {
                        toggleUser(member.userId);
                      }
                    }}
                  >
                    <td className="px-4">
                      <Checkbox 
                        checked={isSelected}
                        onCheckedChange={() => toggleUser(member.userId)}
                        disabled={member.isDisabled}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-4">
                      <div className="font-medium text-foreground">{member.name || member.username}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        <span>@{member.username}</span>
                        {member.isInternal && <Badge variant="outline" className="text-[9px] h-4 px-1">Internal</Badge>}
                        {!member.eligible && <Badge variant="outline" className="text-[9px] h-4 px-1 text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-900 dark:bg-amber-950">Ineligible</Badge>}
                      </div>
                    </td>
                    <td className="px-4 text-xs text-muted-foreground">
                      {member.limitState === 'no_limit' ? 'No limit' : 
                       member.limitState === 'inherited' ? 'Inherited' :
                       member.limitState === 'unavailable' ? 'Unavailable' :
                       'Explicit'}
                    </td>
                    <td className="px-4 text-right font-mono tabular-nums">
                      {member.usageUsd != null ? `$${member.usageUsd.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 text-right font-mono tabular-nums font-medium text-foreground">
                      {member.effectiveLimitUsd != null ? `$${member.effectiveLimitUsd.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </VirtualizedTableRows>
        </table>
      </div>
    </div>
  );
}

function OperationManager({ 
  ws, op, onClose, isReadOnly 
}: { 
  ws: any; op: LimitOperation; onClose: () => void; isReadOnly: boolean;
}) {
  const commitOp = useCommitLimitOperation();
  const retryTargets = useRetryLimitOperationTargets();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleCommit = () => {
    commitOp.mutate({
      operationId: op.id,
      data: {
        reviewFingerprint: op.reviewFingerprint,
        amountUsd: op.amountUsd,
        userIds: op.targets.map((t: LimitOperationTarget) => t.userId)
      }
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetLimitOperationQueryKey(data.id), data);
      },
      onError: (err: any) => {
        toast({ title: 'Commit failed', description: err.message, variant: 'destructive' });
      }
    });
  };

  const handleRetryFailed = () => {
    const failedIds = op.targets.filter((t: LimitOperationTarget) => t.state === 'failed').map((t: LimitOperationTarget) => t.userId);
    if (failedIds.length === 0) return;
    
    retryTargets.mutate({
      operationId: op.id,
      data: {
        userIds: failedIds,
        idempotencyKey: crypto.randomUUID()
      }
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetLimitOperationQueryKey(data.id), data);
      }
    });
  };

  const isComplete = op.state === 'completed';
  const hasFailed = op.counts.failed > 0;
  const isRunning = op.state === 'queued' || op.state === 'running';

  return (
    <div className="flex-1 flex flex-col min-h-0 border rounded-md bg-card shadow-sm overflow-hidden">
      <div className="p-5 border-b bg-muted/20 shrink-0">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold flex items-center gap-2">
              {op.state === 'prepared' && "Review limit changes"}
              {isRunning && "Applying limits..."}
              {isComplete && "Limit operation complete"}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Workspace: <span className="font-medium text-foreground">{ws.workspaceName}</span>
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {isComplete ? 'Close' : 'Cancel'}
          </Button>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          <div className="bg-background border rounded-md p-3">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">New Limit</div>
            <div className="text-xl font-mono tabular-nums font-semibold text-primary">${op.amountUsd.toFixed(2)}</div>
          </div>
          <div className="bg-background border rounded-md p-3">
            <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Total Targets</div>
            <div className="text-xl font-mono tabular-nums font-semibold">{op.counts.total}</div>
          </div>
          {isRunning || isComplete ? (
            <>
              <div className="bg-background border rounded-md p-3 flex flex-col justify-between">
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold flex items-center gap-1.5 text-emerald-600 dark:text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Verified
                </div>
                <div className="text-xl font-mono tabular-nums font-semibold">{op.counts.verified}</div>
              </div>
              <div className="bg-background border rounded-md p-3 flex flex-col justify-between">
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold flex items-center gap-1.5 text-destructive">
                  <XCircle className="h-3.5 w-3.5" /> Failed
                </div>
                <div className="text-xl font-mono tabular-nums font-semibold">{op.counts.failed}</div>
              </div>
            </>
          ) : null}
        </div>
        
        {op.state === 'prepared' && (
          <div className="mt-6 flex justify-end">
            <Button 
              onClick={handleCommit} 
              disabled={isReadOnly || commitOp.isPending}
              className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-8 h-10"
            >
              {commitOp.isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
              Confirm and apply limits
            </Button>
          </div>
        )}
        
        {isComplete && hasFailed && (
          <div className="mt-6 flex justify-end">
            <Button 
              onClick={handleRetryFailed} 
              disabled={isReadOnly || retryTargets.isPending}
              variant="outline"
              className="text-amber-600 border-amber-200 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-900 dark:hover:bg-amber-950"
            >
              {retryTargets.isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
              Retry {op.counts.failed} failed targets
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-background">
        <table className="w-full text-sm text-left relative">
          <thead className="sticky top-0 bg-muted/40 z-10 text-xs uppercase text-muted-foreground border-b shadow-sm">
            <tr>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium text-right">Old Limit</th>
              <th className="px-4 py-3 w-8"></th>
              <th className="px-4 py-3 font-medium text-right">New Limit</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {op.targets.map((t: LimitOperationTarget) => {
              const currentSpend = ws.members.find((m: SetLimitsMember) => m.userId === t.userId)?.usageUsd || 0;
              const isBelowSpend = t.newAmountUsd < currentSpend;
              
              return (
                <tr key={t.userId} className="h-16 hover:bg-muted/10 transition-colors">
                  <td className="px-4">
                    <div className="font-medium text-foreground">{t.memberName || t.userId}</div>
                    {t.memberEmail && <div className="text-xs text-muted-foreground">{t.memberEmail}</div>}
                    {isBelowSpend && op.state === 'prepared' && (
                      <div className="text-[10px] text-destructive flex items-center gap-1 mt-1 font-semibold">
                        <AlertTriangle className="h-3 w-3" />
                        Limit is below current spend (${currentSpend.toFixed(2)})
                      </div>
                    )}
                  </td>
                  <td className="px-4 text-right font-mono tabular-nums text-muted-foreground">
                    {t.oldAmountUsd != null ? `$${t.oldAmountUsd.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-1 text-center text-muted-foreground">
                    <ArrowRight className="h-4 w-4 inline-block opacity-50" />
                  </td>
                  <td className="px-4 text-right font-mono tabular-nums font-semibold text-primary">
                    ${t.newAmountUsd.toFixed(2)}
                  </td>
                  <td className="px-4 text-xs font-medium">
                    {t.state === 'queued' && <Badge variant="outline" className="text-muted-foreground bg-muted/50 border-dashed">Queued</Badge>}
                    {t.state === 'applying' && <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-900 dark:bg-blue-950/50"><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Applying</Badge>}
                    {t.state === 'verified' && <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900 dark:bg-emerald-950/50"><CheckCircle2 className="h-3 w-3 mr-1" /> Verified</Badge>}
                    {t.state === 'verification_pending' && <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-900 dark:bg-amber-950/50">Pending Verification</Badge>}
                    {t.state === 'failed' && (
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="destructive" className="bg-destructive/10 text-destructive border-none shadow-none"><XCircle className="h-3 w-3 mr-1" /> Failed</Badge>
                        <span className="text-[10px] text-destructive truncate max-w-[200px]" title={t.errorMessage || ''}>{t.errorMessage || 'Unknown error'}</span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
