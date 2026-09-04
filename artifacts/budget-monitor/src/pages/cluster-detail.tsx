import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useSearch } from 'wouter';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  getGetGroupDetailQueryOptions,
  getGetGroupDetailQueryKey,
  getGetClusterProjectsQueryOptions,
  getGetClusterProjectsQueryKey,
  useGetCanonicalClusterHeadline,
  getGetCanonicalClusterHeadlineQueryKey,
  useListVisibleWorkspaceMembers,
  getListVisibleWorkspaceMembersQueryKey,
  type WorkspaceMemberBudget,
  useBulkSetWorkspaceMemberBudgets,
  useListWorkspaceUsageLimitAudits,
  getListWorkspaceUsageLimitAuditsQueryKey,
} from '@workspace/api-client-react';
import { useRange } from '@/components/range-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, RefreshCw, DollarSign, Users, AlertCircle } from 'lucide-react';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';
import {
  parseRoleSuffix,
  normalizeRole,
  higherRole,
  roleBadgeClass,
  ROLE_PRIORITY,
} from '@/lib/group-clusters';
import { GroupUserExport } from '@/components/group-user-export';
import { useAuthContext, useCanWrite } from '@/components/auth-context';
import { MemberBudgetInput } from '@/components/member-budget-input';
import {
  chunkMemberIds,
  failedBulkSelection,
  indexMemberBudgets,
  toggleDisplayedSelection,
} from '@/lib/member-budgets';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

interface MergedMember {
  userId: string;
  username: string | null;
  email: string | null;
  name: string | null;
  role: string;
  allRoles: string[];
  spendUsd: number;
  spendLoaded: boolean;
}

interface ClusterProjectMetric {
  id: string;
  name: string;
  category: string;
  costUsd: number;
}

interface ClusterProject {
  projectId: string;
  title: string | null;
  totalCostUsd: number;
  metrics: ClusterProjectMetric[];
  workspaceId: string | null;
  workspaceName: string | null;
}

