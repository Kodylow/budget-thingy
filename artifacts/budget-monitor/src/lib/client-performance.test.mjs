import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  POLL_FAST_MS,
  POLL_SLOW_MS,
  DASHBOARD_MAX_POLL_RESPONSES,
  dashboardPollInterval,
  isPollingQueryError,
  pollingRetryDelay,
  progressivePollInterval,
} from './client-performance.ts';

const helperSource = await readFile(new URL('./client-performance.ts', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
const detailSource = await readFile(new URL('../pages/group-detail.tsx', import.meta.url), 'utf8');
const trendsSource = await readFile(new URL('../pages/trends-tab.tsx', import.meta.url), 'utf8');
const dashboardSource = await readFile(new URL('../pages/dashboard.tsx', import.meta.url), 'utf8');
const virtualRowsSource = await readFile(new URL('../components/virtualized-table-rows.tsx', import.meta.url), 'utf8');
const clusterDetailSource = await readFile(new URL('../pages/cluster-detail.tsx', import.meta.url), 'utf8');
const directorySource = await readFile(new URL('../pages/workspace-directory.tsx', import.meta.url), 'utf8');

test('queries remain fresh for one minute and ignore window focus', () => {
  assert.match(helperSource, /QUERY_STALE_TIME_MS = 60_000/);
  assert.match(appSource, /staleTime: QUERY_STALE_TIME_MS/);
  assert.match(appSource, /refetchOnWindowFocus: false/);
});

test('returning from detail retains and invalidates dashboard cache', () => {
  assert.match(detailSource, /invalidateQueries\(\{ queryKey: getListGroupsQueryKey\(\), exact: false \}\)/);
  assert.match(detailSource, /invalidateQueries\(\{ queryKey: getGetSummaryQueryKey\(\), exact: false \}\)/);
  assert.doesNotMatch(detailSource, /removeQueries/);
});

test('secondary routes use lazy imports and a suspense loading boundary', () => {
  for (const page of [
    'settings',
    'trends',
    'alerts',
    'group-detail',
    'cluster-detail',
    'workspace-admins',
    'workspace-directory',
    'team-budgets',
    'user-guide',
  ]) {
    assert.ok(appSource.includes(`import('@/pages/${page}')`), `${page} should load on demand`);
  }
  assert.ok(appSource.includes('<Suspense fallback={<RouteLoading />}>'));
});

test('trend polling is terminal and never retries faster than eight seconds', () => {
  assert.match(helperSource, /syncStatus === 'partial' \|\| data\?\.syncStatus === 'failed'\) return false/);
  assert.match(helperSource, /POLL_FAST_MS = 8_000/);
  assert.match(helperSource, /POLL_SLOW_MS = 30_000/);
  assert.match(helperSource, /dataUpdateCount > 1 \? POLL_SLOW_MS : POLL_FAST_MS/);
  assert.match(helperSource, /isPollingQueryError\(queryStatus\)\) return false/);
  assert.match(trendsSource, /progressivePollInterval/g);
  assert.doesNotMatch(trendsSource, /3000/);
  assert.equal(pollingRetryDelay(), POLL_FAST_MS);
  assert.equal(isPollingQueryError('error'), true);
  assert.equal(isPollingQueryError('success'), false);
  assert.equal(progressivePollInterval(undefined, 0, 'error'), false);
  assert.equal(progressivePollInterval({ isComplete: true }, 1, 'success'), false);
  assert.equal(progressivePollInterval({ syncStatus: 'partial' }, 1, 'success'), false);
  assert.equal(progressivePollInterval({ syncStatus: 'failed' }, 1, 'success'), false);
  assert.equal(progressivePollInterval({ isComplete: false }, 1, 'success'), POLL_FAST_MS);
  assert.equal(progressivePollInterval({ isComplete: false }, 2, 'success'), POLL_SLOW_MS);
  assert.match(appSource, /retry: 1/);
  assert.match(appSource, /retryDelay: pollingRetryDelay/);
});

test('dashboard and detail polling stop after failed requests or terminal responses', () => {
  assert.doesNotMatch(dashboardSource, /retryPollingStartedAt/);
  assert.match(dashboardSource, /dashboardPollInterval/g);
  assert.match(detailSource, /query\.state\.status === 'error'/g);
  assert.match(clusterDetailSource, /state\.status === 'error'/g);
  assert.match(directorySource, /progressivePollInterval/);
});

test('dashboard polling has a finite response budget for non-converging syncs', () => {
  assert.equal(dashboardPollInterval(undefined, 0, 'success'), POLL_FAST_MS);
  assert.equal(
    dashboardPollInterval({ isComplete: false, syncStatus: 'syncing' }, 2, 'success'),
    POLL_SLOW_MS,
  );
  assert.equal(
    dashboardPollInterval(
      { isComplete: false, syncStatus: 'syncing' },
      DASHBOARD_MAX_POLL_RESPONSES,
      'success',
    ),
    false,
  );
  assert.equal(dashboardPollInterval({ syncStatus: 'partial' }, 1, 'success'), false);
  assert.equal(dashboardPollInterval({ syncStatus: 'failed' }, 1, 'success'), false);
  assert.equal(dashboardPollInterval(undefined, 0, 'error'), false);
});

test('large dashboard and member tables only mount a visible row window', () => {
  assert.match(dashboardSource, /<VirtualizedTableRows columnCount=\{8\}>/);
  assert.match(detailSource, /<VirtualizedTableRows columnCount=\{7\}/);
  assert.match(virtualRowsSource, /rows\.slice\(window\.start, window\.end\)/);
  assert.match(virtualRowsSource, /node\.type === Fragment/);
  assert.match(virtualRowsSource, /data-virtual-scroll/);
  assert.match(virtualRowsSource, /onKeyDownCapture=\{handleKeyDown\}/);
  assert.match(virtualRowsSource, /focusLogicalRow/);
});