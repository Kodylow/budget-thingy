import { describe, expect, test } from 'vitest';
import { getUsageAcquisitionPresentation } from './usage-acquisition-status';

const run = {
  id: 2,
  kind: 'backfill' as const,
  startedAt: new Date('2026-09-05T00:00:00.000Z'),
  finishedAt: new Date('2026-09-05T00:01:00.000Z'),
  units: 3,
  calls: 8,
  failures: 1,
  error: 'failed-units:2026-08-20|workspace-1\n2026-08-21|',
  remaining: 7,
  status: 'partial' as const,
};

describe('usage acquisition operator presentation', () => {
  test('separates latest attempt, last successful publication, and failed scopes', () => {
    const view = getUsageAcquisitionPresentation({
      recentRuns: [run],
      remainingBackfillCount: 5,
    }, Date.parse('2026-09-05T00:05:00.000Z'));
    expect(view.health).toBe('degraded');
    expect(view.latestAttemptAt?.toISOString()).toBe('2026-09-05T00:01:00.000Z');
    expect(view.latestSuccessfulPublicationAt?.toISOString()).toBe('2026-09-05T00:01:00.000Z');
    expect(view.remaining).toBe(7);
    expect(view.failedAttempts).toEqual([
      expect.objectContaining({
        stage: 'backfill',
        usageDate: '2026-08-20',
        scope: 'workspace',
        scopeId: 'workspace-1',
      }),
      expect.objectContaining({
        usageDate: '2026-08-21',
        scope: 'account',
        scopeId: null,
      }),
    ]);
  });

  test('reports recovery independently from failures', () => {
    const view = getUsageAcquisitionPresentation({
      recentRuns: [{ ...run, failures: 0, error: null, status: 'partial' }],
      remainingBackfillCount: 2,
    }, Date.parse('2026-09-05T00:05:00.000Z'));
    expect(view.health).toBe('recovering');
    expect(view.failedAttempts).toEqual([]);
    expect(view.remaining).toBe(7);
  });

  test('does not invent a successful publication for an all-failed run', () => {
    const view = getUsageAcquisitionPresentation({
      recentRuns: [{ ...run, units: 1, status: 'failed' }],
      remainingBackfillCount: 0,
    }, Date.parse('2026-09-05T00:05:00.000Z'));
    expect(view.latestSuccessfulPublicationAt).toBeNull();
  });

  test('uses only the latest run per stage for remaining recovery work', () => {
    const recovered = {
      ...run,
      id: 3,
      finishedAt: new Date('2026-09-05T00:03:00.000Z'),
      failures: 0,
      error: null,
      remaining: 0,
      status: 'succeeded' as const,
    };
    const view = getUsageAcquisitionPresentation({
      recentRuns: [recovered, run],
      remainingBackfillCount: 0,
    }, Date.parse('2026-09-05T00:05:00.000Z'));
    expect(view.health).toBe('healthy');
    expect(view.remaining).toBe(0);
    expect(view.failedAttempts).toEqual([]);
  });

  test('marks a quiet scheduler stale after twice its ten-minute cadence', () => {
    const view = getUsageAcquisitionPresentation({
      recentRuns: [{ ...run, failures: 0, error: null, remaining: 0, status: 'succeeded' }],
      remainingBackfillCount: 0,
    }, Date.parse('2026-09-05T00:21:01.000Z'));
    expect(view.health).toBe('stale');
    expect(view.latestSuccessfulPublicationAt).not.toBeNull();
  });
});