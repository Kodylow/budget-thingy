import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, FolderKanban, Users } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  buildFundingHierarchy,
  fundingGroupKey,
  type FundingGroup,
  type FundingGroupInventory,
} from '@/pages/funding-groups-hierarchy';
import type { FundingGroupAudit } from '@workspace/api-client-react';

type SaveFundingGroup = (input: {
  workspaceId: string;
  groupId: string;
  teamName: string | null;
  expectedRevision: string;
}) => Promise<void>;

const allocationCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function GroupIdentity({ group }: { group: FundingGroup }) {
  return (
    <div className="min-w-0">
      <div className="break-words font-medium" title={group.groupName}>{group.groupName}</div>
      <div className="break-words text-xs text-muted-foreground" title={group.workspaceName}>
        {group.workspaceName}
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={`${group.workspaceId} / ${group.groupId}`}>
        {group.workspaceId} / {group.groupId}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        {group.memberCount == null ? 'People unavailable' : `${group.memberCount} ${group.memberCount === 1 ? 'person' : 'people'}`}
      </div>
    </div>
  );
}

function GroupTeamSelect({ group, teams, disabled, onSelect }: {
  group: FundingGroup;
  teams: string[];
  disabled: boolean;
  onSelect: (teamName: string | null) => void;
}) {
  return (
    <Select
      value={group.teamName ?? '__unmapped__'}
      disabled={disabled}
      onValueChange={value => {
        const teamName = value === '__unmapped__' ? null : value;
        if (teamName !== group.teamName) onSelect(teamName);
      }}
    >
      <SelectTrigger
        className="w-full min-w-0"
        aria-label={`Budgeted team for ${group.groupName} in ${group.workspaceName}`}
        data-testid="select-funding-group-team"
      >
        <SelectValue placeholder="Choose a budgeted team" />
      </SelectTrigger>
      <SelectContent className="max-h-[300px]">
        <SelectItem value="__unmapped__">Unmapped groups</SelectItem>
        {teams.map(team => <SelectItem key={team} value={team}>{team}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function MappingDialog({
  group,
  initialDestination,
  canSave,
  teams,
  revision,
  open,
  onOpenChange,
  onSave,
  onRefresh,
}: {
  group: FundingGroup | null;
  initialDestination: string | null;
  canSave: boolean;
  teams: string[];
  revision: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: SaveFundingGroup;
  onRefresh: () => Promise<string>;
}) {
  const [destination, setDestination] = useState('');
  const [step, setStep] = useState<'select' | 'review'>('select');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [revisionAtOpen, setRevisionAtOpen] = useState('');
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!open || !group) return;
    setDestination(initialDestination ?? '__unmapped__');
    setStep('review');
    setPending(false);
    setError('');
    setRevisionAtOpen(revision);
    setReviewedRevision(revision);
  }, [group, open]);

  if (!group) return null;
  const teamName = destination === '__unmapped__' ? null : destination;
  const destinationLabel = teamName ?? 'Unmapped groups';
  const isUnchanged = teamName === group.teamName;

  const save = async () => {
    if (!canSave || pending || isUnchanged || !reviewedRevision) return;
    setPending(true);
    setError('');
    try {
      await onSave({
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        teamName,
        expectedRevision: reviewedRevision,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The assignment could not be saved.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{group.teamName ? 'Change funding assignment' : 'Assign funding group'}</DialogTitle>
          <DialogDescription>
            This changes reporting attribution for one exact group. It does not change funding dollars or a Replit platform limit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-3">
          <div className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2">
            <div><span className="block text-xs text-muted-foreground">Workspace</span><strong className="break-words">{group.workspaceName}</strong></div>
            <div><span className="block text-xs text-muted-foreground">Group</span><strong className="break-words">{group.groupName}</strong></div>
            <div><span className="block text-xs text-muted-foreground">Workspace ID</span><code className="break-all text-xs">{group.workspaceId}</code></div>
            <div><span className="block text-xs text-muted-foreground">Group ID</span><code className="break-all text-xs">{group.groupId}</code></div>
          </div>
          {step === 'select' ? (
            <div className="space-y-2">
              <Label htmlFor="funding-team-destination">Funding destination</Label>
              <Select value={destination} onValueChange={value => { setDestination(value); setError(''); }}>
                <SelectTrigger id="funding-team-destination" data-testid="select-funding-team-destination">
                  <SelectValue placeholder="Choose a destination" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  <SelectItem value="__unmapped__">Unmapped groups</SelectItem>
                  {teams.map(team => <SelectItem key={team} value={team}>{team}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="rounded-md border p-4 text-sm" data-testid="summary-funding-group-review">
              <span className="block text-xs text-muted-foreground">{group.teamName ? 'New destination' : 'Assign to'}</span>
              <strong>{destinationLabel}</strong>
            </div>
          )}
          {error && (
            <Alert variant="destructive" data-testid="status-funding-group-save-error">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Assignment was not saved</AlertTitle>
              <AlertDescription>
                <p>{error} Your selected destination is preserved.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={refreshing}
                  onClick={() => {
                    setRefreshing(true);
                    void onRefresh()
                      .then(nextRevision => {
                        setRevisionAtOpen(nextRevision);
                        setReviewedRevision(null);
                        setStep('select');
                        setError('Inventory refreshed. Review the preserved destination again before saving.');
                      })
                      .catch(cause => setError(cause instanceof Error ? cause.message : 'Inventory refresh failed.'))
                      .finally(() => setRefreshing(false));
                  }}
                  data-testid="button-refresh-funding-group-conflict"
                >
                  {refreshing ? 'Refreshing…' : 'Refresh inventory'}
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          {step === 'select' ? (
            <Button
              disabled={!destination || isUnchanged}
              onClick={() => {
                setReviewedRevision(revisionAtOpen);
                setError('');
                setStep('review');
              }}
              data-testid="button-review-funding-group"
            >
              Review assignment
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={() => setStep('select')}>Back</Button>
              <Button disabled={!canSave || pending || isUnchanged || !reviewedRevision} onClick={() => void save()} data-testid="button-save-funding-group">
                {pending ? 'Saving…' : teamName === null ? 'Confirm unmap' : group.teamName ? 'Confirm reassignment' : 'Confirm assignment'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FundingGroupsHierarchy({
  inventory,
  inventoryLoading,
  inventoryError,
  teamNames,
  searchQuery,
  showHidden,
  authorizationKey,
  canManage,
  onRetry,
  onRefresh,
  onSave,
  teamAllocations,
  allocationYear,
}: {
  inventory: FundingGroupInventory | undefined;
  inventoryLoading: boolean;
  inventoryError: boolean;
  teamNames: string[];
  searchQuery: string;
  showHidden: boolean;
  authorizationKey: string;
  canManage: boolean;
  onRetry: () => void;
  onRefresh: () => Promise<string>;
  onSave: SaveFundingGroup;
  teamAllocations: Record<string, number>;
  allocationYear: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ group: FundingGroup; teamName: string | null } | null>(null);
  const hierarchy = useMemo(
    () => buildFundingHierarchy(inventory?.groups ?? [], teamNames, searchQuery, showHidden),
    [inventory?.groups, searchQuery, showHidden, teamNames],
  );

  useEffect(() => {
    setEditing(null);
    setExpanded(new Set());
  }, [authorizationKey]);

  if (inventoryLoading && !inventory) {
    return <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading funding groups…</div>;
  }
  if (inventoryError && !inventory) {
    return (
      <Alert variant="destructive" data-testid="status-funding-groups-unavailable">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Funding group inventory is unavailable</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          Inventory availability is unknown; this is not an empty queue.
          <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!inventory) return null;
  if (inventory.freshness.status === 'unavailable' && inventory.groups.length === 0) {
    return (
      <Alert variant="destructive" data-testid="status-funding-groups-unknown">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Funding group inventory is unavailable</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          {inventory.freshness.error ?? 'The directory did not return a usable inventory.'} The unmapped count is unknown.
          <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  const canEdit = canManage && !inventoryError && !inventoryLoading && inventory.freshness.status === 'fresh';

  return (
    <section className="space-y-4" aria-labelledby="funding-groups-heading" data-testid="funding-groups-hierarchy">
      {inventoryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Inventory refresh failed</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            Showing the last available funding groups.
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}
      {(inventory.freshness.status === 'stale' || inventory.freshness.error) && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Directory inventory may be out of date</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{inventory.freshness.error ?? `Showing inventory as of ${inventory.freshness.dataAsOf ? new Date(inventory.freshness.dataAsOf).toLocaleString() : 'the last successful directory refresh'}.`}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}
      <div>
        <h2 id="funding-groups-heading" className="text-xl font-semibold">Funding groups</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review each concrete workspace group’s reporting destination. Inferred assignments remain editable.
        </p>
        {!canManage && <p className="mt-1 text-xs text-muted-foreground">Changing assignments requires funding-mapping permission.</p>}
      </div>
      <div className="overflow-hidden rounded-md border">
        <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
          <div>
            <strong>Unmapped groups</strong>
            <p className="text-xs text-muted-foreground">
              {canManage ? 'Choose a budgeted team below, then confirm the assignment.' : 'Groups awaiting a budget team.'}
            </p>
          </div>
          <Badge variant={hierarchy.unmapped.length ? 'destructive' : 'secondary'}>{hierarchy.unmapped.length}</Badge>
        </div>
        {hierarchy.unmapped.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
            <Check className="h-4 w-4" /> No unmapped groups in this view.
          </div>
        ) : (
          <ul className="grid gap-3 bg-muted/10 p-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Unmapped groups">
            {hierarchy.unmapped.map(group => (
              <li
                key={fundingGroupKey(group)}
                className="flex min-w-0 flex-col gap-3 rounded-xl border bg-background p-3"
                aria-label={`${group.groupName} in ${group.workspaceName}`}
                data-testid="unmapped-group-card"
              >
                <div className="flex-1"><GroupIdentity group={group} /></div>
                <GroupTeamSelect
                  group={group}
                  teams={teamNames}
                  disabled={!canEdit}
                  onSelect={teamName => setEditing({ group, teamName })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="overflow-hidden rounded-md border">
        <div className="border-b bg-muted/20 px-4 py-3 text-sm font-semibold">Budget teams and mapped groups</div>
        {hierarchy.teams.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">No budget teams match this search.</div>
        ) : hierarchy.teams.map(teamName => {
          const mapped = hierarchy.byTeam.get(teamName) ?? [];
          const isOpen = expanded.has(teamName) || Boolean(searchQuery.trim() && mapped.length);
          return (
            <Collapsible
              key={teamName}
              open={isOpen}
              onOpenChange={open => setExpanded(current => {
                const next = new Set(current);
                if (open) next.add(teamName); else next.delete(teamName);
                return next;
              })}
              className="border-b last:border-b-0"
            >
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="h-auto w-full justify-between rounded-none px-4 py-3 text-left">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{teamName}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {allocationCurrency.format(teamAllocations[teamName] ?? 0)} total through {allocationYear}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">{mapped.length} {mapped.length === 1 ? 'group' : 'groups'}</Badge>
                    <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t bg-muted/10">
                {mapped.length === 0 ? (
                  <div className="flex items-center gap-2 px-6 py-4 text-sm text-muted-foreground"><FolderKanban className="h-4 w-4" />No mapped groups.</div>
                ) : mapped.map(group => (
                  <div key={fundingGroupKey(group)} className="flex flex-col justify-between gap-3 border-b px-6 py-3 last:border-b-0 sm:flex-row sm:items-center">
                    <GroupIdentity group={group} />
                    <div className="flex w-full min-w-0 items-center gap-2 sm:w-72 sm:shrink-0">
                      <Badge variant="secondary" className="hidden font-normal sm:inline-flex">{group.origin}</Badge>
                      <GroupTeamSelect
                        group={group}
                        teams={teamNames}
                        disabled={!canEdit}
                        onSelect={teamName => setEditing({ group, teamName })}
                      />
                    </div>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
      <MappingDialog
        key={`${authorizationKey}:${editing ? fundingGroupKey(editing.group) : 'closed'}`}
        group={editing?.group ?? null}
        initialDestination={editing?.teamName ?? null}
        canSave={canEdit}
        teams={teamNames}
        revision={inventory.revision}
        open={editing !== null}
        onOpenChange={open => { if (!open) setEditing(null); }}
        onSave={async input => {
          await onSave(input);
          const teamName = input.teamName;
          if (teamName !== null) {
            setExpanded(current => new Set([...current, teamName]));
          }
        }}
        onRefresh={onRefresh}
      />
    </section>
  );
}

export function FundingGroupAuditList({
  changes,
  loading,
  error,
  onRetry,
}: {
  changes: FundingGroupAudit[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (loading && !changes) return <div className="p-6 text-sm text-muted-foreground">Loading mapping history…</div>;
  if (error && !changes) {
    return (
      <div className="flex items-center justify-between gap-3 p-6 text-sm text-muted-foreground" role="alert">
        <span>Funding assignment history is unavailable.</span>
        <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (!changes?.length) return <div className="p-6 text-sm text-muted-foreground">No funding assignment changes recorded yet.</div>;
  return (
    <div className="max-w-full overflow-x-auto" tabIndex={0} aria-label="Funding group audit history">
      {error && <div className="border-b bg-destructive/5 px-5 py-3 text-sm text-destructive">Refresh failed. Showing the last available mapping history.</div>}
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-muted/20 text-left text-xs uppercase text-muted-foreground">
          <tr><th className="px-5 py-3">When</th><th className="px-5 py-3">Workspace / group</th><th className="px-5 py-3">Assignment</th><th className="px-5 py-3">Actor</th></tr>
        </thead>
        <tbody>
          {changes.map(change => (
            <tr key={change.id} className="border-t">
              <td className="whitespace-nowrap px-5 py-4">{new Date(change.changedAt).toLocaleString()}</td>
              <td className="px-5 py-4"><strong>{change.groupName}</strong><span className="block text-xs text-muted-foreground">{change.workspaceName}</span></td>
              <td className="px-5 py-4">{change.previousTeamName ?? 'Unmapped'} → {change.newTeamName ?? 'Unmapped'}</td>
              <td className="px-5 py-4 font-mono text-xs">{change.actor}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}