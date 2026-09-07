import type { SystemStatus, UsageIngestRun } from '@workspace/api-client-react';

export type FailedUsageAttempt = {
  stage: UsageIngestRun['kind'];
  usageDate: string;
  scope: 'account' | 'workspace';
  scopeId: string | null;
  attemptedAt: Date;
};

export type UsageAcquisitionPresentation = {
  health: 'healthy' | 'recovering' | 'degraded' | 'running' | 'stale' | 'unknown';
  latestAttemptAt: Date | null;
  latestSuccessfulPublicationAt: Date | null;
  remaining: number;
  failedAttempts: FailedUsageAttempt[];
};

function date(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function failedKeys(run: UsageIngestRun): FailedUsageAttempt[] {
  if (!run.error?.startsWith('failed-units:')) return [];
  const attemptedAt = date(run.finishedAt) ?? date(run.startedAt);
  if (!attemptedAt) return [];
  return run.error
    .slice('failed-units:'.length)
    .split('\n')
    .map((key) => key.trim())
    .filter(Boolean)
    .flatMap((key) => {
      const separator = key.indexOf('|');
      if (separator < 0) return [];
      const usageDate = key.slice(0, separator);
      const scopeId = key.slice(separator + 1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) return [];
      return [{
        stage: run.kind,
        usageDate,
        scope: scopeId ? 'workspace' as const : 'account' as const,
        scopeId: scopeId || null,
        attemptedAt,
      }];
    });
}

export function getUsageAcquisitionPresentation(
  status: Pick<SystemStatus, 'recentRuns' | 'remainingBackfillCount'>,
  now = Date.now(),
): UsageAcquisitionPresentation {
  const runs = status.recentRuns;
  const latest = runs[0];
  const latestByStage = new Map<UsageIngestRun['kind'], UsageIngestRun>();
  for (const run of runs) {
    if (!latestByStage.has(run.kind)) latestByStage.set(run.kind, run);
  }
  const latestAttemptAt = latest
    ? date(latest.finishedAt) ?? date(latest.startedAt)
    : null;
  const latestSuccessfulPublicationAt = runs
    .filter((run) =>
      (run.kind === 'live' || run.kind === 'backfill') &&
      run.finishedAt &&
      run.units > run.failures)
    .map((run) => date(run.finishedAt))
    .find((value): value is Date => value !== null) ?? null;
  const remaining = Math.max(
    status.remainingBackfillCount,
    ...[...latestByStage.values()].map((run) => run.remaining ?? 0),
  );
  const failures = new Map<string, FailedUsageAttempt>();
  for (const run of latestByStage.values()) {
    for (const failed of failedKeys(run)) {
      const key = `${failed.usageDate}|${failed.scopeId ?? ''}`;
      if (!failures.has(key)) failures.set(key, failed);
    }
  }
  const latestStages = [...latestByStage.values()];
  const health = !latest
    ? 'unknown'
    : latestStages.some((run) => run.status === 'running')
      ? 'running'
      : latestStages.some((run) => run.failures > 0 && run.error !== null)
        ? 'degraded'
        : remaining > 0
          ? 'recovering'
          : latestAttemptAt && now - latestAttemptAt.getTime() > 20 * 60_000
            ? 'stale'
            : 'healthy';
  return {
    health,
    latestAttemptAt,
    latestSuccessfulPublicationAt,
    remaining,
    failedAttempts: [...failures.values()],
  };
}