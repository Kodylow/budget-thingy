// @vitest-environment happy-dom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingCycleComparisonCycle } from '@workspace/api-client-react';
import { SpendStoryChart, billingCycleSeriesData } from './spend-story-chart';

const observed = vi.hoisted(() => ({
  chartData: [] as Array<Record<string, unknown>>,
  tooltipDay: 0,
  lines: [] as Array<Record<string, unknown>>,
  axis: {} as Record<string, any>,
  margin: {} as Record<string, number>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => children,
  LineChart: ({ children, data, margin }: any) => {
    observed.chartData = data;
    observed.margin = margin;
    return children;
  },
  Line: (props: any) => {
    observed.lines.push(props);
    return null;
  },
  XAxis: (props: any) => { observed.axis = props; return null; },
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => content({
    active: true,
    label: observed.tooltipDay + 1,
    payload: [{ payload: observed.chartData[observed.tooltipDay] }],
  }),
  BarChart: ({ children }: any) => children,
  Bar: () => null,
  Cell: () => null,
}));

beforeEach(() => {
  observed.chartData = [];
  observed.tooltipDay = 0;
  observed.lines = [];
  observed.axis = {};
  observed.margin = {};
});

describe('billing cycle spend series', () => {
  it('aligns cycles by day and preserves missing and future values as null', () => {
    const cycles: BillingCycleComparisonCycle[] = [
      {
        key: 'current',
        label: 'This month',
        startDate: '2026-03-10',
        endDate: '2026-04-09',
        personalComplete: false,
        teamComplete: false,
        points: [
          { day: 1, date: '2026-03-10', personalSpendUsd: 10, teamSpendUsd: 25 },
          { day: 2, date: '2026-03-11', personalSpendUsd: null, teamSpendUsd: null },
        ],
      },
      {
        key: 'previous',
        label: 'Last month',
        startDate: '2026-02-10',
        endDate: '2026-03-09',
        personalComplete: true,
        teamComplete: true,
        points: [
          { day: 1, date: '2026-02-10', personalSpendUsd: 8, teamSpendUsd: 20 },
          { day: 2, date: '2026-02-11', personalSpendUsd: 12, teamSpendUsd: 30 },
          { day: 3, date: '2026-02-12', personalSpendUsd: 18, teamSpendUsd: 40 },
        ],
      },
    ];

    const personal = billingCycleSeriesData(cycles, 'personal');

    expect(personal).toHaveLength(3);
    expect(personal[0]).toMatchObject({ day: 1, current: 10, previous: 8 });
    expect(personal[1]).toMatchObject({ day: 2, current: null, previous: 12 });
    expect(personal[2]).toMatchObject({ day: 3, current: null, previous: 18, twoAgo: null });
    expect(personal[2].current).not.toBe(0);
  });

  it('retains observed zeroes and null gaps in partial series', () => {
    const cycles = [{
      key: 'current',
      label: 'Current',
      points: [
        { day: 1, date: '2026-03-10', personalSpendUsd: 0, teamSpendUsd: 2 },
        { day: 2, date: '2026-03-11', personalSpendUsd: null, teamSpendUsd: 3 },
      ],
    }] as BillingCycleComparisonCycle[];

    expect(billingCycleSeriesData(cycles, 'personal')).toEqual([
      expect.objectContaining({ current: 0 }),
      expect.objectContaining({ current: null }),
    ]);
  });
});

describe('SpendStoryChart visible series', () => {
  const cycles = [
    {
      key: 'current',
      label: 'Current',
      points: [
        { day: 1, date: '2026-03-10', personalSpendUsd: 0, teamSpendUsd: null },
        { day: 2, date: '2026-03-11', personalSpendUsd: null, teamSpendUsd: null },
      ],
    },
    {
      key: 'previous',
      label: 'Previous',
      points: [
        { day: 1, date: '2026-02-10', personalSpendUsd: null, teamSpendUsd: 20 },
        { day: 2, date: '2026-02-11', personalSpendUsd: null, teamSpendUsd: null },
      ],
    },
    {
      key: 'twoAgo',
      label: 'Two ago',
      points: [
        { day: 1, date: '2026-01-10', personalSpendUsd: 10, teamSpendUsd: null },
        { day: 2, date: '2026-01-11', personalSpendUsd: 15, teamSpendUsd: null },
      ],
    },
  ] as BillingCycleComparisonCycle[];

  it('renders only scope-known legend and lines, independently by scope', () => {
    const personalHtml = renderToStaticMarkup(
      React.createElement(SpendStoryChart, { cycles, scope: 'personal' }),
    );
    expect(personalHtml).toContain('Current');
    expect(personalHtml).toContain('Two ago');
    expect(personalHtml).not.toContain('Previous');
    expect(observed.lines.map((line) => line.dataKey)).toEqual(['current', 'twoAgo']);
    expect(observed.chartData[0]).toMatchObject({ current: 0, twoAgo: 10 });

    observed.lines = [];
    const teamHtml = renderToStaticMarkup(
      React.createElement(SpendStoryChart, { cycles, scope: 'team' }),
    );
    expect(teamHtml).toContain('Previous');
    expect(teamHtml).not.toContain('Current');
    expect(teamHtml).not.toContain('Two ago');
    expect(observed.lines.map((line) => line.dataKey)).toEqual(['previous']);
  });

  it('omits unknown tooltip rows on a partially known day', () => {
    observed.tooltipDay = 1;
    const html = renderToStaticMarkup(
      React.createElement(SpendStoryChart, { cycles, scope: 'personal' }),
    );

    expect(html).toContain('Two ago');
    expect(html).toContain('$15.00');
    expect(html).not.toContain('Unavailable');
    expect(html.match(/Current/g)).toHaveLength(1);
    expect(html.match(/Two ago/g)).toHaveLength(2);
  });

  it('hides a chart whose selected scope has only null or non-finite values', () => {
    const emptyCycles = [{
      key: 'current',
      label: 'Current',
      points: [
        { day: 1, date: '2026-03-10', personalSpendUsd: null, teamSpendUsd: 0 },
        { day: 2, date: '2026-03-11', personalSpendUsd: Number.NaN, teamSpendUsd: 1 },
      ],
    }] as BillingCycleComparisonCycle[];

    const html = renderToStaticMarkup(
      React.createElement(SpendStoryChart, { cycles: emptyCycles, scope: 'personal' }),
    );
    expect(html).toContain('No comparable period spend available');
    expect(observed.lines).toHaveLength(0);
  });
});

