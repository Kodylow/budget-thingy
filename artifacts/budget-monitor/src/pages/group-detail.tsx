import { Link, useLocation, useRoute, useSearch } from 'wouter';
import {
  getGetGroupProjectsQueryKey,
  getGetReportingDetailQueryKey,
  useGetGroupProjects,
  useGetReportingDetail,
  type GroupProjectsResponse,
} from '@workspace/api-client-react';
import { useRange } from '@/components/range-context';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertCircle, ChevronLeft, Info, RefreshCw, ShieldCheck } from 'lucide-react';
import { LoadingCell } from '@/components/loading-cell';
import { RangeFilter } from '@/components/range-filter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GroupUserExport } from '@/components/group-user-export';
import { useAuthContext } from '@/components/auth-context';
import { VirtualizedTableRows } from '@/components/virtualized-table-rows';
import { InternalSpendExplanation, InternalUserBadge } from '@/components/internal-user-badge';
import { BudgetMeter, StatusBadge, type JourneyStatus } from '@/components/journey-primitives';
import { isUnknownSpendTotal } from '@/lib/spend-presentation';
import { sanitizeSpendReturnTo } from '@/lib/spend-exploration';

function errorStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

function BackLink() {
  const search = useSearch();
  const returnTo = new URLSearchParams(search).get('returnTo');
  const backHref = sanitizeSpendReturnTo(returnTo, '/my-team');

  return (
    <Link
      href={backHref}
      className="flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      data-testid="link-group-detail-back"
    >
      <ChevronLeft className="h-4 w-4" /> Back to results
    </Link>
  );
}

function DetailUnavailable() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8" data-testid="group-detail-unavailable">
      <BackLink />
      <Card className="rounded-md border-dashed shadow-none">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <AlertCircle className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Group unavailable</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            This group does not exist or is outside your authorized account scope.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function DetailLoading() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">
      <BackLink />
      <div className="h-10 w-64 animate-pulse-glow rounded bg-muted" />
      <div className="grid gap-4 lg:grid-cols-[1.12fr_.88fr]">
        {[1, 2].map((i) => <div key={i} className="h-48 animate-pulse-glow rounded-md border bg-muted/50" />)}
      </div>
      <div className="h-64 animate-pulse-glow rounded-md border bg-muted/50" />
    </div>
  );
}

