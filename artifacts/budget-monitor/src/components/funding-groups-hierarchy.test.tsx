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

  const props = {
    inventory: initialInventory,
    inventoryLoading: false,
    inventoryError: false,
    teamNames: ['Alpha'],
    searchQuery: '',
    showHidden: false,
    authorizationKey: 'auth',
    canManage: true,
    onRetry: () => {},
    onRefresh: async () => 'r1',
    onSave: async () => {},
    teamAllocations: { Alpha: 100 },
    allocationYear: 2026,
  };

  const unmappedTrigger = () => container.querySelector<HTMLButtonElement>('[data-testid="button-toggle-unmapped-groups"]')!;
  const teamTrigger = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Alpha'))!;

  it('starts collapsed with a count and toggles the real accessible disclosure', async () => {
    await act(async () => root.render(<FundingGroupsHierarchy {...props} />));
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('false');
    expect(unmappedTrigger().textContent).toContain('Unmapped groups');
    expect(unmappedTrigger().textContent).toContain('1');
    expect(container.querySelector('[data-testid="unmapped-group-card"]')).toBeNull();
    expect(teamTrigger().getAttribute('aria-expanded')).toBe('false');

    await act(async () => unmappedTrigger().click());
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('0 people');
    expect(container.querySelector('[data-testid="unmapped-group-card"]')).not.toBeNull();
    await act(async () => unmappedTrigger().click());
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="unmapped-group-card"]')).toBeNull();
  });

  it('reveals search matches without losing explicit state on clear or refresh', async () => {
    const render = async (searchQuery = '', inventory = initialInventory, authorizationKey = 'auth') =>
      act(async () => root.render(<FundingGroupsHierarchy {...props} {...{ searchQuery, inventory, authorizationKey }} />));
    await render('Zero');
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Zero Group');
    await render('One');
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('false');
    expect(teamTrigger().getAttribute('aria-expanded')).toBe('true');
    await render('');
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('false');
    await act(async () => unmappedTrigger().click());
    await render('Zero');
    await render('', { ...initialInventory, revision: 'r2', groups: [...initialInventory.groups] });
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('true');
    await render('', initialInventory, 'different-auth');
    expect(unmappedTrigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps populated unmapped groups and empty mapped groups in their proper sections', async () => {
    const inventory = {
      ...initialInventory,
      groups: initialInventory.groups.map(group => ({ ...group, memberCount: group.teamName === null ? 3 : 0 })),
    };
    await act(async () => root.render(<FundingGroupsHierarchy {...props} inventory={inventory} />));
    await act(async () => unmappedTrigger().click());
    const card = container.querySelector('[data-testid="unmapped-group-card"]')!;
    expect(card.textContent).toContain('3 people');
    expect(card.textContent).not.toContain('One Group');
    await act(async () => teamTrigger().click());
    expect(container.textContent).toContain('One Group');
    expect(container.textContent).toContain('0 people');
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
    await act(async () => unmappedTrigger().click());
    await act(async () => teamTrigger().click());
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
      await act(async () => unmappedTrigger().click());
      await act(async () => teamTrigger().click());
      const selectors = [...container.querySelectorAll('select')];
      expect(selectors).toHaveLength(2);
      expect(selectors.every(select => select.disabled)).toBe(true);
    };

    await render(false, 'fresh');
    await render(true, 'stale');
  });
});