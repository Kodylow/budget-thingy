import React, { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'wouter';
import type { ReportingDetailBudgetTracking, TeamBudget } from '@workspace/api-client-react';
import { useAuthContext } from '@/components/auth-context';
import { getAvailableSpendViews } from '@/pages/spend';
import { Button } from '@/components/ui/button';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { reportingNavigationHref } from '@/lib/reporting-navigation';
import { formatUsd } from './format';
import { personalLimitBudgetRows, type PersonalLimitSummary } from './budget-logic';

export type CanonicalTeamBudget = TeamBudget & { poolId?: string | null };

export function selectDefaultWorkspace(limits: PersonalLimitSummary[]): string | null {
  const rows = personalLimitBudgetRows(limits);
  return (
    rows.find((row) => row.allocationUsd != null && row.currentCycleAgentSpendUsd != null)?.id ??
    rows.find((row) => row.allocationUsd != null)?.id ??
    rows.find((row) => row.currentCycleAgentSpendUsd != null && row.currentCycleAgentSpendUsd !== 0)?.id ??
    rows[0]?.id ??
    null
  );
}

export function selectDefaultTeam(teams: CanonicalTeamBudget[]): string | null {
  return teams.find((team) => typeof team.poolId === 'string' && team.poolId.length > 0)?.poolId ?? null;
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-2 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <div className={`h-full ${value > 100 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export function PersonalBudgetPanel({
  workspaceName,
  selectedAgentSpendUsd,
  limit,
  selectedPeriodLabel,
  billingPeriodLabel,
  showCurrentCycleComparison,
}: {
  workspaceName: string;
  selectedAgentSpendUsd: number | null;
  limit: PersonalLimitSummary | null;
  selectedPeriodLabel: string;
  billingPeriodLabel: string;
  showCurrentCycleComparison: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasFiniteLimit = limit?.state === 'explicit' || limit?.state === 'inherited';
  const canCompare = showCurrentCycleComparison && hasFiniteLimit && limit?.amount != null && limit.currentCycleAgentSpendUsd != null;
  const percent = canCompare ? limit.currentCyclePercentUsed : null;
  const remaining = canCompare ? limit.currentCycleRemainingUsd : null;

  return (
    <article className="overflow-hidden rounded-md border bg-card shadow-none">
      <div className="border-b bg-muted/25 px-5 py-4">
        <h2 className="text-xl font-semibold">My Agent usage</h2>
        <p className="mt-1 text-xs text-muted-foreground">{workspaceName} · {selectedPeriodLabel}</p>
      </div>
      <div className="space-y-5 p-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-3xl font-semibold tracking-tight">{formatUsd(selectedAgentSpendUsd)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Personal Agent spend</p>
          </div>
          {remaining != null && (
            <div className="text-right">
              <p className={`font-mono text-xl font-semibold ${remaining < 0 ? 'text-destructive' : ''}`}>{formatUsd(remaining)}</p>
              <p className="mt-1 text-xs text-muted-foreground">remaining this billing period</p>
            </div>
          )}
        </div>
        {percent != null && Number.isFinite(percent) ? (
          <>
            <ProgressBar value={percent} label="Workspace Agent monthly limit used" />
            <p className="text-xs font-medium">{percent.toFixed(1)}% of the monthly Agent limit used</p>
          </>
        ) : null}
        {limit && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            aria-expanded={expanded}
          >
            Monthly limit details {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
        {expanded && limit && (
          <div className="grid grid-cols-2 gap-3 rounded-sm border bg-muted/20 p-3 text-xs">
            {(hasFiniteLimit && limit.amount != null) || limit.state === 'no_limit' ? <div><p className="text-muted-foreground">Monthly Agent limit</p><p className="mt-1 font-mono">{limit.state === 'no_limit' ? 'Unlimited' : formatUsd(limit.amount)}</p></div> : null}
            <div><p className="text-muted-foreground">Limit source</p><p className="mt-1 font-medium">{limit.state.replace('_', ' ')}</p></div>
            {billingPeriodLabel && <div><p className="text-muted-foreground">Reference period</p><p className="mt-1 font-medium">{billingPeriodLabel}</p></div>}
            {limit.currentCycleAgentSpendUsd != null && <div><p className="text-muted-foreground">Current-cycle Agent spend</p><p className="mt-1 font-mono">{formatUsd(limit.currentCycleAgentSpendUsd)}</p></div>}
          </div>
        )}
      </div>
    </article>
  );
}

export type TeamBudgetTracking =
  Omit<ReportingDetailBudgetTracking, 'budgetKind' | 'workspaceCount'> &
  Partial<Pick<ReportingDetailBudgetTracking, 'budgetKind' | 'workspaceCount'>>;

export function TeamBudgetPanel({
  team,
  tracking,
  loading,
  error,
  onRetry,
  search,
  selectedPeriodLabel,
  comparisonsMatchBudgetWindow,
  wholeBudgetMode,
}: {
  team: CanonicalTeamBudget;
  tracking: TeamBudgetTracking | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  search: string;
  selectedPeriodLabel: string;
  comparisonsMatchBudgetWindow: boolean;
  wholeBudgetMode?: boolean;
}) {
  const { isAccountAdmin, isWorkspaceAdmin, isTeamAdmin, capabilities } = useAuthContext();
  const authorizedForPools = getAvailableSpendViews({ isAccountAdmin, isWorkspaceAdmin, isTeamAdmin, canEditAllocations: capabilities.canEditAllocations }).includes('pools');

  const [expanded, setExpanded] = useState(false);
  const complete = comparisonsMatchBudgetWindow && tracking?.scopeComplete && tracking.usageComplete;
  const monthlyAgent = tracking?.budgetKind === 'monthly_agent';
  const periodLabel = wholeBudgetMode && tracking?.periodLabel
    ? tracking.periodLabel
    : selectedPeriodLabel;
  const reportHref = team.poolId
    ? authorizedForPools
      ? reportingNavigationHref(`/spend?tab=pools&poolId=${encodeURIComponent(team.poolId)}`, search)
      : reportingNavigationHref(`/my-team`, search)
    : null;

  return (
    <article className="overflow-hidden rounded-md border bg-card shadow-none">
      <div className="border-b bg-muted/25 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">{monthlyAgent ? 'My team Agent usage' : 'My team budget'}</p>
        <h2 className="mt-1 text-xl font-semibold">{team.teamName}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{monthlyAgent ? 'Agent-only spend' : 'Team spend'} · {periodLabel}</p>
        {wholeBudgetMode && tracking?.scopeComplete && (
          <p className="mt-2 text-xs font-medium text-foreground">Full team · {tracking.workspaceCount ?? team.workspaceIds.length} {(tracking.workspaceCount ?? team.workspaceIds.length) === 1 ? 'workspace' : 'workspaces'}</p>
        )}
      </div>
      <div className="space-y-5 p-5">
        {loading ? (
          <div className="h-28 animate-pulse rounded-sm bg-muted" aria-label="Loading team budget" />
        ) : error ? (
          <div className="flex h-28 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            Team budget unavailable
            <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
          </div>
        ) : tracking ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              {tracking.spendUsd != null && <div>
                <p className="font-mono text-3xl font-semibold tracking-tight">{formatUsd(tracking.spendUsd)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{monthlyAgent ? 'Agent spend this billing period' : comparisonsMatchBudgetWindow ? 'Known spend to date' : 'Selected-period team spend'}</p>
              </div>}
              {tracking.allocationUsd != null && <div className="text-right">
                <p className="font-mono text-2xl font-semibold">{formatUsd(tracking.allocationUsd)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{monthlyAgent ? 'Monthly Agent limit' : 'Annual allocation'}</p>
              </div>}
              {complete && tracking.remainingUsd != null && <div className="text-right">
                <p className={`font-mono text-xl font-semibold ${tracking.remainingUsd < 0 ? 'text-destructive' : ''}`}>{formatUsd(tracking.remainingUsd)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{monthlyAgent ? 'Agent limit remaining' : 'remaining in this budget period'}</p>
              </div>}
            </div>
            {complete && tracking.percentUsed != null ? (
              <>
                <ProgressBar value={tracking.percentUsed} label={monthlyAgent ? 'Team monthly Agent limit used' : 'Team funding used'} />
                <p className="text-xs font-medium">{tracking.percentUsed.toFixed(1)}% of {monthlyAgent ? 'monthly Agent limit' : 'funding'} used</p>
              </>
            ) : null}
          </>
        ) : null}
        {tracking?.qualification && <AdminDataQualityNote title="Team budget">{tracking.qualification}</AdminDataQualityNote>}
        {tracking && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            aria-expanded={expanded}
          >
            {monthlyAgent ? 'Usage details' : 'Funding details'} {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
        {expanded && tracking && (
          <div className="grid grid-cols-2 gap-3 rounded-sm border bg-muted/20 p-3 text-xs">
            {tracking.periodLabel && <div><p className="text-muted-foreground">{monthlyAgent ? 'Billing period' : 'Funding period'}</p><p className="mt-1 font-medium">{tracking.periodLabel}</p></div>}
            {tracking.asOf && <div><p className="text-muted-foreground">As of</p><p className="mt-1 font-medium">{tracking.asOf.slice(0, 10)}</p></div>}
            {(tracking.workspaceCount ?? team.workspaceIds.length) > 0 && <div><p className="text-muted-foreground">Workspaces</p><p className="mt-1 font-mono">{tracking.workspaceCount ?? team.workspaceIds.length}</p></div>}
          </div>
        )}
        {reportHref && (
          <Link href={reportHref} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Open team report <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </article>
  );
}