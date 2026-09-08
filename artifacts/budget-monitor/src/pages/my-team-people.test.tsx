// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpendPersonWorkspace, SpendTableRow } from '@workspace/api-client-react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PeopleTable, ProjectsTable, resolveLimitStatus } from './my-team';
import { PersonWorkspaceDetails } from '@/components/person-workspace-details';

beforeAll(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterAll(() => vi.unstubAllGlobals());

const workspace: SpendPersonWorkspace = {
  workspaceId: 'one', workspaceName: 'Workspace One',
  spendUsd: 10, agentSpendUsd: 7, otherServicesUsd: 3,
  allocationUsd: 100, remainingUsd: 80, percentUsed: 20,
  currentCycleAgentSpendUsd: 20, currentCycleRemainingUsd: 80,
  currentCyclePercentUsed: 20, limitState: 'explicit',
  limitObservationStatus: 'complete', usageObserved: true,
};
const person: SpendTableRow = {
  ...workspace, id: 'person:one-person', userId: 'one-person', kind: 'person',
  name: 'Sample Member', workspaceId: null, workspaceName: 'Workspace One, Workspace Two',
  spendUsd: 35, agentSpendUsd: 27, otherServicesUsd: 8,
  allocationUsd: null, remainingUsd: null, percentUsed: null,
  currentCycleAgentSpendUsd: 40, currentCycleRemainingUsd: null,
  currentCyclePercentUsed: null, status: 'per_workspace',
  limitState: 'not_applicable', limitObservationStatus: 'not_applicable',
  memberCount: null, ownerName: null, sharedPool: false,
  workspaces: [workspace, {
    ...workspace, workspaceId: 'two', workspaceName: 'Workspace Two',
    spendUsd: 25, agentSpendUsd: 20, otherServicesUsd: 5, allocationUsd: 200,
    currentCycleRemainingUsd: 180,
  }],
};

describe('unique people presentation', () => {
  it('shows one member with combined spend and separate workspace limits', () => {
    const markup = renderToStaticMarkup(<PeopleTable rows={[person]} rangeType="full-term" />);
    expect(markup).toContain('Sample Member');
    expect(markup).toContain('$35.00');
    expect(markup).toContain('$27.00');
    expect(markup).toContain('$8.00');
    expect(markup).not.toContain('$40.00');
    expect(markup).not.toContain('Billing-cycle Agent');
    expect(markup).toContain('2 workspaces');
    expect(markup).not.toContain('Workspace One');
    expect(markup).not.toContain('$100.00');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('Per workspace');
    expect(markup).not.toContain('$300.00');
    expect(resolveLimitStatus(person)).toBeNull();
  });

  it('retains individual workspace observation failures and unlimited limits', () => {
    const markup = renderToStaticMarkup(<PersonWorkspaceDetails workspaces={[workspace, {
        ...workspace, workspaceId: 'two', workspaceName: 'Workspace Two',
        allocationUsd: null, limitState: 'no_limit',
        currentCycleAgentSpendUsd: null, currentCycleRemainingUsd: null,
        limitObservationStatus: 'failed',
       }]} />);
    expect(markup).toContain('No limit');
    expect(markup).toContain('Observation failed');
    expect(markup).not.toContain('Within budget');
    expect(markup).not.toContain('Over budget');
  });

  it('keeps known workspace limits quiet during passive refresh failures', () => {
    const markup = renderToStaticMarkup(<PersonWorkspaceDetails workspaces={[
        { ...workspace, limitObservationStatus: 'refreshing' },
        { ...workspace, workspaceId: 'two', allocationUsd: 200, limitObservationStatus: 'failed' },
      ]} />);
    expect(markup).toContain('$100.00');
    expect(markup).toContain('$200.00');
    expect(markup).not.toContain('Refreshing');
    expect(markup).not.toContain('refresh failed');
  });

  it('keeps a single-workspace member’s limit visible without a breakdown', () => {
    const markup = renderToStaticMarkup(<PeopleTable rangeType="billing" rows={[{
      ...person, ...workspace, workspaces: [workspace],
    }]} />);
    expect(markup).not.toContain('<details');
    expect(markup).toContain('Workspace One');
    expect(markup).toContain('$100.00');
    expect(markup).toContain('Within budget');
  });

  it.each(['full-term', 'billing'] as const)('uses additive selected-period People columns for %s', rangeType => {
    const body = new DOMParser().parseFromString(
      renderToStaticMarkup(<PeopleTable rows={[person]} rangeType={rangeType} />), 'text/html',
    );
    expect([...body.querySelectorAll('th')].map(cell => cell.textContent))
      .toEqual(['Member', 'Total', 'Projects', 'Agent', 'Agent Limit']);
    const cells = body.querySelectorAll('tbody > tr > td');
    expect([...cells].slice(1, 4).map(cell => cell.textContent)).toEqual(['$35.00', '$8.00', '$27.00']);
    expect(body.querySelectorAll('tbody > tr')).toHaveLength(1);
    expect(cells[4].textContent).toBe('Per workspace');
  });

  it('suppresses full-term parent status but keeps the billing-cycle limit', () => {
    const single = { ...person, ...workspace, workspaces: [workspace], agentSpendUsd: 500 };
    const markup = renderToStaticMarkup(<PeopleTable rows={[single]} rangeType="full-term" />);
    expect(markup).toContain('$500.00');
    expect(markup).toContain('$100.00');
    expect(markup).not.toContain('Within budget');
    expect(markup).not.toContain('Over budget');
  });

  it.each(['refreshing', 'failed', 'unavailable'] as const)('preserves single-workspace %s observations', observation => {
    const single = {
      ...person, ...workspace, workspaces: [workspace],
      limitObservationStatus: observation,
    };
    const markup = renderToStaticMarkup(<PeopleTable rows={[single]} rangeType="full-term" />);
    expect(markup).toContain('$100.00');
    if (observation === 'unavailable') expect(markup).toContain('Observation unavailable');
    else {
      expect(markup).not.toContain('Refreshing');
      expect(markup).not.toContain('refresh failed');
    }
  });

  it.each([
    [true, '$0.00'],
    [false, 'Unavailable'],
  ])('keeps observed-zero and unavailable selected spend distinct (%s)', (observed, expected) => {
    const row = { ...person, ...workspace, spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0, usageObserved: observed, workspaces: [workspace] };
    for (const table of [
      <PeopleTable key="people" rows={[row]} rangeType="full-term" />,
      <ProjectsTable key="projects" rows={[row]} />,
    ]) {
      const body = new DOMParser().parseFromString(renderToStaticMarkup(table), 'text/html');
      expect([...body.querySelectorAll('tbody > tr > td')].slice(1, 4).map(cell => cell.textContent))
        .toEqual([expected, expected, expected]);
    }
  });

  it('retains a known selected subtotal when another workspace has unavailable usage', () => {
    const row = { ...person, spendUsd: 10, agentSpendUsd: 7, otherServicesUsd: 3, workspaces: [
      workspace, { ...person.workspaces![1], usageObserved: false },
    ] };
    const body = new DOMParser().parseFromString(
      renderToStaticMarkup(<PeopleTable rows={[row]} rangeType="full-term" />), 'text/html',
    );
    const cells = body.querySelectorAll('tbody > tr > td');
    expect([...cells].slice(1, 4).map(cell => cell.textContent)).toEqual(['$10.00', '$3.00', '$7.00']);
    expect(cells[0].textContent).not.toContain('Unavailable');
    const detail = renderToStaticMarkup(<PersonWorkspaceDetails workspaces={row.workspaces} />);
    expect(detail).toContain('Unavailable');
    expect(cells[4].textContent).toBe('Per workspace');
  });

  it.each([
    ['no_limit', 'No limit'],
    ['unavailable', 'Unavailable'],
  ] as const)('retains a single-workspace %s limit', (limitState, expected) => {
    const row = { ...person, ...workspace, allocationUsd: null, limitState, workspaces: [workspace] };
    const body = new DOMParser().parseFromString(
      renderToStaticMarkup(<PeopleTable rows={[row]} rangeType="billing" />), 'text/html',
    );
    expect(body.querySelectorAll('tbody > tr > td')[4].textContent).toBe(expected);
  });

  it('labels Apps with Total, Agent and non-Agent Cloud Services in that order', () => {
    const body = new DOMParser().parseFromString(
      renderToStaticMarkup(<ProjectsTable rows={[person]} />), 'text/html',
    );
    expect([...body.querySelectorAll('th')].map(cell => cell.textContent))
      .toEqual(['App / project', 'Total', 'Agent', 'Cloud Services']);
    expect([...body.querySelectorAll('tbody > tr > td')].slice(1).map(cell => cell.textContent))
      .toEqual(['$35.00', '$27.00', '$8.00']);
  });
});

describe('member workspace disclosure', () => {
  it('inserts a full-width companion row, preserves summary values and focus, and collapses cleanly', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<PeopleTable rows={[person, { ...person, id: 'other', userId: 'other', name: 'Other Member' }]} rangeType="full-term" />));
      const table = container.querySelector('table')!;
      const summaryRows = () => table.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr');
      const summary = summaryRows()[0];
      const originalCells = [...summary.cells].map(cell => cell.textContent);
      const link = summary.querySelector('a')!.getAttribute('href');
      const toggle = summary.querySelector('button')!;
      toggle.focus();
      act(() => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(toggle);
      expect([...summary.cells].map(cell => cell.textContent)).toEqual(originalCells);
      expect(summary.querySelector('a')!.getAttribute('href')).toBe(link);
      expect(summary.querySelector('table')).toBeNull();
      expect(summaryRows()).toHaveLength(3);
      const details = summaryRows()[1];
      const detailCells = details.querySelectorAll<HTMLTableCellElement>(':scope > td');
      expect(detailCells).toHaveLength(1);
      expect(detailCells[0].colSpan).toBe(5);
      expect(details.querySelector('div')!.id).toBe(toggle.getAttribute('aria-controls'));
      expect([...details.querySelectorAll('thead th')].map(cell => cell.textContent)).toEqual([
        'Workspace', 'Selected-period spend', 'Billing-cycle Agent', 'Monthly Agent limit', 'Billing-cycle remaining',
      ]);
      expect([...details.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => cell.textContent))).toEqual([
        ['Workspace One', '$10.00', '$20.00', '$100.00Source: explicit', '$80.00'],
        ['Workspace Two', '$25.00', '$20.00', '$200.00Source: explicit', '$180.00'],
      ]);
      expect(summaryRows()[2].querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
      act(() => toggle.click());
      expect(summaryRows()).toHaveLength(2);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keys expansion by member identity rather than row position', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const other = { ...person, id: 'other', userId: 'other', name: 'Other Member' };
    try {
      act(() => root.render(<PeopleTable rows={[person, other]} rangeType="billing" />));
      act(() => container.querySelector('button')!.click());
      act(() => root.render(<PeopleTable rows={[other, person]} rangeType="billing" />));
      expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
      act(() => root.render(<PeopleTable rows={[other]} rangeType="billing" />));
      expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelectorAll('table')).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps zero, unknown usage, unlimited limits and source context distinct in aligned rows', () => {
    const markup = renderToStaticMarkup(<PersonWorkspaceDetails workspaces={[
      { ...workspace, spendUsd: 0, allocationUsd: 0, currentCycleAgentSpendUsd: 0, currentCycleRemainingUsd: 0, limitState: 'inherited' },
      { ...workspace, workspaceId: 'unknown', usageObserved: false, allocationUsd: null, currentCycleAgentSpendUsd: null, currentCycleRemainingUsd: null, limitState: 'unavailable', limitObservationStatus: 'unavailable' },
      { ...workspace, workspaceId: 'unlimited', allocationUsd: null, limitState: 'no_limit', currentCycleRemainingUsd: null },
    ]} />);
    const body = new DOMParser().parseFromString(markup, 'text/html');
    const rows = [...body.querySelectorAll('tbody tr')];
    expect(rows[0].textContent).toContain('$0.00');
    expect(rows[0].textContent).toContain('Source: inherited');
    expect(rows[1].textContent).toContain('Observation unavailable');
    expect(rows[1].textContent).not.toContain('$0.00');
    expect(rows[2].textContent).toContain('No limit');
    expect(markup).not.toMatch(/Refreshing|Updating/);
  });
});