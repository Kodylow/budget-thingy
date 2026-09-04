import { Fragment, useState, useMemo, useCallback, useEffect } from 'react';
import {
  useListDirectoryMembers,
  getListDirectoryMembersQueryKey,
  useListDirectoryGroups,
  getListDirectoryGroupsQueryKey,
  useGetUserActivity,
  getGetUserActivityQueryKey,
} from '@workspace/api-client-react';
import { progressivePollInterval } from '@/lib/client-performance';
import type { DirectoryMember, DirectoryMemberWorkspace } from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChevronDown, Download, Search, ShieldCheck } from 'lucide-react';
import { useRange } from '@/components/range-context';
import { buildCsv } from '@/lib/csv';
import { groupDirectoryByWorkspace } from '@/lib/workspace-directory-groups';

// ---------- helpers ----------

function initials(member: DirectoryMember): string {
  if (member.name) {
    const parts = member.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
    }
    return parts[0]![0]!.toUpperCase();
  }
  return member.username.charAt(0).toUpperCase();
}

function fmtUsd(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

function exportDirectoryUsers(
  members: DirectoryMember[],
  spendByUser: ReadonlyMap<string, SpendInfo>,
) {
  const header = [
    'Email',
    'Name',
    'Username',
    'Account Admin',
    'Workspace(s)',
    'Workspace Role(s)',
    'Workspace Status(es)',
    'AI Spend (USD)',
    'Hosting / Non-AI Spend (USD)',
    'Spend (USD)',
  ];
  const rows = [...members]
    .sort((a, b) => {
      const spendDifference =
        (spendByUser.get(b.userId)?.spendUsd ?? 0) -
        (spendByUser.get(a.userId)?.spendUsd ?? 0);
      return spendDifference || a.username.localeCompare(b.username);
    })
    .map((member) => {
      const spend = spendByUser.get(member.userId);
      return [
        member.email,
        member.name ?? '',
        member.username,
        member.isAccountAdmin ? 'Yes' : 'No',
        member.workspaces.map((workspace) => workspace.workspaceName).join('; '),
        member.workspaces.map((workspace) => workspace.role).join('; '),
        member.workspaces
          .map((workspace) => workspace.isDisabled ? 'Disabled' : 'Active')
          .join('; '),
        (spend?.aiSpendUsd ?? 0).toFixed(2),
        (spend?.nonAiSpendUsd ?? 0).toFixed(2),
        (spend?.spendUsd ?? 0).toFixed(2),
      ];
    });
  const csv = buildCsv([header, ...rows]);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `workspace-directory-users-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ---------- skeleton ----------

function SkeletonRow() {
  return (
    <tr className="border-b border-border">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-muted animate-pulse shrink-0" />
          <div className="space-y-1.5">
            <div className="h-3.5 w-24 bg-muted animate-pulse rounded" />
            <div className="h-3 w-32 bg-muted animate-pulse rounded" />
          </div>
        </div>
      </td>
      <td className="px-4 py-3 hidden md:table-cell">
        <div className="h-3 w-40 bg-muted animate-pulse rounded" />
      </td>
      <td className="px-4 py-3 hidden lg:table-cell">
        <div className="h-3 w-20 bg-muted animate-pulse rounded" />
      </td>
      <td className="px-4 py-3 text-right">
        <div className="h-3 w-16 bg-muted animate-pulse rounded ml-auto" />
      </td>
    </tr>
  );
}

function GroupSkeletonRow() {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <div className="h-3.5 w-36 bg-muted animate-pulse rounded" />
      </td>
      <td className="px-4 py-3">
        <div className="h-3.5 w-44 bg-muted animate-pulse rounded" />
      </td>
    </tr>
  );
}

// ---------- member detail panel ----------

interface SpendInfo {
  spendUsd: number;
  aiSpendUsd: number;
  nonAiSpendUsd: number;
}

function SpendCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3 flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums">{fmtUsd(value)}</span>
    </div>
  );
}

function WorkspaceChip({ ws }: { ws: DirectoryMemberWorkspace }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{ws.workspaceName}</div>
        <div className="text-xs text-muted-foreground capitalize">{ws.role}</div>
        {ws.reAttributedSpendUsd !== undefined && ws.reAttributedSpendUsd > 0 && (
          <div className="text-[11px] text-muted-foreground">incl. Comcast re-attribution</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {ws.spendUsd > 0 && (
          <span className="text-xs tabular-nums font-mono font-medium">
            {fmtUsd(ws.spendUsd)}
          </span>
        )}
        <Badge
          variant={ws.isDisabled ? 'outline' : 'secondary'}
          className={`text-[10px] ${ws.isDisabled ? 'text-muted-foreground' : ''}`}
        >
          {ws.isDisabled ? 'Disabled' : 'Active'}
        </Badge>
      </div>
    </div>
  );
}

interface DetailPanelProps {
  member: DirectoryMember | null;
  spend: SpendInfo | null;
  onClose: () => void;
}

function DetailPanel({ member, spend, onClose }: DetailPanelProps) {
  // Workspaces sorted by spend desc so highest-spend workspace appears first
  const sortedWorkspaces = useMemo(() => {
    if (!member) return [];
    return [...member.workspaces].sort((a, b) => b.spendUsd - a.spendUsd);
  }, [member]);

  const totalWorkspaceSpend = useMemo(
    () => sortedWorkspaces.reduce((sum, ws) => sum + ws.spendUsd, 0),
    [sortedWorkspaces],
  );

  const hasAnyWorkspaceSpend = totalWorkspaceSpend > 0;

  return (
    <Sheet open={!!member} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {member && (
          <>
            <SheetHeader className="mb-5">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold text-primary shrink-0">
                  {initials(member)}
                </div>
                <div className="min-w-0">
                  <SheetTitle className="text-left">{member.username}</SheetTitle>
                  <SheetDescription className="text-left">
                    {member.name && <span className="block">{member.name}</span>}
                    <span className="block text-xs">{member.email}</span>
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            {/* Profile section */}
            <section className="space-y-3 mb-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Profile
              </h3>
              {member.isAccountAdmin && (
                <div className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
                  <Badge variant="default" className="text-xs">Account Admin</Badge>
                </div>
              )}
              {member.workspaces.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No workspace memberships</p>
              ) : (
                <div className="space-y-2">
                  {sortedWorkspaces.map((ws) => (
                    <WorkspaceChip key={ws.workspaceId} ws={ws} />
                  ))}
                </div>
              )}
            </section>

            {/* Current spend section */}
            <section className="space-y-3 mb-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Current Spend — Totals
              </h3>
              {!spend || (spend.spendUsd === 0 && spend.aiSpendUsd === 0 && spend.nonAiSpendUsd === 0) ? (
                <p className="text-sm text-muted-foreground italic">No spend recorded</p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <SpendCard label="Total" value={spend.spendUsd} />
                  <SpendCard label="AI" value={spend.aiSpendUsd} />
                  <SpendCard label="Non-AI" value={spend.nonAiSpendUsd} />
                </div>
              )}
            </section>

            {/* Per-workspace spend breakdown */}
            {member.workspaces.length > 0 && (
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Spend by Workspace
                </h3>
                {!hasAnyWorkspaceSpend ? (
                  <p className="text-sm text-muted-foreground italic">No workspace spend recorded</p>
                ) : (
                  <div className="rounded-md border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/40 border-b border-border">
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                            Workspace
                          </th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                            Spend
                          </th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground hidden sm:table-cell">
                            Share
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {sortedWorkspaces
                          .filter((ws) => ws.spendUsd > 0)
                          .map((ws) => (
                            <tr key={ws.workspaceId} className="hover:bg-muted/20 transition-colors">
                              <td className="px-3 py-2.5">
                                <div className="font-medium truncate max-w-[160px]">{ws.workspaceName}</div>
                                <div className="text-xs text-muted-foreground capitalize">{ws.role}</div>
                                {ws.reAttributedSpendUsd !== undefined && ws.reAttributedSpendUsd > 0 && (
                                  <div className="text-[11px] text-muted-foreground">
                                    incl. Comcast re-attribution
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums font-mono font-medium">
                                {fmtUsd(ws.spendUsd)}
                              </td>
                              <td className="px-3 py-2.5 text-right text-xs text-muted-foreground tabular-nums hidden sm:table-cell">
                                {totalWorkspaceSpend > 0
                                  ? `${Math.round((ws.spendUsd / totalWorkspaceSpend) * 100)}%`
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border bg-muted/20">
                          <td className="px-3 py-2 text-xs font-semibold text-muted-foreground">
                            Total
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-mono font-semibold text-sm">
                            {fmtUsd(totalWorkspaceSpend)}
                          </td>
                          <td className="px-3 py-2 hidden sm:table-cell" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------- main page ----------

export default function WorkspaceDirectory() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [selectedMember, setSelectedMember] = useState<DirectoryMember | null>(null);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Keep selected member data in sync when the list refreshes
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const { rangeType, startDate, endDate } = useRange();
  const rangeParams = {
    rangeType,
    ...(rangeType === 'custom' ? { startDate, endDate } : {}),
  };

  // Debounce search input
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(id);
  }, [search]);

  const { data: members, isLoading: membersLoading } = useListDirectoryMembers(rangeParams, {
    query: {
      queryKey: getListDirectoryMembersQueryKey(rangeParams),
    },
  });

  const {
    data: directoryGroups,
    isLoading: groupsLoading,
    isError: groupsUnavailable,
  } = useListDirectoryGroups({
    query: {
      queryKey: getListDirectoryGroupsQueryKey(),
    },
  });

  const activityParams = rangeParams;
  const { data: activity, isLoading: activityLoading } = useGetUserActivity(activityParams, {
    query: {
      queryKey: getGetUserActivityQueryKey(activityParams),
      refetchInterval: (query) =>
        progressivePollInterval(
          query.state.data,
          query.state.dataUpdateCount,
          query.state.status,
        ),
    },
  });

  const isLoading = membersLoading || (activityLoading && !activity);

  // Build spend lookup by userId (for total/AI/non-AI cards)
  const spendByUser = useMemo(() => {
    const map = new Map<string, SpendInfo>();
    for (const u of activity?.users ?? []) {
      map.set(u.userId, {
        spendUsd: u.spendUsd,
        aiSpendUsd: u.aiSpendUsd,
        nonAiSpendUsd: u.nonAiSpendUsd,
      });
    }
    return map;
  }, [activity]);

  // Filtered members
  const filteredMembers = useMemo(() => {
    const all = members ?? [];
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (m) =>
        m.username.toLowerCase().includes(q) ||
        (m.name ?? '').toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    );
  }, [members, debouncedSearch]);

  const filteredDirectoryGroups = useMemo(() => {
    const groups = directoryGroups ?? [];
    const query = groupSearch.trim().toLowerCase();
    if (!query) return groups;

    return groups.filter(
      (group) =>
        group.groupName.toLowerCase().includes(query) ||
        group.workspaceName.toLowerCase().includes(query),
    );
  }, [directoryGroups, groupSearch]);

  const groupedWorkspaces = useMemo(
    () => groupDirectoryByWorkspace(filteredDirectoryGroups),
    [filteredDirectoryGroups],
  );

  // Derive the selected member object from the live members list so workspace
  // spend stays up-to-date as the range changes or data refreshes.
  const selectedMemberLive = useMemo(
    () => (selectedUserId ? (members ?? []).find((m) => m.userId === selectedUserId) ?? null : null),
    [selectedUserId, members],
  );

  const handleRowClick = useCallback((member: DirectoryMember) => {
    setSelectedUserId(member.userId);
    setSelectedMember(member);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedUserId(null);
    setSelectedMember(null);
  }, []);

  const toggleWorkspace = useCallback((workspaceId: string) => {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }, []);

  const activeMember = selectedMemberLive ?? selectedMember;

  const selectedSpend = activeMember
    ? (spendByUser.get(activeMember.userId) ?? { spendUsd: 0, aiSpendUsd: 0, nonAiSpendUsd: 0 })
    : null;

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Workspace Directory</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse enterprise groups by workspace and search all members
        </p>
      </div>

      <Tabs defaultValue="members" className="space-y-4">
        <TabsList aria-label="Workspace directory view">
          <TabsTrigger value="members" data-testid="directory-tab-members">
            Members
          </TabsTrigger>
          <TabsTrigger value="groups" data-testid="directory-tab-groups">
            Groups
          </TabsTrigger>
        </TabsList>

        <TabsContent value="groups">
          <section className="space-y-3" aria-labelledby="groups-directory-heading">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 id="groups-directory-heading" className="text-lg font-semibold">Groups</h2>
                <p className="text-sm text-muted-foreground">
                  Enterprise groups organized by their owning workspace
                </p>
              </div>
              {!groupsLoading && !groupsUnavailable && (
                <p className="text-xs text-muted-foreground" data-testid="directory-group-counts">
                  {filteredDirectoryGroups.length} group{filteredDirectoryGroups.length === 1 ? '' : 's'} across{' '}
                  {groupedWorkspaces.length} workspace{groupedWorkspaces.length === 1 ? '' : 's'}
                  {groupSearch.trim() ? ' found' : ''}
                </p>
              )}
            </div>

            <div className="relative max-w-md">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                placeholder="Search groups or workspaces…"
                aria-label="Search groups or workspaces"
                value={groupSearch}
                onChange={(event) => setGroupSearch(event.target.value)}
                className="pl-8"
                data-testid="directory-groups-search"
              />
            </div>

            <div className="rounded-lg border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="directory-groups-table">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                        Workspace
                      </th>
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                        Group
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupsLoading ? (
                      Array.from({ length: 4 }).map((_, i) => <GroupSkeletonRow key={i} />)
                    ) : groupsUnavailable ? (
                      <tr>
                        <td colSpan={2} className="px-4 py-10 text-center text-sm text-muted-foreground">
                          Group directory is currently unavailable. Try again later.
                        </td>
                      </tr>
                    ) : groupedWorkspaces.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="px-4 py-10 text-center text-sm text-muted-foreground">
                          {groupSearch.trim() ? 'No groups match that search.' : 'No groups found.'}
                        </td>
                      </tr>
                    ) : (
                      groupedWorkspaces.map((workspace) => {
                        const isExpanded = !collapsedWorkspaceIds.has(workspace.workspaceId);
                        const contentId = `workspace-groups-${workspace.workspaceId}`;
                        return (
                          <Fragment key={workspace.workspaceId}>
                            <tr className="border-b border-border bg-muted/20">
                              <th colSpan={2} scope="rowgroup" className="p-0 text-left">
                                <button
                                  type="button"
                                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                                  onClick={() => toggleWorkspace(workspace.workspaceId)}
                                  aria-expanded={isExpanded}
                                  aria-controls={contentId}
                                  data-testid={`directory-workspace-toggle-${workspace.workspaceId}`}
                                >
                                  <span>
                                    <span className="block font-medium">{workspace.workspaceName}</span>
                                    <span className="block text-xs font-normal text-muted-foreground">
                                      {workspace.groups.length} group{workspace.groups.length === 1 ? '' : 's'}
                                    </span>
                                  </span>
                                  <ChevronDown
                                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                                      isExpanded ? 'rotate-180' : ''
                                    }`}
                                    aria-hidden="true"
                                  />
                                </button>
                              </th>
                            </tr>
                            {isExpanded && workspace.groups.map((group) => (
                              <tr
                                key={group.groupId}
                                id={group === workspace.groups[0] ? contentId : undefined}
                                className="border-b border-border last:border-0"
                                data-testid={`directory-group-row-${group.groupId}`}
                              >
                                <td className="px-4 py-3 text-muted-foreground">
                                  <span className="sr-only">{workspace.workspaceName}</span>
                                </td>
                                <td className="px-4 py-3 font-medium">{group.groupName}</td>
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="members">
          <section className="space-y-3" aria-labelledby="members-directory-heading">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="members-directory-heading" className="text-lg font-semibold">Members</h2>
                <p className="text-sm text-muted-foreground">Search enterprise members and review current spend</p>
              </div>
              <button
                type="button"
                disabled={isLoading || !members}
                onClick={() => exportDirectoryUsers(members ?? [], spendByUser)}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="button-export-directory-users"
              >
                <Download className="h-4 w-4" />
                Export Users
              </button>
            </div>
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search members…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
            data-testid="directory-search"
          />
        </div>

        {/* Member count */}
        {!isLoading && (
          <p className="text-xs text-muted-foreground">
            {filteredMembers.length} member{filteredMembers.length !== 1 ? 's' : ''}
            {debouncedSearch ? ' found' : ''}
          </p>
        )}

        {/* Table */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Member
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide hidden md:table-cell">
                  Email
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide hidden lg:table-cell">
                  Role
                </th>
                <th className="px-4 py-2.5 text-right font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Spend
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
              ) : filteredMembers.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    {debouncedSearch ? 'No members match that search.' : 'No members found.'}
                  </td>
                </tr>
              ) : (
                filteredMembers.map((member) => {
                  const spend = spendByUser.get(member.userId);
                  const isSelected = member.userId === selectedUserId;
                  return (
                    <tr
                      key={member.userId}
                      onClick={() => handleRowClick(member)}
                      className={`border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer ${
                        isSelected ? 'bg-muted/40' : ''
                      }`}
                      data-testid={`directory-row-${member.userId}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0 uppercase">
                            {initials(member)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate flex items-center gap-1.5">
                              {member.username}
                              {member.isAccountAdmin && (
                                <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0" aria-label="Account admin" />
                              )}
                            </div>
                            {member.name && (
                              <div className="text-xs text-muted-foreground truncate">{member.name}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell truncate max-w-xs">
                        {member.email}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {member.isAccountAdmin ? (
                          <Badge variant="default" className="text-[10px]">Account Admin</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground capitalize">
                            {member.workspaces[0]?.role ?? 'Member'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-mono text-sm">
                        {spend && spend.spendUsd > 0 ? (
                          <span className="font-medium">{fmtUsd(spend.spendUsd)}</span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            </table>
          </div>
        </div>
          </section>
        </TabsContent>
      </Tabs>

      {/* Detail slide-over */}
      <DetailPanel
        member={activeMember}
        spend={selectedSpend}
        onClose={handleClose}
      />
    </div>
  );
}
