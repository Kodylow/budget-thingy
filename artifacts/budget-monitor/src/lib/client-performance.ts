export const QUERY_STALE_TIME_MS = 60_000;
export const POLL_FAST_MS = 8_000;
export const POLL_SLOW_MS = 30_000;
export const DASHBOARD_MAX_POLL_RESPONSES = 6;

export function pollingRetryDelay(): number {
  return POLL_FAST_MS;
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