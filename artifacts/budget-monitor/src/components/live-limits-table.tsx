import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getGetFundingGroupsQueryKey,
  getGetLimitsQueryKey,
  getListVisibleWorkspacesQueryKey,
  type LimitChangeInput,
  type LimitChangeOperation,
  type LimitRow,
  type SetLimitsGroup,
  type SetLimitsMember,
  type SetLimitsWorkspace,
  useGetFundingGroups,
  useGetLimits,
  useGetSetLimitsWorkspace,
  useListVisibleWorkspaces,
  usePrepareClearAllLimits,
  usePrepareLimitChanges,
} from '@workspace/api-client-react';
import {
  AlertTriangle, BriefcaseBusiness, ChevronDown, ChevronRight, RotateCcw, Search, Trash2, User, Users,
} from 'lucide-react';
import { useSearch } from 'wouter';
import { useAuthContext } from '@/components/auth-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { BudgetMeter } from '@/components/journey-primitives';
import { getSelectableGroupUserIds, isMemberSelectable, parseLimitsUrlContext } from '@/lib/limits-utils';
import { LimitChangeReview } from './limit-change-review';
import {
  buildLimitsTeamHierarchy, dedupeLimitDrafts, describeLimitValue, personTargetKey, positiveUsdAmount,
  selectableTeamPersonKeys, type LimitsPersonRef, type LimitsTeamNode, type LiveLimitDraft,
} from './limits-table-model';

const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
const OPERATIONS_KEY = 'budget-monitor-live-limit-operations';

