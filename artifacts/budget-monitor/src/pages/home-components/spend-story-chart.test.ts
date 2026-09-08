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
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => children,
  LineChart: ({ children, data }: any) => {
    observed.chartData = data;
    return children;
  },
  Line: (props: any) => {
    observed.lines.push(props);
    return null;
  },
  XAxis: () => null,
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