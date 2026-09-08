import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpendPersonWorkspace, SpendTableRow } from '@workspace/api-client-react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PeopleTable, resolveLimitStatus } from './my-team';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const workspace: SpendPersonWorkspace = {
  workspaceId: 'one', workspaceName: 'Workspace One',
  spendUsd: 10, agentSpendUsd: 10, otherServicesUsd: 0,
  allocationUsd: 100, remainingUsd: 80, percentUsed: 20,
  currentCycleAgentSpendUsd: 20, currentCycleRemainingUsd: 80,
  currentCyclePercentUsed: 20, limitState: 'explicit',
  limitObservationStatus: 'complete', usageObserved: true,
};
const person: SpendTableRow = {
  ...workspace, id: 'person:one-person', userId: 'one-person', kind: 'person',
  name: 'Sample Member', workspaceId: null, workspaceName: 'Workspace One, Workspace Two',
  spendUsd: 35, agentSpendUsd: 35,
  allocationUsd: null, remainingUsd: null, percentUsed: null,
  currentCycleAgentSpendUsd: 40, currentCycleRemainingUsd: null,
  currentCyclePercentUsed: null, status: 'per_workspace',
  limitState: 'not_applicable', limitObservationStatus: 'not_applicable',
  memberCount: null, ownerName: null, sharedPool: false,
  workspaces: [workspace, {
    ...workspace, workspaceId: 'two', workspaceName: 'Workspace Two',
    spendUsd: 25, agentSpendUsd: 25, allocationUsd: 200,
    currentCycleRemainingUsd: 180,
  }],
};

describe('unique people presentation', () => {
  it('shows one member with combined spend and separate workspace limits', () => {
    const markup = renderToStaticMarkup(<PeopleTable rows={[person]} />);
    expect(markup.match(/Sample Member/g)).toHaveLength(1);
    expect(markup).toContain('$35.00');
    expect(markup).toContain('$40.00');
    expect(markup).toContain('2 workspaces');
    expect(markup).toContain('Workspace One');
    expect(markup).toContain('Workspace Two');
    expect(markup).toContain('$100.00');
    expect(markup).toContain('$200.00');
    expect(markup).toContain('Per workspace');
    expect(markup).not.toContain('$300.00');
    expect(resolveLimitStatus(person)).toBeNull();
  });

  it('retains individual workspace observation failures and unlimited limits', () => {
    const markup = renderToStaticMarkup(<PeopleTable rows={[{
      ...person, currentCycleAgentSpendUsd: null,
      workspaces: [workspace, {
        ...workspace, workspaceId: 'two', workspaceName: 'Workspace Two',
        allocationUsd: null, limitState: 'no_limit',
        currentCycleAgentSpendUsd: null, currentCycleRemainingUsd: null,
        limitObservationStatus: 'failed',
      }],
    }]} />);
    expect(markup).toContain('No limit');
    expect(markup).toContain('Observation failed');
    expect(markup).not.toContain('Within budget');
    expect(markup).not.toContain('Over budget');
  });

  it('keeps a single-workspace member’s limit visible without a breakdown', () => {
    const markup = renderToStaticMarkup(<PeopleTable rows={[{
      ...person, ...workspace, workspaces: [workspace],
    }]} />);
    expect(markup).not.toContain('<details');
    expect(markup).toContain('Workspace One');
    expect(markup).toContain('$100.00');
    expect(markup).toContain('Within budget');
  });
});