// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgBudgetOverviewResponse } from '@workspace/api-client-react';
import { OrgBudgetChart } from './org-budget-chart';

const observed = vi.hoisted(() => ({
  data: [] as any[],
  lines: new Map<string, any>(),
  referenceLines: [] as any[],
  tooltip: null as null | ((props: any) => React.ReactNode),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <>{children}</>,
  LineChart: ({ children, data }: any) => {
    observed.data = data;
    observed.lines.clear();
    observed.referenceLines.length = 0;
    return <div data-testid="mock-line-chart">{children}</div>;
  },
  Line: (props: any) => {
    observed.lines.set(props.name, props);
    return <i data-line-name={props.name} />;
  },
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  ReferenceLine: (props: any) => {
    observed.referenceLines.push(props);
    return null;
  },
  Tooltip: ({ content }: any) => {
    observed.tooltip = content;
    return null;
  },
}));
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}));

const reporting = {
  acquisitionCoverage: 'complete',
  rosterAttributionBasis: 'observed_roster',
  creatorCoverage: 'complete',
  creatorAttributionBasis: 'not_applicable',
  freshness: 'fresh',
  valueBasis: 'verified',
  comparisonsVerified: true,
} as const;

const makeTeam = (id: string, name: string, allocationUsd: number | null, spendUsd: number | null) => ({
  id,
  name,
  allocationUsd,
  spendUsd,
  remainingUsd: null,
  percentUsed: null,
  complete: true,
  reporting,
  points: spendUsd == null ? [] : [{ date: '2026-06-01', spendUsd }],
});

const makeData = (teams: OrgBudgetOverviewResponse['teams']): OrgBudgetOverviewResponse => ({
  periodStart: '2026-05-20',
  periodEnd: '2027-05-20',
  asOf: '2026-09-08',
  complete: true,
  reporting,
  qualification: null,
  summary: {
    accountSpendUsd: null,
    teamAllocationUsd: null,
    remainingUsd: null,
    teamsOverBudget: null,
    unassignedSpendUsd: null,
  },
  teams,
});

const teams = [
  makeTeam('low', 'Low team', 100, 10),
  makeTeam('highest', 'Highest team', 100, 50),
  makeTeam('middle', 'Middle team', 100, 30),
  makeTeam('second', 'Second team', 100, 40),
];

let container: HTMLDivElement;
let root: Root;
const buttonFor = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes(name))!;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observed.data = [];
  observed.lines.clear();
  observed.referenceLines.length = 0;
  observed.tooltip = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('organization budget chart controls', () => {
  it('selects the three highest-spend funded teams by default', async () => {
    await act(async () => root.render(<OrgBudgetChart data={makeData(teams)} />));

    expect(buttonFor('Highest team').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Second team').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Middle team').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Low team').getAttribute('aria-pressed')).toBe('false');
    expect(observed.lines.size).toBe(6);
  });

  it('toggles both actual and budget lines with an aria-pressed team control', async () => {
    await act(async () => root.render(<OrgBudgetChart data={makeData(teams)} />));
    await act(async () => buttonFor('Highest team').click());

    expect(buttonFor('Highest team').getAttribute('aria-pressed')).toBe('false');
    expect(observed.lines.has('Highest team Actual')).toBe(false);
    expect(observed.lines.has('Highest team Budget')).toBe(false);

    await act(async () => buttonFor('Highest team').click());
    expect(buttonFor('Highest team').getAttribute('aria-pressed')).toBe('true');
    expect(observed.lines.has('Highest team Actual')).toBe(true);
    expect(observed.lines.has('Highest team Budget')).toBe(true);
  });

  it('supports Clear and All while retaining controls for an empty selection', async () => {
    await act(async () => root.render(<OrgBudgetChart data={makeData(teams)} />));
    await act(async () => buttonFor('Clear').click());

    expect(container.textContent).toContain('No teams selected.');
    expect(buttonFor('All')).toBeTruthy();
    expect(buttonFor('Highest team').getAttribute('aria-pressed')).toBe('false');

    await act(async () => buttonFor('All').click());
    expect(container.textContent).not.toContain('No teams selected.');
    expect(teams.every(team => buttonFor(team.name).getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(observed.lines.size).toBe(8);
  });

  it('keys duplicate names by stable IDs and preserves selection across reorder', async () => {
    const duplicates = [
      makeTeam('first-id', 'Same team', 100, 20),
      makeTeam('second-id', 'Same team', 200, 10),
    ];
    await act(async () => root.render(<OrgBudgetChart data={makeData(duplicates)} />));
    const duplicateButtons = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent?.includes('Same team'));
    const colorBeforeReorder = observed.lines.get('Same team Actual').stroke;
    await act(async () => duplicateButtons[0].click());
    await act(async () => root.render(<OrgBudgetChart data={makeData([...duplicates].reverse())} />));

    const reordered = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent?.includes('Same team'));
    expect(reordered.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(observed.lines.size).toBe(2);
    const row = observed.data.find(item => item.date === '2026-06-01');
    const actual = [...observed.lines.values()].find(line => line.name.endsWith('Actual'));
    expect(actual.dataKey(row)).toBe(10);
    expect(actual.stroke).toBe(colorBeforeReorder);
  });

  it('searches long team names without changing their selection', async () => {
    const longName = 'Customer Experience and International Operations Team';
    await act(async () => root.render(
      <OrgBudgetChart data={makeData([...teams, makeTeam('long', longName, 100, 1)])} />,
    ));
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Search teams..."]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'international operations');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(buttonFor(longName)).toBeTruthy();
    expect(container.textContent).not.toContain('Highest team');
    expect(buttonFor(longName).getAttribute('aria-pressed')).toBe('false');
  });

  it('exposes functional line keys and a tooltip with actual, pace, and funded values', async () => {
    await act(async () => root.render(<OrgBudgetChart data={makeData(teams)} />));
    const row = observed.data.find(item => item.date === '2026-06-01');
    const actual = observed.lines.get('Highest team Actual');
    const budget = observed.lines.get('Highest team Budget');

    expect(actual.dataKey(row)).toBe(50);
    expect(budget.dataKey(row)).toBeGreaterThan(0);
    expect(actual.connectNulls).toBe(false);
    expect(budget.connectNulls).toBe(false);
    const tooltip = renderToStaticMarkup(<>{observed.tooltip?.({
      active: true,
      label: row.day,
      payload: [{ payload: row }],
    })}</>);
    expect(tooltip).toContain('Highest team');
    expect(tooltip).toContain('$50.00');
    expect(tooltip).toContain('Pace:');
    expect(tooltip).toContain('Funded:');
  });

  it('places the as-of marker on the date portion of an ISO timestamp', async () => {
    const data = { ...makeData(teams), asOf: '2026-09-08T23:59:59Z' };
    await act(async () => root.render(<OrgBudgetChart data={data} />));

    expect(observed.referenceLines).toContainEqual(expect.objectContaining({
      x: Math.floor(Date.parse('2026-09-08T00:00:00Z') / 86_400_000),
    }));
  });

  it('shows the funded-team empty state without chart controls', async () => {
    await act(async () => root.render(
      <OrgBudgetChart data={makeData([makeTeam('zero', 'Zero', 0, 1), makeTeam('none', 'None', null, 2)])} />,
    ));

    expect(container.textContent).toContain('No teams with funded budgets found.');
    expect(container.querySelector('[data-testid="mock-line-chart"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});