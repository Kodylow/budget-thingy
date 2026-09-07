import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Link, useSearch } from 'wouter';
import { useAuthContext } from '@/components/auth-context';
import {
  activeLimitOperationQueryOptions,
  useLimitsState,
} from '@/lib/limits-state';
import {
  isValidAmount,
  isMemberSelectable,
  getSelectableGroupUserIds,
  getContextSelectionUpdate,
  parseLimitsUrlContext,
  resolveLimitsWorkspaceId,
} from '@/lib/limits-utils';
import {
  useGetSetLimitsWorkspace,
  usePrepareLimitOperation,
  useCommitLimitOperation,
  useGetLimitOperation,
  useRetryLimitOperationTargets,
  useListVisibleWorkspaces,
  getGetSetLimitsWorkspaceQueryKey,
  getGetLimitOperationQueryKey,
  getListVisibleWorkspacesQueryKey,
  SetLimitsMember,
  LimitOperation,
  LimitOperationTarget,
  SetLimitsGroup,
  SetLimitsWorkspace
} from '@workspace/api-client-react';
import {
  getGetWorkspaceLimitPoliciesQueryKey,
  useGetWorkspaceLimitPolicies,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Search, ShieldAlert, AlertTriangle, CheckCircle2, ChevronRight,
  XCircle, ArrowRight, RefreshCw, Users, User, Building2, UserX,
  SlidersHorizontal
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateBudgetCaches } from '@/lib/budget-cache';
import { GroupPolicyControl, WorkspacePolicyControl } from '@/components/policy-control';
import { BudgetMeter, DataTable, EmptyState, StatusBadge } from '@/components/journey-primitives';

export default function LimitsPage() {
  const searchParams = useSearch();
  const urlContext = useMemo(() => parseLimitsUrlContext(searchParams), [searchParams]);
  const { auth, isPreviewing } = useAuthContext();
  const {
    workspaceId, setWorkspaceId,
    activeOperations, addOperation, removeOperation,
    activeOperationId, setActiveOperationId,
    availableWorkspaces
  } = useLimitsState();
  const isReadOnly = isPreviewing || auth?.previewReadOnly === true;

  const [amountUsd, setAmountUsd] = useState<string>('');

  useEffect(() => {
    setAmountUsd('');
  }, [workspaceId]);

  useEffect(() => {
    const resolved = resolveLimitsWorkspaceId(
      urlContext.workspaceId,
      workspaceId,
      availableWorkspaces,
    );
    if (resolved !== workspaceId) setWorkspaceId(resolved);
  }, [availableWorkspaces, setWorkspaceId, urlContext.workspaceId, workspaceId]);

  if (availableWorkspaces.length === 0) {
    return (
      <div className="mx-auto max-w-[1280px] px-4 py-6 md:px-8 md:py-8">
        <EmptyState
          title="No authorized workspaces"
          description="You do not have permission to set user limits in any workspaces."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1280px] flex-col space-y-8 px-4 py-6 md:px-8 md:py-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Limits</h1>
          <p className="text-sm text-muted-foreground">Individual monthly Agent limits · reset each billing cycle · hard-block Agent usage when reached.</p>
        </div>

        {isReadOnly && (
          <Badge variant="outline" className="h-8 w-fit border-amber-200 bg-amber-50 px-3 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            Preview · Read-only
          </Badge>
        )}
      </div>

      {!workspaceId ? (
        <WorkspaceSelectionList
          availableWorkspaces={availableWorkspaces}
          onSelect={setWorkspaceId}
        />
      ) : (
        <WorkspaceLimitsView
          key={workspaceId}
          workspaceId={workspaceId}
          amountUsd={amountUsd}
          setAmountUsd={setAmountUsd}
          availableWorkspaces={availableWorkspaces}
          setWorkspaceId={setWorkspaceId}
          activeOperations={activeOperations}
          addOperation={addOperation}
          removeOperation={removeOperation}
          activeOperationId={activeOperationId}
          setActiveOperationId={setActiveOperationId}
          isReadOnly={isReadOnly}
          clearWorkspace={() => setWorkspaceId(null)}
          contextGroupIds={urlContext.workspaceId === workspaceId ? urlContext.groupIds : []}
          canManagePolicies={!isReadOnly && availableWorkspaces.includes(workspaceId)}
        />
      )}
    </div>
  );
}

function WorkspaceSelectionList({
  availableWorkspaces,
  onSelect,
}: {
  availableWorkspaces: string[];
  onSelect: (id: string) => void;
}) {
  const { data: visibleWorkspaces, isLoading, isError, refetch } = useListVisibleWorkspaces({
    query: { queryKey: getListVisibleWorkspacesQueryKey() }
  });

  if (isLoading) {
    return <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4"><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 border border-destructive/20 bg-destructive/5 p-8 text-center" role="alert">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="font-semibold">Workspaces couldn&apos;t be loaded</p>
        <p className="text-sm text-muted-foreground">Your authorized workspace list is temporarily unavailable.</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
    );
  }

  const list = visibleWorkspaces?.filter(w => availableWorkspaces.includes(w.workspaceId)) || [];

  return (
    <div className="sm:flex-1 flex flex-col gap-4 sm:min-h-0">
      <div className="flex items-center justify-between shrink-0">
        <h2 className="text-lg font-semibold text-foreground">Select a workspace</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 overflow-auto pb-6">
        {list.map(w => (
          <Card
            key={w.workspaceId}
            className="hover:bg-muted/30 transition-colors border-border/60 hover:border-primary/50 group"
            data-testid={`workspace-card-${w.workspaceId}`}
          >
            <button
              type="button"
              className="w-full text-left"
              onClick={() => onSelect(w.workspaceId)}
              data-testid={`button-select-workspace-${w.workspaceId}`}
            >
            <CardHeader className="p-5">
              <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-md text-primary shrink-0">
                  <Building2 className="h-5 w-5" />
                </div>
                 <CardTitle className="text-base group-hover:text-primary transition-colors">{w.workspaceName}</CardTitle>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground opacity-50 group-hover:opacity-100 transition-opacity group-hover:text-primary group-hover:translate-x-0.5 transform shrink-0" />
              </div>
            </CardHeader>
            </button>
          </Card>
        ))}
      </div>
    </div>
  );
}