export default function ClusterDetail() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const rawIds = params.get('ids') ?? '';
  const clusterName = params.get('name') ?? 'Group Cluster';
  const groupIds = rawIds ? rawIds.split(',').filter(Boolean) : [];

  const canWrite = useCanWrite();
  const { realRole } = useAuthContext();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const bulkSetLimits = useBulkSetWorkspaceMemberBudgets();
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [bulkLimit, setBulkLimit] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);

  const { rangeType, startDate, endDate } = useRange();
  const clusterKey = groupIds.join(',');
  const queryParams = {
    rangeType,
    ...(rangeType === 'custom' ? { startDate, endDate } : {}),
    scopeGroupIds: clusterKey,
  };

  // Fetch all constituent group details in parallel
  const results = useQueries({
    queries: groupIds.map((id) =>
      getGetGroupDetailQueryOptions(id, queryParams, {
        query: {
          queryKey: getGetGroupDetailQueryKey(id, queryParams),
          refetchInterval: (q: any) =>
            q.state.status === 'error' || q.state.data?.usageHealth ? false : 8000,
        },
      }),
    ),
  });

  // Single cluster-projects query: exact figures via creator attribution (no scaling)
  const clusterProjectsQuery = useQuery(
    getGetClusterProjectsQueryOptions(clusterKey, queryParams, {
      query: {
        queryKey: getGetClusterProjectsQueryKey(clusterKey, queryParams),
        refetchInterval: (q: any) =>
          q.state.status === 'error' || q.state.data?.usageHealth ? false : 8000,
        enabled: groupIds.length > 0,
      },
    }),
  );
  const clusterProjectsData = clusterProjectsQuery.data;
  const { data: clusterHeadline } = useGetCanonicalClusterHeadline(clusterKey, queryParams, {
    query: {
      queryKey: getGetCanonicalClusterHeadlineQueryKey(clusterKey, queryParams),
      refetchInterval: (q: any) =>
        q.state.status === 'error' || q.state.data?.usageHealth ? false : 8000,
      enabled: groupIds.length > 0,
    },
  });
  const allLoaded = results.every((r) => !r.isLoading);
  const allComplete = results.every((r) =>
    r.data?.usageHealth.status === 'complete' || r.data?.usageHealth.status === 'stale',
  );
  const projectsComplete = clusterProjectsData?.usageHealth.status === 'complete' ||
    clusterProjectsData?.usageHealth.status === 'stale';

  // Build a map of groupId → sub-group role by parsing the fetched group names
  const groupRoleMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of results) {
      if (!r.data) continue;
      const { group } = r.data;
      const parsed = parseRoleSuffix(group.name);
      m[group.groupId] = parsed?.role ?? normalizeRole(group.type);
    }
    return m;
  }, [results]);

  // Merge members across all constituent groups
  const { mergedMembers, totalMembersSpend, totalUnattributedSpend, rangeLabel } =
    useMemo(() => {
      const memberMap = new Map<string, MergedMember>();
      // Track which users have been seen so spend is only counted once per person,
      // even if they appear in multiple sub-groups (Admin + Member, etc.).
      const seenUserIds = new Set<string>();
      let totalMembersSpend = 0;
      // Use per-group unattributed from the API (deleted users / shared costs) rather
      // than deriving it from raw group totals, which would inflate the figure.
      let totalUnattributedSpend = 0;
      let rangeLabel = '';

      for (const r of results) {
        if (!r.data) continue;
        const { members, unattributedSpendUsd } = r.data;
        rangeLabel = r.data.rangeLabel ?? '';
        const subRole = groupRoleMap[r.data.group.groupId] ?? 'Member';

        totalUnattributedSpend += unattributedSpendUsd ?? 0;

        for (const m of members) {
          const existing = memberMap.get(m.userId);
          const spendLoaded = m.spendUsd != null;
          const spend = m.spendUsd ?? 0;
          if (!existing) {
            memberMap.set(m.userId, {
              userId: m.userId,
              username: m.username ?? null,
              email: m.email ?? null,
              name: m.name ?? null,
              role: subRole,
              allRoles: [subRole],
              spendUsd: spend,
              spendLoaded,
            });
            seenUserIds.add(m.userId);
          } else {
            // Update to highest-privilege role; spend is NOT added again —
            // the same person's usage is already reflected from their first sub-group.
            const bestRole = higherRole(existing.role, subRole);
            if (!existing.allRoles.includes(subRole)) existing.allRoles.push(subRole);
            existing.role = bestRole;
            existing.spendLoaded = existing.spendLoaded && spendLoaded;
            existing.spendUsd += spend;
          }
        }
      }

      // Sum member spends after deduplication
      for (const m of memberMap.values()) {
        totalMembersSpend += m.spendUsd;
      }

      return {
        mergedMembers: [...memberMap.values()].sort((a, b) => b.spendUsd - a.spendUsd),
        totalMembersSpend,
        totalUnattributedSpend,
        rangeLabel,
      };
    }, [results, groupRoleMap]);

  const clusterAttributedTotal = clusterHeadline?.spendUsd ?? 0;
  const clusterSpendLoaded = clusterHeadline?.usageHealth.status !== 'empty';

  const sortedRoleLabels = useMemo(() => {
    const roles = new Set(Object.values(groupRoleMap));
    return [...roles].sort((a, b) => (ROLE_PRIORITY[a] ?? 99) - (ROLE_PRIORITY[b] ?? 99));
  }, [groupRoleMap]);

  // Project data comes directly from the cluster-projects endpoint (creator-attributed, no scaling).
  const mergedProjects: ClusterProject[] = clusterProjectsData?.projects ?? [];
  const projectsUnattributedSpend = clusterProjectsData?.unattributedSpendUsd ?? 0;

  const firstGroupData = results.find((r) => r.data)?.data;
  const workspaceId = firstGroupData?.group.workspaceId;

  const workspaceMembersQuery = useListVisibleWorkspaceMembers(workspaceId as string, {
    query: {
      enabled: !!workspaceId,
      queryKey: workspaceId ? getListVisibleWorkspaceMembersQueryKey(workspaceId) : ['workspaceMembers', ''],
      refetchInterval: (query) => {
        if (query.state.status === 'error') return false;
        const response = query.state.data;
        if (!response || response.connector.status !== 'available') return false;
        return response.members.some(
          (member) => member.budgetUsd !== null && member.usageUsd === null,
        ) ? 8000 : false;
      },
    },
  });
  const workspaceMembersData = workspaceMembersQuery.data;
  const canReviewUsageLimitHistory = realRole === 'account_admin';
  const usageLimitAuditsQuery = useListWorkspaceUsageLimitAudits(workspaceId as string, {
    query: {
      enabled: Boolean(workspaceId && canReviewUsageLimitHistory),
      queryKey: workspaceId
        ? getListWorkspaceUsageLimitAuditsQueryKey(workspaceId)
        : ['workspaceUsageLimitAudits', ''],
    },
  });

  const workspaceMembersMap = useMemo(() => {
    return indexMemberBudgets<WorkspaceMemberBudget>(
      mergedMembers,
      workspaceMembersData?.members ?? [],
    );
  }, [mergedMembers, workspaceMembersData]);
  const connectorUnavailable =
    workspaceMembersData?.connector.status === 'unavailable' ||
    workspaceMembersData?.connector.status === 'error';
  const mutationUnavailable =
    canWrite &&
    workspaceMembersData?.connector.status === 'available' &&
    !workspaceMembersData.connector.canWrite;
  const canEditLimits = Boolean(
    canWrite &&
    workspaceId &&
    workspaceMembersData?.connector.status === 'available' &&
    workspaceMembersData.connector.canWrite,
  );
  const editingDisabledReason = mutationUnavailable || connectorUnavailable || workspaceMembersQuery.isError
    ? 'Ask your workspace admin to enable the approved Replit integration with write:budgets permission.'
    : !workspaceMembersData
      ? 'Checking Replit integration permissions…'
      : undefined;
  const displayedMemberIds = useMemo(
    () => mergedMembers.map((member) => member.userId),
    [mergedMembers],
  );
  const allDisplayedSelected =
    displayedMemberIds.length > 0 &&
    displayedMemberIds.every((userId) => selectedMemberIds.has(userId));
  const someDisplayedSelected =
    displayedMemberIds.some((userId) => selectedMemberIds.has(userId));
  const displayedSelectedCount =
    displayedMemberIds.filter((userId) => selectedMemberIds.has(userId)).length;

  const applyBulkLimit = async () => {
    const amountUsd = Number(bulkLimit);
    if (!workspaceId || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      toast({
        title: 'Invalid usage limit',
        description: 'Enter a positive USD amount.',
        variant: 'destructive',
      });
      return;
    }
    const userIds = displayedMemberIds.filter((userId) => selectedMemberIds.has(userId));
    if (userIds.length === 0) return;
    setBulkApplying(true);
    const outcomes: Array<{ userId: string; success: boolean }> = [];
    let lastError: unknown;
    for (const batch of chunkMemberIds(userIds)) {
      try {
        const result = await bulkSetLimits.mutateAsync({
          workspaceId,
          data: { userIds: batch, amountUsd },
        });
        outcomes.push(...result.outcomes);
      } catch (error) {
        lastError = error;
        outcomes.push(...batch.map((userId) => ({ userId, success: false })));
      }
    }
    const failed = failedBulkSelection(outcomes);
    const succeeded = outcomes.length - failed.size;
    setSelectedMemberIds(failed);
    if (succeeded > 0) {
      await queryClient.invalidateQueries({
        queryKey: getListVisibleWorkspaceMembersQueryKey(workspaceId),
      });
      await queryClient.invalidateQueries({
        queryKey: getListWorkspaceUsageLimitAuditsQueryKey(workspaceId),
      });
    }
    setBulkApplying(false);
    toast({
      title: failed.size === 0
        ? `Updated ${succeeded} usage limit${succeeded === 1 ? '' : 's'}`
        : `Updated ${succeeded}; ${failed.size} failed`,
      description: failed.size === 0
        ? `Set selected members to $${amountUsd.toFixed(2)}.`
        : lastError instanceof Error
          ? `${lastError.message} Failed members remain selected so you can retry.`
          : 'Failed members remain selected so you can retry.',
      variant: failed.size === 0 ? 'default' : 'destructive',
    });
  };

  if (!allLoaded && results.every((r) => !r.data)) {
    return (
      <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
        <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
          <Link href="/" className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
            <ChevronLeft className="h-4 w-4" /> Back to Dashboard
          </Link>
        </div>
        <div className="h-10 w-64 bg-muted animate-pulse-glow rounded" />
        <div className="grid grid-cols-2 gap-3 md:gap-4">
          {[1, 2].map((i) => <div key={i} className="h-28 bg-muted animate-pulse-glow rounded" />)}
        </div>
        <div className="h-64 bg-muted animate-pulse-glow rounded mt-8" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
        <Link href="/" className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
          <ChevronLeft className="h-4 w-4" /> Back to Dashboard
        </Link>
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight flex items-center gap-3 flex-wrap">
            {clusterName}
            <div className="flex gap-1.5">
              {sortedRoleLabels.map((r) => (
                <span
                  key={r}
                  className={`inline-flex items-center border rounded px-2 py-0.5 text-[10px] font-medium ${roleBadgeClass(r)}`}
                >
                  {r}
                </span>
              ))}
            </div>
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            {firstGroupData?.group.workspaceName ? `Workspace: ${firstGroupData.group.workspaceName} • ` : ''}
            {mergedMembers.length} unique member{mergedMembers.length !== 1 ? 's' : ''}
            {rangeLabel ? ` • ${rangeLabel}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <GroupUserExport groupIds={groupIds} />
          <RangeFilter />
          {!allComplete && (
            <Badge variant="outline" className="flex items-center gap-2 shrink-0">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Syncing usage…
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Group Spend</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!clusterSpendLoaded ? (
              <div className="h-8 w-24 bg-muted animate-pulse-glow rounded" />
            ) : (
              <div className="text-2xl font-bold font-mono tabular-nums">
                ${clusterAttributedTotal.toFixed(2)}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Total spend used for allocations and alerts
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unique Members</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!allLoaded ? (
              <div className="h-8 w-24 bg-muted animate-pulse-glow rounded" />
            ) : (
              <div className="text-2xl font-bold font-mono tabular-nums">
                {mergedMembers.length}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Deduplicated across all roles
            </p>
          </CardContent>
        </Card>
      </div>

      {(workspaceMembersQuery.isError || connectorUnavailable || mutationUnavailable) && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm px-4 py-3 rounded-md flex items-start gap-3">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {mutationUnavailable ? 'Usage limit editing unavailable' : 'Member usage limits unavailable'}
            </p>
            <p className="text-xs opacity-90 mt-0.5">
               Reach out to your workspace admin to enable the approved Replit integration
              with <code>write:budgets</code> permission. No API key or token can be
              entered here.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Each person appears once. Role shows their highest privilege across{' '}
            {sortedRoleLabels.join(' / ')} sub-groups. Spend combines member AI with
            creator-attributed project hosting and other non-AI costs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canWrite && (
            <div className="mb-4 flex flex-col gap-2 rounded-md border bg-muted/20 p-3 sm:flex-row sm:items-center">
              <div className="text-sm font-medium min-w-fit">
                {displayedSelectedCount} selected
              </div>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={bulkLimit}
                onChange={(event) => setBulkLimit(event.target.value)}
                placeholder="Usage limit (USD)"
                aria-label="Bulk usage limit in US dollars"
                className="sm:max-w-48"
                disabled={!canEditLimits || bulkApplying}
              />
              <Button
                onClick={applyBulkLimit}
                disabled={!canEditLimits || displayedSelectedCount === 0 || bulkApplying}
              >
                {bulkApplying ? 'Applying…' : 'Apply usage limit'}
              </Button>
              <span className="text-xs text-muted-foreground">
                {editingDisabledReason ??
                  'Applies one workspace-scoped Agent limit to each selected member.'}
              </span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {canWrite && (
                    <th className="w-10 py-3 pl-4">
                      <Checkbox
                        checked={allDisplayedSelected ? true : someDisplayedSelected ? 'indeterminate' : false}
                        onCheckedChange={(checked) =>
                          setSelectedMemberIds((current) =>
                            toggleDisplayedSelection(current, displayedMemberIds, checked === true),
                          )
                        }
                        aria-label="Select all displayed members"
                        disabled={!canEditLimits || bulkApplying}
                      />
                    </th>
                  )}
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Role</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Usage limit</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Spend</th>
                </tr>
              </thead>
              <tbody>
                {mergedMembers.map((member) => {
                  const wsm = workspaceMembersMap.get(member.userId);
                  const hasConnector = workspaceMembersData?.connector.status === 'available';
                  return (
                    <tr
                      key={member.userId}
                      className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                    >
                      {canWrite && (
                        <td className="py-3 pl-4 align-middle">
                          <Checkbox
                            checked={selectedMemberIds.has(member.userId)}
                            onCheckedChange={(checked) =>
                              setSelectedMemberIds((current) => {
                                const next = new Set(current);
                                if (checked === true) next.add(member.userId);
                                else next.delete(member.userId);
                                return next;
                              })
                            }
                            aria-label={`Select ${member.name || member.username || member.userId}`}
                            disabled={!canEditLimits || bulkApplying}
                          />
                        </td>
                      )}
                      <td className="py-3 px-4 align-middle">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">
                            {member.name || member.username || member.userId}
                          </span>
                          <span className="text-xs text-muted-foreground">{member.email || '—'}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 align-middle">
                        <div className="flex flex-wrap gap-1">
                          <span
                            className={`inline-flex items-center border rounded px-2 py-0.5 text-[10px] font-medium ${roleBadgeClass(member.role)}`}
                          >
                            {member.role}
                          </span>
                          {member.allRoles.length > 1 &&
                            member.allRoles
                              .filter((r) => r !== member.role)
                              .map((r) => (
                                <span
                                  key={r}
                                  className={`inline-flex items-center border rounded px-2 py-0.5 text-[10px] font-medium opacity-60 ${roleBadgeClass(r)}`}
                                >
                                  {r}
                                </span>
                              ))}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right align-middle w-32">
                        {workspaceMembersQuery.isLoading ? (
                          <div className="flex justify-end"><LoadingCell /></div>
                        ) : hasConnector && workspaceId ? (
                          <MemberBudgetInput
                            workspaceId={workspaceId}
                            userId={member.userId}
                            currentBudget={wsm?.budgetUsd ?? null}
                            canWrite={canWrite && workspaceMembersData.connector.canWrite}
                            disabledReason={editingDisabledReason}
                          />
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right align-middle">
                        {!member.spendLoaded ? (
                          <div className="flex justify-end">
                            <LoadingCell />
                          </div>
                        ) : (
                          <span className="text-sm font-mono tabular-nums">
                            ${member.spendUsd.toFixed(2)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {allComplete && totalUnattributedSpend > 0.005 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    {canEditLimits && <td className="py-3 pl-4" />}
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed residual</span>
                        <span className="text-xs text-muted-foreground">
                          Usage not assignable to a current displayed member
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">
                        ${totalUnattributedSpend.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  {canEditLimits && <td className="py-3 pl-4" />}
                  <td className="py-3 px-4 text-sm">Combined Total</td>
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4 text-right">
                    {!allComplete || !clusterSpendLoaded ? (
                      <div className="flex justify-end">
                        <LoadingCell />
                      </div>
                    ) : (
                      <span className="text-sm font-mono tabular-nums">
                        ${(totalMembersSpend + totalUnattributedSpend).toFixed(2)}
                      </span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>

            {mergedMembers.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                {allLoaded ? 'No members found.' : 'Loading members...'}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {canReviewUsageLimitHistory && workspaceId && (
        <Card>
          <CardHeader>
            <CardTitle>Usage Limit History</CardTitle>
            <CardDescription>
              Account administrator audit trail for changes in this workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usageLimitAuditsQuery.isLoading ? (
              <div className="h-16 bg-muted animate-pulse-glow rounded" />
            ) : usageLimitAuditsQuery.isError ? (
              <p className="text-sm text-destructive">Usage limit history could not be loaded.</p>
            ) : usageLimitAuditsQuery.data?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">When</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Operator</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Change</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageLimitAuditsQuery.data.map((entry) => (
                      <tr key={entry.id} className="border-b border-border/50">
                        <td className="py-3 px-4 text-sm whitespace-nowrap">
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          <div>{entry.operatorName || entry.operatorEmail || entry.operatorUserId}</div>
                          {entry.operatorName && entry.operatorEmail && (
                            <div className="text-xs text-muted-foreground">{entry.operatorEmail}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          <div>{entry.memberName || entry.memberEmail || entry.memberUserId}</div>
                          {entry.memberName && entry.memberEmail && (
                            <div className="text-xs text-muted-foreground">{entry.memberEmail}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          {entry.action === 'clear'
                            ? 'Cleared limit'
                            : `${entry.operation === 'bulk' ? 'Bulk set' : 'Set'} to $${entry.requestedAmountUsd!.toFixed(2)}`}
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={entry.outcome === 'success' ? 'outline' : 'destructive'}>
                            {entry.outcome === 'success' ? 'Succeeded' : 'Failed'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No usage limit changes recorded yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
            <CardTitle>Project-Attributed Spend</CardTitle>
          <CardDescription>
            Project attribution by creator. These rows explain project ownership and are not expected to reconcile to the canonical rollup total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Project</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Total</th>
                </tr>
              </thead>
              <tbody>
                {!projectsComplete && mergedProjects.length === 0 ? (
                  [1, 2, 3].map((i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-3 px-4"><LoadingCell /></td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex justify-end"><LoadingCell /></div>
                      </td>
                    </tr>
                  ))
                ) : (
                  mergedProjects.map((project) => (
                      <tr key={project.projectId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {project.title ?? <span className="italic text-muted-foreground">Untitled</span>}
                            </span>
                            {project.workspaceName && (
                              <span className="text-xs text-muted-foreground mt-0.5">{project.workspaceName}</span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums font-medium">
                            ${project.totalCostUsd.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))
                )}

                {projectsUnattributedSpend > 0 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed Spend</span>
                        <span className="text-xs text-muted-foreground">Creator not in this team or unknown</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">${projectsUnattributedSpend.toFixed(2)}</span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  <td className="py-3 px-4 text-sm">Total</td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      ${mergedProjects.reduce((s, p) => s + p.totalCostUsd, 0).toFixed(2)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>

            {projectsComplete && mergedProjects.length === 0 && projectsUnattributedSpend === 0 && (
              <div className="text-center py-12 text-muted-foreground">No project spend found.</div>
            )}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
