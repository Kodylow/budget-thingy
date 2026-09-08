import { useEffect, useState } from 'react';
import { Link, useSearch } from 'wouter';
import {
  getGetClusterProjectsQueryKey,
  getGetReportingDetailQueryKey,
  getListWorkspaceUsageLimitAuditsQueryKey,
  useGetClusterProjects,
  useGetReportingDetail,
  useListWorkspaceUsageLimitAudits,
  type DirectoryRole,
  type GroupProjectsResponse,
} from '@workspace/api-client-react';
import { useRange } from '@/components/range-context';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import { Button } from '@/components/ui/button';
import { AlertCircle, ChevronLeft } from 'lucide-react';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';
import { roleBadgeClass, roleLabel } from '@/lib/hierarchy-presentation';
import { GroupUserExport } from '@/components/group-user-export';
import { useAuthContext } from '@/components/auth-context';
import { InternalUserBadge } from '@/components/internal-user-badge';
import { MetricCard } from '@/components/journey-primitives';
import { sanitizeSpendReturnTo } from '@/lib/spend-exploration';
import { isBlockingQueryError, isReportingUsageRefreshing } from '@/lib/errors';

function errorStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

function parseGroupIds(search: string) {
  const raw = new URLSearchParams(search).get('ids') ?? '';
  return [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 32);
}

function BackLink() {
  const search = useSearch();
  const returnTo = new URLSearchParams(search).get('returnTo');
  const backHref = sanitizeSpendReturnTo(returnTo, '/my-team');
  return (
    <Link
      href={backHref}
      className="flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      data-testid="link-cluster-detail-back"
    >
      <ChevronLeft className="h-4 w-4" /> Back
    </Link>
  );
}

function DetailUnavailable() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8" data-testid="cluster-detail-unavailable">
      <BackLink />
      <Card className="border-dashed shadow-none">
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <AlertCircle className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Cluster unavailable</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            Choose a visible group cluster from the dashboard or check that the requested groups are in your scope.
          </p>
        </div>
      </Card>
    </div>
  );
}

function DetailLoading() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8">
      <BackLink />
      <div className="h-10 w-64 animate-pulse-glow rounded bg-muted" />
      <div className="grid gap-4 md:grid-cols-2">
        {[1, 2].map((i) => <div key={i} className="h-32 animate-pulse-glow rounded-md border bg-card" />)}
      </div>
      <div className="h-64 animate-pulse-glow rounded-md border bg-card" />
    </div>
  );
}

function LoadError({ retry }: { retry: () => void }) {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8">
      <BackLink />
      <Card className="border-dashed shadow-none">
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <h1 className="text-xl font-semibold">Couldn&apos;t load cluster details</h1>
          <p className="text-sm text-muted-foreground">The reporting service is temporarily unavailable.</p>
          <Button variant="outline" onClick={retry} data-testid="button-retry-cluster-detail">Retry</Button>
        </div>
      </Card>
    </div>
  );
}

