import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimitOperation, SetLimitsWorkspace } from '@workspace/api-client-react';
import { OperationManagerDialog } from './limits';

const mocks = vi.hoisted(() => ({
  op: undefined as LimitOperation | undefined,
  isError: false,
  commitError: false,
  retryError: false,
  mutationOptions: [] as unknown[],
  commit: vi.fn(),
  retry: vi.fn(),
}));
vi.mock('@workspace/api-client-react', async (importOriginal) => ({
  ...await importOriginal<object>(),
  useGetLimitOperation: () => ({ data: mocks.op, isError: mocks.isError, refetch: vi.fn(), isFetching: false }),
  useCommitLimitOperation: (options: unknown) => {
    mocks.mutationOptions.push(options);
    return { mutate: mocks.commit, isError: mocks.commitError, error: mocks.commitError ? new Error('Connection lost') : null };
  },
  useRetryLimitOperationTargets: (options: unknown) => {
    mocks.mutationOptions.push(options);
    return { mutate: mocks.retry, isError: mocks.retryError, error: mocks.retryError ? new Error('Connection lost') : null };
  },
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...await importOriginal<object>(),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <section>{children}</section>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}));

const workspace = {
  workspaceId: 'ws-fixture',
  workspaceName: 'Fixture Workspace',
  canWrite: true,
  unavailableReason: null,
  billingPeriod: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
  limitObservation: { status: 'available', observedAt: '2026-09-06T00:00:00Z' },
  members: [{
    userId: 'member-fixture', name: 'Fixture Member', username: 'fixture',
    limitState: 'explicit', effectiveLimitUsd: 999, usageUsd: 50,
  }],
} as SetLimitsWorkspace;

function operation(state: LimitOperation['state'] = 'prepared', targetState: LimitOperation['targets'][number]['state'] = 'queued'): LimitOperation {
  return {
    id: 'operation-fixture', workspaceId: workspace.workspaceId, state, amountUsd: 50,
    reviewFingerprint: 'frozen-review', preparedAt: '2026-09-06T00:00:00Z',
    counts: { total: 1, queued: 0, applying: 0, verified: 0, failed: 0, verificationPending: 0 },
    targets: [{
      userId: 'member-fixture', memberName: 'Fixture Member', oldAmountUsd: 25,
      newAmountUsd: 50, state: targetState, history: [],
    }],
  } as unknown as LimitOperation;
}
function render(ws = workspace, isReadOnly = false) {
  return renderToStaticMarkup(<OperationManagerDialog isOpen operationId="operation-fixture" onClose={() => {}} ws={ws} isReadOnly={isReadOnly} />);
}

beforeEach(() => {
  mocks.op = operation();
  mocks.isError = false;
  mocks.commitError = false;
  mocks.retryError = false;
  mocks.mutationOptions = [];
});

describe('fixture-backed limit review and recovery presentation', () => {
  it('reviews the frozen observed explicit value, current effective value and per-member change separately', () => {
    const html = render();
    expect(html).toContain('Fixture Workspace');
    expect(html).toContain('$25.00');
    expect(html).toContain('Current effective: $999.00 (explicit)');
    expect(html).toContain('Not applied');
    expect(html).toContain('no limits have been changed');
    expect(html).toContain('may block Agent');
    expect(html).toContain('Shared group caps, opening funding, monthly additions and ongoing policies are unchanged');
    expect(html).toContain('Confirm and apply limits');
    expect(mocks.mutationOptions).toEqual([{ mutation: { retry: false } }, { mutation: { retry: false } }]);
  });

  it.each([
    [true, workspace],
    [false, { ...workspace, canWrite: false }],
    [false, { ...workspace, unavailableReason: 'Writes unavailable' }],
  ])('keeps permitted review information but hides write controls when disabled', (readOnly, ws) => {
    const html = render(ws, readOnly);
    expect(html).toContain('Fixture Member');
    expect(html).toContain('Read-only');
    expect(html).not.toContain('Confirm and apply limits');
    mocks.op = operation('completed', 'failed');
    mocks.op.counts.failed = 1;
    expect(render(ws, readOnly)).not.toContain('Recover unresolved targets');
  });

  it('never exposes a cached operation after access denial', () => {
    mocks.isError = true;
    const html = render();
    expect(html).toContain('Operation status unavailable');
    expect(html).toContain('Refresh status');
    expect(html).not.toContain('Fixture Member');
    expect(html).not.toContain('$25.00');
  });

  it('renders unavailable status without a cached operation', () => {
    mocks.op = undefined;
    expect(render()).toContain('Loading saved operation');
    mocks.isError = true;
    expect(render()).toContain('No outcome is confirmed');
  });

  it('distinguishes pending, failed, partial-success, verified and unknown states', () => {
    mocks.op = operation('running', 'applying');
    expect(render()).toContain('Applying limits');
    mocks.op = operation('completed', 'failed');
    mocks.op.counts.failed = 1;
    expect(render()).toContain('Limits failed');
    mocks.op.counts.verified = 1;
    expect(render()).toContain('Partial success');
    mocks.op.counts.verificationPending = 1;
    expect(render()).toContain('Outcome unknown');
    expect(render()).toContain('Recovery checks upstream before any further write');
    mocks.op = operation('completed', 'verified');
    mocks.op.counts.verified = 1;
    expect(render()).toContain('Limits verified');
  });

  it('qualifies stale usage and blocks repeated apply while the request outcome is uncertain', () => {
    mocks.commitError = true;
    const html = render({ ...workspace, limitObservation: { ...workspace.limitObservation, status: 'failed' } });
    expect(html).toContain('last observed, not a verified current balance');
    expect(html).toContain('Request outcome not confirmed');
    expect(html).toContain('Refresh saved status');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm and apply limits/);
  });
});