import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardResponseTrend } from '@workspace/api-client-react';
import TrendChart from './dashboard-chart';
import { MonthMiniBars, SpendStoryChart } from './home-components/spend-story-chart';

const observed = vi.hoisted(() => ({
  chart: {} as Record<string, any>,
  line: {} as Record<string, any>,
  bucket: 0,
  adminNotes: [] as React.ReactNode[],
}));
vi.mock('@/components/admin-data-quality', () => ({
  AdminDataQualityNote: ({ children }: { children: React.ReactNode }) => {
    observed.adminNotes.push(children);
    return null;
  },
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => children,
  BarChart: ({ children, ...props }: any) => { observed.chart = props; return children; },
  Bar: (props: any) => { observed.line = props; return null; },
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => content({
    active: true, payload: [{ payload: observed.chart.data[observed.bucket] }],
  }),
}));

const trend: DashboardResponseTrend = {
  mode: 'cumulative', granularity: 'day',
  buckets: [
    { start: '2026-09-01', endExclusive: '2026-09-02', spendUsd: 1234.56, valueUsd: 1234.56, isPartial: false, isMissing: false },
    { start: '2026-09-02', endExclusive: '2026-09-03', spendUsd: null, valueUsd: 1234.56, isPartial: true, isMissing: true },
  ],
};

beforeEach(() => {
  observed.bucket = 0;
  observed.adminNotes.length = 0;
});

describe('spend trend presentation', () => {
  it('preserves known cumulative values but keeps coverage in admin notes only', () => {
    observed.bucket = 1;
    const html = renderToStaticMarkup(<TrendChart trend={trend} onClick={() => {}} />);
    expect(html).not.toContain('Known cumulative spend · partial coverage');
    expect(observed.adminNotes).toContain('Known cumulative spend · partial coverage');
    expect(html).not.toContain('Missing coverage');
    expect(html).toContain('$1,234.56');
    expect(observed.chart.data[1].val).toBe(1234.56);
  });

  it('keeps unknown period values as gaps rather than zero', () => {
    observed.bucket = 1;
    const html = renderToStaticMarkup(<TrendChart trend={{ ...trend, mode: 'period' }} onClick={() => {}} />);
    expect(observed.chart.data[1].val).toBeNull();
    expect(observed.line.radius).toEqual([2, 2, 0, 0]);
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('gaps are not zero');
    expect(observed.adminNotes).toContain('Partial coverage · gaps are not zero');
    expect(html).not.toContain('$0.00');
  });

  it('keeps chart keyboard exploration separate from Spend navigation', () => {
    const navigate = vi.fn();
    const html = renderToStaticMarkup(<TrendChart trend={trend} onClick={navigate} />);
    expect(observed.chart.accessibilityLayer).toBe(true);
    expect(observed.chart['aria-label']).toContain('arrow keys');
    expect(html).toContain('Values');
    expect(html).toContain('Explore spend');
    expect(html).toContain('aria-controls=');
    observed.chart.onClick();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('shows an explicit empty state', () => {
    const html = renderToStaticMarkup(<TrendChart trend={{ ...trend, buckets: [] }} onClick={() => {}} />);
    expect(html).toContain('No trend data available');
    expect(html).not.toContain('$0.00');
  });

  it.each(['cumulative', 'period'] as const)(
    'keeps Home %s charts and tooltips free of coverage labels',
    (mode) => {
      observed.bucket = 1;
      const html = renderToStaticMarkup(<SpendStoryChart trend={{ ...trend, mode }} />);
      expect(html).not.toMatch(/Partial coverage|Missing coverage|Partial month/);
      expect(observed.adminNotes).toContain('Partial coverage. Missing buckets are not zero.');
      expect(observed.line.radius).toEqual([2, 2, 0, 0]);
      if (mode === 'period') {
        expect(observed.chart.data[1].val).toBeNull();
        expect(html).toContain('Unavailable');
        expect(html).not.toContain('$0.00');
      } else {
        expect(html).toContain('$1,234.56');
      }
    },
  );

  it.each([
    { spendUsd: 42, isPartial: true, isMissing: false },
    { spendUsd: null, isPartial: true, isMissing: true },
  ])('keeps monthly chart coverage out of the tooltip: %j', (bucket) => {
    const html = renderToStaticMarkup(
      <MonthMiniBars monthly={[{ start: '2026-09-01', ...bucket }]} />,
    );
    expect(html).not.toMatch(/Partial coverage|Missing coverage|Partial month/);
    expect(observed.adminNotes).toContain(
      'Some months have partial or unavailable coverage. Missing values are not zero.',
    );
    if (bucket.spendUsd === null) {
      expect(html).toContain('Unavailable');
      expect(html).not.toContain('$0.00');
    } else {
      expect(html).toContain('$42.00');
    }
  });
});