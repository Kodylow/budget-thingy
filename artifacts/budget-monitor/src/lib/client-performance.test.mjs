import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POLL_FAST_MS,
  POLL_SLOW_MS,
  DASHBOARD_MAX_POLL_RESPONSES,
  dashboardPollInterval,
  isPollingQueryError,
  pollingRetryDelay,
  progressivePollInterval,
} from './client-performance.ts';

test('progressive polling is terminal and never retries faster than eight seconds', () => {
  assert.equal(pollingRetryDelay(), POLL_FAST_MS);
  assert.equal(isPollingQueryError('error'), true);
  assert.equal(isPollingQueryError('success'), false);
  assert.equal(progressivePollInterval(undefined, 0, 'error'), false);
  assert.equal(progressivePollInterval({ isComplete: true }, 1, 'success'), false);
  assert.equal(progressivePollInterval({ syncStatus: 'partial' }, 1, 'success'), false);
  assert.equal(progressivePollInterval({ syncStatus: 'failed' }, 1, 'success'), false);
  assert.equal(progressivePollInterval({ isComplete: false }, 1, 'success'), POLL_FAST_MS);
  assert.equal(progressivePollInterval({ isComplete: false }, 2, 'success'), POLL_SLOW_MS);
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