import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListWorkspaceGroups,
  getListWorkspaceGroupsQueryKey,
  useListWorkspaceGroupMembers,
  getListWorkspaceGroupMembersQueryKey,
  type WorkspaceGroupSummary,
} from '@workspace/api-client-react';
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  ExternalLink,
  Info,
  KeyRound,
  Settings2,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { useAuthContext } from '@/components/auth-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Access() {
  const { capabilities, authorizationKey } = useAuthContext();
  const workspaceId = new URLSearchParams(useSearch()).get('workspaceId') || undefined;
  const queryClient = useQueryClient();
  const previousContext = useRef(`${authorizationKey}:${workspaceId || 'all'}`);
  useEffect(() => {
    const context = `${authorizationKey}:${workspaceId || 'all'}`;
    if (previousContext.current !== context) {
      void queryClient.cancelQueries({ predicate: query => String(query.queryKey[0]).includes('/api/directory/workspace') });
      queryClient.removeQueries({ predicate: query => String(query.queryKey[0]).includes('/api/directory/workspace') });
      previousContext.current = context;
    }
  }, [authorizationKey, queryClient, workspaceId]);

  if (!capabilities.canManageAccess) {
    return (
      <div className="mx-auto max-w-[1280px] space-y-4 px-4 py-6 md:px-8 md:py-8">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Access</h1>
        <p className="text-sm text-muted-foreground">
          You do not have permission to view or manage access.
        </p>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Access</h1>
        </div>
        <Button variant="outline" asChild className="w-full gap-2 sm:w-auto">
          <Link href="/settings">
            <Settings2 className="h-4 w-4" />
            Open Settings
          </Link>
        </Button>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)]">
        <section aria-labelledby="application-grants-heading">
          <Card className="rounded-md shadow-none">
            <CardHeader className="border-b bg-muted/25 pb-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <KeyRound className="h-[18px] w-[18px]" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <CardTitle id="application-grants-heading" className="text-lg">
                    Application grants
                  </CardTitle>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="flex items-start gap-3 px-5 py-4">
                <Info
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-sm leading-6 text-muted-foreground">
                  Application administrators are managed in{' '}
                  <span className="font-medium text-foreground">Settings</span>.
                </p>
              </div>
              <div className="flex justify-end border-t bg-muted/20 px-5 py-4">
                <Button variant="outline" size="sm" asChild className="w-full gap-2 sm:w-auto">
                  <Link href="/settings">
                    Manage in Settings
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-4" aria-label="Access sources">
          <Card className="rounded-md shadow-none">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">Access model</CardTitle>
                <Badge
                  variant="outline"
                  className="gap-1.5 font-medium text-emerald-700 dark:text-emerald-400"
                >
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Synced
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Budget Monitor grants</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Application administrator assignments are managed in Settings.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <UsersRound className="h-4 w-4" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Replit membership</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Workspace and team membership comes from Replit and is not overridden here.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-md border-dashed bg-muted/15 shadow-none">
            <CardContent className="flex gap-3 px-5 py-4">
              <Info
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">Need to change a person’s scope?</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Update their workspace or team membership in Replit, then return here to confirm
                  the account view.
                </p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
      <section aria-labelledby="workspace-groups-heading" className="space-y-6 border-t pt-6">
        <div className="flex items-start gap-3">
          <UsersRound className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="workspace-groups-heading" className="text-lg font-semibold">Workspace groups</h2>
          </div>
        </div>
        <WorkspaceGroupsList key={`${authorizationKey}:${workspaceId || 'all'}`} workspaceId={workspaceId} />
      </section>
    </main>
  );
}

