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
  groups: [
    { groupId, name: `${workspaceId} Members`, role: 'member', familyName: 'Members', eligibleUserIds: ['same-user'] },
    ...(workspaceId === 'ws-a' ? [{ groupId: 'ga-overlap', name: 'A Overlap', role: 'member', familyName: 'Members', eligibleUserIds: ['same-user'] }] : []),
  ],
  members: [
    { ...member(workspaceId, groupId), groupIds: workspaceId === 'ws-a' ? [groupId, 'ga-overlap'] : [groupId] },
    ...(workspaceId === 'ws-a' ? [{
      ...member(workspaceId, groupId), userId: 'ineligible', username: 'ineligible', name: 'Ineligible Person',
      email: 'ineligible@example.test', eligible: false,
    }] : []),
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
const readonlyRosterFixtures = {
  'ws-a': { ...rosterFixtures['ws-a'], canWrite: false },
  'ws-b': { ...rosterFixtures['ws-b'], canWrite: false },
};

const mocks = vi.hoisted(() => ({
  preview: false,
  account: true,
  accountScope: true,
  search: '',
  authorizationKey: 'fixture-auth',
  userId: 'fixture-user',
  writeLimits: true,
  planMode: 'normal' as 'normal' | 'reconfirm' | 'unavailable',
  prepareError: null as Error | null,
  clearError: null as Error | null,
  prepare: vi.fn(),
  prepareClear: vi.fn(),
  savePlan: vi.fn(),
  commit: vi.fn(),
  retry: vi.fn(),
  operation: null as LimitChangeOperation | null,
}));

vi.mock('wouter', () => ({ useSearch: () => mocks.search }));
vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    auth: { previewReadOnly: mocks.preview },
    capabilities: { canViewAccountUsage: mocks.accountScope },
    isPreviewing: mocks.preview,
    realIsAccountAdmin: mocks.account,
    authorizationKey: mocks.authorizationKey,
    user: { id: mocks.userId },
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
    useGetFundingGroups: (options: any) => ({
      data: {
        revision: 'fixture', freshness: { status: 'fresh', dataAsOf: '2026-09-10', error: null },
        teams: [{ teamName: 'Product', isHidden: false }],
        groups: [
          { workspaceId: 'ws-a', workspaceName: 'Workspace ws-a', groupId: 'ga', groupName: 'A Members', memberCount: 1, teamName: 'Product', origin: 'explicit', isHidden: false },
          { workspaceId: 'ws-a', workspaceName: 'Workspace ws-a', groupId: 'ga-overlap', groupName: 'A Overlap', memberCount: 1, teamName: 'Product', origin: 'explicit', isHidden: false },
          { workspaceId: 'ws-b', workspaceName: 'Workspace ws-b', groupId: 'gb', groupName: 'B Members', memberCount: 1, teamName: 'Product', origin: 'explicit', isHidden: false },
        ],
      },
      isLoading: false, isError: false, refetch: vi.fn(),
      ...(options?.query?.enabled === false ? { data: undefined } : {}),
    }),
    useGetGroupPlanInventory: () => ({
      data: {
        revision: '12',
        fundingPeriod: { start: '2026-05-20', end: '2027-05-20' },
        plans: [
          ...Object.entries(rosterFixtures).flatMap(([workspaceId, value]) => value.groups.map(group => ({
            workspaceId,
            workspaceName: value.workspaceName,
            groupId: group.groupId,
            groupName: group.name,
            teamName: 'Product',
            canEditPlan: !mocks.preview,
            savedAmountUsdCents: mocks.planMode === 'reconfirm' ? 120000 : null,
            savedStatus: mocks.planMode === 'reconfirm' ? 'requires_reconfirmation' as const : 'unset' as const,
            planRevision: mocks.planMode === 'reconfirm' ? 2 : null,
            recommendationAmountUsdCents: mocks.planMode === 'unavailable' ? null : 100000,
            recommendationStatus: mocks.planMode === 'unavailable' ? 'missing_history' as const : 'available' as const,
            recommendationReason: mocks.planMode === 'unavailable' ? 'Complete canonical spend is unavailable.' : 'Opening remaining funds are weighted across the fixed term.',
            teamEnvelopeUsdCents: 200000,
            overlapAdjustedMemberWeight: 1,
            eligibleMemberCount: 1,
            writableMemberCount: 1,
            skippedMemberCount: 0,
            memberSuggestionAmountUsdCents: 20000,
            memberSuggestionReason: 'The group planning amount is divided equally and rounded down.',
            billingAlignmentStatus: 'aligned' as const,
            existingIndividualLimitStatus: 'none' as const,
            existingIndividualLimitAmountUsdCents: null,
            savedExceedsRecommendation: false,
            suggestedAllowancesExceedPlan: false,
          }))),
        ],
      },
      isLoading: false, isError: false, refetch: vi.fn().mockResolvedValue({}),
    }),
    useGetSetLimitsWorkspace: (workspaceId: keyof typeof rosterFixtures) => ({ data: (mocks.writeLimits ? rosterFixtures : readonlyRosterFixtures)[workspaceId], isError: false }),
    usePrepareLimitChanges: () => ({ ...mutation(mocks.prepare), isError: mocks.prepareError !== null, error: mocks.prepareError }),
    usePrepareClearAllLimits: () => ({ ...mutation(mocks.prepareClear), isError: mocks.clearError !== null, error: mocks.clearError }),
    useSaveGroupPlan: () => mutation(mocks.savePlan),
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
  mocks.preview = false; mocks.account = true; mocks.accountScope = true; mocks.search = ''; mocks.authorizationKey = 'fixture-auth'; mocks.userId = 'fixture-user'; mocks.writeLimits = true; mocks.planMode = 'normal'; mocks.prepareError = null; mocks.clearError = null; mocks.operation = null;
  mocks.prepare.mockReset(); mocks.prepareClear.mockReset(); mocks.savePlan.mockReset(); mocks.commit.mockReset(); mocks.retry.mockReset();
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

  it('starts funding and unmapped sections closed, then keeps all contexts reachable', async () => {
    expect(container.querySelectorAll('[data-testid^="row-limit-team-"]')).toHaveLength(2);
    expect(container.textContent).toContain('Product');
    expect(container.querySelector('[data-testid="row-limit-group-ws-a-ga"]')).toBeNull();
    expect(container.querySelector('[data-testid="row-limit-person-ws-a-no-group"]')).toBeNull();
    await click('button-toggle-limit-team-Product');
    expect(container.textContent).toContain('Workspace ws-a');
    expect(container.textContent).toContain('Workspace ws-b');
    await click('button-toggle-limit-team-__unmapped__');
    expect(container.textContent).toContain('No observed group');
    expect(container.textContent).toContain('No Group Person');
  });

  it('uses the scoped planning inventory for team mappings without account-wide funding access', async () => {
    mocks.accountScope = false;
    mocks.account = false;
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); await flush(); });
    expect(container.querySelector('[data-testid="row-limit-team-Product"]')).not.toBeNull();
    await click('button-toggle-limit-team-Product');
    expect(container.querySelector('[data-testid="row-limit-group-ws-a-ga"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-limit-group-ws-a-ga-overlap"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-limit-group-ws-b-gb"]')).not.toBeNull();
  });

  it('stages one amount for every eligible writable person from a closed group row', async () => {
    await click('button-toggle-limit-team-Product');
    const input = container.querySelector<HTMLInputElement>('[data-testid="input-group-person-limit-ws-a-ga"]')!;
    await setInput(input, '200');
    await click('button-stage-group-person-limits-ws-a-ga');
    expect(container.textContent).toContain('Review 1 change');
  });

  it('shows affected and skipped people in the frozen review', async () => {
    await click('button-toggle-limit-team-Product');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-person-limit-ws-a-ga"]')!, '200');
    await click('button-stage-group-person-limits-ws-a-ga');
    const target = {
      workspaceId: 'ws-a', type: 'workspace_user_limit' as const, targetId: 'same-user', amountUsd: 200,
      userId: 'same-user', groupId: null, memberName: 'Same Person ws-a', memberEmail: 'ws-a@example.test',
      oldAmountUsd: null, newAmountUsd: 200, state: 'queued' as const, attempts: 0, history: [],
      errorStage: null, errorCode: null, errorMessage: null, upstreamRequestId: null,
      queuedAt: null, applyingAt: null, verifiedAt: null, failedAt: null,
    };
    mocks.operation = operation('change', [target]);
    mocks.prepare.mockImplementation((_request, options) => options.onSuccess(mocks.operation));
    await click('button-review-staged-limits');
    expect(container.textContent).toContain('1 exact target frozen for review');
    expect(container.textContent).toContain('1 skipped/ineligible');
    expect(container.textContent).toContain('Ineligible Person');
    expect(container.textContent).toContain('Not configured');
    expect(container.textContent).toContain('$200.00 / month');
  });

  it('saves a combined group plan separately and copies the person recommendation into staging', async () => {
    mocks.savePlan.mockImplementation((_request, options) => options.onSuccess({
      workspaceId: 'ws-a', groupId: 'ga', amountUsdCents: 100000, status: 'confirmed',
      revision: 1, updatedAt: '2026-09-10T00:00:00Z',
    }));
    await click('button-toggle-limit-team-Product');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-plan-ws-a-ga"]')!, '1000');
    await click('button-save-group-plan-ws-a-ga');
    expect(mocks.savePlan.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-a',
      groupId: 'ga',
      data: { amountUsdCents: 100000, expectedPlanRevision: null, expectedConfigurationRevision: '12' },
    });
    expect(container.textContent).toContain('Plan saved locally. No limits were applied.');
    expect(container.textContent).not.toContain('Review 1 change');

    const personCell = container.querySelector('[data-testid="input-group-person-limit-ws-a-ga"]')!.closest('td')!;
    const copy = [...personCell.querySelectorAll('button')].find(button => button.textContent === 'Copy')!;
    await act(async () => { copy.click(); await flush(); });
    await click('button-stage-group-person-limits-ws-a-ga');
    expect(container.textContent).toContain('Review 1 change');
  });

  it('keeps planning permission independent and explains unavailable recommendations and reconfirmation', async () => {
    mocks.writeLimits = false;
    mocks.planMode = 'unavailable';
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); await flush(); });
    await click('button-toggle-limit-team-Product');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-person-limit-ws-a-ga"]')!, '200');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-plan-ws-a-ga"]')!, '1000');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-stage-group-person-limits-ws-a-ga"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-save-group-plan-ws-a-ga"]')?.disabled).toBe(false);
    expect(container.textContent).toContain('Recommended: Unavailable');
    expect(container.textContent).toContain('Complete canonical spend is unavailable.');

    mocks.planMode = 'reconfirm';
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-save-group-plan-ws-a-ga"]')?.textContent).toBe('Re-confirm');
    expect(container.textContent).toContain('Funding changed · re-confirm required');
  });

  it('blocks different amounts from overlapping groups until explicit resolution', async () => {
    await click('button-toggle-limit-team-Product');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-person-limit-ws-a-ga"]')!, '100');
    await click('button-stage-group-person-limits-ws-a-ga');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-person-limit-ws-a-ga-overlap"]')!, '200');
    await click('button-stage-group-person-limits-ws-a-ga-overlap');
    expect(container.textContent).toContain('Resolve overlapping individual limits');
    expect(container.textContent).toContain('No value was replaced');
    expect(container.textContent).toContain('Review 1 change');

    await click('button-resolve-limit-conflicts');
    mocks.operation = operation('change', []);
    mocks.prepare.mockImplementation((_request, options) => options.onSuccess(mocks.operation));
    await click('button-review-staged-limits');
    expect(mocks.prepare.mock.calls[0][0].data.targets).toEqual([{
      workspaceId: 'ws-a', type: 'workspace_user_limit', targetId: 'same-user', amountUsd: 200,
    }]);
  });

  it('retains staged drafts and reports prepare failures separately', async () => {
    await click('button-toggle-limit-team-Product');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-person-limit-ws-a-ga"]')!, '200');
    await click('button-stage-group-person-limits-ws-a-ga');
    mocks.prepareError = new Error('inventory changed');
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); });
    await click('button-review-staged-limits');
    expect(container.textContent).toContain('Review could not be prepared');
    expect(container.textContent).toContain('Your 1 staged change remains available');
    expect(container.textContent).toContain('Review 1 change');

    mocks.clearError = new Error('clear inventory unavailable');
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); });
    expect(container.textContent).toContain('Clear Limits review could not be prepared');
  });

  it('clears a bulk amount on close and ignores late mutation callbacks after identity change', async () => {
    await click('checkbox-limit-team-Product');
    await click('button-bulk-set-limits');
    const bulkInput = container.querySelector<HTMLInputElement>('[data-testid="input-bulk-limit-amount"]')!;
    await setInput(bulkInput, '25');
    const cancel = [...container.querySelectorAll('button')].find(button => button.textContent === 'Cancel') as HTMLButtonElement;
    await act(async () => { cancel.click(); await flush(); });
    await click('button-bulk-set-limits');
    expect(container.querySelector<HTMLInputElement>('[data-testid="input-bulk-limit-amount"]')?.value).toBe('');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-bulk-limit-amount"]')!, '25');
    await click('button-stage-bulk-limits');
    await click('button-review-staged-limits');
    const latePrepareSuccess = mocks.prepare.mock.calls[0][1].onSuccess;

    await click('button-toggle-limit-team-Product');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-plan-ws-a-ga"]')!, '1000');
    await click('button-save-group-plan-ws-a-ga');
    const lateSaveSuccess = mocks.savePlan.mock.calls[0][1].onSuccess;

    mocks.authorizationKey = 'late-other-auth';
    mocks.userId = 'late-other-user';
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); await flush(); });
    await act(async () => {
      latePrepareSuccess(operation('change', []));
      await lateSaveSuccess({ workspaceId: 'ws-a', groupId: 'ga', amountUsdCents: 100000, status: 'confirmed', revision: 1, updatedAt: '2026-09-10T00:00:00Z' });
      await flush();
    });
    expect(container.textContent).not.toContain('Plan saved locally');
    expect(container.querySelector('[data-testid="table-limit-review"]')).toBeNull();
  });

  it('reveals search and deep-link matches but does not reopen a manual collapse', async () => {
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-search-limits"]')!, 'Same Person');
    expect(container.querySelector('[data-testid="row-limit-person-ws-a-same-user"]')).not.toBeNull();
    await click('button-toggle-limit-team-Product');
    expect(container.querySelector('[data-testid="row-limit-group-ws-a-ga"]')).toBeNull();
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-search-limits"]')!, 'Workspace');
    expect(container.querySelector('[data-testid="row-limit-group-ws-a-ga"]')).toBeNull();

    mocks.search = '?groupId=ga';
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); });
    expect(container.querySelector('[data-testid="row-limit-group-ws-a-ga"]')).toBeNull();
  });

  it('resets drafts, disclosures, and dialogs when the protected identity changes', async () => {
    await click('button-toggle-limit-team-Product');
    await setInput(container.querySelector<HTMLInputElement>('[data-testid="input-group-person-limit-ws-a-ga"]')!, '200');
    await click('button-stage-group-person-limits-ws-a-ga');
    expect(container.textContent).toContain('Review 1 change');

    mocks.authorizationKey = 'other-auth';
    mocks.userId = 'other-user';
    await act(async () => { root.render(<LiveLimitsTable />); await flush(); await flush(); });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-review-staged-limits"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="row-limit-group-ws-a-ga"]')).toBeNull();
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