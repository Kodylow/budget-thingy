import React from 'react';
import { Link } from 'wouter';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type {
  MyMembershipBudgetTeam,
  MyMembershipContext,
  MyMembershipGroup,
  MyMembershipWorkspace,
} from '@workspace/api-client-react';

export type PersonalMembershipGroup = MyMembershipGroup;
export type PersonalMembershipBudgetTeam = MyMembershipBudgetTeam;
export type PersonalMembershipWorkspace = MyMembershipWorkspace;
export type PersonalMembershipContext = MyMembershipContext;

export function searchAfterEffectiveIdentityChange(
  search: string,
  previousUserId: string | null,
  nextUserId: string,
): string {
  if (!previousUserId || previousUserId === nextUserId) return search;
  const params = new URLSearchParams(search);
  params.delete('workspaceId');
  const next = params.toString();
  return next ? `?${next}` : '';
}

export function resolvePersonalWorkspace(
  context: PersonalMembershipContext | undefined,
  requestedWorkspaceId: string | null,
) {
  if (!context) return { workspace: null, status: 'loading' as const };
  if (requestedWorkspaceId) {
    const workspace = context.workspaces.find((candidate) => candidate.workspaceId === requestedWorkspaceId) ?? null;
    if (workspace) return { workspace, status: 'selected' as const };
  }
  const workspace = context.workspaces.find((candidate) => candidate.workspaceId === context.defaultWorkspaceId)
    ?? context.workspaces[0] ?? null;
  return { workspace, status: workspace ? 'selected' as const : 'empty' as const };
}

function groupNames(groups: PersonalMembershipGroup[]) {
  return groups.map((group) => group.groupName).join(', ');
}

export function MembershipContextSummary({
  workspace,
  qualification,
  isAccountAdmin,
  canViewAccountUsage,
  defaultWorkspace,
}: {
  workspace: PersonalMembershipWorkspace;
  qualification: string | null;
  isAccountAdmin: boolean;
  canViewAccountUsage: boolean;
  defaultWorkspace: PersonalMembershipWorkspace | null;
}) {
  return (
    <Dialog>
      {qualification && <AdminDataQualityNote title="Workspace membership">{qualification}</AdminDataQualityNote>}
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Your membership context</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Your membership context</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <span className="block text-xs text-muted-foreground">Workspace</span>
            <strong className="font-medium">{workspace.workspaceName}</strong>
          </div>
          {!workspace.isPreferred && defaultWorkspace && (
            <div>
              <span className="block text-xs text-muted-foreground">Default workspace</span>
              <strong className="font-medium">{defaultWorkspace.workspaceName}</strong>
            </div>
          )}
          {workspace.budgetTeams.map((team) => (
            <div key={team.poolId} className="rounded-sm bg-muted/25 px-3 py-2.5">
              <span className="block text-xs text-muted-foreground">Budgeted team</span>
              <strong className="font-medium">{team.teamName}</strong>
              {team.groups.length > 0 && <>
                <span className="mt-2 block text-xs text-muted-foreground">Your groups</span>
                <strong className="font-medium">{groupNames(team.groups)}</strong>
              </>}
            </div>
          ))}
          {workspace.unmappedGroups.length > 0 && (
            <div className="flex items-start gap-2 rounded-sm border border-dashed px-3 py-2.5">
              <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <span className="block text-xs text-muted-foreground">Other access groups</span>
                <strong className="font-medium">{groupNames(workspace.unmappedGroups)}</strong>
              </div>
            </div>
          )}
          {isAccountAdmin && canViewAccountUsage && (
            <Link href="/org-insights" className="inline-block font-medium text-primary hover:underline">Open Org Insights</Link>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
