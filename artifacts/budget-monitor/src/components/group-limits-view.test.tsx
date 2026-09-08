// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TeamBudgetApplyResponse,
  TeamBudgetTarget,
  TeamBudgetTargetConfiguration,
  TeamBudgetUpstreamSync,
} from '@workspace/api-client-react';
import { classifyGroupLimitObservation, describeApplyOutcome, GroupLimitsView } from './group-limits-view';

const target = {
  teamName: 'Budget Team',
  workspaceId: 'workspace-stable',
  groupId: 'group-stable',
  groupName: 'Budget Team Members',
  monthlyLimitUsd: null,
  isEnabled: true,
  teamMonthlyLimitUsd: 100,
  targetAmountUsd: 100,
} satisfies TeamBudgetTarget;
const syncRow = {
  teamName: target.teamName,
  workspaceId: target.workspaceId,
  targetGroupId: target.groupId,
  targetGroupName: target.groupName,
  targetType: 'group',
  desiredAmountUsd: 100,
  upstreamAmountUsd: 75,
  status: 'drift',
  reason: null,
  lastAttemptAt: null,
} satisfies TeamBudgetUpstreamSync;

const mocks = vi.hoisted(() => ({
  canWrite: false,
  enabled: [] as boolean[],
  targetsData: undefined as TeamBudgetTargetConfiguration | undefined,
  syncData: undefined as any,
  applyResponse: undefined as TeamBudgetApplyResponse | undefined,
  updateTarget: vi.fn(),
  apply: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    auth: { previewReadOnly: false },
    capabilities: { canWriteGroupLimits: mocks.canWrite },
    isPreviewing: false,
    authorizationKey: 'auth',
  }),
}));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<object>(),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <section>{children}</section>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}));
vi.mock('@workspace/api-client-react', async importOriginal => {
  const actual = await importOriginal<object>();
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), reset: vi.fn(), isPending: false, isError: false });
  return {
    ...actual,
    useGetTeamBudgetTargets: (options: { query: { enabled: boolean } }) => {
      mocks.enabled.push(options.query.enabled);
      return {
        data: mocks.targetsData,
        isLoading: false,
        isError: false,
        refetch: vi.fn(async () => ({ data: mocks.targetsData })),
      };
    },
    useGetTeamBudgetSyncStatus: (options: { query: { enabled: boolean } }) => {
      mocks.enabled.push(options.query.enabled);
      return { data: mocks.syncData, isLoading: false, isError: false, refetch: vi.fn(async () => ({ data: mocks.syncData })) };
    },
    useListVisibleWorkspaces: (_params: unknown, options: { query: { enabled: boolean } }) => {
      mocks.enabled.push(options.query.enabled);
      return { data: [{ workspaceId: target.workspaceId, workspaceName: 'Stable Workspace' }] };
    },
    useRetryTeamBudgetUpstreamSync: () => ({
      ...mutation(),
      mutateAsync: mocks.reconcile.mockImplementation(async () => mocks.syncData),
    }),
    useUpdateTeamBudgetTarget: () => ({
      ...mutation(),
      mutate: mocks.updateTarget.mockImplementation((request, options) => {
        const updated = { ...target, monthlyLimitUsd: request.data.monthlyLimitUsd, targetAmountUsd: request.data.monthlyLimitUsd };
        mocks.targetsData = {
          ...mocks.targetsData!,
          targets: [updated],
          teams: [{ teamName: target.teamName, monthlyLimitUsd: updated.targetAmountUsd, targetAmountSumUsd: updated.targetAmountUsd, differenceUsd: 0 }],
        };
        options.onSuccess(updated);
      }),
    }),
    useApplyTeamBudgetLimits: () => ({
      ...mutation(),
      mutate: mocks.apply.mockImplementation((_request, options) => options.onSuccess(mocks.applyResponse)),
    }),
    useUpdateTeamBudgetLimit: mutation,
    useAssignTeamBudgetTarget: mutation,
  };
});

