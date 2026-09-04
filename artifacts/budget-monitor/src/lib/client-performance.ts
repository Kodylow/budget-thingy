export const QUERY_STALE_TIME_MS = 60_000;
export const DATA_REFRESH_INTERVAL_MS = 60_000;
export const POLL_FAST_MS = 8_000;
export const POLL_SLOW_MS = 30_000;
export const DASHBOARD_MAX_POLL_RESPONSES = 6;

export function pollingRetryDelay(): number {
  return 1_000;
}

export type PollableResponse = {
  isComplete?: boolean;
  syncStatus?: string | null;
};

export function isPollingQueryError(queryStatus?: string): boolean {
  return queryStatus === 'error';
}

export function progressivePollInterval(
  data: PollableResponse | undefined,
  dataUpdateCount: number,
  queryStatus?: string,
): number | false {
  if (isPollingQueryError(queryStatus)) return false;
  if (data?.isComplete || data?.syncStatus === 'complete') return false;
  if (data?.syncStatus === 'partial' || data?.syncStatus === 'failed') return false;
  return dataUpdateCount > 1 ? POLL_SLOW_MS : POLL_FAST_MS;
}

export function dashboardPollInterval(
  data: PollableResponse | undefined,
  dataUpdateCount: number,
  queryStatus?: string,
): number | false {
  if (dataUpdateCount >= DASHBOARD_MAX_POLL_RESPONSES) return false;
  return progressivePollInterval(data, dataUpdateCount, queryStatus);
}

export type DashboardPerformanceMilestone =
  | 'initial-load-start'
  | 'range-change-start'
  | 'background-refresh-start'
  | 'required-requests-complete'
  | 'first-useful-values-ready'
  | 'all-required-values-ready'
  | 'background-refresh-ready';

export interface DashboardPerformanceContext {
  generation: number;
  scopeKey: string;
  rangeKey: string;
}

function dashboardEntryName(
  milestone: string,
  context: DashboardPerformanceContext,
): string {
  return `dashboard-${milestone}:g${context.generation}`;
}

function logDashboardPerformance(
  kind: 'mark' | 'measure',
  name: string,
  durationMs: number | undefined,
  context: DashboardPerformanceContext,
): void {
  console.info('[performance]', JSON.stringify({
    kind,
    name,
    durationMs: durationMs === undefined ? undefined : Number(durationMs.toFixed(1)),
    ...context,
  }));
}

export function markDashboardMilestone(
  milestone: DashboardPerformanceMilestone,
  context: DashboardPerformanceContext,
): string {
  const name = dashboardEntryName(milestone, context);
  performance.mark(name, { detail: context });
  logDashboardPerformance('mark', name, undefined, context);
  return name;
}

/**
 * Records the first paint after a Dashboard data milestone. The caller owns
 * request readiness; this helper deliberately measures paint separately.
 */
export function reportDashboardMilestonePainted(
  milestone:
    | 'first-useful-values'
    | 'all-required-values'
    | 'range-change-complete'
    | 'background-refresh-complete',
  context: DashboardPerformanceContext,
  readyMark: string,
  phaseStartMark?: string,
): () => void {
  const paintedMark = dashboardEntryName(`${milestone}-painted`, context);
  const readyToPaintMeasurement = dashboardEntryName(
    `${milestone}-ready-to-painted`,
    context,
  );
  const phaseMeasurement = dashboardEntryName(`${milestone}-duration`, context);
  let paintedFrame = 0;
  const committedFrame = requestAnimationFrame(() => {
    paintedFrame = requestAnimationFrame(() => {
      performance.mark(paintedMark, { detail: context });
      performance.measure(readyToPaintMeasurement, readyMark, paintedMark);
      const readyToPaintDuration = performance
        .getEntriesByName(readyToPaintMeasurement)
        .at(-1)?.duration;
      logDashboardPerformance(
        'measure',
        readyToPaintMeasurement,
        readyToPaintDuration,
        context,
      );

      if (
        phaseStartMark &&
        performance.getEntriesByName(phaseStartMark, 'mark').length > 0
      ) {
        performance.measure(phaseMeasurement, phaseStartMark, paintedMark);
        const phaseDuration = performance
          .getEntriesByName(phaseMeasurement)
          .at(-1)?.duration;
        logDashboardPerformance('measure', phaseMeasurement, phaseDuration, context);
      } else if (milestone === 'first-useful-values') {
        const paintedAt = performance.getEntriesByName(paintedMark).at(-1)?.startTime;
        if (paintedAt !== undefined) {
          performance.measure(phaseMeasurement, {
            start: 0,
            duration: paintedAt,
          });
          logDashboardPerformance('measure', phaseMeasurement, paintedAt, context);
        }
      }
    });
  });

  return () => {
    cancelAnimationFrame(committedFrame);
    cancelAnimationFrame(paintedFrame);
  };
}

export interface VirtualWindow {
  start: number;
  end: number;
  before: number;
  after: number;
}

export function getVirtualWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 6,
): VirtualWindow {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan;
  const end = Math.min(rowCount, Math.max(start, visibleEnd));
  return {
    start,
    end,
    before: start * rowHeight,
    after: Math.max(0, (rowCount - end) * rowHeight),
  };
}
