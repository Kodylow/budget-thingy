// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimitChangeOperation, SetLimitsWorkspace } from '@workspace/api-client-react';
import { LiveLimitsTable } from './live-limits-table';

const member = (workspace: string, groupId: string) => ({
  userId: 'same-user', username: `same-${workspace}`, name: `Same Person ${workspace}`, email: `${workspace}@example.test`,
  role: 'member', groupIds: [groupId], isInternal: false, isDisabled: false, eligible: true,
  usageUsd: 10, explicitLimitUsd: null, effectiveLimitUsd: 50, limitState: 'inherited' as const,
});
const roster = (workspaceId: string, groupId: string): SetLimitsWorkspace => ({
  workspaceId, workspaceName: `Workspace ${workspaceId}`, canWrite: true, unavailableReason: null,
  billingPeriod: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
  limitObservation: { status: 'available', observedAt: '2026-09-10T00:00:00Z', error: null },
  groups: [{ groupId, name: `${workspaceId} Members`, role: 'member', familyName: 'Members', eligibleUserIds: ['same-user'] }],
  members: [
    member(workspaceId, groupId),
    ...(workspaceId === 'ws-a' ? [{
      ...member(workspaceId, groupId), userId: 'no-group', username: 'no-group', name: 'No Group Person',
      email: 'no-group@example.test', groupIds: [],
    }] : []),
  ],
});
const rosterFixtures = {
  'ws-a': roster('ws-a', 'ga'),
  'ws-b': roster('ws-b', 'gb'),
};

const mocks = vi.hoisted(() => ({
  preview: false,
  account: true,
  prepare: vi.fn(),
  prepareClear: vi.fn(),
  commit: vi.fn(),
  retry: vi.fn(),
  operation: null as LimitChangeOperation | null,
}));

vi.mock('wouter', () => ({ useSearch: () => '' }));
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    auth: { previewReadOnly: mocks.preview },
    capabilities: { canViewAccountUsage: true },
    isPreviewing: mocks.preview,
    realIsAccountAdmin: mocks.account,
    authorizationKey: 'fixture-auth',
    user: { id: 'fixture-user' },
  }),
}));
vi.mock('@tanstack/react-query', async original => ({
  ...await original<object>(),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <section>{children}</section>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => <div>Loading</div> }));
