// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FundingGroupsHierarchy } from './funding-groups-hierarchy';
import type { FundingGroupInventory } from '@/pages/funding-groups-hierarchy';

(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const SelectTrigger = () => null;
  const SelectContent = ({ children }: any) => children;
  const SelectItem = ({ children }: any) => children;
  const SelectValue = () => null;
  function Select({ value, disabled, onValueChange, children }: any) {
    const parts = React.Children.toArray(children) as React.ReactElement<any>[];
    const trigger = parts.find(child => child.type === SelectTrigger);
    const content = parts.find(child => child.type === SelectContent);
    const items = React.Children.toArray(content?.props.children) as React.ReactElement<any>[];
    return (
      <select
        {...trigger?.props}
        value={value}
        disabled={disabled}
        onChange={event => onValueChange(event.target.value)}
      >
        {items.map(item => (
          <option key={item.props.value} value={item.props.value}>{item.props.children}</option>
        ))}
      </select>
    );
  }
  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
});

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <section>{children}</section>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
}));

const initialInventory: FundingGroupInventory = {
  revision: 'r1',
  groups: [
    {
      workspaceId: 'ws',
      workspaceName: 'Workspace',
      groupId: 'zero',
      groupName: 'Zero Group',
      memberCount: 0,
      teamName: null,
      origin: 'unmapped',
      isHidden: false,
    },
    {
      workspaceId: 'ws',
      workspaceName: 'Workspace',
      groupId: 'one',
      groupName: 'One Group',
      memberCount: 1,
      teamName: 'Alpha',
      origin: 'explicit',
      isHidden: false,
    },
  ],
  teams: [{ teamName: 'Alpha', isHidden: false }],
  freshness: { status: 'fresh', dataAsOf: '2026-01-01T00:00:00.000Z', error: null },
};

describe('FundingGroupsHierarchy interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('waits for confirmation and committed inventory before moving a group', async () => {
    let resolveSave!: () => void;
    const save = vi.fn((_input: unknown) => new Promise<void>(resolve => { resolveSave = resolve; }));

    function Harness() {
      const [inventory, setInventory] = useState(initialInventory);
      return (
        <FundingGroupsHierarchy
          inventory={inventory}
          inventoryLoading={false}
          inventoryError={false}
          teamNames={['Alpha']}
          searchQuery=""
          showHidden={false}
          authorizationKey="auth"
          canManage
          onRetry={() => {}}
          onRefresh={async () => inventory.revision}
          onSave={input => save(input).then(() => setInventory({
            ...inventory,
            revision: 'r2',
            groups: inventory.groups.map(group => group.groupId === input.groupId
              ? { ...group, teamName: input.teamName, origin: input.teamName ? 'explicit' : 'unmapped' }
              : group),
          }))}
          teamAllocations={{ Alpha: 100 }}
          allocationYear={2026}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    expect(container.textContent).toContain('0 people');
    expect(container.textContent).toContain('1 person');
    expect(container.querySelectorAll('[data-testid="unmapped-group-card"]')).toHaveLength(1);

    const select = container.querySelector(
      '[aria-label="Budgeted team for Zero Group in Workspace"]',
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = 'Alpha';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="summary-funding-group-review"]')).not.toBeNull();

    const confirm = container.querySelector('[data-testid="button-save-funding-group"]') as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-testid="unmapped-group-card"]')).toHaveLength(1);

    await act(async () => resolveSave());
    expect(container.querySelectorAll('[data-testid="unmapped-group-card"]')).toHaveLength(0);
    expect(container.textContent).toContain('2 groups');
  });

  it('disables inline selectors when inventory is stale or access is read-only', async () => {
    const render = async (canManage: boolean, status: string) => {
      await act(async () => root.render(
        <FundingGroupsHierarchy
          inventory={{ ...initialInventory, freshness: { ...initialInventory.freshness, status } }}
          inventoryLoading={false}
          inventoryError={false}
          teamNames={['Alpha']}
          searchQuery=""
          showHidden={false}
          authorizationKey={`${canManage}:${status}`}
          canManage={canManage}
          onRetry={() => {}}
          onRefresh={async () => 'r1'}
          onSave={async () => {}}
          teamAllocations={{ Alpha: 100 }}
          allocationYear={2026}
        />,
      ));
      expect([...container.querySelectorAll('select')].every(select => select.disabled)).toBe(true);
    };

    await render(false, 'fresh');
    await render(true, 'stale');
  });
});