let container: HTMLDivElement;
let root: Root;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.canWrite = false;
  mocks.enabled = [];
  mocks.targetsData = {
    targets: [target],
    teams: [{ teamName: target.teamName, monthlyLimitUsd: 100, targetAmountSumUsd: 100, differenceUsd: 0 }],
    legacy: [],
    unassignedGroups: [],
  };
  mocks.syncData = {
    sourceAvailable: true,
    unavailableReason: null,
    teams: [syncRow],
  };
  mocks.applyResponse = {
    teams: [{
      teamName: target.teamName,
      outcome: 'success',
      targets: [{
        workspaceId: target.workspaceId,
        targetGroupId: target.groupId,
        targetGroupName: target.groupName,
        desiredAmountUsd: 120,
        outcome: 'success',
        error: null,
      }],
    }],
  };
  mocks.updateTarget.mockReset();
  mocks.apply.mockReset();
  mocks.reconcile.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Group limits safety UI', () => {
  it('does not issue account-only queries without the exact capability', () => {
    expect(renderToStaticMarkup(<GroupLimitsView />)).toBe('');
    expect(mocks.enabled).toEqual([false, false, false]);
  });

  it('distinguishes live, absent, and unavailable observations', () => {
    expect(classifyGroupLimitObservation(target, syncRow, true, null)).toEqual({ kind: 'live', amountUsd: 75, detail: null });
    expect(classifyGroupLimitObservation(target, syncRow, false, 'Finance source unavailable').kind).toBe('live');
    expect(classifyGroupLimitObservation(target, { ...syncRow, upstreamAmountUsd: null }, true, null).kind).toBe('absent');
    expect(classifyGroupLimitObservation(target, { ...syncRow, status: 'failed', reason: 'Timed out' }, true, null)).toEqual({
      kind: 'unavailable', amountUsd: 75, detail: 'Timed out',
    });
    expect(classifyGroupLimitObservation({ ...target, isEnabled: false }, syncRow, true, null).kind).toBe('unavailable');
    expect(classifyGroupLimitObservation({ ...target, validationReason: 'Group is now Admins' }, syncRow, true, null)).toEqual({
      kind: 'unavailable', amountUsd: null, detail: 'Group is now Admins',
    });
  });

  it('offers repair and blocks review for an enabled but invalid Members mapping', async () => {
    mocks.canWrite = true;
    mocks.targetsData!.targets = [{ ...target, isEnabled: true, validationReason: 'Group is now Admins' }];
    await act(async () => root.render(<GroupLimitsView />));
    expect(container.textContent).toContain('Assign a replacement for the invalid mapping');
    expect(container.textContent).toContain('Group is now Admins');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-review-group-limit-workspace-stable-group-stable"]')?.disabled).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('edits locally, renews observation, and applies one exact reviewed target', async () => {
    mocks.canWrite = true;
    await act(async () => root.render(<GroupLimitsView />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-edit-group-limit-workspace-stable-group-stable"]')?.click());
    const input = container.querySelector<HTMLInputElement>('[data-testid="input-group-limit-amount"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setInputValue.call(input, '120');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="button-save-group-limit-proposal"]')?.click();
      await flush();
      await flush();
    });
    expect(mocks.updateTarget).toHaveBeenCalled();
    expect(container.textContent).toContain('Observed Replit cap');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-apply-group-limit"]')?.click());
    expect(mocks.apply.mock.calls[0][0]).toEqual({
      data: {
        targets: [{
          teamName: target.teamName,
          workspaceId: target.workspaceId,
          groupId: target.groupId,
          reviewedDesiredAmountUsd: 120,
          reviewedUpstreamAmountUsd: 75,
        }],
      },
    });
    expect(container.textContent).toContain('Confirmed');
  });

  it('retains exact retry and offers renewed review after failure', async () => {
    mocks.canWrite = true;
    mocks.applyResponse = {
      teams: [{
        teamName: target.teamName,
        outcome: 'failed',
        targets: [{ workspaceId: target.workspaceId, targetGroupId: target.groupId, targetGroupName: target.groupName, desiredAmountUsd: 100, outcome: 'failed', error: 'Reviewed value changed' }],
      }],
    };
    await act(async () => root.render(<GroupLimitsView />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="button-review-group-limit-workspace-stable-group-stable"]')?.click();
      await flush();
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-apply-group-limit"]')?.click());
    expect(container.textContent).toContain('Retry exact target');
    expect(container.textContent).toContain('Renew review');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-apply-group-limit"]')?.click());
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="button-renew-group-limit-review"]')?.click();
      await flush();
    });
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  });

  it('never treats an empty, uncertain, or failed exact-target result as success', () => {
    expect(describeApplyOutcome({
      workspaceId: target.workspaceId, targetGroupId: target.groupId, targetGroupName: target.groupName,
      desiredAmountUsd: 0, outcome: 'success', error: null,
    }).detail).toContain('no monthly Agent cap');
    expect(describeApplyOutcome(undefined).state).toBe('uncertain');
    expect(describeApplyOutcome({
      workspaceId: target.workspaceId, targetGroupId: target.groupId, targetGroupName: target.groupName,
      desiredAmountUsd: 100, outcome: 'uncertain', error: 'Verification timed out',
    }).state).toBe('uncertain');
    expect(describeApplyOutcome({
      workspaceId: target.workspaceId, targetGroupId: target.groupId, targetGroupName: target.groupName,
      desiredAmountUsd: 100, outcome: 'failed', error: 'Target changed',
    }).state).toBe('failed');
  });
});