export default function ClusterDetail() {
  const search = useSearch();
  const groupIds = parseGroupIds(search);
  const clusterKey = groupIds.join(',');
  const { rangeType, startDate, endDate } = useRange();
  const { capabilities, authorizationKey } = useAuthContext();
  const [historyClusterKey, setHistoryClusterKey] = useState<string | null>(null);
  const [auditCursors, setAuditCursors] = useState<Array<number | undefined>>([undefined]);
  const showHistory = historyClusterKey === clusterKey;
  const detailParams = { rangeType, ...(rangeType === 'custom' ? { startDate, endDate } : {}) };
  const detailQueryKey = [...getGetReportingDetailQueryKey(clusterKey, detailParams), authorizationKey];
  const projectParams = { ...detailParams, scopeGroupIds: clusterKey };
  const detailQuery = useGetReportingDetail(clusterKey, detailParams, {
    query: {
      enabled: groupIds.length > 0,
      queryKey: detailQueryKey,
      placeholderData: (previous, previousQuery) =>
        JSON.stringify(previousQuery?.queryKey) === JSON.stringify(detailQueryKey)
          ? previous
          : undefined,
    },
  });
  const projectsQueryKey = [...getGetClusterProjectsQueryKey(clusterKey, projectParams), authorizationKey];
  const projectsQuery = useGetClusterProjects(clusterKey, projectParams, {
    query: {
      enabled: groupIds.length > 0,
      queryKey: projectsQueryKey,
      placeholderData: (previous, previousQuery) =>
        JSON.stringify(previousQuery?.queryKey) === JSON.stringify(projectsQueryKey)
          ? previous
          : undefined,
    },
  });
  const rawData = detailQuery.data;
  const workspaceIds = [...new Set(rawData?.sourceGroups.map((group) => group.workspaceId) ?? [])];
  const auditWorkspaceId = workspaceIds.length === 1 ? workspaceIds[0] : undefined;
  const canReviewHistory = capabilities.canManageAccess && Boolean(auditWorkspaceId);
  const auditBeforeId = auditCursors[auditCursors.length - 1];
  const auditParams = auditBeforeId === undefined ? {} : { beforeId: auditBeforeId };
  useEffect(() => {
    setAuditCursors([undefined]);
  }, [clusterKey, auditWorkspaceId]);
  const auditsQuery = useListWorkspaceUsageLimitAudits(auditWorkspaceId ?? '', auditParams, {
    query: {
      enabled: Boolean(showHistory && canReviewHistory),
      queryKey: auditWorkspaceId
          ? [...getListWorkspaceUsageLimitAuditsQueryKey(auditWorkspaceId, auditParams), authorizationKey]
        : ['workspaceUsageLimitAudits', ''],
    },
  });
  const status = errorStatus(detailQuery.error);
  const detailRefreshPending = isReportingUsageRefreshing(detailQuery.failureReason ?? detailQuery.error);
  const detailBlocked = isBlockingQueryError(detailQuery.error);
  const displayData = detailBlocked ? undefined : rawData;

  if (groupIds.length === 0 || ([401, 403, 404].includes(status ?? 0) && detailQuery.isError)) return <DetailUnavailable />;
  if (!displayData && (detailQuery.isLoading || detailRefreshPending)) return <DetailLoading />;
  if (!displayData) return <LoadError retry={() => void detailQuery.refetch()} />;

  const data = displayData;
  const roleByGroupId = new Map(data.sourceGroups.map((group) => [group.groupId, group.role]));
  const roles = [...new Set(data.groups.map((group) => group.role))];
  const workspaceNameById = new Map(data.sourceGroups.map((group) => [group.workspaceId, group.workspaceName]));
  const members = [...data.members].sort((a, b) => b.spendUsd - a.spendUsd);
  const hasSelectedObservations = data.metadata.status !== 'empty';
  const projectsDenied = projectsQuery.isError && [401, 403, 404].includes(errorStatus(projectsQuery.error) ?? 0);
  const projectsBlocked = isBlockingQueryError(projectsQuery.error);
  const projectsData = projectsBlocked ? undefined : projectsQuery.data;
  const projectsRefreshing = isReportingUsageRefreshing(projectsQuery.failureReason ?? projectsQuery.error);
  const auditsDenied = auditsQuery.isError && [403, 404].includes(errorStatus(auditsQuery.error) ?? 0);
  const auditsData = isBlockingQueryError(auditsQuery.error) ? undefined : auditsQuery.data;
  const auditsRefreshing = isReportingUsageRefreshing(auditsQuery.failureReason ?? auditsQuery.error);
  const manageContexts = workspaceIds.flatMap((workspaceId) => {
    if (!capabilities.canWriteUserLimitsIn.includes(workspaceId)) return [];
    return [{
      workspaceId,
      groupIds: data.sourceGroups.filter((group) => group.workspaceId === workspaceId).map((group) => group.groupId),
    }];
  });

  return (
    <div className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8" data-testid="page-cluster-detail">
      <BackLink />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="flex flex-wrap items-center gap-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {data.headline.familyName}
            {(data.metadata.stale || data.metadata.status !== 'complete') && (
              <Badge
                variant="outline"
                className="text-muted-foreground"
                data-testid="status-cluster-detail-qualified"
              >
                {data.metadata.stale || data.metadata.status === 'stale' ? 'Stale data' : data.metadata.status === 'partial' ? 'Partial data' : 'No observations'}
              </Badge>
            )}
            <span className="flex gap-1.5">
              {roles.map((role) => (
                <span key={role} className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${roleBadgeClass(role)}`}>
                  {roleLabel(role)}
                </span>
              ))}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {workspaceIds.length === 1 ? `Workspace: ${workspaceNameById.get(workspaceIds[0]) || '—'} • ` : `${workspaceIds.length} workspaces • `}
            {members.length} member{members.length !== 1 ? 's' : ''} • {data.period.label}
          </p>
          {data.metadata.qualifications.length > 0 && (
            <AdminDataQualityNote title="Team data">
              <p data-testid="text-cluster-detail-qualifications">
              {data.metadata.qualifications.join(' ')}
              </p>
            </AdminDataQualityNote>
          )}
        </div>
        <div className="flex shrink-0 flex-col flex-wrap items-stretch gap-2 sm:flex-row sm:items-center">
          {manageContexts.map((context) => (
            <Link
              key={context.workspaceId}
              href={`/limits?workspaceId=${encodeURIComponent(context.workspaceId)}&groupIds=${encodeURIComponent(context.groupIds.join(','))}`}
              className="inline-flex h-10 sm:h-9 w-full sm:w-auto items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
              data-testid={`link-manage-people-budgets-${context.workspaceId}`}
            >
              Manage limits{manageContexts.length > 1 ? ` (${workspaceNameById.get(context.workspaceId) || context.workspaceId})` : ''}
            </Link>
          ))}
          <div className="w-full sm:w-auto flex justify-start">
            <GroupUserExport groupIds={groupIds} />
          </div>
          <div className="w-full sm:w-auto">
            <RangeFilter />
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard
          label="Group spend"
          value={hasSelectedObservations ? `$${data.headline.spendUsd.toFixed(2)}` : '—'}
          detail="Allocation and alert basis"
        />
        <MetricCard
          label="Members"
          value={members.length.toString()}
          detail="Workspace-qualified across all roles"
        />
      </div>

      <Card className="overflow-hidden rounded-md shadow-none">
        <CardHeader className="gap-1 border-b pb-4">
          <CardTitle className="text-lg">Members</CardTitle>
          <CardDescription>
            One row per workspace member across {roles.map(roleLabel).join(' / ')} roles.
            Limit, Agent spend and remaining columns use the current billing cycle; total spend uses the selected period.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[980px] [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-3">
              <TableHeader className="bg-muted/50 text-xs">
                <TableRow className="border-b border-border">
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Current-cycle limit</TableHead>
                  <TableHead className="text-right">Current-cycle Agent spend</TableHead>
                  <TableHead className="text-right">Current-cycle remaining</TableHead>
                  <TableHead className="text-right">Selected total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const memberSourceGroups = data.sourceGroups.filter((source) =>
                    source.workspaceId === member.workspaceId && member.groupIds.includes(source.groupId),
                  );
                  const memberRoles = [...new Set(member.groupIds.map((id) => roleByGroupId.get(id)).filter((role): role is DirectoryRole => Boolean(role)))];
                  const canWriteMemberLimit = capabilities.canWriteUserLimitsIn.includes(member.workspaceId);
                  const blocked = !member.isInternal
                    && member.limitUsd != null
                    && member.currentCycleAgentSpendUsd != null
                    && member.currentCycleAgentSpendUsd >= member.limitUsd;
                  const observationStale = member.limitObservationStatus === 'failed' || member.limitObservationStatus === 'refreshing';
                  return (
                    <TableRow key={`${member.workspaceId}:${member.userId}`} >
                      <TableCell className="align-middle">
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium break-words overflow-hidden">{member.name || member.username || member.userId}</span>
                          {member.isInternal && <InternalUserBadge />}
                          <span className="text-xs text-muted-foreground break-words">{member.email || '—'}</span>
                          {workspaceIds.length > 1 && <span className="text-xs text-muted-foreground">{workspaceNameById.get(member.workspaceId) || member.workspaceId}</span>}
                          {canWriteMemberLimit && memberSourceGroups.length > 0 && (
                            <Link
                              href={`/limits?workspaceId=${encodeURIComponent(member.workspaceId)}&groupIds=${encodeURIComponent(memberSourceGroups.map((source) => source.groupId).join(','))}`}
                              className="mt-1 w-fit text-xs text-primary hover:underline inline-flex min-h-[44px] sm:min-h-0 items-center py-2 sm:py-0"
                              data-testid={`link-manage-member-limit-${member.workspaceId}-${member.userId}`}
                            >
                              Manage limit
                            </Link>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-middle">
                        <div className="flex flex-wrap gap-1">
                          {memberRoles.map((role, index) => (
                            <span key={role} className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${index ? 'opacity-60' : ''} ${roleBadgeClass(role)}`}>
                              {roleLabel(role)}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="align-middle">
                        {member.isInternal
                          ? <span className="text-sm text-muted-foreground">Excluded</span>
                          : member.isDisabled
                            ? <span className="text-sm text-muted-foreground">Disabled</span>
                            : member.currentCycleAgentSpendUsd == null || member.limitState === 'unavailable'
                              ? <span className="text-sm text-muted-foreground">Unknown</span>
                              : blocked
                          ? <Badge variant="destructive" className="uppercase text-[10px]" data-testid={`badge-blocked-${member.workspaceId}-${member.userId}`}>Blocked</Badge>
                          : <span className="text-sm text-muted-foreground">Active</span>}
                      </TableCell>
                      <TableCell className="w-32 text-right align-middle">
                        {member.limitState === 'unavailable'
                          ? <span className="text-sm text-muted-foreground">Unavailable</span>
                          : member.limitUsd != null
                            ? <span className="font-mono text-sm tabular-nums">${member.limitUsd.toFixed(2)}{observationStale && <span className="ml-1 text-xs text-muted-foreground">stale</span>}</span>
                            : <span className="text-sm text-muted-foreground">{member.limitState === 'no_limit' ? 'Not set' : 'Unknown'}</span>}
                      </TableCell>
                      <TableCell className="text-right align-middle">
                        {member.currentCycleAgentSpendUsd == null ? <span className="text-sm text-muted-foreground">—</span> : <span className="font-mono text-sm tabular-nums">${member.currentCycleAgentSpendUsd.toFixed(2)}</span>}
                      </TableCell>
                      <TableCell className="text-right align-middle">
                        {member.remainingUsd == null ? <span className="text-sm text-muted-foreground">—</span> : (
                          <span className={`font-mono text-sm tabular-nums ${member.remainingUsd <= 0 ? 'font-bold text-destructive' : ''}`}>
                            {member.remainingUsd < 0 ? '-' : ''}${Math.abs(member.remainingUsd).toFixed(2)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${member.spendUsd.toFixed(2)}` : '—'}</TableCell>
                    </TableRow>
                  );
                })}
                {hasSelectedObservations && data.headline.unattributedSpendUsd > 0.005 && (
                  <TableRow className="border-b border-border/50 bg-muted/10">
                    <TableCell className="">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium italic">Unattributed residual</span>
                        <span className="text-xs text-muted-foreground">Usage not assignable to a current displayed member</span>
                      </div>
                    </TableCell>
                    <TableCell colSpan={5} />
                    <TableCell className="text-right font-mono text-sm tabular-nums">${data.headline.unattributedSpendUsd.toFixed(2)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
              <tfoot>
                <TableRow className="border-t border-border bg-muted/30 font-medium">
                  <TableCell className="text-sm">Combined Total</TableCell>
                  <TableCell colSpan={5} />
                  <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${data.headline.spendUsd.toFixed(2)}` : '—'}</TableCell>
                </TableRow>
              </tfoot>
            </Table>
            {members.length === 0 && <div className="py-12 text-center text-muted-foreground">No members found.</div>}
          </div>
        </CardContent>
      </Card>

      {canReviewHistory && (
        <Card className="overflow-hidden rounded-md shadow-none">
          <CardHeader className="flex-row items-center justify-between gap-4 border-b pb-4">
            <div>
              <CardTitle className="text-lg">Limit change history</CardTitle>
              <CardDescription className="mt-1">Account administrator audit trail for changes in this workspace.</CardDescription>
            </div>
            {!showHistory && (
              <Button variant="outline" onClick={() => setHistoryClusterKey(clusterKey)} data-testid="button-load-limit-history">
                Load history
              </Button>
            )}
          </CardHeader>
          {showHistory && (
            <CardContent className="p-4">
              {auditsDenied ? (
                <p className="text-sm text-muted-foreground" data-testid="status-limit-history-unavailable">Limit history is no longer available.</p>
              ) : auditsRefreshing && !auditsData ? (
                <div className="h-16 animate-pulse-glow rounded bg-muted" />
              ) : auditsQuery.isError && !auditsData ? (
                <div className="flex items-center justify-between border border-destructive/30 bg-destructive/5 p-4 text-sm" data-testid="status-limit-history-error">
                  <span>Limit history couldn&apos;t be loaded.</span>
                  <Button variant="outline" size="sm" onClick={() => void auditsQuery.refetch()} data-testid="button-retry-limit-history">Retry</Button>
                </div>
              ) : auditsQuery.isLoading || !auditsData ? (
                <div className="h-16 animate-pulse-glow rounded bg-muted" />
              ) : auditsData.length ? (
                <div>
                  <p className="mb-3 text-xs text-muted-foreground" data-testid="text-limit-history-window">
                    Page {auditCursors.length} · up to 200 changes per page.
                  </p>
                  <div className="overflow-x-auto">
                   <Table className="min-w-[720px] [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-3">
                     <TableHeader className="bg-muted/50">
                      <TableRow className="border-b border-border">
                        {['When', 'Operator', 'Member', 'Change', 'Outcome'].map((heading) => <th key={heading} className="text-left text-xs font-medium text-muted-foreground">{heading}</th>)}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {auditsData.map((entry) => (
                        <TableRow key={entry.id} >
                          <TableCell className="whitespace-nowrap text-sm">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                          <TableCell className="text-sm">{entry.operatorName || entry.operatorEmail || entry.operatorUserId}</TableCell>
                          <TableCell className="text-sm">{entry.memberName || entry.memberEmail || entry.memberUserId}</TableCell>
                          <TableCell className="text-sm">{entry.action === 'clear' ? 'Cleared limit' : `${entry.operation === 'bulk' ? 'Bulk set' : 'Set'} to $${entry.requestedAmountUsd!.toFixed(2)}`}</TableCell>
                          <TableCell className=""><Badge variant={entry.outcome === 'success' ? 'outline' : 'destructive'}>{entry.outcome === 'success' ? 'Succeeded' : 'Failed'}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button
                      variant="outline"
                      className="min-h-[44px] sm:min-h-[36px]"
                      disabled={auditCursors.length === 1 || auditsQuery.isFetching}
                      onClick={() => setAuditCursors((current) => current.slice(0, -1))}
                      data-testid="button-previous-limit-history"
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      className="min-h-[44px] sm:min-h-[36px]"
                      disabled={auditsQuery.isFetching || auditsData.length < 200}
                      onClick={() => setAuditCursors((current) => [
                        ...current,
                        auditsData.at(-1)?.id,
                      ])}
                      data-testid="button-next-limit-history"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">
                    {auditBeforeId ? 'No older usage limit changes.' : 'No usage limit changes recorded yet.'}
                  </p>
                  {auditCursors.length > 1 && (
                    <Button
                      className="mt-3 min-h-[44px] sm:min-h-[36px]"
                      variant="outline"
                      onClick={() => setAuditCursors((current) => current.slice(0, -1))}
                    >
                      Previous
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      <Card className="overflow-hidden rounded-md shadow-none">
        <CardHeader className="gap-1 border-b pb-4">
          <CardTitle className="text-lg">Project-Attributed Spend</CardTitle>
          <AdminDataQualityNote title="Team project attribution"><p>
            Project attribution by creator. These rows explain project ownership and are not expected to reconcile to the canonical rollup total.
          </p></AdminDataQualityNote>
        </CardHeader>
        <CardContent className="p-0">
          {projectsDenied ? (
            <p className="text-sm text-muted-foreground" data-testid="status-cluster-projects-unavailable">Projects are unavailable for this cluster.</p>
          ) : projectsRefreshing && !projectsData ? (
            <ProjectsTable data={undefined} />
          ) : projectsQuery.isError && !projectsData ? (
            <div className="flex items-center justify-between border border-destructive/30 bg-destructive/5 p-4 text-sm" data-testid="status-cluster-projects-error">
              <span>Projects couldn&apos;t be loaded. Headline and member totals remain available.</span>
              <Button variant="outline" size="sm" onClick={() => void projectsQuery.refetch()} data-testid="button-retry-cluster-projects">Retry</Button>
            </div>
          ) : (
            <ProjectsTable data={projectsData} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectsTable({ data }: { data: GroupProjectsResponse | undefined }) {
  const projects = data?.projects ?? [];
  const incomplete = data && (data.usageHealth.status !== 'complete' || !data.titlesComplete);
  return (
    <div className="overflow-x-auto">
      {incomplete && (
        <AdminDataQualityNote title="Team project coverage"><p data-testid="status-cluster-projects-partial">
          Project details are partial{!data.titlesComplete ? '; some titles are unavailable' : ''}.
        </p></AdminDataQualityNote>
      )}
      <Table className="[&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-3">
        <TableHeader className="bg-muted/50 text-xs">
          <TableRow className="border-b border-border">
            <TableHead>Project</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data ? [1, 2, 3].map((i) => (
            <TableRow key={i} >
              <TableCell className=""><LoadingCell /></TableCell>
              <TableCell className="text-right"><div className="flex justify-end"><LoadingCell /></div></TableCell>
            </TableRow>
          )) : projects.map((project) => (
            <TableRow key={project.projectId} >
              <TableCell className="">
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium break-words overflow-hidden">
                    {project.title ?? <span className="italic text-muted-foreground">{data.titlesComplete ? 'Untitled' : 'Title unavailable'}</span>}
                  </span>
                  {project.workspaceName && <span className="mt-0.5 text-xs text-muted-foreground break-words">{project.workspaceName}</span>}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-sm font-medium tabular-nums">${project.totalCostUsd.toFixed(2)}</TableCell>
            </TableRow>
          ))}
          {data && data.unattributedSpendUsd > 0 && (
            <TableRow className="border-b border-border/50 bg-muted/10">
              <TableCell className="text-sm font-medium italic">Unattributed Spend</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">${data.unattributedSpendUsd.toFixed(2)}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data && data.usageHealth.status === 'complete' && data.titlesComplete && projects.length === 0 && data.unattributedSpendUsd === 0 && (
        <div className="py-12 text-center text-muted-foreground">No project spend found.</div>
      )}
    </div>
  );
}