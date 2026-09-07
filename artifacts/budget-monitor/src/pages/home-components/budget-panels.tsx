import { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, Users } from 'lucide-react';
import { Link } from 'wouter';
import type { TeamBudget } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

function limitLabel(row: ReturnType<typeof personalLimitBudgetRows>[number]) {
  if (row.limitState === 'no_limit') return 'Unlimited';
  return formatUsd(row.allocationUsd);
}

function remainingLabel(row: ReturnType<typeof personalLimitBudgetRows>[number]) {
  if (row.limitState === 'no_limit') return 'Unlimited';
  return formatUsd(row.currentCycleRemainingUsd);
}

export function PersonalBudgetPanel({
  limits,
  selectedId,
  onSelect,
  billingPeriodLabel,
}: {
  limits: PersonalLimitSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  billingPeriodLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = personalLimitBudgetRows(limits);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const percent = selected?.currentCyclePercentUsed;

  return (
    <article className="overflow-hidden rounded-md border bg-card shadow-none">
      <div className="border-b bg-muted/25 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">My budget</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{selected?.workspaceName || selected?.workspaceId || 'Workspace budget'}</h2>
            <p className="mt-1 text-xs text-muted-foreground">Agent · {billingPeriodLabel}</p>
          </div>
          {rows.length > 1 && (
            <Select value={selected?.id ?? ''} onValueChange={onSelect}>
              <SelectTrigger className="h-9 w-full text-xs sm:w-[220px]" aria-label="Personal budget workspace">
                <SelectValue placeholder="Choose a workspace" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((row) => (
                  <SelectItem key={row.id} value={row.id}>{row.workspaceName || row.workspaceId}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      <div className="space-y-5 p-5">
        {!selected ? (
          <p className="text-sm text-muted-foreground">No workspace Agent budget is available.</p>
        ) : (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-3xl font-semibold tracking-tight">{formatUsd(selected.currentCycleAgentSpendUsd)}</p>
                <p className="mt-1 text-xs text-muted-foreground">spent of {limitLabel(selected)} limit</p>
              </div>
              <div className="text-right">
                <p className={`font-mono text-xl font-semibold ${(selected.currentCycleRemainingUsd ?? 0) < 0 ? 'text-destructive' : ''}`}>
                  {remainingLabel(selected)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selected.limitState === 'no_limit' ? 'no configured limit' : 'remaining this cycle'}
                </p>
              </div>
            </div>
            {percent != null && Number.isFinite(percent) ? (
              <>
                <ProgressBar value={percent} label="Workspace Agent budget used" />
                <p className="text-xs font-medium">
                  {percent.toFixed(1)}% of this workspace limit used
                </p>
              </>
            ) : (
              <p className="rounded-sm border bg-muted/25 p-3 text-xs text-muted-foreground">
                {selected.limitState === 'no_limit'
                  ? 'Usage is tracked independently in this unlimited workspace.'
                  : 'Remaining and usage percentage are unavailable until both limit and Agent usage are observed.'}
              </p>
            )}
          </>
        )}
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            aria-expanded={expanded}
          >
            All workspace details {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
        {expanded && (
          <div className="max-h-72 divide-y overflow-y-auto rounded-sm border bg-muted/20 px-3">
            {rows.map((row) => (
              <div key={row.id} className="py-3 text-xs">
                <p className="truncate font-medium">{row.workspaceName || row.workspaceId}</p>
                <dl className="mt-2 grid grid-cols-3 gap-2">
                  <div><dt className="text-muted-foreground">Spent</dt><dd className="mt-1 font-mono">{formatUsd(row.currentCycleAgentSpendUsd)}</dd></div>
                  <div><dt className="text-muted-foreground">Limit</dt><dd className="mt-1 font-mono">{limitLabel(row)}</dd></div>
                  <div><dt className="text-muted-foreground">Remaining</dt><dd className="mt-1 font-mono">{remainingLabel(row)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

export interface TeamBudgetTracking {
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string;
  asOf: string | null;
  allocationUsd: number | null;
  spendUsd: number | null;
  remainingUsd: number | null;
  percentUsed: number | null;
  scopeComplete: boolean;
  usageComplete: boolean;
  benchmarkEligible: boolean;
  qualification: string | null;
  points: Array<{ date: string; spendUsd: number | null }>;
}

export function TeamBudgetPanel({
  teams,
  selectedPoolId,
  onSelect,
  tracking,
  loading,
  error,
  onRetry,
  search,
}: {
  teams: CanonicalTeamBudget[];
  selectedPoolId: string | null;
  onSelect: (id: string) => void;
  tracking: TeamBudgetTracking | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  search: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const selectable = teams.filter((team): team is CanonicalTeamBudget & { poolId: string } => Boolean(team.poolId));
  const selected = selectable.find((team) => team.poolId === selectedPoolId) ?? null;
  const complete = tracking?.scopeComplete && tracking.usageComplete;
  const reportHref = selectedPoolId
    ? reportingNavigationHref(`/reports?poolId=${encodeURIComponent(selectedPoolId)}`, search)
    : null;

  return (
    <article className="overflow-hidden rounded-md border bg-card shadow-none">
      <div className="border-b bg-muted/25 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">My team budget</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{selected?.teamName || 'Funding team'}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{tracking?.periodLabel || selected?.spendPeriodLabel || 'Budget period unavailable'}</p>
          </div>
          {selectable.length > 1 && (
            <Select value={selectedPoolId ?? ''} onValueChange={onSelect}>
              <SelectTrigger className="h-9 w-full text-xs sm:w-[220px]" aria-label="Funding team">
                <SelectValue placeholder="Choose a funding team" />
              </SelectTrigger>
              <SelectContent>
                {selectable.map((team) => <SelectItem key={team.poolId} value={team.poolId}>{team.teamName}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      <div className="space-y-5 p-5">
        {loading ? (
          <div className="h-28 animate-pulse rounded-sm bg-muted" aria-label="Loading team budget" />
        ) : error ? (
          <div className="flex h-28 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            Team budget unavailable
            <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
          </div>
        ) : !selected ? (
          <p className="text-sm text-muted-foreground">No own funding team with a canonical report is available.</p>
        ) : !tracking ? (
          <p className="text-sm text-muted-foreground">Budget-period tracking is unavailable for this team.</p>
        ) : (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-3xl font-semibold tracking-tight">{formatUsd(tracking.spendUsd)}</p>
                <p className="mt-1 text-xs text-muted-foreground">spent of {formatUsd(tracking.allocationUsd)} funding</p>
              </div>
              <div className="text-right">
                <p className={`font-mono text-xl font-semibold ${(tracking.remainingUsd ?? 0) < 0 ? 'text-destructive' : ''}`}>
                  {formatUsd(complete ? tracking.remainingUsd : null)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">remaining in this budget period</p>
              </div>
            </div>
            {complete && tracking.percentUsed != null ? (
              <>
                <ProgressBar value={tracking.percentUsed} label="Team funding used" />
                <p className="text-xs font-medium">{tracking.percentUsed.toFixed(1)}% of funding used</p>
              </>
            ) : (
              <p className="rounded-sm border bg-muted/25 p-3 text-xs text-muted-foreground">
                Remaining and usage percentage are unavailable when budget scope or usage coverage is incomplete.
              </p>
            )}
            {tracking.qualification && <p className="text-xs text-muted-foreground">{tracking.qualification}</p>}
          </>
        )}
        {selected && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            aria-expanded={expanded}
          >
            Funding details {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
        {expanded && selected && (
          <div className="grid grid-cols-2 gap-3 rounded-sm border bg-muted/20 p-3 text-xs">
            <div><p className="text-muted-foreground">Funding team</p><p className="mt-1 font-medium">{selected.teamName}</p></div>
            <div><p className="text-muted-foreground">Coverage</p><p className="mt-1 font-medium">{complete ? 'Complete' : 'Incomplete'}</p></div>
            <div><p className="text-muted-foreground">As of</p><p className="mt-1 font-medium">{tracking?.asOf ? tracking.asOf.slice(0, 10) : 'Unavailable'}</p></div>
            <div><p className="text-muted-foreground">Workspaces</p><p className="mt-1 font-mono">{selected.workspaceIds.length}</p></div>
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