function LoadError({ retry }: { retry: () => void }) {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8">
      <BackLink />
      <Card className="rounded-md border-dashed shadow-none">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <h1 className="text-xl font-semibold">Couldn&apos;t load group details</h1>
          <p className="text-sm text-muted-foreground">The reporting service is temporarily unavailable.</p>
          <Button variant="outline" onClick={retry} data-testid="button-retry-group-detail">Retry</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function GroupDetail() {
  const [, params] = useRoute('/groups/:groupId');
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const groupId = params?.groupId ?? '';
  const { rangeType, startDate, endDate } = useRange();
  const { capabilities } = useAuthContext();
  const activeTab = new URLSearchParams(search).get('tab') === 'projects' ? 'projects' : 'members';
  const queryParams = { rangeType, ...(rangeType === 'custom' ? { startDate, endDate } : {}) };
  const detailQueryKey = getGetReportingDetailQueryKey(groupId, queryParams);
  const detailQuery = useGetReportingDetail(groupId, queryParams, {
    query: {
      enabled: Boolean(groupId),
      queryKey: detailQueryKey,
      placeholderData: (previous, previousQuery) =>
        previous?.kind === 'group' &&
        JSON.stringify(previousQuery?.queryKey) === JSON.stringify(detailQueryKey)
          ? previous
          : undefined,
    },
  });
  const projectsQuery = useGetGroupProjects(groupId, queryParams, {
    query: {
      enabled: Boolean(groupId) && activeTab === 'projects',
      queryKey: getGetGroupProjectsQueryKey(groupId, queryParams),
    },
  });
  const status = errorStatus(detailQuery.error);

  if (!groupId || ((status === 400 || status === 403 || status === 404) && detailQuery.isError)) return <DetailUnavailable />;
  if (!detailQuery.data && detailQuery.isLoading) return <DetailLoading />;
  if (!detailQuery.data) return <LoadError retry={() => void detailQuery.refetch()} />;

  const data = detailQuery.data;
  const group = data.groups[0];
  if (!group) return <DetailUnavailable />;
  const sortedMembers = [...data.members].sort((a, b) => b.spendUsd - a.spendUsd);
  const sourceWorkspaceIds = [...new Set(data.sourceGroups.map((source) => source.workspaceId))];
  const sourceWorkspaceNameById = new Map(data.sourceGroups.map((source) => [source.workspaceId, source.workspaceName]));
  const manageContexts = sourceWorkspaceIds.flatMap((workspaceId) => {
    if (!capabilities.canWriteUserLimitsIn.includes(workspaceId)) return [];
    return [{
      workspaceId,
      groupIds: data.sourceGroups.filter((source) => source.workspaceId === workspaceId).map((source) => source.groupId),
    }];
  });
  const hasSelectedObservations = data.metadata.status !== 'empty' && !isUnknownSpendTotal(data.metadata);
  const projectsDenied = projectsQuery.isError && [403, 404].includes(errorStatus(projectsQuery.error) ?? 0);
  const budgetStatus: JourneyStatus | null = data.headline.percentUsed == null
    ? null
    : data.headline.percentUsed >= 100
      ? 'Over budget'
      : data.headline.percentUsed >= 90
        ? 'Near limit'
        : 'Within budget';
  const setActiveTab = (value: string) => {
    const nextTab = value === 'projects' ? 'projects' : 'members';
    const nextSearch = new URLSearchParams(search);
    nextSearch.set('tab', nextTab);
    const serialized = nextSearch.toString();
    const pathname = location.split('?')[0];
    setLocation(serialized ? `${pathname}?${serialized}` : pathname);
  };

  return (
    <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8" data-testid="page-group-detail">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="flex flex-wrap items-center gap-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {group.name}
            {detailQuery.isFetching && (
              <Badge variant="outline" className="text-muted-foreground" data-testid="status-group-detail-updating">
                <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> Updating
              </Badge>
            )}
            {(data.metadata.stale || data.metadata.status !== 'complete') && (
              <Badge
                variant="outline"
                className="text-muted-foreground"
                data-testid="status-group-detail-qualified"
              >
                {data.metadata.stale || data.metadata.status === 'stale' ? 'Stale data' : data.metadata.status === 'partial' ? 'Partial data' : 'No observations'}
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {sourceWorkspaceIds.length === 1
              ? `Workspace: ${sourceWorkspaceNameById.get(sourceWorkspaceIds[0]) || sourceWorkspaceIds[0]}`
              : `${sourceWorkspaceIds.length} workspaces`}
            {' '}• {data.headline.memberCount} members • {data.period.label}
          </p>
          {data.metadata.qualifications.length > 0 && (
            <AdminDataQualityNote title="Group data"><p data-testid="text-group-detail-qualifications">
              {data.metadata.qualifications.join(' ')}
            </p></AdminDataQualityNote>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex justify-start">
            <GroupUserExport groupIds={[groupId]} />
          </div>
          <div>
            <RangeFilter />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <BackLink />
      </div>

      <section className="grid gap-4 lg:grid-cols-[1.12fr_.88fr]" aria-label="Group headline">
        <Card className="rounded-md shadow-none">
          <CardHeader className="border-b bg-muted/20 pb-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-xl">{group.name}</CardTitle>
                  <Badge variant="secondary" className="text-[10px] uppercase">{group.role}</Badge>
                  {budgetStatus && <StatusBadge status={budgetStatus} />}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {manageContexts.map((context) => (
                  <Link
                    key={context.workspaceId}
                    href={`/limits?workspaceId=${encodeURIComponent(context.workspaceId)}&groupIds=${encodeURIComponent(context.groupIds.join(','))}`}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
                    data-testid={`link-manage-people-budgets-${context.workspaceId}`}
                  >
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Manage limits{manageContexts.length > 1 ? ` (${sourceWorkspaceNameById.get(context.workspaceId) || context.workspaceId})` : ''}
                  </Link>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 p-5 sm:grid-cols-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Selected total</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{hasSelectedObservations ? `$${data.headline.spendUsd.toFixed(2)}` : '—'}</p>
              <p className="mt-1 text-xs text-muted-foreground">Authoritative group total</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Agent</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{hasSelectedObservations ? `$${data.headline.agentSpendUsd.toFixed(2)}` : '—'}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Other services</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{hasSelectedObservations ? `$${data.headline.otherServicesUsd.toFixed(2)}` : '—'}</p>
              <p className="mt-1 text-xs text-muted-foreground">Hosting, storage, and other costs</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-md shadow-none">
          <CardHeader className="pb-3">
            <CardDescription>{group.sharedPool ? 'Shared allocation' : 'Allocation'}</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {data.headline.allocationUsd == null ? '—' : `$${data.headline.allocationUsd.toFixed(2)}`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <BudgetMeter
              actualUsd={hasSelectedObservations ? data.headline.spendUsd : null}
              budgetUsd={data.headline.allocationUsd}
              stale={data.metadata.stale}
              incomplete={data.metadata.status !== 'complete'}
              label="Group usage"
            />
            <div className="grid grid-cols-2 gap-4 border-t pt-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Remaining</p>
                <p className={`mt-1 font-mono text-lg font-semibold tabular-nums ${data.headline.remainingUsd != null && data.headline.remainingUsd < 0 ? 'text-destructive' : ''}`}>
                  {data.headline.remainingUsd == null ? '—' : `$${data.headline.remainingUsd.toFixed(2)}`}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Usage</p>
                <p className={`mt-1 font-mono text-lg font-semibold tabular-nums ${data.headline.percentUsed != null && data.headline.percentUsed >= 100 ? 'text-destructive' : ''}`}>
                  {data.headline.percentUsed == null ? '—' : `${data.headline.percentUsed.toFixed(1)}%`}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <Card className="overflow-hidden rounded-md shadow-none">
          <CardHeader className="gap-4 border-b bg-muted/20 pb-0 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="text-lg">Spending breakdown</CardTitle>
            </div>
            <TabsList aria-label="Group spending breakdown">
              <TabsTrigger value="members" data-testid="tab-group-members">Members</TabsTrigger>
              <TabsTrigger value="projects" data-testid="tab-group-projects">Projects</TabsTrigger>
            </TabsList>
          </CardHeader>
          <TabsContent value="members" className="mt-0">
            <div className="flex items-start gap-2 border-b bg-muted/10 px-5 py-4 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p>
                  Member spend plus unattributed residual reconciles to the group total.
                  Limit, Agent spend and remaining columns use the current billing cycle; total spend uses the selected period.
                </p>
                <InternalSpendExplanation />
              </div>
            </div>
            <div className="p-0">
              <div className="max-h-[70vh] overflow-auto" data-virtual-scroll>
                <Table className="min-w-[1120px]">
                  <TableHeader className="sticky top-0 bg-background/95 backdrop-blur z-10">
                    <TableRow className="border-b border-border">
                      <TableHead>Member</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Current-cycle limit</TableHead>
                      <TableHead className="text-right">Current-cycle Agent spend</TableHead>
                      <TableHead className="text-right">Current-cycle remaining</TableHead>
                      <TableHead className="text-right">Selected total</TableHead>
                      <TableHead className="text-right">Selected Agent</TableHead>
                      <TableHead className="text-right">Selected other services</TableHead>
                    </TableRow>
                  </TableHeader>
                  <VirtualizedTableRows columnCount={8} estimatedRowHeight={80}>
                    {sortedMembers.map((member) => {
                      const observationStale = member.limitObservationStatus === 'failed' || member.limitObservationStatus === 'refreshing';
                      const blocked = !member.isInternal
                        && member.limitUsd != null
                        && member.currentCycleAgentSpendUsd != null
                        && member.currentCycleAgentSpendUsd >= member.limitUsd;
                      const memberSourceGroups = data.sourceGroups.filter((source) =>
                        source.workspaceId === member.workspaceId && member.groupIds.includes(source.groupId),
                      );
                      const canWriteMemberLimit = capabilities.canWriteUserLimitsIn.includes(member.workspaceId);
                      return (
                        <TableRow key={`${member.workspaceId}:${member.userId}`} >
                          <TableCell className="">
                            <div className="flex items-center justify-between">
                              <div className="flex flex-col min-w-0">
                                <span className="text-sm font-medium break-words overflow-hidden">{member.name || member.username || member.userId}</span>
                                <span className="text-xs text-muted-foreground break-words">{member.email || '—'}</span>
                                <span className="text-xs text-muted-foreground">
                                  Workspace: {sourceWorkspaceNameById.get(member.workspaceId) || member.workspaceId}
                                </span>
                                {canWriteMemberLimit && memberSourceGroups.length > 0 && (
                                  <Link
                                    href={`/limits?workspaceId=${encodeURIComponent(member.workspaceId)}&groupIds=${encodeURIComponent(memberSourceGroups.map((source) => source.groupId).join(','))}`}
                                    className="mt-1 w-fit text-xs text-primary hover:underline"
                                    data-testid={`link-manage-member-limit-${member.workspaceId}-${member.userId}`}
                                  >
                                    Manage limit
                                  </Link>
                                )}
                              </div>
                              <div className="ml-2 flex gap-1">
                                {[...new Set(memberSourceGroups.map((source) => source.role))].map((role) => (
                                  <Badge key={role} variant="outline" className="h-5 text-[10px] capitalize">{role}</Badge>
                                ))}
                                {member.isInternal && <InternalUserBadge />}
                                {member.isDisabled && <Badge variant="secondary" className="h-5 text-[10px] opacity-50">Disabled</Badge>}
                              </div>
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
                          <TableCell className="w-32 text-right">
                            {member.limitState === 'unavailable'
                              ? <span className="text-sm text-muted-foreground">Unavailable</span>
                              : member.limitUsd != null
                                ? <span className="font-mono text-sm tabular-nums">${member.limitUsd.toFixed(2)}{observationStale && <span className="ml-1 text-xs text-muted-foreground">stale</span>}</span>
                                : <span className="text-sm text-muted-foreground">{member.limitState === 'no_limit' ? 'Not set' : 'Unknown'}</span>}
                          </TableCell>
                          <TableCell className="text-right">
                            {member.currentCycleAgentSpendUsd == null ? <span className="text-sm text-muted-foreground">—</span> : <span className="font-mono text-sm tabular-nums">${member.currentCycleAgentSpendUsd.toFixed(2)}</span>}
                          </TableCell>
                          <TableCell className="text-right">
                             <div className="ml-auto w-48">
                               <BudgetMeter
                                 actualUsd={member.currentCycleAgentSpendUsd}
                                 budgetUsd={member.limitState === 'unavailable' ? null : member.limitUsd}
                                 stale={observationStale}
                                 incomplete={member.limitObservationStatus === 'unavailable' || member.limitState === 'unavailable'}
                                 label="Current-cycle Agent usage"
                                 compact
                               />
                               <div className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                                 {member.remainingUsd == null ? 'Remaining unknown' : (
                                   <span className={member.remainingUsd <= 0 ? 'font-bold text-destructive' : ''}>
                                     {member.remainingUsd < 0 ? '-' : ''}${Math.abs(member.remainingUsd).toFixed(2)} remaining
                                   </span>
                                 )}
                               </div>
                             </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${member.spendUsd.toFixed(2)}` : '—'}</TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${member.agentSpendUsd.toFixed(2)}` : '—'}</TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${member.otherServicesUsd.toFixed(2)}` : '—'}</TableCell>
                        </TableRow>
                      );
                    })}
                    {hasSelectedObservations && data.headline.unattributedSpendUsd > 0 && (
                      <TableRow className="border-b border-border/50 bg-muted/10">
                        <TableCell className="">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium italic">Unattributed residual</span>
                            <span className="text-xs text-muted-foreground">Usage not assignable to a current displayed member</span>
                          </div>
                        </TableCell>
                        <TableCell colSpan={4} />
                        <TableCell className="text-right font-mono text-sm tabular-nums">${data.headline.unattributedSpendUsd.toFixed(2)}</TableCell>
                        <TableCell colSpan={2} />
                      </TableRow>
                    )}
                  </VirtualizedTableRows>
                  <tfoot>
                    <TableRow className="border-t border-border bg-muted/30 font-medium">
                      <TableCell className="text-sm">Group Total</TableCell>
                      <TableCell colSpan={4} />
                      <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${data.headline.spendUsd.toFixed(2)}` : '—'}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${data.headline.agentSpendUsd.toFixed(2)}` : '—'}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{hasSelectedObservations ? `$${data.headline.otherServicesUsd.toFixed(2)}` : '—'}</TableCell>
                    </TableRow>
                  </tfoot>
                </Table>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="projects" className="mt-0">
            <div className="border-b bg-muted/10 p-5">
              <h3 className="font-semibold tracking-tight text-lg">Projects</h3>
              <AdminDataQualityNote title="Group project attribution"><p>
                Project attribution is explanatory, not the authoritative group total.
                A dash means category detail is unavailable, not zero.
              </p></AdminDataQualityNote>
            </div>
            <div className="p-0">
              {projectsDenied ? (
                <p className="text-sm text-muted-foreground" data-testid="status-group-projects-unavailable">Projects are unavailable for this group.</p>
              ) : projectsQuery.isError && !projectsQuery.data ? (
                <div className="flex items-center justify-between border border-destructive/30 bg-destructive/5 p-4 text-sm" data-testid="status-group-projects-error">
                  <span>Projects couldn&apos;t be loaded. Member totals remain available.</span>
                  <Button variant="outline" size="sm" onClick={() => void projectsQuery.refetch()} data-testid="button-retry-group-projects">Retry</Button>
                </div>
              ) : (
                <ProjectsTable data={projectsQuery.data} />
              )}
            </div>
          </TabsContent>
        </Card>
      </Tabs>
    </div>
  );
}

function ProjectsTable({ data }: { data: GroupProjectsResponse | undefined }) {
  const rows = data?.projects ?? [];
  const incomplete = data && (data.usageHealth.status !== 'complete' || !data.titlesComplete);
  return (
    <div className="overflow-x-auto" tabIndex={0} aria-label="Project spending details">
      {incomplete && (
        <AdminDataQualityNote title="Group project coverage"><p data-testid="status-group-projects-partial">
          Project details are partial{!data.titlesComplete ? '; some titles are unavailable' : ''}.
        </p></AdminDataQualityNote>
      )}
      <Table className="min-w-[760px]">
        <TableHeader className="sticky top-0 bg-background/95 backdrop-blur z-10">
          <TableRow className="border-b border-border">
            <TableHead>Project</TableHead>
            <TableHead className="text-right">AI</TableHead>
            <TableHead className="text-right">Hosting</TableHead>
            <TableHead className="text-right">Storage</TableHead>
            <TableHead className="text-right">Other / unclassified</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data ? [1, 2, 3].map((i) => (
            <TableRow key={i} >
              <TableCell className=""><LoadingCell /></TableCell>
              {[1, 2, 3, 4, 5].map((column) => <TableCell key={column} className="text-right"><div className="flex justify-end"><LoadingCell /></div></TableCell>)}
            </TableRow>
          )) : rows.map((project) => {
            const hosting = project.metrics.length ? project.metrics.filter((metric) => metric.category === 'hosting').reduce((sum, metric) => sum + metric.costUsd, 0) : null;
            const storage = project.metrics.length ? project.metrics.filter((metric) => metric.category === 'storage').reduce((sum, metric) => sum + metric.costUsd, 0) : null;
            const other = Math.max(0, project.nonAiSpendUsd - (hosting ?? 0) - (storage ?? 0));
            return (
              <TableRow key={project.projectId} >
                <TableCell className="">
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium break-words overflow-hidden">
                      {project.title ?? <span className="italic text-muted-foreground">{data.titlesComplete ? 'Untitled' : 'Title unavailable'}</span>}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground break-all">{project.projectId}</span>
                    <span className="mt-0.5 text-xs text-muted-foreground">Creator: {project.creatorName ?? 'Unknown'}{!project.creatorIsCurrentMember && ' (not currently attributable)'}</span>
                  </div>
                </TableCell>
                {[project.aiSpendUsd, hosting, storage, other, project.totalCostUsd].map((value, index) => (
                  <TableCell key={index} className="text-right font-mono text-sm tabular-nums">{value == null ? '—' : `$${value.toFixed(2)}`}</TableCell>
                ))}
              </TableRow>
            );
          })}
          {data && data.unattributedSpendUsd > 0 && (
            <TableRow className="border-b border-border/50 bg-muted/10">
              <TableCell className="text-sm font-medium italic">Unattributed residual · group spend not explained by these projects</TableCell>
              <TableCell colSpan={4} />
              <TableCell className="text-right font-mono text-sm tabular-nums">${data.unattributedSpendUsd.toFixed(2)}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data && data.usageHealth.status === 'complete' && data.titlesComplete && rows.length === 0 && data.unattributedSpendUsd === 0 && (
        <div className="py-12 text-center text-muted-foreground">No project spend found.</div>
      )}
    </div>
  );
}