function WorkspaceLimitsView({
  workspaceId, amountUsd, setAmountUsd, availableWorkspaces, setWorkspaceId, activeOperations, addOperation, removeOperation,
  activeOperationId, setActiveOperationId, isReadOnly, clearWorkspace, contextGroupIds,
  canManagePolicies
}: {
  workspaceId: string; amountUsd: string; setAmountUsd: (value: string) => void;
  availableWorkspaces: string[]; setWorkspaceId: (id: string | null) => void;
  activeOperations: string[]; addOperation: (id: string) => void; removeOperation: (id: string) => void;
  activeOperationId: string | null; setActiveOperationId: (id: string | null) => void;
  isReadOnly: boolean; clearWorkspace: () => void; contextGroupIds: string[];
  canManagePolicies: boolean;
}) {
  const { data: visibleWorkspaces } = useListVisibleWorkspaces({
    query: { queryKey: getListVisibleWorkspacesQueryKey() }
  });
  const { data: ws, isLoading, error } = useGetSetLimitsWorkspace(workspaceId, {
    query: {
      enabled: !!workspaceId,
      queryKey: getGetSetLimitsWorkspaceQueryKey(workspaceId)
    }
  });

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-[400px] w-full" /></div>;
  }

  if (error || !ws) {
    return (
      <div className="flex-1 flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button onClick={clearWorkspace} className="hover:text-foreground inline-flex items-center gap-1.5 transition-colors font-medium">
            <Building2 className="h-3.5 w-3.5" /> Workspaces
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center border rounded-xl bg-destructive/5 text-destructive border-destructive/20 shadow-sm">
          <div className="text-center">
            <AlertTriangle className="h-10 w-10 mx-auto mb-3 opacity-80" />
            <p className="font-semibold text-lg">Failed to load limits data</p>
            <Button variant="outline" className="mt-4" onClick={clearWorkspace}>Return to workspaces</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 shrink-0">
        <label htmlFor="limits-workspace" className="text-sm font-semibold text-foreground">Workspace</label>
        <Select value={workspaceId} onValueChange={setWorkspaceId}>
          <SelectTrigger id="limits-workspace" className="w-full sm:w-72 bg-background" data-testid="select-limits-workspace">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableWorkspaces.map(id => (
              <SelectItem key={id} value={id}>
                {visibleWorkspaces?.find(workspace => workspace.workspaceId === id)?.workspaceName || (id === workspaceId ? ws.workspaceName : id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(isReadOnly || !ws.canWrite || ws.unavailableReason) && (
        <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50/60 p-4 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Workspace edits disabled</h3>
            <p className="mt-0.5 text-xs opacity-75">{ws.unavailableReason || (isReadOnly ? 'You can review limit coverage. Changes require write access outside preview mode.' : 'You do not have write access to this workspace.')}</p>
          </div>
        </div>
      )}

      <div className="shrink-0 border-y py-3 flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-6 text-sm">
          <p className="font-semibold" data-testid="text-limit-cycle">
          Current billing cycle: {new Date(ws.billingPeriod.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric'})} &ndash; {new Date(ws.billingPeriod.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric'})}
        </p>
        {ws.limitObservation.status === 'available' ? (
          <p className="flex items-center gap-1.5 text-muted-foreground" data-testid="status-limit-observation">
            <CheckCircle2 className="h-4 w-4 text-emerald-700" />
            Usage observed {ws.limitObservation.observedAt ? new Date(ws.limitObservation.observedAt).toLocaleString() : 'during the current cycle'}.
          </p>
        ) : (
          <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400" data-testid="status-limit-observation">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            {ws.limitObservation.error || 'Current-cycle usage observation is unavailable.'}
          </p>
        )}
        <p className="text-muted-foreground lg:ml-auto">
          Each amount is an individual monthly Agent limit, not a shared group cap.
        </p>
      </div>

      {activeOperations.length > 0 && (
        <div className="shrink-0 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 text-blue-900 dark:text-blue-200 px-4 py-3 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center gap-2.5 font-medium text-sm">
            <RefreshCw className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            {activeOperations.length} saved operation(s) · review, progress or recovery
          </div>
          <Select value={activeOperationId ?? ''} onValueChange={setActiveOperationId}>
            <SelectTrigger className="w-full sm:w-64" aria-label="Reopen saved limit operation" data-testid="button-view-limit-progress">
              <SelectValue placeholder="Reopen saved operation" />
            </SelectTrigger>
            <SelectContent>
              {activeOperations.map((id, index) => <SelectItem key={id} value={id}>Operation {index + 1} · {id.slice(0, 8)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      <WorkspaceLimitsManager
        ws={ws}
        amountUsd={amountUsd}
        setAmountUsd={setAmountUsd}
        isReadOnly={!ws.canWrite || !!ws.unavailableReason || isReadOnly}
        canManagePolicies={canManagePolicies && ws.canWrite && !ws.unavailableReason}
        openReview={(opId) => { addOperation(opId); setActiveOperationId(opId); }}
        contextGroupIds={contextGroupIds}
      />

      <OperationManagerDialog
        isOpen={!!activeOperationId}
        operationId={activeOperationId}
        onClose={() => setActiveOperationId(null)}
        ws={ws}
        isReadOnly={!ws.canWrite || !!ws.unavailableReason || isReadOnly}
        onComplete={(op) => {
          const hasUnresolved = op.counts.failed > 0 || op.counts.verificationPending > 0;
          if (op.state === 'completed' && !hasUnresolved) {
            removeOperation(op.id);
          }
        }}
      />
    </div>
  );
}

function WorkspaceLimitsManager({
  ws, amountUsd, setAmountUsd, isReadOnly, canManagePolicies, openReview, contextGroupIds
}: {
  ws: SetLimitsWorkspace; amountUsd: string; setAmountUsd: (value: string) => void;
  isReadOnly: boolean; openReview: (id: string) => void;
  canManagePolicies: boolean; contextGroupIds: string[];
}) {
  const [viewMode, setViewMode] = useState<'groups'|'members'>('members');
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const contextKeyRef = useRef<string | null>(null);
  const [search, setSearch] = useState('');
  const [memberFilter, setMemberFilter] = useState<'eligible'|'all'|'explicit'|'inherited'|'no_limit'|'unavailable'>('eligible');
  const [groupFilter, setGroupFilter] = useState<'all'|'eligible'|'ineligible'>('all');
  const [page, setPage] = useState(1);
  const pageSize = 24;

  const { toast } = useToast();
  const prepareOp = usePrepareLimitOperation({ mutation: { retry: false } });
  const policiesQuery = useGetWorkspaceLimitPolicies(ws.workspaceId, {
    query: {
      enabled: canManagePolicies,
      queryKey: getGetWorkspaceLimitPoliciesQueryKey(ws.workspaceId),
    },
  });

  useEffect(() => {
    if (isReadOnly) {
      setSelectedUserIds((current) => current.size ? new Set() : current);
      return;
    }
    const update = getContextSelectionUpdate(
      contextKeyRef.current,
      contextGroupIds,
      ws.groups,
      ws.members,
    );
      if (!update) {
      if (contextKeyRef.current === null) contextKeyRef.current = '';
      return;
    }
    setSelectedUserIds(new Set(update.userIds));
    contextKeyRef.current = update.contextKey;
  }, [contextGroupIds, ws.groups, ws.members, isReadOnly]);

  useEffect(() => { setPage(1); }, [search, memberFilter, groupFilter, viewMode]);

  const filteredGroups = useMemo(() => {
    let groups: SetLimitsGroup[] = ws.groups;
    if (groupFilter !== 'all') {
      groups = groups.filter((group: SetLimitsGroup) => {
        const count = getSelectableGroupUserIds(group, ws.members).length;
        return groupFilter === 'eligible' ? count > 0 : count === 0;
      });
    }
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups.filter((g: SetLimitsGroup) =>
      g.name.toLowerCase().includes(q) ||
      g.familyName?.toLowerCase().includes(q) ||
      g.role?.toLowerCase().includes(q)
    );
  }, [ws.groups, ws.members, search, groupFilter]);

  const filteredMembers = useMemo(() => {
    let list: SetLimitsMember[] = ws.members;
    if (memberFilter === 'eligible') {
      list = list.filter(isMemberSelectable);
    } else if (memberFilter !== 'all') {
      list = list.filter(member => member.limitState === memberFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(m =>
        m.name?.toLowerCase().includes(q) ||
        m.username.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        m.groupIds.some(id => ws.groups.find((group: SetLimitsGroup) => group.groupId === id)?.name.toLowerCase().includes(q))
      );
    }
    return list;
  }, [ws.members, ws.groups, search, memberFilter]);

  const pagedMembers = useMemo(() => {
    return filteredMembers.slice((page - 1) * pageSize, page * pageSize);
  }, [filteredMembers, page, pageSize]);

  const memberPageCount = Math.max(1, Math.ceil(filteredMembers.length / pageSize));
  useEffect(() => {
    if (page > memberPageCount) setPage(memberPageCount);
  }, [memberPageCount, page]);

  const handleGroupToggle = (group: SetLimitsGroup) => {
    if (isReadOnly) return;
    const selectableIds = getSelectableGroupUserIds(group, ws.members);
    if (selectableIds.length === 0) return;

    const isAll = selectableIds.every(id => selectedUserIds.has(id));
    const next = new Set(selectedUserIds);

    if (isAll) {
      selectableIds.forEach(id => next.delete(id));
    } else {
      selectableIds.forEach(id => next.add(id));
    }
    setSelectedUserIds(next);
  };

  const toggleMember = (m: SetLimitsMember) => {
    if (isReadOnly || !isMemberSelectable(m)) return;
    const next = new Set(selectedUserIds);
    if (next.has(m.userId)) next.delete(m.userId);
    else next.add(m.userId);
    setSelectedUserIds(next);
  };

  const handlePageToggle = () => {
    if (isReadOnly) return;
    const pageSelectable = pagedMembers.filter(isMemberSelectable);
    if (pageSelectable.length === 0) return;
    const isAll = pageSelectable.every(m => selectedUserIds.has(m.userId));

    const next = new Set(selectedUserIds);
    if (isAll) {
      pageSelectable.forEach(m => next.delete(m.userId));
    } else {
      pageSelectable.forEach(m => next.add(m.userId));
    }
    setSelectedUserIds(next);
  };

  const handleSelectAllMatching = () => {
    if (isReadOnly) return;
    const matchingSelectable = filteredMembers.filter(isMemberSelectable);
    const next = new Set(selectedUserIds);
    matchingSelectable.forEach(m => next.add(m.userId));
    setSelectedUserIds(next);
  };

  const handlePrepare = () => {
    if (isReadOnly) return;
    if (!isValidAmount(amountUsd)) {
      toast({ title: 'Invalid amount', description: 'Enter a positive monthly USD amount with no more than two decimal places.', variant: 'destructive' });
      return;
    }
    if (selectedUserIds.size === 0) return;

    prepareOp.mutate({
      data: {
        workspaceId: ws.workspaceId,
        amountUsd: parseFloat(amountUsd),
        userIds: Array.from(selectedUserIds),
        groupIds: [],
        idempotencyKey: crypto.randomUUID()
      }
    }, {
      onSuccess: (data) => {
        openReview(data.id);
      },
      onError: (err: any) => {
        toast({ title: 'Failed to prepare', description: err.message, variant: 'destructive' });
      }
    });
  };

  const selectableCount = ws.members.filter(isMemberSelectable).length;
  const explicitCount = ws.members.filter((m: SetLimitsMember) => m.limitState === 'explicit').length;
  const inheritedCount = ws.members.filter((m: SetLimitsMember) => m.limitState === 'inherited').length;

  const pageSelectable = pagedMembers.filter(isMemberSelectable);
  const isPageAllSelected = pageSelectable.length > 0 && pageSelectable.every(m => selectedUserIds.has(m.userId));
  const isPageSomeSelected = !isPageAllSelected && pageSelectable.some(m => selectedUserIds.has(m.userId));

  const matchingSelectableCount = filteredMembers.filter(isMemberSelectable).length;
  const selectedMatchingCount = filteredMembers.filter(member => isMemberSelectable(member) && selectedUserIds.has(member.userId)).length;
  const visibleSelectableIds = useMemo(() => {
    if (viewMode === 'members') return new Set(pagedMembers.filter(isMemberSelectable).map(member => member.userId));
    return new Set(filteredGroups.flatMap(group => getSelectableGroupUserIds(group, ws.members)));
  }, [filteredGroups, pagedMembers, viewMode, ws.members]);
  const selectedVisibleCount = [...selectedUserIds].filter(id => visibleSelectableIds.has(id)).length;
  const selectedOutsideCount = selectedUserIds.size - selectedVisibleCount;
  const observationAvailable = ws.limitObservation.status === 'available';
  const groupRows = filteredGroups.map((group: SetLimitsGroup) => {
    const groupMembers = ws.members.filter((member: SetLimitsMember) => member.groupIds.includes(group.groupId));
    const selectableIds = getSelectableGroupUserIds(group, ws.members);
    const selectedCount = selectableIds.filter(id => selectedUserIds.has(id)).length;
    const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
    const stateCounts = groupMembers.reduce((counts: Record<string, number>, member: SetLimitsMember) => {
      counts[member.limitState] = (counts[member.limitState] || 0) + 1;
      return counts;
    }, {});

    return [
      <Checkbox
        checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
        onCheckedChange={() => handleGroupToggle(group)}
        disabled={selectableIds.length === 0 || isReadOnly}
        aria-label={`Select eligible members in ${group.name}`}
        data-testid={`checkbox-group-${group.groupId}`}
      />,
      <span className="font-medium" title={group.name}>{group.name}</span>,
      <span className="font-mono">{groupMembers.length}</span>,
      <span className="font-mono">{selectableIds.length}</span>,
      <span className="text-xs text-muted-foreground" data-testid={`text-group-states-${group.groupId}`}>
        {stateCounts.explicit || 0} explicit · {stateCounts.inherited || 0} inherited · {stateCounts.no_limit || 0} none · {stateCounts.unavailable || 0} unknown
      </span>,
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs text-primary"
          onClick={() => handleGroupToggle(group)}
          disabled={selectableIds.length === 0 || isReadOnly}
          data-testid={`button-select-group-${group.groupId}`}
        >
          {allSelected ? 'Remove eligible' : 'Select eligible'}
        </Button>
        {canManagePolicies && (
          <Link
            href={`/limits?workspaceId=${encodeURIComponent(ws.workspaceId)}&groupId=${encodeURIComponent(group.groupId)}`}
            className="text-xs font-medium text-primary hover:underline"
            data-testid={`link-manage-baseline-${group.groupId}`}
          >
            Baseline policy
          </Link>
        )}
      </div>,
    ];
  });

  return (
    <div className="space-y-5">
      {canManagePolicies && (
        <details
          key={contextGroupIds.join(',')}
          open={contextGroupIds.length > 0 ? true : undefined}
          className="group rounded-md border bg-card px-4 py-3"
        >
          <summary className="cursor-pointer list-none text-sm font-semibold">
            Advanced defaults and baseline policies
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            Defaults and policies provide ongoing limits while preserving hand-set overrides. They are separate from the selected one-time limits below.
          </p>
          {policiesQuery.isLoading && (
            <p className="mt-4 text-sm text-muted-foreground">Loading policy settings…</p>
          )}
          {policiesQuery.isError && (
            <p className="mt-4 text-sm text-destructive">
              Policy settings are unavailable. No defaults or baselines can be edited until they load successfully.
            </p>
          )}
          {policiesQuery.isSuccess && policiesQuery.data && (
          <div className="mt-4 border-t pt-4">
            <WorkspacePolicyControl
              workspaceId={ws.workspaceId}
              currentAmount={policiesQuery.data?.defaultAmountUsd ?? null}
            />
            {contextGroupIds.map((groupId) => {
              const group = ws.groups.find((item: SetLimitsGroup) => item.groupId === groupId);
              if (!group) return null;
              const policy = policiesQuery.data?.groups?.find((item) => item.groupId === groupId);
              return (
                <div key={groupId}>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{group.name}</p>
                  <GroupPolicyControl
                    workspaceId={ws.workspaceId}
                    groupId={groupId}
                    currentAmount={policy?.amountUsd ?? null}
                  />
                </div>
              );
            })}
          </div>
          )}
        </details>
      )}
      <Card className="overflow-hidden rounded-md shadow-none">
      <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as 'groups' | 'members')}>
        <CardHeader className="gap-4 border-b pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Review limits</CardTitle>
              <CardDescription className="mt-1">Select members or groups to prepare a one-time monthly limit update.</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono font-semibold text-foreground">{selectableCount}</span> eligible
              <span>·</span>
              <span className="font-mono font-semibold text-foreground">{explicitCount}</span> explicit
              <span>·</span>
              <span className="font-mono font-semibold text-foreground">{inheritedCount}</span> inherited
            </div>
          </div>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <TabsList className="self-start">
              <TabsTrigger value="members" className="gap-2 px-5" data-testid="tab-limits-members"><User className="h-4 w-4"/> Members</TabsTrigger>
              <TabsTrigger value="groups" className="gap-2 px-5" data-testid="tab-limits-groups"><Users className="h-4 w-4"/> Groups</TabsTrigger>
            </TabsList>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full lg:w-auto">
            <div className="relative w-full sm:w-64 shrink-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={`Search ${viewMode}...`}
                aria-label={`Search ${viewMode}`}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 h-10 bg-background"
                data-testid={`search-${viewMode}`}
              />
            </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-10 gap-2" data-testid="button-limits-filters">
                    <SlidersHorizontal className="h-4 w-4" />
                    Filters{(viewMode === 'members' ? memberFilter !== 'all' : groupFilter !== 'all') ? ' (1)' : ''}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64 space-y-3">
                  <p className="text-sm font-semibold">Eligibility and limit state</p>
              {viewMode === 'members' ? (
                <Select value={memberFilter} onValueChange={(value) => setMemberFilter(value as typeof memberFilter)}>
                  <SelectTrigger aria-label="Member eligibility and limit state" className="w-full h-10 bg-background shrink-0" data-testid="select-member-filter">
                    <SlidersHorizontal className="h-4 w-4 mr-2" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="eligible">Eligible members</SelectItem>
                    <SelectItem value="all">All members</SelectItem>
                    <SelectItem value="explicit">Explicit limit</SelectItem>
                    <SelectItem value="inherited">Inherited limit</SelectItem>
                    <SelectItem value="no_limit">No limit</SelectItem>
                    <SelectItem value="unavailable">Unknown state</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Select value={groupFilter} onValueChange={(value) => setGroupFilter(value as typeof groupFilter)}>
                  <SelectTrigger aria-label="Group eligibility" className="w-full h-10 bg-background shrink-0" data-testid="select-group-filter">
                    <SlidersHorizontal className="h-4 w-4 mr-2" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All groups</SelectItem>
                    <SelectItem value="eligible">Has eligible members</SelectItem>
                    <SelectItem value="ineligible">No eligible members</SelectItem>
                  </SelectContent>
                </Select>
              )}
                  <Button variant="ghost" size="sm" onClick={() => viewMode === 'members' ? setMemberFilter('all') : setGroupFilter('all')}>Clear filters</Button>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">

        {!isReadOnly && selectedUserIds.size > 0 && (
          <div className="border-b bg-primary/5">
            <SelectionActionBar
              selectedCount={selectedUserIds.size}
              selectedOutsideCount={selectedOutsideCount}
              amountUsd={amountUsd}
              onAmountChange={setAmountUsd}
              isReadOnly={isReadOnly}
              isPending={prepareOp.isPending}
              onClear={() => { if (!isReadOnly) setSelectedUserIds(new Set()); }}
              onPrepare={handlePrepare}
            />
          </div>
        )}

        <TabsContent value="groups" className="m-0">
          {filteredGroups.length === 0 ? (
            <div className="py-14 text-center text-sm text-muted-foreground">No groups match your search and filters.</div>
          ) : (
            <>
            <DataTable
              caption="Group monthly Agent limit policies"
              columns={[
                { label: 'Select', className: 'w-10' },
                { label: 'Group' },
                { label: 'Members' },
                { label: 'Eligible' },
                { label: 'Limit states' },
                { label: 'Policy' },
              ]}
              rows={groupRows}
              rowProps={(_row, index) => {
                const selectableIds = getSelectableGroupUserIds(filteredGroups[index], ws.members);
                return {
                  className: selectableIds.length > 0 && selectableIds.every(id => selectedUserIds.has(id)) ? 'bg-primary/5' : '',
                  'data-testid': `card-limit-group-${filteredGroups[index].groupId}`,
                } as React.HTMLAttributes<HTMLTableRowElement>;
              }}
            />
            {false && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <caption className="sr-only">Group monthly Agent limit policies</caption>
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="w-10 px-4 py-3 font-medium">Select</th>
                    <th className="px-4 py-3 font-medium">Group</th>
                    <th className="px-4 py-3 font-medium">Members</th>
                    <th className="px-4 py-3 font-medium">Eligible</th>
                    <th className="px-4 py-3 font-medium">Limit states</th>
                    <th className="px-4 py-3 font-medium">Policy</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
              {filteredGroups.map((group: SetLimitsGroup) => {
                const groupMembers = ws.members.filter((member: SetLimitsMember) => member.groupIds.includes(group.groupId));
                const selectableIds = getSelectableGroupUserIds(group, ws.members);
                const selectedCount = selectableIds.filter(id => selectedUserIds.has(id)).length;
                const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
                const stateCounts = groupMembers.reduce((counts: Record<string, number>, member: SetLimitsMember) => {
                  counts[member.limitState] = (counts[member.limitState] || 0) + 1;
                  return counts;
                }, {});
                return (
                  <tr key={group.groupId} className={allSelected ? 'bg-primary/5' : 'bg-card'} data-testid={`card-limit-group-${group.groupId}`}>
                    <td className="px-4 py-3">
                        <Checkbox
                          checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
                          onCheckedChange={() => handleGroupToggle(group)}
                          disabled={selectableIds.length === 0 || isReadOnly}
                          aria-label={`Select eligible members in ${group.name}`}
                          data-testid={`checkbox-group-${group.groupId}`}
                        />
                    </td>
                    <td className="px-4 py-3 font-medium" title={group.name}>{group.name}</td>
                    <td className="px-4 py-3 font-mono">{groupMembers.length}</td>
                    <td className="px-4 py-3 font-mono">{selectableIds.length}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground" data-testid={`text-group-states-${group.groupId}`}>
                      {stateCounts.explicit || 0} explicit · {stateCounts.inherited || 0} inherited · {stateCounts.no_limit || 0} none · {stateCounts.unavailable || 0} unknown
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs text-primary"
                          onClick={() => handleGroupToggle(group)}
                          disabled={selectableIds.length === 0 || isReadOnly}
                          data-testid={`button-select-group-${group.groupId}`}
                        >
                          {allSelected ? 'Remove eligible' : 'Select eligible'}
                        </Button>
                        {canManagePolicies && (
                          <Link
                            href={`/limits?workspaceId=${encodeURIComponent(ws.workspaceId)}&groupId=${encodeURIComponent(group.groupId)}`}
                            className="text-xs font-medium text-primary hover:underline"
                            data-testid={`link-manage-baseline-${group.groupId}`}
                          >
                            Baseline policy
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
                </tbody>
              </table>
            </div>
            )}
            </>
          )}
        </TabsContent>

        <TabsContent value="members" className="m-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <caption className="sr-only">Member monthly Agent limits</caption>
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-3 font-medium">
                    <Checkbox
                      checked={isPageAllSelected ? true : isPageSomeSelected ? 'indeterminate' : false}
                      onCheckedChange={handlePageToggle}
                      disabled={isReadOnly || pageSelectable.length === 0}
                      id="select-page-cards"
                      aria-label="Select eligible members on this page"
                      data-testid="checkbox-select-page"
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">Member</th>
                  <th className="px-4 py-3 font-medium">Role / group</th>
                  <th className="px-4 py-3 font-medium">Monthly limit</th>
                  <th className="min-w-[230px] px-4 py-3 font-medium">Cycle usage</th>
                  <th className="px-4 py-3 font-medium">State</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pagedMembers.length === 0 ? (
                  <tr><td colSpan={7} className="h-32 text-center text-muted-foreground">No members match your filters.</td></tr>
                ) : (
                  pagedMembers.map(m => {
                    const isSelected = selectedUserIds.has(m.userId);
                    const selectable = isMemberSelectable(m);
                    const status = m.effectiveLimitUsd != null && m.usageUsd != null
                      ? m.usageUsd > m.effectiveLimitUsd
                        ? 'Over budget'
                        : m.usageUsd >= m.effectiveLimitUsd * 0.8
                          ? 'Near limit'
                          : 'Within budget'
                      : null;

                    return (
                      <tr
                        key={m.userId}
                        data-testid={`card-limit-member-${m.userId}`}
                        className={`transition-colors ${!selectable ? 'bg-muted/20' : 'cursor-pointer bg-card hover:bg-muted/20'} ${isSelected ? 'bg-primary/5' : ''}`}
                        onClick={(e) => {
                          if (!selectable || isReadOnly) return;
                          if (e.target instanceof Element && e.target.closest('button, input, a, [role="checkbox"]')) return;
                          toggleMember(m);
                        }}
                      >
                        <td className="px-4 py-3">
                          <Checkbox
                            checked={isSelected}
                            disabled={!selectable || isReadOnly}
                            onCheckedChange={() => toggleMember(m)}
                            aria-label={`Select ${m.name || m.username}`}
                            data-testid={`checkbox-member-${m.userId}`}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium" title={m.name || m.username}>{m.name || m.username}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground" title={`@${m.username}`}>@{m.username}</div>
                          {!selectable && !m.isInternal && (
                            <div className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-destructive/80">
                              <UserX className="h-3 w-3" />{m.isDisabled ? 'Disabled' : 'Ineligible'}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div>{m.role}</div>
                          <div className="mt-1 flex max-w-[220px] flex-wrap gap-1">
                            {m.groupIds.slice(0, 2).map(id => {
                              const group = ws.groups.find((item: SetLimitsGroup) => item.groupId === id);
                              return group ? <span key={id} className="text-xs text-muted-foreground">{group.name}</span> : null;
                            })}
                            {m.groupIds.length > 2 && <span className="text-xs text-muted-foreground">+{m.groupIds.length - 2}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono" data-testid={`text-effective-limit-${m.userId}`}>
                                {m.limitState === 'no_limit' ? <span className="text-muted-foreground">No limit</span> :
                                 m.limitState === 'unavailable' || m.effectiveLimitUsd == null ? <span className="text-muted-foreground">Unknown</span> :
                                  `$${m.effectiveLimitUsd.toFixed(2)}`}
                        </td>
                        <td className="px-4 py-3">
                            <BudgetMeter
                              actualUsd={m.usageUsd}
                              budgetUsd={m.limitState === 'unavailable' ? null : m.effectiveLimitUsd}
                              periodStart={ws.billingPeriod.start}
                              periodEnd={ws.billingPeriod.end}
                              dataThrough={ws.limitObservation.observedAt}
                              stale={ws.limitObservation.status === 'failed'}
                              incomplete={ws.limitObservation.status === 'unavailable' || m.limitState === 'unavailable'}
                              label="Current-cycle Agent usage"
                            />
                            <div className="mt-1 font-mono text-xs text-muted-foreground" data-testid={`text-cycle-usage-${m.userId}`}>
                              {m.usageUsd != null ? (
                                <span>${m.usageUsd.toFixed(2)} used · {m.effectiveLimitUsd != null ? `$${(m.effectiveLimitUsd - m.usageUsd).toFixed(2)} remaining` : 'Remaining unknown'}</span>
                              ) : <span>Usage unknown</span>}
                            </div>
                        </td>
                        <td className="px-4 py-3"><LimitStateBadge state={m.limitState} /></td>
                        <td className="px-4 py-3">
                          {status ? <StatusBadge status={status} /> : <span className="text-xs text-muted-foreground">{observationAvailable ? 'Unknown' : 'Usage unavailable'}</span>}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Banner if all on page selected but not all matching */}
          {isPageAllSelected && matchingSelectableCount > pageSelectable.length && selectedMatchingCount < matchingSelectableCount && (
            <div className="bg-primary/10 text-primary text-sm px-4 py-2 flex items-center justify-between border-t border-primary/20 shrink-0">
              <span>All <strong>{pageSelectable.length}</strong> eligible members on this page are selected.</span>
              <Button variant="link" size="sm" className="h-auto p-0 text-primary font-semibold" onClick={handleSelectAllMatching} disabled={isReadOnly}>
                Select all {matchingSelectableCount} matching eligible members
              </Button>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20 shrink-0">
            <div className="text-xs font-medium text-muted-foreground">
              Showing {filteredMembers.length === 0 ? 0 : (page - 1) * pageSize + 1} &ndash; {Math.min(page * pageSize, filteredMembers.length)} of {filteredMembers.length}
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="h-8 bg-background">Previous</Button>
              <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={page * pageSize >= filteredMembers.length} className="h-8 bg-background">Next</Button>
            </div>
          </div>
        </TabsContent>
        </CardContent>
      </Tabs>
      </Card>
    </div>
  );
}


function SelectionActionBar({
  selectedCount,
  selectedOutsideCount,
  amountUsd,
  onAmountChange,
  isReadOnly,
  isPending,
  onClear,
  onPrepare
}: {
  selectedCount: number;
  selectedOutsideCount: number;
  amountUsd: string;
  onAmountChange: (value: string) => void;
  isReadOnly: boolean;
  isPending: boolean;
  onClear: () => void;
  onPrepare: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="bg-card border border-primary/30 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4" data-testid="bar-limit-selection">
      <div className="flex flex-col flex-1 sm:flex-none min-w-0">
        <span className="font-semibold text-foreground leading-tight">{selectedCount} members selected</span>
        <span className="mt-1 text-xs text-muted-foreground">One explicit limit per eligible member. Not shared funding or a group cap.</span>
        {selectedOutsideCount > 0 && (
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400 mt-1" data-testid="warning-selection-outside">
            {selectedOutsideCount} selected {selectedOutsideCount === 1 ? 'member is' : 'members are'} outside the visible results and will still be included.
          </span>
        )}
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full lg:w-auto">
        <div className="w-full sm:w-60">
          <label htmlFor="limit-amount" className="mb-1 block text-xs font-medium">Proposed monthly limit per member (USD)</label>
        <div className="relative" data-testid="amount-input-container">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
          <Input
            id="limit-amount"
            type="text"
            inputMode="decimal"
            placeholder="Monthly limit"
            className="pl-7 pr-12 h-10 bg-background tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            value={amountUsd}
            onChange={event => onAmountChange(event.target.value)}
            disabled={isReadOnly}
            aria-label="Monthly Agent limit per selected member"
            aria-describedby="limit-amount-help"
            aria-invalid={amountUsd !== '' && !isValidAmount(amountUsd)}
            data-testid="input-limit-amount"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">/ mo</span>
        </div>
          <p id="limit-amount-help" className={`mt-1 text-xs ${amountUsd !== '' && !isValidAmount(amountUsd) ? 'text-destructive' : 'text-muted-foreground'}`}>
            {amountUsd !== '' && !isValidAmount(amountUsd) ? 'Enter a positive USD amount with up to 2 decimal places.' : 'Review first. Nothing changes until you confirm.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClear} disabled={isReadOnly} className="flex-1 sm:flex-none" data-testid="button-clear-selection">
            Clear
          </Button>
          <Button
            className="flex-1 sm:flex-none"
            onClick={onPrepare}
            disabled={isReadOnly || isPending || !isValidAmount(amountUsd)}
            data-testid="button-review-limit-changes"
          >
            {isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
            Review changes
          </Button>
        </div>
      </div>
    </div>
  );
}

function LimitStateBadge({ state }: { state: string }) {
  if (state === 'explicit') return <Badge variant="default" className="bg-primary/10 text-primary hover:bg-primary/20 shadow-none border-none">Explicit</Badge>;
  if (state === 'inherited') return <Badge variant="secondary" className="bg-muted text-muted-foreground shadow-none border-none">Inherited</Badge>;
  if (state === 'no_limit') return <span className="text-xs text-muted-foreground font-medium">None</span>;
  return <span className="text-xs text-muted-foreground/60 font-medium italic">Unavailable</span>;
}

export function OperationManagerDialog({
  isOpen, operationId, onClose, ws, onComplete, isReadOnly
}: {
  isOpen: boolean; operationId: string | null; onClose: () => void; ws: SetLimitsWorkspace; onComplete?: (op: LimitOperation) => void; isReadOnly: boolean;
}) {
  const { data: op, isError, refetch, isFetching } = useGetLimitOperation(
    operationId ?? '',
    activeLimitOperationQueryOptions(operationId),
  );

  const commitOp = useCommitLimitOperation({ mutation: { retry: false } });
  const retryTargets = useRetryLimitOperationTargets({ mutation: { retry: false } });
  const retryRequests = useRef(new Map<string, { userIds: string[]; idempotencyKey: string }>());
  const submitting = useRef(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (op?.state === 'completed') {
      invalidateBudgetCaches(queryClient, ws.workspaceId);
    }
  }, [op?.id, op?.state, op?.completedAt, queryClient, ws.workspaceId]);

  useEffect(() => {
    if (!op) return;
    const request = retryRequests.current.get(op.id);
    // A recorded marker confirms that the server accepted this retry, even if
    // its response was lost. A later, deliberate retry can then use a new key.
    if (request && op.targets.some(target => target.history.some(attempt => attempt.outcome === `retry:${request.idempotencyKey}`))) {
      retryRequests.current.delete(op.id);
    }
  }, [op]);

  if (!isOpen) return null;
  if (!op || isError || op.workspaceId !== ws.workspaceId) return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isError ? 'Operation status unavailable' : 'Loading saved operation'}</DialogTitle>
          <DialogDescription>{isError ? 'No outcome is confirmed. Reopen or refresh this saved operation before taking further action; do not create a replacement.' : 'Retrieving the saved review and results.'}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {isError && <Button onClick={() => void refetch()} disabled={isFetching}>Refresh status</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  const writesDisabled = isReadOnly || !ws.canWrite || !!ws.unavailableReason;

  const handleCommit = () => {
    if (writesDisabled || submitting.current) return;
    submitting.current = true;
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
        toast({ title: 'Apply request not confirmed', description: err.message, variant: 'destructive' });
      },
      onSettled: () => { submitting.current = false; },
    });
  };

  const handleRetryUnresolved = () => {
    if (writesDisabled || submitting.current) return;
    const unresolvedIds = op.targets.filter((t: LimitOperationTarget) =>
      t.state === 'failed' || t.state === 'verification_pending'
    ).map((t: LimitOperationTarget) => t.userId);

    if (unresolvedIds.length === 0) return;
    const request = retryRequests.current.get(op.id) ?? { userIds: unresolvedIds, idempotencyKey: crypto.randomUUID() };
    retryRequests.current.set(op.id, request);
    submitting.current = true;
    retryTargets.mutate({
      operationId: op.id,
      data: {
        userIds: request.userIds,
        idempotencyKey: request.idempotencyKey
      }
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetLimitOperationQueryKey(data.id), data);
        retryRequests.current.delete(op.id);
      },
      onSettled: () => { submitting.current = false; },
    });
  };

  const isPrepared = op.state === 'prepared';
  const isRunning = op.state === 'queued' || op.state === 'running';
  const isComplete = op.state === 'completed';
  const hasUnresolved = op.counts.failed > 0 || op.counts.verificationPending > 0;
  const isNeedsVerification = isComplete && op.counts.verificationPending > 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[95dvh] flex flex-col p-0 gap-0 overflow-hidden bg-background border-border">
        <DialogHeader className="p-4 sm:p-6 border-b bg-muted/20 shrink-0 text-left">
          <div className="flex flex-col sm:flex-row items-start justify-between gap-4 pr-5">
            <div className="min-w-0">
              <DialogTitle className="text-2xl font-bold tracking-tight">
                {isPrepared && "Review limit changes"}
                {isRunning && "Applying limits..."}
                {isNeedsVerification ? "Outcome unknown — needs verification" : isComplete ? (hasUnresolved ? (op.counts.verified > 0 ? "Partial success" : "Limits failed") : "Limits verified") : null}
              </DialogTitle>
              <DialogDescription className="mt-2 break-words text-base">
                Individual Agent limits for <strong>{op.counts.total} members</strong> in <span className="font-semibold text-foreground">{ws.workspaceName}</span>.
              </DialogDescription>
            </div>

            <div className="flex items-center gap-4 shrink-0 bg-background border shadow-sm p-3 rounded-xl">
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mb-1">Proposed / member / cycle</span>
                <span className="text-xl font-mono font-bold text-primary tabular-nums">${op.amountUsd.toFixed(2)}</span>
              </div>

              {(isRunning || isComplete) && (
                <>
                  <div className="w-px h-8 bg-border"></div>
                  <div className="flex flex-col">
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 uppercase font-bold tracking-wider mb-1 flex items-center gap-1"><CheckCircle2 className="h-3 w-3"/> Verified</span>
                    <span className="text-xl font-mono font-bold tabular-nums">{op.counts.verified}</span>
                  </div>
                  {hasUnresolved && (
                    <>
                      <div className="w-px h-8 bg-border"></div>
                      <div className="flex flex-col">
                        <span className="text-[10px] text-destructive uppercase font-bold tracking-wider mb-1 flex items-center gap-1"><XCircle className="h-3 w-3"/> Unresolved</span>
                        <span className="text-xl font-mono font-bold tabular-nums text-destructive">{op.counts.failed + op.counts.verificationPending}</span>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Current cycle: {new Date(ws.billingPeriod.start).toLocaleDateString()} – {new Date(ws.billingPeriod.end).toLocaleDateString()}.
            {' '}Review prepared {new Date(op.preparedAt).toLocaleString()}. Operation {op.id.slice(0, 8)}.
          </p>
          <p className="mt-2 text-sm">
            Replaces each selected member’s explicit limit in this workspace. Shared group caps, opening funding, monthly additions and ongoing policies are unchanged.
          </p>
          {ws.limitObservation.status !== 'available' && <p className="mt-2 text-sm text-amber-700">Current-cycle usage is not current or available. Any displayed usage is last observed, not a verified current balance.</p>}
          {writesDisabled && <p role="status" className="mt-2 text-sm font-medium">Read-only — applying and retrying limits are disabled.</p>}
        </DialogHeader>

        <div className="flex-1 min-h-0 max-w-full overflow-auto overscroll-contain bg-background" tabIndex={0} aria-label="Limit operation members">
          {(commitOp.isError || retryTargets.isError) && (
            <div role="alert" className="m-4 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-semibold">Request outcome not confirmed</p>
              <p>{(commitOp.error || retryTargets.error)?.message}</p>
              <p>Refresh the saved status first. Recovery uses this operation, not a new set of writes. No automatic mutation retry is performed.</p>
              <Button variant="outline" className="mt-2" disabled={isFetching} onClick={async () => {
                const result = await refetch();
                if (result.isSuccess) { commitOp.reset(); retryTargets.reset(); }
              }}>Refresh saved status</Button>
            </div>
          )}
          <p role="status" aria-live="polite" className="px-4 py-3 text-sm text-muted-foreground">
            {isPrepared ? 'Review only — no limits have been changed.' : `${op.counts.verified} verified · ${op.counts.queued + op.counts.applying} pending · ${op.counts.failed} failed · ${op.counts.verificationPending} unknown`}
            {isNeedsVerification && ' Unknown outcomes may already have applied. Recovery checks upstream before any further write.'}
          </p>
          <table className="w-full min-w-[620px] text-sm text-left">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm z-10 text-xs uppercase text-muted-foreground border-b shadow-sm">
              <tr>
                <th className="px-6 py-3 font-semibold">Member</th>
                <th className="px-6 py-3 font-semibold text-right w-40">Observed explicit limit at review</th>
                <th className="px-2 py-3 w-8"></th>
                <th className="px-6 py-3 font-semibold text-right w-32">New Limit</th>
                <th className="px-6 py-3 font-semibold w-40">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {op.targets.map((t: LimitOperationTarget) => {
                const member = ws.members.find((m: SetLimitsMember) => m.userId === t.userId);
                const usageUsd = member?.usageUsd;
                const isBelowSpend = usageUsd != null && t.newAmountUsd <= usageUsd;

                return (
                  <tr key={t.userId} className="h-16 hover:bg-muted/10 transition-colors group">
                    <td className="px-6">
                      <div className="font-semibold text-foreground">{t.memberName || t.userId}</div>
                      {t.memberEmail && <div className="text-xs text-muted-foreground">{t.memberEmail}</div>}
                      {isBelowSpend && isPrepared && (
                        <div className="text-[10px] text-destructive flex items-center gap-1 mt-1 font-bold uppercase tracking-wider bg-destructive/10 inline-flex px-1.5 py-0.5 rounded-sm">
                          <AlertTriangle className="h-3 w-3" />
                          At or below observed spend (${usageUsd.toFixed(2)}) — may block Agent
                        </div>
                      )}
                    </td>
                    <td className="px-6 text-right font-mono tabular-nums text-muted-foreground">
                      {t.oldAmountUsd != null ? `$${t.oldAmountUsd.toFixed(2)}` : 'No explicit limit observed'}
                      {isPrepared && member && <div className="mt-1 text-xs font-sans">
                        Current effective: {member.limitState === 'unavailable' ? 'Unknown' : member.limitState === 'no_limit' ? 'No limit' : member.effectiveLimitUsd != null ? `$${member.effectiveLimitUsd.toFixed(2)} (${member.limitState})` : 'Unknown'}
                      </div>}
                    </td>
                    <td className="px-2 text-center">
                      <ArrowRight className="h-4 w-4 inline-block text-muted-foreground/40 group-hover:text-primary/60 transition-colors" />
                    </td>
                    <td className="px-6 text-right font-mono tabular-nums font-bold text-primary">
                      ${t.newAmountUsd.toFixed(2)}
                    </td>
                    <td className="px-6">
                      {t.state === 'queued' && <span className="text-xs font-semibold text-muted-foreground">{isPrepared ? 'Not applied' : 'Queued'}</span>}
                      {t.state === 'applying' && <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1.5"><RefreshCw className="h-3 w-3 animate-spin"/> Applying</span>}
                      {t.state === 'verified' && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5"/> Verified</span>}
                      {t.state === 'verification_pending' && <span className="text-xs font-semibold text-amber-600 dark:text-amber-500">Unknown outcome</span>}
                      {t.state === 'failed' && (
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-bold text-destructive flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5"/> Failed</span>
                          <span className="text-[9px] text-destructive/80 leading-tight line-clamp-2" title={t.errorMessage || ''}>{t.errorMessage || 'Unknown error'}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter className="p-4 border-t bg-muted/20 shrink-0 flex gap-3 items-start sm:justify-between">
          <div className="min-w-0 text-xs text-muted-foreground">
            {isPrepared && "Confirmation queues real platform writes. A limit at or below usage may block Agent immediately."}
            {isRunning && "You can close this window; the operation will continue in the background."}
            {isComplete && hasUnresolved && "Only unresolved targets enter recovery. Verified targets are not resubmitted."}
            {isComplete && !hasUnresolved && "All targets verified successfully."}
          </div>

          <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap shrink-0">
            {isPrepared && (
              <>
                <Button variant="ghost" onClick={onClose} className="font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/50">Close review</Button>
                {!writesDisabled && (
                <Button
                  onClick={handleCommit}
                  disabled={commitOp.isPending || commitOp.isError}
                  className="w-full bg-primary px-4 font-bold text-primary-foreground shadow-md hover:bg-primary/90 sm:w-auto sm:px-8"
                >
                  {commitOp.isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Confirm and apply limits
                </Button>
                )}
              </>
            )}

            {isRunning && (
              <Button variant="outline" onClick={onClose} className="font-semibold bg-background hover:bg-muted/50">
                Close — continues in background
              </Button>
            )}

            {isComplete && (
              <>
                {hasUnresolved && !writesDisabled && (
                  <Button
                    onClick={handleRetryUnresolved}
                    disabled={retryTargets.isPending || retryTargets.isError}
                    variant="outline"
                    className="border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50 font-bold"
                  >
                    {retryTargets.isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                    Recover unresolved targets
                  </Button>
                )}
                <Button onClick={() => { onClose(); onComplete?.(op); }} className="font-bold px-8 shadow-md">
                  Close
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