function storedOperations(storageKey: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeOperations(storageKey: string, ids: string[]) {
  try { localStorage.setItem(storageKey, JSON.stringify(ids)); } catch { /* persistence is best effort */ }
}

function configuredRow(rows: LimitRow[], workspaceId: string, type: LiveLimitDraft['type'], targetId: string) {
  return rows.find(row => row.workspaceId === workspaceId && row.type === type && row.targetId === targetId);
}

export function LiveLimitsTable() {
  const { auth, capabilities, isPreviewing, realIsAccountAdmin, authorizationKey, user } = useAuthContext();
  const operationStorageKey = `${OPERATIONS_KEY}:${user?.id ?? authorizationKey}`;
  const url = parseLimitsUrlContext(useSearch());
  const previewReadOnly = isPreviewing || auth?.previewReadOnly === true;
  const accountScope = capabilities.canViewAccountUsage === true;
  const limits = useGetLimits({ query: { queryKey: getGetLimitsQueryKey(), refetchOnMount: 'always' } });
  const workspaces = useListVisibleWorkspaces(accountScope ? { scope: 'operator' } : undefined, {
    query: { queryKey: getListVisibleWorkspacesQueryKey(accountScope ? { scope: 'operator' } : undefined) },
  });
  const funding = useGetFundingGroups({
    query: { enabled: accountScope, queryKey: getGetFundingGroupsQueryKey(), refetchOnMount: 'always' },
  });
  const prepare = usePrepareLimitChanges({ mutation: { retry: false } });
  const prepareClear = usePrepareClearAllLimits({ mutation: { retry: false } });
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<LiveLimitDraft[]>([]);
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<LiveLimitDraft | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [operationIds, setOperationIds] = useState<string[]>(() => storedOperations(operationStorageKey));
  const [operationId, setOperationId] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<LimitChangeOperation | null>(null);
  const [clearWarningOpen, setClearWarningOpen] = useState(false);
  const [rosters, setRosters] = useState<Record<string, SetLimitsWorkspace | null>>({});

  useEffect(() => {
    setDrafts([]);
    setSelectedPeople(new Set());
    setOperationId(null);
    setOperationIds(storedOperations(operationStorageKey));
  }, [authorizationKey, operationStorageKey]);

  const visibleWorkspaceIds = useMemo(() => {
    const ids = new Set<string>();
    workspaces.data?.forEach(workspace => ids.add(workspace.workspaceId));
    limits.data?.limits.forEach(row => ids.add(row.workspaceId));
    return [...ids].filter(id => !url.workspaceId || id === url.workspaceId);
  }, [limits.data?.limits, url.workspaceId, workspaces.data]);
  const captureRoster = useCallback((workspaceId: string, roster: SetLimitsWorkspace | null) => {
    setRosters(current => current[workspaceId] === roster ? current : { ...current, [workspaceId]: roster });
  }, []);
  const loadedWorkspaces = useMemo(() => visibleWorkspaceIds
    .map(workspaceId => rosters[workspaceId])
    .filter((workspace): workspace is SetLimitsWorkspace => Boolean(workspace))
    .map(workspace => ({
      ...workspace,
      canWrite: workspace.canWrite && !workspace.unavailableReason && workspace.limitObservation.status === 'available',
    })), [rosters, visibleWorkspaceIds]);
  const fundingByGroup = useMemo(() => new Map(
    (funding.data?.groups ?? []).map(group => [`${group.workspaceId}:${group.groupId}`, group.teamName]),
  ), [funding.data?.groups]);
  const teamHierarchy = useMemo(() => buildLimitsTeamHierarchy(
    loadedWorkspaces,
    funding.data?.groups ?? [],
  ), [funding.data?.groups, loadedWorkspaces]);
  const canClear = Boolean(realIsAccountAdmin && !previewReadOnly && limits.data?.canClearAll);
  const tableUnavailable = limits.isError || !limits.data || workspaces.isError || (accountScope && funding.isError);
  const stage = (draft: LiveLimitDraft) => {
    if (previewReadOnly) return;
    setDrafts(current => dedupeLimitDrafts([...current, draft]));
  };
  const rememberOperation = (operation: LimitChangeOperation) => {
    setPrepared(operation);
    setOperationId(operation.id);
    setOperationIds(current => {
      const next = current.includes(operation.id) ? current : [...current, operation.id];
      writeOperations(operationStorageKey, next);
      return next;
    });
  };
  const prepareDrafts = () => {
    if (previewReadOnly || drafts.length === 0) return;
    prepare.mutate({
      data: { idempotencyKey: crypto.randomUUID(), targets: drafts as LimitChangeInput[] },
    }, { onSuccess: operation => { setDrafts([]); rememberOperation(operation); } });
  };
  const prepareBulk = (amountUsd: number | null) => {
    const targets = [...selectedPeople].map(key => {
      const [workspaceId, , targetId] = key.split('\0');
      return { workspaceId, type: 'workspace_user_limit' as const, targetId, amountUsd };
    });
    setDrafts(current => dedupeLimitDrafts([...current, ...targets]));
    setSelectedPeople(new Set());
    setBulkOpen(false);
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-5 px-4 py-6 md:px-8 md:py-8" data-testid="live-limits-table">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Limits</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage monthly Agent limits by workspace, group, and person. Funding remains unchanged.</p>
        </div>
        {previewReadOnly && <Badge variant="outline" className="w-fit border-amber-300">Preview · Read-only</Badge>}
      </div>
      <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm">
        Limits apply per person for the current billing cycle. Funding allocations and period dates are context only; they do not set an upstream limit.
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search workspaces, groups, or people…" className="pl-9" data-testid="input-search-limits" />
        </div>
        <div className="flex flex-wrap gap-2">
          {operationIds.length > 0 && (
            <Button variant="outline" onClick={() => setOperationId(operationIds.at(-1) ?? null)} data-testid="button-reopen-limit-operation">
              Reopen saved operation
            </Button>
          )}
          {selectedPeople.size > 0 && !previewReadOnly && (
            <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="button-bulk-set-limits">
              Set limit for {selectedPeople.size} selected
            </Button>
          )}
          <Button disabled={drafts.length === 0 || previewReadOnly || prepare.isPending} onClick={prepareDrafts} data-testid="button-review-staged-limits">
            Review {drafts.length || ''} change{drafts.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
      {visibleWorkspaceIds.map(workspaceId => (
        <RosterLoader key={workspaceId} workspaceId={workspaceId} onResult={captureRoster} />
      ))}

      {(limits.isLoading || workspaces.isLoading || (accountScope && funding.isLoading)) ? (
        <div className="space-y-3"><Skeleton className="h-14" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>
      ) : tableUnavailable ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-6" role="alert" data-testid="status-limits-load-error">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-5 w-5" />Limits are unavailable</div>
          <p className="mt-1 text-sm text-muted-foreground">No empty state is inferred and all editing remains disabled until the complete live inventory, authorized workspaces, and funding mappings load.</p>
          <Button className="mt-3" variant="outline" onClick={() => {
            void limits.refetch(); void workspaces.refetch(); if (accountScope) void funding.refetch();
          }}>Retry</Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="border-b bg-muted/80 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="w-12 px-3 py-3">Select</th><th className="px-4 py-3">Budget entity</th><th className="px-4 py-3">Scope context</th><th className="px-4 py-3 text-right">Monthly limit</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Effective limit / usage</th><th className="px-4 py-3 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y">
                <tr className="bg-muted/50"><td colSpan={7} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workspace default context</td></tr>
                {visibleWorkspaceIds.map(workspaceId => {
                  const roster = rosters[workspaceId];
                  const workspaceName = roster?.workspaceName ?? workspaces.data?.find(item => item.workspaceId === workspaceId)?.workspaceName ?? workspaceId;
                  const row = configuredRow(limits.data.limits, workspaceId, 'workspace_default_user_limit', workspaceId);
                  return <WorkspaceDefaultRow key={workspaceId} workspaceId={workspaceId} workspaceName={workspaceName} billingPeriod={roster?.billingPeriod} row={row} unavailable={roster === null || roster?.limitObservation.status !== 'available'} readOnly={previewReadOnly || roster?.canWrite !== true} onEdit={setEditing} onStage={stage} />;
                })}
                {visibleWorkspaceIds.some(workspaceId => !(workspaceId in rosters)) && <tr><td colSpan={7} className="p-4"><Skeleton className="h-10" /></td></tr>}
                {visibleWorkspaceIds.filter(workspaceId => rosters[workspaceId] === null).map(workspaceId => <tr key={`error:${workspaceId}`}><td colSpan={7} className="bg-amber-50 p-4 text-sm text-amber-900" role="alert">Roster and membership for workspace {workspaceId} are unavailable. No empty group or person result is inferred, and its controls are disabled.</td></tr>)}
                <tr className="bg-muted/50"><td colSpan={7} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Budget allocation teams</td></tr>
                {teamHierarchy.map(team => (
                  <TeamLimitRows key={team.key} team={team} rows={limits.data.limits} search={search} contextGroupIds={url.groupIds} selectedPeople={selectedPeople} onSelectedPeople={setSelectedPeople} onEdit={setEditing} onStage={stage} readOnly={previewReadOnly} />
                ))}
                {visibleWorkspaceIds.length === 0 && <tr><td colSpan={7} className="p-10 text-center text-muted-foreground">No authorized workspaces are available.</td></tr>}
                {visibleWorkspaceIds.length > 0 && teamHierarchy.length === 0 && visibleWorkspaceIds.every(workspaceId => workspaceId in rosters) && !visibleWorkspaceIds.some(workspaceId => rosters[workspaceId] === null) && <tr><td colSpan={7} className="p-10 text-center text-muted-foreground">No groups or people are present in the complete authorized rosters.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {realIsAccountAdmin && (
        <div className="mt-4 flex flex-col gap-3 border-t border-red-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Clear Limits</p>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">Removing every workspace default, group limit, and individual override—and disabling the reviewed automatic baseline policies that could restore them—can leave Agent spend uncapped. Account spending controls, team funding, and allocations are excluded.</p>
          </div>
          <Button variant="destructive" disabled={!canClear || tableUnavailable || limits.isLoading || prepareClear.isPending} onClick={() => setClearWarningOpen(true)} data-testid="button-clear-all-limits">
            <Trash2 className="mr-2 h-4 w-4" />Clear Limits
          </Button>
        </div>
      )}

      <AmountEditor draft={editing} onClose={() => setEditing(null)} onSave={draft => { stage(draft); setEditing(null); }} />
      <BulkEditor open={bulkOpen} count={selectedPeople.size} onClose={() => setBulkOpen(false)} onSave={prepareBulk} />
      <Dialog open={clearWarningOpen} onOpenChange={setClearWarningOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Prepare a complete Clear Limits review?</DialogTitle><DialogDescription>This does not write immediately. The server will freshly discover and freeze the exact complete inventory for review.</DialogDescription></DialogHeader>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">Cleared targets may allow uncapped Agent spend. The reviewed automatic workspace/group baseline policies are disabled so those caps do not return after refresh. Funding and account spending controls are not changed.</div>
          <DialogFooter><Button variant="outline" onClick={() => setClearWarningOpen(false)}>Cancel</Button><Button variant="destructive" disabled={!canClear || prepareClear.isPending} onClick={() => prepareClear.mutate({ data: { idempotencyKey: crypto.randomUUID() } }, { onSuccess: operation => { setClearWarningOpen(false); rememberOperation(operation); } })} data-testid="button-prepare-clear-all-limits">Prepare complete inventory</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <LimitChangeReview operationId={operationId} preparedOperation={prepared} readOnly={previewReadOnly} onOperation={rememberOperation} onClose={() => setOperationId(null)} />
    </div>
  );
}

function RosterLoader({ workspaceId, onResult }: {
  workspaceId: string;
  onResult: (workspaceId: string, roster: SetLimitsWorkspace | null) => void;
}) {
  const roster = useGetSetLimitsWorkspace(workspaceId);
  useEffect(() => {
    if (roster.data) onResult(workspaceId, roster.data);
    else if (roster.isError) onResult(workspaceId, null);
  }, [onResult, roster.data, roster.isError, workspaceId]);
  return null;
}

function WorkspaceDefaultRow({ workspaceId, workspaceName, billingPeriod, row, unavailable, readOnly, onEdit, onStage }: {
  workspaceId: string; workspaceName: string; billingPeriod?: { start: string; end: string }; row?: LimitRow; unavailable: boolean; readOnly: boolean;
  onEdit: (draft: LiveLimitDraft) => void; onStage: (draft: LiveLimitDraft) => void;
}) {
  return (
    <tr className="bg-muted/20" data-testid={`row-limit-workspace-${workspaceId}`}>
      <td className="px-3 py-3" />
      <td className="px-4 py-3"><div className="inline-flex items-center gap-2 font-semibold"><BriefcaseBusiness className="h-4 w-4" />{workspaceName}</div><div className="font-mono text-[10px] text-muted-foreground">{workspaceId}</div></td>
      <td className="px-4 py-3 text-xs text-muted-foreground">Workspace default · applies per person{billingPeriod ? <div>Billing cycle {new Date(billingPeriod.start).toLocaleDateString()} – {new Date(billingPeriod.end).toLocaleDateString()}</div> : null}</td>
      <td className="px-4 py-3 text-right font-mono">{unavailable ? 'Unavailable' : row ? currency.format(row.amountUsd) : '—'}</td>
      <td className="px-4 py-3"><LimitBadge state={unavailable ? 'unavailable' : row ? 'explicit' : 'none'} /></td>
      <td className="px-4 py-3 text-xs text-muted-foreground">Separate from allocation-team funding</td>
      <td className="px-4 py-3 text-right"><RowActions row={row} identity={{ workspaceId, type: 'workspace_default_user_limit', targetId: workspaceId, amountUsd: row?.amountUsd ?? null }} readOnly={readOnly || unavailable || row?.canWrite === false} onEdit={onEdit} onStage={onStage} /></td>
    </tr>
  );
}

function TeamLimitRows({ team, rows, search, contextGroupIds, selectedPeople, onSelectedPeople, onEdit, onStage, readOnly }: {
  team: LimitsTeamNode<SetLimitsMember, SetLimitsGroup>; rows: LimitRow[]; search: string; contextGroupIds: string[];
  selectedPeople: Set<string>; onSelectedPeople: (next: Set<string>) => void;
  onEdit: (draft: LiveLimitDraft) => void; onStage: (draft: LiveLimitDraft) => void; readOnly: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(contextGroupIds));
  const selectableKeys = selectableTeamPersonKeys(team);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every(key => selectedPeople.has(key));
  const someSelected = !allSelected && selectableKeys.some(key => selectedPeople.has(key));
  const query = search.trim().toLowerCase();
  const teamMatches = !query || team.name.toLowerCase().includes(query);
  const groups = team.groups.filter(node => {
    if (contextGroupIds.length > 0 && !contextGroupIds.includes(node.group.groupId)) return false;
    if (teamMatches) return true;
    return `${node.group.name} ${node.workspaceName} ${node.workspaceId}`.toLowerCase().includes(query)
      || node.members.some(({ member }) => `${member.name} ${member.username} ${member.email}`.toLowerCase().includes(query));
  });
  const ungroupedPeople = team.ungroupedPeople.filter(({ member, workspaceName, workspaceId }) =>
    teamMatches || `${member.name} ${member.username} ${member.email} ${workspaceName} ${workspaceId}`.toLowerCase().includes(query));
  if (groups.length === 0 && ungroupedPeople.length === 0) return null;
  const toggleTeam = () => {
    if (readOnly) return;
    const next = new Set(selectedPeople);
    selectableKeys.forEach(key => allSelected ? next.delete(key) : next.add(key));
    onSelectedPeople(next);
  };
  return (
    <>
      <tr className="bg-primary/[0.04]" data-testid={`row-limit-team-${team.key}`}>
        <td className="px-3 py-3"><Checkbox checked={allSelected ? true : someSelected ? 'indeterminate' : false} disabled={readOnly || selectableKeys.length === 0} onCheckedChange={toggleTeam} aria-label={`Select all eligible writable people in ${team.name}`} data-testid={`checkbox-limit-team-${team.key}`} /></td>
        <td className="px-4 py-3"><button onClick={() => setOpen(value => !value)} className="inline-flex items-center gap-2 font-semibold">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}<BriefcaseBusiness className="h-4 w-4" />{team.name}</button></td>
        <td className="px-4 py-3 text-xs text-muted-foreground">{team.groups.length} mapped group{team.groups.length === 1 ? '' : 's'} · {selectableKeys.length} eligible writable people</td>
        <td className="px-4 py-3 text-right text-muted-foreground">—</td>
        <td className="px-4 py-3"><Badge variant="outline">Funding context</Badge></td>
        <td className="px-4 py-3 text-xs text-muted-foreground">Read-only allocation team · never a limit pool</td>
        <td className="px-4 py-3 text-right text-xs text-muted-foreground">No funding controls</td>
      </tr>
      {open && groups.map(node => {
        const groupRow = configuredRow(rows, node.workspaceId, 'workspace_group_limit', node.group.groupId);
        const selectedKeys = node.members.filter(person => person.canWrite && isMemberSelectable(person.member)).map(person => personTargetKey(node.workspaceId, person.member.userId));
        const groupSelected = selectedKeys.length > 0 && selectedKeys.every(key => selectedPeople.has(key));
        const groupOpenKey = `${node.workspaceId}:${node.group.groupId}`;
        const groupOpen = openGroups.has(groupOpenKey) || contextGroupIds.includes(node.group.groupId) || Boolean(query);
        return <GroupRows key={groupOpenKey} workspaceId={node.workspaceId} workspaceName={node.workspaceName} group={node.group} groupRow={groupRow} members={node.members.map(person => person.member)} team={team.name} open={groupOpen} selected={groupSelected} selectedPeople={selectedPeople} readOnly={readOnly || !node.canWrite} onToggleOpen={() => { const next = new Set(openGroups); next.has(groupOpenKey) ? next.delete(groupOpenKey) : next.add(groupOpenKey); setOpenGroups(next); }} onToggle={() => {
          if (readOnly) return;
          const next = new Set(selectedPeople);
          selectedKeys.forEach(key => groupSelected ? next.delete(key) : next.add(key));
          onSelectedPeople(next);
        }} onSelectedPeople={onSelectedPeople} onEdit={onEdit} onStage={onStage} billingPeriod={node.billingPeriod} />;
      })}
      {open && ungroupedPeople.length > 0 && (
        <tr className="bg-muted/10"><td /><td className="px-4 py-2 pl-10 font-medium">No observed group</td><td colSpan={5} className="px-4 py-2 text-xs text-muted-foreground">People with no known authorized roster group remain visible; unknown membership is not treated as empty.</td></tr>
      )}
      {open && ungroupedPeople.map(person => <UngroupedPersonRow key={`${person.workspaceId}:${person.member.userId}`} person={person} rows={rows} selectedPeople={selectedPeople} onSelectedPeople={onSelectedPeople} onEdit={onEdit} onStage={onStage} readOnly={readOnly || !person.canWrite} />)}
    </>
  );
}

function UngroupedPersonRow({ person, rows, selectedPeople, onSelectedPeople, onEdit, onStage, readOnly }: {
  person: LimitsPersonRef<SetLimitsMember>; rows: LimitRow[]; selectedPeople: Set<string>;
  onSelectedPeople: (next: Set<string>) => void; onEdit: (draft: LiveLimitDraft) => void;
  onStage: (draft: LiveLimitDraft) => void; readOnly: boolean;
}) {
  const { member, workspaceId, workspaceName } = person;
  const key = personTargetKey(workspaceId, member.userId);
  const row = configuredRow(rows, workspaceId, 'workspace_user_limit', member.userId);
  const selectable = isMemberSelectable(member);
  return (
    <tr data-testid={`row-limit-person-${workspaceId}-${member.userId}`}>
      <td className="px-3 py-2 pl-10"><Checkbox checked={selectedPeople.has(key)} disabled={readOnly || !selectable} onCheckedChange={() => { const next = new Set(selectedPeople); next.has(key) ? next.delete(key) : next.add(key); onSelectedPeople(next); }} aria-label={`Select ${member.name ?? member.username}`} /></td>
      <td className="px-4 py-2 pl-16"><div className="font-medium">{member.name ?? member.username}</div><div className="text-[11px] text-muted-foreground">@{member.username}</div></td>
      <td className="px-4 py-2 text-xs text-muted-foreground">{workspaceName} · {workspaceId}</td>
      <td className="px-4 py-2 text-right font-mono">{describeLimitValue(member.limitState === 'no_limit' ? 'none' : member.limitState, member.effectiveLimitUsd)}</td>
      <td className="px-4 py-2"><LimitBadge state={member.limitState === 'no_limit' ? 'none' : member.limitState} /></td>
      <td className="px-4 py-2 text-xs text-muted-foreground">{member.usageUsd == null ? 'Usage unavailable' : `${currency.format(member.usageUsd)} used this cycle`}</td>
      <td className="px-4 py-2 text-right"><RowActions row={row} identity={{ workspaceId, type: 'workspace_user_limit', targetId: member.userId, amountUsd: member.explicitLimitUsd }} hasExplicit={member.limitState === 'explicit'} readOnly={readOnly || !selectable || row?.canWrite === false} onEdit={onEdit} onStage={onStage} /></td>
    </tr>
  );
}

function GroupRows({ workspaceId, workspaceName, group, groupRow, members, team, open, selected, selectedPeople, readOnly, onToggleOpen, onToggle, onSelectedPeople, onEdit, onStage, billingPeriod }: {
  workspaceId: string; workspaceName?: string; group: SetLimitsGroup; groupRow?: LimitRow; members: SetLimitsMember[]; team: string | null | undefined; open: boolean; selected: boolean;
  selectedPeople: Set<string>; readOnly: boolean; onToggleOpen: () => void; onToggle: () => void; onSelectedPeople: (next: Set<string>) => void;
  onEdit: (draft: LiveLimitDraft) => void; onStage: (draft: LiveLimitDraft) => void; billingPeriod?: { start: string; end: string };
}) {
  return (
    <>
      <tr data-testid={`row-limit-group-${workspaceId}-${group.groupId}`}>
        <td className="px-3 py-3 pl-7"><Checkbox checked={selected} disabled={readOnly || getSelectableGroupUserIds(group, members).length === 0} onCheckedChange={onToggle} aria-label={`Select eligible people in ${group.name}`} data-testid={`checkbox-limit-group-${workspaceId}-${group.groupId}`} /></td>
        <td className="px-4 py-3 pl-10"><button onClick={onToggleOpen} className="inline-flex items-center gap-2 font-medium">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}<Users className="h-4 w-4" />{group.name}</button><div className="ml-8 font-mono text-[10px] text-muted-foreground">{group.groupId}</div></td>
        <td className="px-4 py-3 text-xs"><div className="font-medium">{workspaceName ?? workspaceId}</div><div className="font-mono text-[10px] text-muted-foreground">{workspaceId}</div>{!team && <span className="text-muted-foreground">Unmapped funding context</span>}</td>
        <td className="px-4 py-3 text-right font-mono">{groupRow ? currency.format(groupRow.amountUsd) : '—'}</td>
        <td className="px-4 py-3"><LimitBadge state={groupRow ? 'explicit' : 'none'} /></td>
        <td className="px-4 py-3 text-xs text-muted-foreground">Per person · not a funding pool</td>
        <td className="px-4 py-3 text-right"><RowActions row={groupRow} identity={{ workspaceId, type: 'workspace_group_limit', targetId: group.groupId, amountUsd: groupRow?.amountUsd ?? null }} readOnly={readOnly || groupRow?.canWrite === false} onEdit={onEdit} onStage={onStage} /></td>
      </tr>
      {open && members.map(member => {
        const key = personTargetKey(workspaceId, member.userId);
        const selectable = isMemberSelectable(member);
        return (
          <tr key={member.userId} className="bg-background" data-testid={`row-limit-person-${workspaceId}-${member.userId}`}>
            <td className="px-3 py-2 pl-10"><Checkbox checked={selectedPeople.has(key)} disabled={readOnly || !selectable} onCheckedChange={() => { const next = new Set(selectedPeople); next.has(key) ? next.delete(key) : next.add(key); onSelectedPeople(next); }} aria-label={`Select ${member.name ?? member.username}`} /></td>
            <td className="px-4 py-2 pl-16"><div className="flex items-center gap-2"><User className="h-4 w-4 text-muted-foreground" /><div><div className="font-medium">{member.name ?? member.username}</div><div className="text-[11px] text-muted-foreground">@{member.username}</div></div></div></td>
            <td className="px-4 py-2 text-xs text-muted-foreground">{member.role}</td>
            <td className="px-4 py-2 text-right font-mono">{describeLimitValue(member.limitState === 'no_limit' ? 'none' : member.limitState, member.effectiveLimitUsd)}</td>
            <td className="px-4 py-2"><LimitBadge state={member.limitState === 'no_limit' ? 'none' : member.limitState} /></td>
            <td className="px-4 py-2">{billingPeriod ? <BudgetMeter actualUsd={member.usageUsd} budgetUsd={member.limitState === 'unavailable' ? null : member.effectiveLimitUsd} periodStart={billingPeriod.start} periodEnd={billingPeriod.end} incomplete={member.limitState === 'unavailable'} label="Current-cycle Agent usage" /> : <span className="text-xs text-muted-foreground">Billing period unavailable</span>}</td>
            <td className="px-4 py-2 text-right"><RowActions row={undefined} identity={{ workspaceId, type: 'workspace_user_limit', targetId: member.userId, amountUsd: member.explicitLimitUsd }} hasExplicit={member.limitState === 'explicit'} readOnly={readOnly || !selectable} onEdit={onEdit} onStage={onStage} /></td>
          </tr>
        );
      })}
    </>
  );
}

function LimitBadge({ state }: { state: 'explicit' | 'inherited' | 'unavailable' | 'none' }) {
  if (state === 'explicit') return <Badge className="bg-primary/10 text-primary shadow-none hover:bg-primary/10">Explicit</Badge>;
  if (state === 'inherited') return <Badge variant="secondary">Inherited</Badge>;
  if (state === 'unavailable') return <Badge variant="outline" className="border-amber-300 text-amber-700">Unavailable</Badge>;
  return <span className="text-xs text-muted-foreground">Not configured</span>;
}

function RowActions({ row, identity, hasExplicit, readOnly, onEdit, onStage }: {
  row?: LimitRow; identity: LiveLimitDraft; hasExplicit?: boolean; readOnly: boolean;
  onEdit: (draft: LiveLimitDraft) => void; onStage: (draft: LiveLimitDraft) => void;
}) {
  const configured = hasExplicit ?? Boolean(row);
  return <div className="flex justify-end gap-1">{configured && <Button variant="ghost" size="icon" disabled={readOnly} title="Clear configuration" onClick={() => onStage({ ...identity, amountUsd: null })}><RotateCcw className="h-4 w-4" /></Button>}<Button variant="ghost" size="sm" disabled={readOnly} onClick={() => onEdit(identity)}>Edit</Button></div>;
}

function AmountEditor({ draft, onClose, onSave }: { draft: LiveLimitDraft | null; onClose: () => void; onSave: (draft: LiveLimitDraft) => void }) {
  const [value, setValue] = useState('');
  useEffect(() => setValue(draft?.amountUsd == null ? '' : String(draft.amountUsd)), [draft]);
  const amount = positiveUsdAmount(value);
  return <Dialog open={!!draft} onOpenChange={open => !open && onClose()}><DialogContent><DialogHeader><DialogTitle>Edit monthly limit</DialogTitle><DialogDescription>{draft ? `${draft.workspaceId} · ${draft.type} · ${draft.targetId}` : ''}</DialogDescription></DialogHeader><div><label htmlFor="edit-live-limit" className="mb-1 block text-sm font-medium">Positive monthly USD amount</label><Input id="edit-live-limit" value={value} onChange={event => setValue(event.target.value)} inputMode="decimal" aria-invalid={value !== '' && amount == null} data-testid="input-edit-limit-amount" /><p className="mt-1 text-xs text-muted-foreground">This stages a change for exact review. Clearing removes the configuration; it does not create an unlimited override.</p></div><DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!draft || amount == null} onClick={() => draft && amount != null && onSave({ ...draft, amountUsd: amount })} data-testid="button-stage-limit-change">Stage change</Button></DialogFooter></DialogContent></Dialog>;
}

function BulkEditor({ open, count, onClose, onSave }: { open: boolean; count: number; onClose: () => void; onSave: (amount: number | null) => void }) {
  const [value, setValue] = useState('');
  const amount = positiveUsdAmount(value);
  return <Dialog open={open} onOpenChange={next => !next && onClose()}><DialogContent><DialogHeader><DialogTitle>Set individual limits</DialogTitle><DialogDescription>Stage the same explicit limit for {count} exact workspace/person targets. Duplicate selections are removed; funding groups are not targets.</DialogDescription></DialogHeader><Input value={value} onChange={event => setValue(event.target.value)} inputMode="decimal" placeholder="Monthly USD" data-testid="input-bulk-limit-amount" /><DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={amount == null} onClick={() => amount != null && onSave(amount)} data-testid="button-stage-bulk-limits">Stage individual limits</Button></DialogFooter></DialogContent></Dialog>;
}