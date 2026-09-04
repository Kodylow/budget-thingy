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

export function reportDashboardNumbersPainted(): () => void {
  const fetchCompleteMark = 'dashboard-final-fetch-complete';
  const numbersPaintedMark = 'dashboard-numbers-painted';
  const fetchToPaintMeasurement = 'dashboard-fetch-complete-to-numbers-painted';
  const navigationToPaintMeasurement = 'dashboard-navigation-to-numbers-painted';

  performance.mark(fetchCompleteMark);
  let paintedFrame = 0;
  const committedFrame = requestAnimationFrame(() => {
    paintedFrame = requestAnimationFrame(() => {
      performance.mark(numbersPaintedMark);
      performance.measure(fetchToPaintMeasurement, fetchCompleteMark, numbersPaintedMark);
      const paintedAt = performance.getEntriesByName(numbersPaintedMark).at(-1)?.startTime;
      if (paintedAt !== undefined) {
        performance.measure(navigationToPaintMeasurement, {
          start: 0,
          duration: paintedAt,
        });
      }
      for (const measurement of [fetchToPaintMeasurement, navigationToPaintMeasurement]) {
        const duration = performance.getEntriesByName(measurement).at(-1)?.duration;
        if (duration !== undefined) {
          console.info(`[performance] ${measurement}: ${duration.toFixed(1)}ms`);
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
