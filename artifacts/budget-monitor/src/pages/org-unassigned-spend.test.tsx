// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrgBudgetOverviewResponse } from '@workspace/api-client-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnassignedSpendCard } from './org-unassigned-spend';

const reporting = {
  acquisitionCoverage: 'complete',
  rosterAttributionBasis: 'observed_roster',
  creatorCoverage: 'complete',
  creatorAttributionBasis: 'not_applicable',
  freshness: 'fresh',
  valueBasis: 'verified',
  comparisonsVerified: true,
} as const;

const overview = (
  detail: OrgBudgetOverviewResponse['unassignedDetail'],
  unassignedSpendUsd: number | null = 47.25,
): OrgBudgetOverviewResponse => ({
  periodStart: '2026-05-20',
  periodEnd: '2027-05-20',
  asOf: '2026-09-08',
  complete: detail.observation === 'complete',
  reporting,
  qualification: null,
  summary: {
    accountSpendUsd: 100,
    teamAllocationUsd: 80,
    remainingUsd: 20,
    teamsOverBudget: 0,
    unassignedSpendUsd,
    fundedTeamCount: 1,
    resolvedTeamCount: 1,
    unresolvedTeamCount: 0,
  },
  unassignedDetail: detail,
  accountPoints: [],
  teams: [],
});

const qualifiedDetail: OrgBudgetOverviewResponse['unassignedDetail'] = {
  observation: 'partial',
  workspaces: [
    {
      workspaceId: 'ws-north',
      workspaceName: 'North Workspace',
      spendUsd: 42.25,
      rows: [
        {
          id: 'row-mapping',
          groupName: 'Platform',
          source: 'unmapped_group',
          spendUsd: 30,
        },
        {
          id: 'row-no-group',
          groupName: null,
          source: 'no_group',
          spendUsd: 12.25,
        },
      ],
    },
    {
      workspaceId: null,
      workspaceName: null,
      spendUsd: 5,
      rows: [
        {
          id: 'row-difference',
          groupName: null,
          source: 'unresolved_difference',
          spendUsd: 5,
        },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const renderCard = async (data: OrgBudgetOverviewResponse, isFetching = false, isError = false) => {
  await act(async () => root.render(
    <UnassignedSpendCard data={data} isFetching={isFetching} isError={isError} />,
  ));
};

const open = async () => {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Inspect Unassigned Spend"]',
  );
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  return trigger!;
};

describe('UnassignedSpendCard', () => {
  it('renders workspace-qualified rows, subtotals, sources, and the attribution explanation', async () => {
    await renderCard(overview(qualifiedDetail));
    await open();

    const dialog = document.querySelector<HTMLElement>('[data-testid="org-unassigned-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('$47.25');
    expect(dialog!.textContent).toContain('Funding Period: 2026-05-20 to 2027-05-20');
    expect(dialog!.textContent).toContain('Recorded through: 2026-09-08');
    expect(dialog!.textContent).toContain('North Workspace');
    expect(dialog!.textContent).toContain('(ws-north)');
    expect(dialog!.textContent).toContain('Subtotal: $42.25');
    expect(dialog!.textContent).toContain('Workspace unresolved');
    expect(dialog!.textContent).toContain('Subtotal: $5.00');
    expect(dialog!.textContent).toContain('Platform');
    expect(dialog!.textContent).toContain('Group not mapped to a budget team');
    expect(dialog!.textContent).toContain('No group / unresolved attribution');
    expect(dialog!.textContent).toContain('Workspace-level attribution');
    expect(dialog!.textContent).toContain('Unresolved accounting difference');
    expect(dialog!.textContent).toContain('These amounts do not identify a missing owner.');
    expect(dialog!.textContent).toContain('Recorded usage only; some workspace observations are missing.');
  });

  it('qualifies an empty partial result without claiming missing usage is zero', async () => {
    await renderCard(overview({ observation: 'partial', workspaces: [] }, 0));
    await open();
    const dialog = document.querySelector('[data-testid="org-unassigned-dialog"]')!;
    expect(dialog.textContent).toContain('No unassigned spend in the recorded usage');
    expect(dialog.textContent).toContain('Recorded usage only; some workspace observations are missing.');
    expect(dialog.textContent).toContain('Missing usage is not zero.');
  });

  it('distinguishes observed zero from unavailable detail', async () => {
    await renderCard(overview({ observation: 'complete', workspaces: [] }, 0));
    await open();
    expect(document.body.textContent).toContain(
      'No unassigned spend in the recorded usage for this funding period.',
    );
    expect(document.body.textContent).not.toContain('Missing usage is not zero.');

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="org-unassigned-dialog"] button',
      )?.click();
    });
    await renderCard(overview({ observation: 'unavailable', workspaces: [] }, null));
    await open();
    expect(document.body.textContent).toContain(
      'Unassigned spend details are unavailable. Missing usage is not zero.',
    );
    expect(document.body.textContent).not.toContain(
      'No unassigned spend in the recorded usage for this funding period.',
    );
  });

  it('keeps the trigger value and open detail on the same response during refresh and update', async () => {
    const first = overview(qualifiedDetail);
    await renderCard(first);
    await open();
    expect(container.textContent).toContain('$47.25');
    expect(document.querySelector('[data-testid="unassigned-detail-total"]')?.textContent).toContain('$47.25');

    await renderCard(first, true);
    expect(container.textContent).toContain('$47.25');
    expect(document.querySelector('[data-testid="unassigned-detail-total"]')?.textContent).toContain('$47.25');
    expect(document.body.textContent).not.toContain('Updating');

    await renderCard(first, false, true);
    expect(container.textContent).toContain('$47.25');
    expect(document.querySelector('[data-testid="unassigned-detail-total"]')?.textContent).toContain('$47.25');
    expect(document.body.textContent).toContain('North Workspace');
    expect(document.querySelector('[role="alert"]')).toBeNull();

    const updated = overview({
      observation: 'complete',
      workspaces: [{
        workspaceId: 'ws-south',
        workspaceName: 'South Workspace',
        spendUsd: 9,
        rows: [{
          id: 'south-no-group',
          groupName: null,
          source: 'no_group',
          spendUsd: 9,
        }],
      }],
    }, 9);
    await renderCard(updated);
    expect(container.textContent).toContain('$9.00');
    expect(document.querySelector('[data-testid="unassigned-detail-total"]')?.textContent).toContain('$9.00');
    expect(document.body.textContent).toContain('South Workspace');
    expect(document.body.textContent).not.toContain('North Workspace');
  });
});