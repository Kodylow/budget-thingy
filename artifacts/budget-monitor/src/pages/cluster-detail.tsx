import { useMemo } from 'react';
import { Link } from 'wouter';
import { useSearch } from 'wouter';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  getGetGroupDetailQueryOptions,
  getGetGroupDetailQueryKey,
  getGetClusterProjectsQueryOptions,
  getGetClusterProjectsQueryKey,
} from '@workspace/api-client-react';
import { useRange } from '@/components/range-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, RefreshCw, DollarSign, Users } from 'lucide-react';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';
import {
  parseRoleSuffix,
  normalizeRole,
  higherRole,
  roleBadgeClass,
  ROLE_PRIORITY,
} from '@/lib/group-clusters';

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
}

export default function ClusterDetail() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const rawIds = params.get('ids') ?? '';
  const clusterName = params.get('name') ?? 'Group Cluster';
  const groupIds = rawIds ? rawIds.split(',').filter(Boolean) : [];

  const { rangeType, startDate, endDate } = useRange();
  const queryParams = {
    rangeType,
    ...(rangeType === 'custom' ? { startDate, endDate } : {}),
  };

  // Fetch all constituent group details in parallel
  const results = useQueries({
    queries: groupIds.map((id) =>
      getGetGroupDetailQueryOptions(id, queryParams, {
        query: {
          queryKey: getGetGroupDetailQueryKey(id, queryParams),
          refetchInterval: (q: any) => (q.state.data?.isComplete ? false : 8000),
        },
      }),
    ),
  });

  // Single cluster-projects query: exact figures via creator attribution (no scaling)
  const clusterKey = groupIds.join(',');
  const clusterProjectsQuery = useQuery(
    getGetClusterProjectsQueryOptions(clusterKey, queryParams, {
      query: {
        queryKey: getGetClusterProjectsQueryKey(clusterKey, queryParams),
        refetchInterval: (q: any) => (q.state.data?.isComplete ? false : 8000),
        enabled: groupIds.length > 0,
      },
    }),
  );
  const clusterProjectsData = clusterProjectsQuery.data;
  const allLoaded = results.every((r) => !r.isLoading);
  const anyComplete = results.some((r) => r.data?.isComplete);
  const allComplete = results.every((r) => r.data?.isComplete);
  const projectsComplete = clusterProjectsData?.isComplete ?? false;

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
          const spend = m.spendLoaded ? (m.spendUsd ?? 0) : 0;
          if (!existing) {
            memberMap.set(m.userId, {
              userId: m.userId,
              username: m.username ?? null,
              email: m.email ?? null,
              name: m.name ?? null,
              role: subRole,
              allRoles: [subRole],
              spendUsd: spend,
              spendLoaded: m.spendLoaded,
            });
            seenUserIds.add(m.userId);
          } else {
            // Update to highest-privilege role; spend is NOT added again —
            // the same person's usage is already reflected from their first sub-group.
            const bestRole = higherRole(existing.role, subRole);
            if (!existing.allRoles.includes(subRole)) existing.allRoles.push(subRole);
            existing.role = bestRole;
            existing.spendLoaded = existing.spendLoaded && m.spendLoaded;
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

  // Cluster total comes from the sum of each constituent group's dedup-attributed
  // spend (group.spendUsd), not the sum of member rows.  Member rows show raw
  // workspace spend so every person's real usage is visible, but that can exceed
  // the dedup total when a member is also counted in another cluster — the
  // attributed group total is the authoritative budget-consistent figure.
  const { clusterAttributedTotal, clusterSpendLoaded } = useMemo(() => {
    let total = 0;
    let loaded = true;
    for (const r of results) {
      const g = r.data?.group;
      if (!g?.spendLoaded || g.spendUsd == null) { loaded = false; continue; }
      total += g.spendUsd;
    }
    return { clusterAttributedTotal: total, clusterSpendLoaded: loaded };
  }, [results]);

  const sortedRoleLabels = useMemo(() => {
    const roles = new Set(Object.values(groupRoleMap));
    return [...roles].sort((a, b) => (ROLE_PRIORITY[a] ?? 99) - (ROLE_PRIORITY[b] ?? 99));
  }, [groupRoleMap]);

  // Project data comes directly from the cluster-projects endpoint (creator-attributed, no scaling).
  const mergedProjects: ClusterProject[] = clusterProjectsData?.projects ?? [];
  const projectsUnattributedSpend = clusterProjectsData?.unattributedSpendUsd ?? 0;

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

  const firstGroupData = results.find((r) => r.data)?.data;

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
          <RangeFilter />
          {!allComplete && (
            <Badge variant="outline" className="flex items-center gap-2 shrink-0">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Loading usage...
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Spend</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tabular-nums">
              ${(totalMembersSpend + totalUnattributedSpend).toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Sum of each member's spend within this team
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unique Members</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!anyComplete ? (
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

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Each person appears once. Role shows their highest privilege across{' '}
            {sortedRoleLabels.join(' / ')} sub-groups.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Member</th>
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Role</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Spend</th>
                </tr>
              </thead>
              <tbody>
                {mergedMembers.map((member) => (
                  <tr
                    key={member.userId}
                    className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">
                          {member.name || member.username || member.userId}
                        </span>
                        <span className="text-xs text-muted-foreground">{member.email || '—'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
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
                    <td className="py-3 px-4 text-right">
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
                ))}

                {totalUnattributedSpend > 0.005 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed Spend</span>
                        <span className="text-xs text-muted-foreground">Deleted users or shared costs</span>
                      </div>
                    </td>
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
                  <td className="py-3 px-4 text-sm">Combined Total</td>
                  <td className="py-3 px-4" />
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      ${(totalMembersSpend + totalUnattributedSpend).toFixed(2)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>

            {mergedMembers.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                {anyComplete ? 'No members found.' : 'Loading members...'}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            Project spending for this team, attributed by project creator. Each project is counted once based on who created it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground py-3 px-4">Project</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">AI</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Hosting</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Storage</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Other</th>
                  <th className="text-right text-xs font-medium text-muted-foreground py-3 px-4">Total</th>
                </tr>
              </thead>
              <tbody>
                {!projectsComplete && mergedProjects.length === 0 ? (
                  [1, 2, 3].map((i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-3 px-4"><LoadingCell /></td>
                      {[1, 2, 3, 4, 5].map((cell) => (
                        <td key={cell} className="py-3 px-4 text-right">
                          <div className="flex justify-end"><LoadingCell /></div>
                        </td>
                      ))}
                    </tr>
                  ))
                ) : (
                  mergedProjects.map((project) => {
                    const spendForCategory = (category: string) =>
                      project.metrics
                        .filter((metric) => metric.category === category)
                        .reduce((sum, metric) => sum + metric.costUsd, 0);
                    const aiSpend = spendForCategory('ai');
                    const hostingSpend = spendForCategory('hosting');
                    const storageSpend = spendForCategory('storage');
                    // Compute "other" as the remainder so the breakdown always sums to the total.
                    const otherSpend = Math.max(0, project.totalCostUsd - aiSpend - hostingSpend - storageSpend);

                    return (
                      <tr key={project.projectId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {project.title ?? <span className="italic text-muted-foreground">Untitled</span>}
                            </span>
                          </div>
                        </td>
                        {['ai', 'hosting', 'storage'].map((category) => (
                          <td key={category} className="py-3 px-4 text-right">
                            {!projectsComplete ? (
                              <div className="flex justify-end"><LoadingCell /></div>
                            ) : (
                              <span className="text-sm font-mono tabular-nums">
                                {spendForCategory(category) > 0 ? `$${spendForCategory(category).toFixed(2)}` : '—'}
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="py-3 px-4 text-right">
                          {!projectsComplete ? (
                            <div className="flex justify-end"><LoadingCell /></div>
                          ) : (
                            <span className="text-sm font-mono tabular-nums">
                              {otherSpend > 0 ? `$${otherSpend.toFixed(2)}` : '—'}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className="text-sm font-mono tabular-nums font-medium">
                            ${project.totalCostUsd.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}

                {projectsUnattributedSpend > 0 && (
                  <tr className="border-b border-border/50 bg-muted/10">
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed Spend</span>
                        <span className="text-xs text-muted-foreground">Creator not in this team or unknown</span>
                      </div>
                    </td>
                    {[1, 2, 3, 4].map((cell) => (
                      <td key={cell} className="py-3 px-4 text-right">
                        <span className="text-sm text-muted-foreground">—</span>
                      </td>
                    ))}
                    <td className="py-3 px-4 text-right">
                      <span className="text-sm font-mono tabular-nums">${projectsUnattributedSpend.toFixed(2)}</span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-medium border-t border-border">
                  <td className="py-3 px-4 text-sm">Total</td>
                  {[1, 2, 3, 4].map((cell) => (
                    <td key={cell} className="py-3 px-4" />
                  ))}
                  <td className="py-3 px-4 text-right">
                    <span className="text-sm font-mono tabular-nums">
                      ${(mergedProjects.reduce((s, p) => s + p.totalCostUsd, 0) + projectsUnattributedSpend).toFixed(2)}
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