describe('SpendStoryChart calendar axis', () => {
  function cycle(key: BillingCycleComparisonCycle['key'], dates: Array<string | null>, values?: Array<number | null>) {
    return {
      key, label: key,
      points: dates.flatMap((date, index) => date ? [{
        day: index + 1, date,
        personalSpendUsd: values ? values[index] : index,
        teamSpendUsd: values ? values[index] : index,
      }] : []),
    } as BillingCycleComparisonCycle;
  }

  it('formats real full-term UTC dates instead of day numbers and reserves axis space', () => {
    renderToStaticMarkup(React.createElement(SpendStoryChart, {
      cycles: [cycle('current', ['2026-05-20T00:00:00Z', '2026-06-10T00:00:00Z', '2026-09-08T00:00:00Z'])],
      scope: 'personal',
    }));
    expect(observed.axis.ticks.map(observed.axis.tickFormatter)).toEqual(['May 20', 'Jun 10', 'Sep 8']);
    expect(observed.axis.dataKey).toBe('day');
    expect(observed.axis.label).toBeUndefined();
    expect(observed.axis.interval).toBe('preserveStartEnd');
    expect(observed.axis.minTickGap).toBeGreaterThanOrEqual(24);
    expect(observed.axis.height).toBeGreaterThanOrEqual(36);
    expect(observed.margin.bottom).toBeGreaterThan(0);
  });

  it.each(['personal', 'team'] as const)('uses current dates for %s even when current spend is entirely unknown', (scope) => {
    const html = renderToStaticMarkup(React.createElement(SpendStoryChart, {
      cycles: [
        cycle('current', ['2024-02-28', '2024-02-29', '2024-03-01'], [null, null, null]),
        cycle('previous', ['2024-01-28', '2024-01-29', '2024-01-30']),
      ], scope,
    }));
    expect(observed.axis.ticks.map(observed.axis.tickFormatter)).toEqual(['Feb 28', 'Feb 29', 'Mar 1']);
    expect(html).toContain('Dates: current period (UTC)');
    expect(observed.lines.map(line => line.dataKey)).toEqual(['previous']);
  });

  it('leaves absent reference buckets and longer previous-period tails unlabeled', () => {
    observed.tooltipDay = 3;
    const html = renderToStaticMarkup(React.createElement(SpendStoryChart, {
      cycles: [
        cycle('current', ['2026-02-27', null, '2026-03-01'], [0, null, 5]),
        cycle('previous', ['2026-01-27', '2026-01-28', '2026-01-29', '2026-01-30']),
      ], scope: 'personal',
    }));
    expect(observed.axis.ticks).toEqual([1, 3]);
    expect(observed.axis.tickFormatter(2)).toBe('');
    expect(observed.axis.tickFormatter(4)).toBe('');
    expect(observed.chartData).toHaveLength(4);
    expect(observed.chartData[0]).toMatchObject({ current: 0, previous: 0 });
    expect(observed.chartData[1]).toMatchObject({ current: null, currentDate: null, previous: 1 });
    expect(observed.chartData[3]).toMatchObject({ current: null, previous: 3 });
    expect(html).toContain('Jan 30, 2026');
    expect(html).not.toContain('Mar 2');
    expect(observed.lines.every(line => line.connectNulls === false)).toBe(true);
  });

  it('keeps each tooltip series actual date, including observed zeroes', () => {
    const html = renderToStaticMarkup(React.createElement(SpendStoryChart, {
      cycles: [
        cycle('current', ['2024-03-01']),
        cycle('previous', ['2024-02-01']),
        cycle('twoAgo', ['2024-01-01']),
      ], scope: 'personal',
    }));
    expect(observed.axis.ticks).toEqual([1]);
    expect(observed.axis.tickFormatter(1)).toBe('Mar 1');
    for (const date of ['Mar 1, 2024', 'Feb 1, 2024', 'Jan 1, 2024']) expect(html).toContain(date);
    expect(html.match(/\$0\.00/g)).toHaveLength(3);
  });

  it('does not substitute older dates when the current period has no points', () => {
    const html = renderToStaticMarkup(React.createElement(SpendStoryChart, {
      cycles: [cycle('current', []), cycle('previous', ['2026-01-31'])],
      scope: 'personal',
    }));
    expect(observed.axis.ticks).toEqual([]);
    expect(observed.axis.tickFormatter(1)).toBe('');
    expect(html).toContain('Current period dates unavailable');
    expect(html).toContain('Jan 31, 2026');
  });
});