import { describe, expect, it, vi } from 'vitest';
import type { LimitChangeOperation, LimitTargetIdentity } from '@workspace/api-client-react';
import { LimitBatchRetryError, retryLimitTargetsInBatches } from './limit-change-review';

const response = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: null,
  kind: 'change',
  state: 'running',
  amountUsd: null,
  reviewFingerprint: 'f'.repeat(64),
  actorUserId: 'fixture',
  preparedAt: '2026-09-10T00:00:00Z',
  committedAt: '2026-09-10T00:01:00Z',
  completedAt: null,
  counts: { total: 1001, queued: 1001, applying: 0, verified: 0, failed: 0, verificationPending: 0 },
  targets: [],
} satisfies LimitChangeOperation;

const targets: LimitTargetIdentity[] = Array.from({ length: 1001 }, (_, index) => ({
  workspaceId: index === 1000 ? 'workspaceB' : 'workspaceA',
  type: 'workspace_user_limit',
  targetId: `user-${index}`,
}));

describe('large unresolved limit retries', () => {
  it('sequentially sends 1001 workspace-qualified identities as stable unique <=1000 requests', async () => {
    const request = vi.fn(async () => response);
    const onResponse = vi.fn();
    await retryLimitTargetsInBatches(response.id, targets, request, onResponse);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(call => call[0].data.targets.length)).toEqual([1000, 1]);
    expect(request.mock.calls[0][0].data.targets[0]).toEqual(targets[0]);
    expect(request.mock.calls[1][0].data.targets[0]).toEqual(targets[1000]);
    const keys = request.mock.calls.map(call => call[0].data.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every(key => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(onResponse).toHaveBeenCalledTimes(2);
  });

  it('stops on an explicit error and reports the current plus unsent target count', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValue(response);
    await expect(retryLimitTargetsInBatches(response.id, targets, request, vi.fn()))
      .rejects.toEqual(expect.objectContaining<Partial<LimitBatchRetryError>>({
        name: 'LimitBatchRetryError',
        message: 'Connection lost',
        remaining: 1001,
      }));
    expect(request).toHaveBeenCalledTimes(1);
  });
});