function WorkspaceGroupsList({ workspaceId }: { workspaceId?: string }) {
  const params = { workspaceId };
  const query = useListWorkspaceGroups(params, { query: { queryKey: getListWorkspaceGroupsQueryKey(params) } });

  if (query.isError) {
    return (
      <div className="flex items-center gap-4 text-sm text-destructive bg-destructive/10 p-4 rounded-md">
        <AlertTriangle className="h-5 w-5 shrink-0" />
        <p>Could not load workspace groups.</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} className="ml-auto bg-background">Retry</Button>
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-12 bg-muted rounded-md w-full"></div>
        <div className="h-12 bg-muted rounded-md w-full"></div>
      </div>
    );
  }
  if (query.data.workspaces.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground bg-muted/30 rounded-xl border border-border">
        No workspace groups available.
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {query.data.workspaces.map((workspace) => (
        <div key={workspace.workspaceId} className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="bg-muted/50 px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-sm">{workspace.workspaceName || workspace.workspaceId}</h3>
          </div>
          <div className="divide-y divide-border">
            {workspace.groups.map(group => (
              <GroupExpandableRow key={group.groupId} workspaceId={workspace.workspaceId} group={group} />
            ))}
            {workspace.groups.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground text-center">No groups found in this workspace.</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function GroupExpandableRow({ workspaceId, group }: { workspaceId: string, group: WorkspaceGroupSummary }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="flex items-center justify-between w-full px-4 py-3 hover:bg-muted/30 transition-colors text-left focus-visible:outline-none focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-3">
          <div className="text-muted-foreground">
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
          <span className="font-medium text-sm">{group.name}</span>
          <span className="text-[10px] bg-secondary/10 text-secondary border border-secondary/25 px-1.5 py-0.5 rounded-full uppercase tracking-wider font-semibold">
            {group.kind}
          </span>
        </div>
        <div className="text-sm text-muted-foreground tabular-nums">
          {group.membershipAvailability === 'unavailable' || group.memberCount === null
            ? 'Unknown members'
            : `${group.memberCount} member${group.memberCount === 1 ? '' : 's'}`}
        </div>
      </button>
      {isOpen && (
        <div className="px-4 py-3 bg-muted/10 border-t border-border border-dashed">
          <GroupMembersList workspaceId={workspaceId} groupId={group.groupId} />
        </div>
      )}
    </div>
  );
}

function GroupMembersList({ workspaceId, groupId }: { workspaceId: string, groupId: string }) {
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const query = useListWorkspaceGroupMembers(workspaceId, groupId, { page, pageSize }, {
    query: { queryKey: getListWorkspaceGroupMembersQueryKey(workspaceId, groupId, { page, pageSize }) }
  });
  if (query.isError) {
    return (
      <div className="text-sm text-destructive py-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" /> Failed to load members.
        <Button variant="link" size="sm" onClick={() => void query.refetch()} className="h-auto p-0 ml-2">Retry</Button>
      </div>
    );
  }
  if (!query.data) {
    return <div className="text-sm text-muted-foreground py-2 animate-pulse">Loading members...</div>;
  }
  const { members, totalMembers, availability } = query.data;
  if (availability === 'unavailable') {
    return <div className="text-sm text-muted-foreground py-2 italic">Membership unknown.</div>;
  }
  if (members.length === 0) {
    return <div className="text-sm text-muted-foreground py-2">No explicit members in this group.</div>;
  }
  const totalPages = totalMembers ? Math.ceil(totalMembers / pageSize) : 1;
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {members.map(member => (
          <li key={member.userId || member.fallbackLabel} className="text-sm flex items-baseline gap-2">
            <span className="font-medium text-foreground">{member.name || member.username || member.fallbackLabel}</span>
            {(member.name || member.username) && member.email && (
              <span className="text-muted-foreground text-xs">&lt;{member.email}&gt;</span>
            )}
            {member.userId && (
              <span className="text-muted-foreground text-xs font-mono ml-auto">ID: {member.userId}</span>
            )}
          </li>
        ))}
      </ul>
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-6 w-6" disabled={page <= 1}
              aria-label="Previous members page" onClick={() => setPage(p => Math.max(1, p - 1))}>
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="icon" className="h-6 w-6" disabled={page >= totalPages}
              aria-label="Next members page" onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
