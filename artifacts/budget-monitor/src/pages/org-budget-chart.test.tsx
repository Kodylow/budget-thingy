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
  yAxis: null as any,
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
  YAxis: (props: any) => { observed.yAxis = props; return null; },
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

const makeData = (
  teams: OrgBudgetOverviewResponse['teams'],
  overrides: Partial<OrgBudgetOverviewResponse> = {},
): OrgBudgetOverviewResponse => ({
  periodStart: '2026-05-20',
  periodEnd: '2027-05-20',
  asOf: '2026-09-08',
  complete: true,
  reporting,
  qualification: null,
  summary: {
    accountSpendUsd: 75,
    teamAllocationUsd: 400,
    remainingUsd: 325,
    teamsOverBudget: 0,
    unassignedSpendUsd: 25,
    fundedTeamCount: 2,
    resolvedTeamCount: 2,
    unresolvedTeamCount: 0,
  },
  accountPoints: [
    { date: '2026-05-20', spendUsd: 0 },
    { date: '2026-06-01', spendUsd: 75 },
  ],
  teams,
  ...overrides,
});

const teams = [
  makeTeam('alpha', 'Alpha team', 100, 50),
  makeTeam('beta', 'Beta team', 100, 20),
];

let container: HTMLDivElement;
let root: Root;
const buttonFor = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.includes(name))!;
const render = async (data = makeData(teams)) => {
  await act(async () => root.render(<OrgBudgetChart data={data} onRetry={async () => {}} />));
};

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
  it.each([
    { spendUsd: 50, label: '$50.00', percent: '50%' },
    { spendUsd: 0, label: '$0.00', percent: '0%' },
    { spendUsd: null, label: 'No spend data', percent: 'No spend data' },
  ])('shows incomplete Total and team spend as $label without selector qualifiers', async ({ spendUsd, label, percent }) => {
    const points = [
      { date: '2026-06-01', spendUsd },
      { date: '2026-06-02', spendUsd: null },
    ];
    const data = makeData([{ ...makeTeam('alpha', 'Alpha team', 100, spendUsd), complete: false, points }], {
      complete: false,
      accountPoints: points,
      summary: { ...makeData([]).summary, accountSpendUsd: spendUsd },
    });
    const original = structuredClone(data);
    await render(data);

    expect(buttonFor('Total').textContent).toBe(`Total${label}$400.00`);
    expect(buttonFor('Alpha team').textContent).toBe(`Alpha team${label}$100.00`);
    expect(buttonFor('Total').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Alpha team').getAttribute('aria-pressed')).toBe('false');
    await act(async () => buttonFor('Alpha team').click());
    expect(buttonFor('Alpha team').getAttribute('aria-pressed')).toBe('true');
    for (const name of ['Total', 'Alpha team']) {
      expect(buttonFor(name).textContent).not.toContain('Partial');
      const line = observed.lines.get(`${name} Actual`);
      expect(line.dataKey(observed.data.find(row => row.date === '2026-06-01'))).toBe(spendUsd);
      expect(line.dataKey(observed.data.find(row => row.date === '2026-06-02'))).toBeNull();
      expect(line.connectNulls).toBe(false);
    }
    await act(async () => buttonFor('% of allocation').click());
    expect(buttonFor('Alpha team').textContent).toBe(`Alpha team${percent}$100.00`);
    expect(buttonFor('Total').textContent).not.toContain('Partial');
    expect(data).toEqual(original);
  });

  it('normalizes each allocation independently, preserves raw dollars, dates, colors and selections across modes/refetch', async () => {
    const unequalTeams = [
      { ...makeTeam('alpha', 'Alpha team', 100, 50), complete: false },
      makeTeam('beta', 'Beta team', 1000, 500),
    ];
    await render(makeData(unequalTeams));
    expect(buttonFor('Dollars').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { buttonFor('Alpha team').click(); });
    await act(async () => { buttonFor('Beta team').click(); });
    const dates = observed.data.map(row => row.date);
    const color = observed.lines.get('Alpha team Actual').stroke;
    await act(async () => buttonFor('% of allocation').click());
    expect(buttonFor('% of allocation').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Trajectory units');
    expect(container.textContent).toContain('Recorded spend (%)');
    expect(buttonFor('Beta team').textContent).toContain('50%');
    expect(buttonFor('Beta team').textContent).toContain('$1,000.00');
    const row = observed.data.find(item => item.date === '2026-06-01');
    expect(observed.lines.get('Alpha team Actual').dataKey(row)).toBe(50);
    expect(observed.lines.get('Beta team Actual').dataKey(row)).toBe(50);
    expect(observed.lines.get('Total Actual').dataKey(row)).toBe(18.75);
    expect(row.values.beta.actual).toBe(500);
    for (const name of ['Total Budget', 'Alpha team Budget', 'Beta team Budget']) {
      expect(observed.lines.get(name).dataKey(observed.data.at(-1))).toBe(100);
    }
    expect(observed.yAxis.tickFormatter(150)).toBe('150%');
    expect(observed.yAxis.domain).toEqual([0, 'auto']);
    expect(observed.yAxis.label.value).toBe('% of allocation');
    const tooltip = renderToStaticMarkup(<>{observed.tooltip?.({ active: true, label: row.day, payload: [{ payload: row }] })}</>);
    expect(tooltip).toContain('Recorded: 50% ($500.00)');
    expect(tooltip).toMatch(/Pace: [\d.]+% \(\$[\d.]+\)/);
    expect(tooltip).toContain('Allocated: $1,000.00');
    await act(async () => buttonFor('Alpha team').click());
    expect(observed.lines.get('Total Actual').dataKey(row)).toBe(18.75);
    await act(async () => buttonFor('Total').click());
    await render(makeData([...unequalTeams].reverse()));
    expect(buttonFor('Total').getAttribute('aria-pressed')).toBe('false');
    expect(buttonFor('Beta team').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('% of allocation').getAttribute('aria-pressed')).toBe('true');
    expect(observed.data.map(row => row.date)).toEqual(dates);
    await act(async () => buttonFor('Alpha team').click());
    expect(observed.lines.get('Alpha team Actual').stroke).toBe(color);
    await act(async () => buttonFor('Dollars').click());
    expect(observed.lines.get('Beta team Actual').dataKey(row)).toBe(500);
    expect(observed.yAxis.tickFormatter(150)).toBe('$150');
  });

  it.each([0, null, undefined, -1, Infinity, NaN])('handles unusable Total allocation %s without changing eligibility or dollar data', async allocation => {
    const data = makeData([
      makeTeam('zero', 'Zero team', 0, 25),
      makeTeam('invalid', 'Invalid team', allocation as number | null, 10),
    ]);
    data.summary.teamAllocationUsd = allocation as number | null;
    await render(data);
    await act(async () => buttonFor('Zero team').click());
    await act(async () => buttonFor('% of allocation').click());
    expect(container.textContent).toContain('Normalization unavailable.');
    expect(container.textContent).toContain('Switch to Dollars');
    expect(container.textContent).not.toContain('Spend and budget data unavailable.');
    expect(buttonFor('Zero team').textContent).toContain('Unavailable');
    expect(buttonFor('Zero team').textContent).toContain('$0.00');
    expect(buttonFor('Total').textContent).toContain('Unavailable');
    expect(container.querySelector('[data-testid="mock-line-chart"]')).toBeNull();
    if (allocation !== 0) expect(buttonFor('Invalid team')).toBeUndefined();
    await act(async () => buttonFor('Dollars').click());
    const row = observed.data.find(item => item.date === '2026-06-01');
    expect(observed.lines.get('Zero team Actual').dataKey(row)).toBe(25);
    expect(observed.lines.get('Total Actual').dataKey(row)).toBe(75);
    expect(buttonFor('Zero team').getAttribute('aria-pressed')).toBe('true');
  });

  it('omits only unusable lines while keeping zeroes, gaps, overspend and as-of cutoff in normalized mode', async () => {
    const data = makeData([
      makeTeam('zero', 'Zero team', 0, 25),
      makeTeam('positive', 'Positive team', 100, 0),
      makeTeam('missing', 'Missing spend', 100, null),
    ], {
      complete: false,
      asOf: '2026-06-03',
      accountPoints: [
        { date: '2026-06-01', spendUsd: 0 },
        { date: '2026-06-02', spendUsd: null },
        { date: '2026-06-03', spendUsd: 600 },
        { date: '2026-06-04', spendUsd: 900 },
      ],
    });
    await render(data);
    await act(async () => buttonFor('Zero team').click());
    await act(async () => buttonFor('% of allocation').click());
    expect([...observed.lines.keys()]).toEqual(['Total Actual', 'Total Budget']);
    const actual = observed.lines.get('Total Actual');
    expect(actual.dataKey(observed.data.find(row => row.date === '2026-06-01'))).toBe(0);
    expect(actual.dataKey(observed.data.find(row => row.date === '2026-06-02'))).toBeNull();
    expect(actual.dataKey(observed.data.find(row => row.date === '2026-06-03'))).toBe(150);
    expect(actual.connectNulls).toBe(false);
    expect(observed.data.find(row => row.date === '2026-06-04')).toBeUndefined();
    expect(buttonFor('Positive team').textContent).toContain('0%');
    expect(buttonFor('Missing spend').textContent).toContain('No spend data');
    const row = observed.data.find(item => item.date === '2026-06-01');
    const tooltip = renderToStaticMarkup(<>{observed.tooltip?.({ active: true, label: row.day, payload: [{ payload: row }] })}</>);
    expect(tooltip).toContain('Recorded: Unavailable ($25.00)');
    expect(tooltip).toContain('Allocated: $0.00');
  });

  it('handles missing accountPoints across response versions without changing selections or inventing totals', async () => {
    await render();
    await act(async () => buttonFor('Alpha team').click());
    await act(async () => buttonFor('Total').click());
    const incompatible = makeData(teams);
    delete (incompatible as Partial<OrgBudgetOverviewResponse>).accountPoints;
    await render(incompatible);
    expect(container.querySelector('[data-testid="org-chart-unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-line-chart"]')).toBeNull();
    await render();
    expect(buttonFor('Alpha team').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Total').getAttribute('aria-pressed')).toBe('false');
    await act(async () => buttonFor('Total').click());
    const row = observed.data.find(item => item.date === '2026-06-01');
    expect(observed.lines.get('Total Actual').dataKey(row)).toBe(75);
  });

  it.each([
    { accountPoints: null },
    { accountPoints: [{ date: '2026-06-01', spendUsd: '75' }] },
    { accountPoints: [null] },
    { asOf: 42 },
    { periodStart: '2026-02-30' },
    { teams: [{ ...teams[0], points: undefined }] },
  ])('shows explicit unavailability for malformed chart data %j', async overrides => {
    await render(makeData(teams, overrides as any));
    expect(container.querySelector('[data-testid="org-chart-unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-line-chart"]')).toBeNull();
    await render();
    expect(container.querySelector('[data-testid="mock-line-chart"]')).not.toBeNull();
  });
  it('defaults to only Total using account actuals and allocated-team pace', async () => {
    await render();

    expect(buttonFor('Total').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Alpha team').getAttribute('aria-pressed')).toBe('false');
    expect(buttonFor('Beta team').getAttribute('aria-pressed')).toBe('false');
    expect([...observed.lines.keys()]).toEqual(['Total Actual', 'Total Budget']);
    const row = observed.data.find(item => item.date === '2026-06-01');
    expect(observed.lines.get('Total Actual').dataKey(row)).toBe(75);
    expect(observed.lines.get('Total Budget').dataKey(row)).toBeGreaterThan(0);
  });

  it('toggles Total independently and toggles both line pairs for a team', async () => {
    await render();
    await act(async () => buttonFor('Alpha team').click());

    expect([...observed.lines.keys()]).toEqual([
      'Total Actual', 'Total Budget', 'Alpha team Actual', 'Alpha team Budget',
    ]);
    await act(async () => buttonFor('Total').click());
    expect(buttonFor('Total').getAttribute('aria-pressed')).toBe('false');
    expect([...observed.lines.keys()]).toEqual(['Alpha team Actual', 'Alpha team Budget']);
    await act(async () => buttonFor('Alpha team').click());
    expect(container.textContent).toContain('No series selected.');
    expect(container.querySelector('[data-testid="mock-line-chart"]')).toBeNull();
  });

  it('does not add search, All, Clear, or any inputs', async () => {
    await render();

    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('Search teams');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'All')).toBe(false);
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Clear')).toBe(false);
  });

  it('renders tooltip Actual, Pace, and Allocated values, including unavailable allocation', async () => {
    await render();
    const row = observed.data.find(item => item.date === '2026-06-01');
    let tooltip = renderToStaticMarkup(<>{observed.tooltip?.({
      active: true,
      label: row.day,
      payload: [{ payload: row }],
    })}</>);
    expect(tooltip).toContain('Total');
    expect(tooltip).toContain('$75.00');
    expect(tooltip).toContain('Pace:');
    expect(tooltip).toContain('Allocated: $400.00');

    await render(makeData(teams, {
      summary: {
        accountSpendUsd: 75,
        teamAllocationUsd: null,
        remainingUsd: null,
        teamsOverBudget: null,
        unassignedSpendUsd: 25,
        fundedTeamCount: 2,
        resolvedTeamCount: 0,
        unresolvedTeamCount: 2,
      },
    }));
    const nullableRow = observed.data.find(item => item.date === '2026-06-01');
    tooltip = renderToStaticMarkup(<>{observed.tooltip?.({
      active: true,
      label: nullableRow.day,
      payload: [{ payload: nullableRow }],
    })}</>);
    expect(tooltip).toContain('$75.00');
    expect(tooltip).not.toContain('Pace:');
    expect(tooltip).toContain('Allocated: Unavailable');
  });

  it('keeps zero allocations selectable while excluding missing allocations', async () => {
    await render(makeData([
      makeTeam('zero', 'Zero', 0, 25),
      makeTeam('none', 'None', null, 20),
    ]));

    expect(buttonFor('Total').getAttribute('aria-pressed')).toBe('true');
    expect([...observed.lines.keys()]).toEqual(['Total Actual', 'Total Budget']);
    expect(buttonFor('Zero').getAttribute('aria-pressed')).toBe('false');
    expect(buttonFor('None')).toBeUndefined();
    await act(async () => buttonFor('Zero').click());
    const row = observed.data.find(item => item.date === '2026-06-01');
    expect(observed.lines.get('Zero Actual').dataKey(row)).toBe(25);
    expect(observed.lines.get('Zero Budget').dataKey(row)).toBe(0);
  });

  it('shows unavailable when selected series has no spend or budget values', async () => {
    await render(makeData([], {
      asOf: null,
      summary: {
        accountSpendUsd: null,
        teamAllocationUsd: null,
        remainingUsd: null,
        teamsOverBudget: null,
        unassignedSpendUsd: null,
        fundedTeamCount: 0,
        resolvedTeamCount: 0,
        unresolvedTeamCount: 0,
      },
      accountPoints: [],
    }));

    expect(container.textContent).toContain('Spend and budget data unavailable.');
    expect(container.textContent).toContain('No spend data');
    expect(container.textContent).toContain('Unavailable');
    expect(container.querySelector('input')).toBeNull();
  });

  it('preserves selections across refetch and reorder, then prunes removed IDs permanently', async () => {
    await render();
    await act(async () => buttonFor('Alpha team').click());
    await render(makeData([...teams].reverse()));
    expect(buttonFor('Alpha team').getAttribute('aria-pressed')).toBe('true');

    await render(makeData([teams[1]]));
    expect(observed.lines.has('Alpha team Actual')).toBe(false);
    await render(makeData([...teams].reverse()));
    expect(buttonFor('Alpha team').getAttribute('aria-pressed')).toBe('false');
    expect(buttonFor('Beta team').getAttribute('aria-pressed')).toBe('false');
    expect([...observed.lines.keys()]).toEqual(['Total Actual', 'Total Budget']);
  });

  it('clips account nulls, zeroes, and future points at as-of without substituting teams', async () => {
    await render(makeData([makeTeam('alpha', 'Alpha team', 100, 999)], {
      asOf: '2026-05-21',
      accountPoints: [
        { date: '2026-05-20', spendUsd: 0 },
        { date: '2026-05-21', spendUsd: null },
        { date: '2026-05-22', spendUsd: 999 },
      ],
    }));

    expect(observed.data.find(row => row.date === '2026-05-20').values['account-total'].actual).toBe(0);
    expect(observed.data.find(row => row.date === '2026-05-21').values['account-total'].actual).toBeNull();
    expect(observed.data.find(row => row.date === '2026-05-22')).toBeUndefined();
  });
});