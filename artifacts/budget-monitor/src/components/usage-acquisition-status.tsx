import type { SystemStatus } from '@workspace/api-client-react';
import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, CheckCircle, LoaderCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { getUsageAcquisitionPresentation } from '@/lib/usage-acquisition-status';

function relative(value: Date | null): string {
  return value ? formatDistanceToNow(value, { addSuffix: true }) : 'not recorded';
}

export function UsageAcquisitionStatus({ status }: { status: SystemStatus }) {
  const view = getUsageAcquisitionPresentation(status);
  const attention = view.health === 'degraded' || view.health === 'stale' || view.health === 'unknown';
  const active = view.health === 'running' || view.health === 'recovering';
  const label = {
    healthy: 'Current',
    recovering: 'Recovering',
    degraded: 'Degraded',
    running: 'Running',
    stale: 'Stale',
    unknown: 'Unknown',
  }[view.health];
  const Icon = attention ? AlertCircle : active ? LoaderCircle : CheckCircle;
  return (
    <div className="border-b border-border py-4" data-testid="status-usage-acquisition">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon
            className={`mt-0.5 h-5 w-5 shrink-0 ${
              attention ? 'text-chart-2' : active ? 'text-primary' : 'text-chart-1'
            }`}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">Usage acquisition</p>
            <p className="text-xs text-muted-foreground">
              Latest attempt {relative(view.latestAttemptAt)}
              {' · '}Last successful acquisition stage {relative(view.latestSuccessfulPublicationAt)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {view.remaining > 0
                ? `${view.remaining.toLocaleString()} backfill units remain in the bounded recovery sweep.`
                : 'No backfill units remain in the current sweep.'}
            </p>
            {view.health === 'stale' && (
              <p className="mt-1 text-xs text-muted-foreground">
                Scheduler attempts are overdue; retained successful facts remain available with their stored timestamps.
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Checker last evaluated stored data {status.lastEvaluatedDataAsOf
                ? relative(new Date(status.lastEvaluatedDataAsOf))
                : 'not recorded'}
              {' · '}Directory {status.directoryAgeMs === null
                ? 'age unknown'
                : `${Math.round(status.directoryAgeMs / 60_000).toLocaleString()} minutes old`}
            </p>
          </div>
        </div>
        <Badge variant={attention ? 'secondary' : view.health === 'healthy' ? 'default' : 'outline'}>
          {label}
        </Badge>
      </div>
      {view.failedAttempts.length > 0 && (
        <details className="ml-8 mt-3 text-xs" data-testid="usage-acquisition-failed-attempts">
          <summary className="cursor-pointer text-muted-foreground">
            {view.failedAttempts.length} recent failed unit attempt{view.failedAttempts.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-1 border-l border-border pl-3 text-muted-foreground">
            {view.failedAttempts.map((attempt) => (
              <li key={`${attempt.attemptedAt.toISOString()}-${attempt.usageDate}-${attempt.scopeId ?? ''}`}>
                <span className="font-medium text-foreground">{attempt.stage}</span>
                {' · '}{attempt.scope} · {attempt.usageDate}
                {attempt.scopeId && <> · <span className="font-mono">{attempt.scopeId}</span></>}
                {' · attempted '}{relative(attempt.attemptedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {status.recentRuns.length > 0 && (
        <details className="ml-8 mt-3 text-xs" data-testid="usage-acquisition-recent-runs">
          <summary className="cursor-pointer text-muted-foreground">
            Recent durable runs (latest {status.recentRuns.length} of up to 20)
          </summary>
          <ul className="mt-2 space-y-1 border-l border-border pl-3 text-muted-foreground">
            {status.recentRuns.map((run) => (
              <li key={run.id}>
                <span className="font-medium text-foreground">{run.kind}</span>
                {' · '}{run.status} · {run.units.toLocaleString()} attempted
                {' · '}{run.failures.toLocaleString()} failed
                {run.remaining !== null && <> · {run.remaining.toLocaleString()} remaining</>}
                {' · '}{relative(new Date(run.finishedAt ?? run.startedAt))}
              </li>
            ))}
          </ul>
        </details>
      )}
      {status.currentMonthReconciliation.length > 0 && (
        <details className="ml-8 mt-3 text-xs" data-testid="usage-acquisition-reconciliation">
          <summary className="cursor-pointer text-muted-foreground">
            Current-month reconciliation ({status.currentMonthReconciliation.length})
          </summary>
          <ul className="mt-2 space-y-1 border-l border-border pl-3 text-muted-foreground">
            {status.currentMonthReconciliation.map((item) => (
              <li key={`${item.monthStart}-${item.scope}-${item.scopeId}`}>
                <span className="font-medium text-foreground">{item.scope}</span>
                {item.scopeId && <> · <span className="font-mono">{item.scopeId}</span></>}
                {' · '}delta ${item.deltaUsd.toFixed(2)}
                {' · checked '}{relative(new Date(item.checkedAt))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}