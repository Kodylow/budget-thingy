export const QUERY_STALE_TIME_MS = 60_000;
export const DATA_REFRESH_INTERVAL_MS = 60_000;

export function pollingRetryDelay(): number {
  return 1_000;
}

export function reportDashboardNumbersPainted(): () => void {
  const fetchCompleteMark = 'dashboard-final-fetch-complete';
  const numbersPaintedMark = 'dashboard-numbers-painted';
  const measurement = 'dashboard-fetch-complete-to-numbers-painted';

  performance.mark(fetchCompleteMark);
  let paintedFrame = 0;
  const committedFrame = requestAnimationFrame(() => {
    paintedFrame = requestAnimationFrame(() => {
      performance.mark(numbersPaintedMark);
      performance.measure(measurement, fetchCompleteMark, numbersPaintedMark);
      const duration = performance.getEntriesByName(measurement).at(-1)?.duration;
      if (duration !== undefined) {
        console.info(`[performance] ${measurement}: ${duration.toFixed(1)}ms`);
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