vi.mock('@/components/journey-primitives', () => ({ BudgetMeter: () => <div>Usage meter</div> }));
vi.mock('@workspace/api-client-react', async original => {
  const actual = await original<object>();
  const mutation = (mutate: ReturnType<typeof vi.fn>) => ({
    mutate, isPending: false, isError: false, error: null, reset: vi.fn(),
  });
  return {
    ...actual,
    useGetLimits: () => ({
      data: { canClearAll: true, writeConfigured: true, observation: { status: 'available', error: null }, limits: [] },
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useListVisibleWorkspaces: () => ({
      data: [{ workspaceId: 'ws-a', workspaceName: 'Workspace ws-a' }, { workspaceId: 'ws-b', workspaceName: 'Workspace ws-b' }],
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useGetFundingGroups: () => ({
      data: {
        revision: 'fixture', freshness: { status: 'fresh', dataAsOf: '2026-09-10', error: null },
        teams: [{ teamName: 'Product', isHidden: false }],
        groups: [
          { workspaceId: 'ws-a', workspaceName: 'Workspace ws-a', groupId: 'ga', groupName: 'A Members', memberCount: 1, teamName: 'Product', origin: 'explicit', isHidden: false },
          { workspaceId: 'ws-b', workspaceName: 'Workspace ws-b', groupId: 'gb', groupName: 'B Members', memberCount: 1, teamName: 'Product', origin: 'explicit', isHidden: false },
        ],
      },
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useGetSetLimitsWorkspace: (workspaceId: keyof typeof rosterFixtures) => ({ data: rosterFixtures[workspaceId], isError: false }),
    usePrepareLimitChanges: () => mutation(mocks.prepare),
    usePrepareClearAllLimits: () => mutation(mocks.prepareClear),
    useCommitLimitChanges: () => mutation(mocks.commit),
    useRetryLimitChanges: () => mutation(mocks.retry),
    useGetLimitChanges: () => ({ data: mocks.operation, isError: false, isFetching: false, refetch: vi.fn() }),
  };
});

let container: HTMLDivElement;
let root: Root;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const setInput = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const click = async (testId: string) => act(async () => {
  container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  await flush();
});
const operation = (kind: 'change' | 'clear_all', targets: LimitChangeOperation['targets']): LimitChangeOperation => ({
  id: kind === 'change' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
  workspaceId: null, kind, state: 'prepared', amountUsd: null, reviewFingerprint: 'f'.repeat(64),
  localPolicyCount: 0,
  actorUserId: 'fixture-user', preparedAt: '2026-09-10T00:00:00Z', committedAt: null, completedAt: null,
  counts: { total: targets.length, queued: targets.length, applying: 0, verified: 0, failed: 0, verificationPending: 0 },
  targets,
});

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.preview = false; mocks.account = true; mocks.operation = null;
  mocks.prepare.mockReset(); mocks.prepareClear.mockReset(); mocks.commit.mockReset(); mocks.retry.mockReset();
  localStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<LiveLimitsTable />); await flush(); await flush(); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('live Limits generated-hook wiring', () => {
  it('reviews and confirms local baseline cleanup even when no upstream limits exist', async () => {
    mocks.operation = { ...operation('clear_all', []), localPolicyCount: 2 };
    mocks.prepareClear.mockImplementation((_request, options) => options.onSuccess(mocks.operation));
    await click('button-clear-all-limits');
    await click('button-prepare-clear-all-limits');
    expect(container.textContent).toContain('2 automatic baseline policies');
    const commit = container.querySelector<HTMLButtonElement>('[data-testid="button-commit-limit-changes"]')!;
    expect(commit.disabled).toBe(true);
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-confirm-clear-limits"]')!, 'CLEAR LIMITS');
    await click('button-commit-limit-changes');
    expect(mocks.commit.mock.calls[0][0].data).toEqual({
      reviewFingerprint: 'f'.repeat(64), confirmation: 'CLEAR LIMITS', targets: [],
    });
  });

  it('renders a cross-workspace allocation team and reachable no-group people', () => {
    expect(container.querySelectorAll('[data-testid^="row-limit-team-"]')).toHaveLength(2);
    expect(container.textContent).toContain('Product');
    expect(container.textContent).toContain('Workspace ws-a');
    expect(container.textContent).toContain('Workspace ws-b');
    expect(container.textContent).toContain('No observed group');
    expect(container.textContent).toContain('No Group Person');
  });

  it('selects both collapsed workspace groups and wires deduplicated workspace/user targets to prepare', async () => {
    await click('checkbox-limit-team-Product');
    await click('button-bulk-set-limits');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-bulk-limit-amount"]')!, '25.50');
    await click('button-stage-bulk-limits');
    const targets = [
      { workspaceId: 'ws-a', type: 'workspace_user_limit' as const, targetId: 'same-user', amountUsd: 25.5 },
      { workspaceId: 'ws-b', type: 'workspace_user_limit' as const, targetId: 'same-user', amountUsd: 25.5 },
    ];
    mocks.operation = operation('change', targets.map(target => ({
      ...target, userId: target.targetId, groupId: null, memberName: null, memberEmail: null,
      oldAmountUsd: null, newAmountUsd: target.amountUsd, state: 'queued', attempts: 0, history: [],
      errorStage: null, errorCode: null, errorMessage: null, upstreamRequestId: null,
      queuedAt: null, applyingAt: null, verifiedAt: null, failedAt: null,
    })));
    mocks.prepare.mockImplementation((_request, options) => options.onSuccess(mocks.operation));
    await click('button-review-staged-limits');
    expect(mocks.prepare.mock.calls[0][0].data.targets).toEqual(targets);
  });

  it('keeps preview selection and mutation controls disabled', async () => {
    mocks.preview = true;
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="checkbox-limit-team-Product"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-review-staged-limits"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-clear-all-limits"]')?.disabled).toBe(true);
    mocks.preview = false;
    mocks.account = false;
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); });
    expect(container.querySelector('[data-testid="button-clear-all-limits"]')).toBeNull();
  });

  it('cancels clear-all before prepare, then requires typed confirmation and commits the frozen payload', async () => {
    await click('button-clear-all-limits');
    const cancel = [...container.querySelectorAll('button')].find(button => button.textContent === 'Cancel') as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(mocks.prepareClear).not.toHaveBeenCalled();

    const target = {
      workspaceId: 'ws-a', type: 'workspace_group_limit' as const, targetId: 'ga', amountUsd: null,
      userId: null, groupId: 'ga', memberName: null, memberEmail: null, oldAmountUsd: 100, newAmountUsd: null,
      state: 'queued' as const, attempts: 0, history: [], errorStage: null, errorCode: null, errorMessage: null,
      upstreamRequestId: null, queuedAt: null, applyingAt: null, verifiedAt: null, failedAt: null,
    };
    mocks.operation = operation('clear_all', [target]);
    mocks.prepareClear.mockImplementation((_request, options) => options.onSuccess(mocks.operation));
    await click('button-clear-all-limits');
    await click('button-prepare-clear-all-limits');
    const commit = container.querySelector<HTMLButtonElement>('[data-testid="button-commit-limit-changes"]')!;
    expect(commit.disabled).toBe(true);
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-confirm-clear-limits"]')!, 'CLEAR LIMITS');
    expect(commit.disabled).toBe(false);
    await click('button-commit-limit-changes');
    expect(mocks.commit.mock.calls[0][0]).toEqual({
      operationId: mocks.operation.id,
      data: {
        reviewFingerprint: 'f'.repeat(64),
        confirmation: 'CLEAR LIMITS',
        targets: [{ workspaceId: 'ws-a', type: 'workspace_group_limit', targetId: 'ga', amountUsd: null }],
      },
    });
  });
});