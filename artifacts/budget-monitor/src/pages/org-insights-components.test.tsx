import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MonthlySpendChart, InsightCard } from './org-insights-components';

// Mock Recharts and generic DOM so renderToStaticMarkup doesn't crash
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => children,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: ({ connectNulls }: any) => <div data-testid={`area-connectNulls-${connectNulls}`} />,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
}));

describe('MonthlySpendChart', () => {
  it('passes connectNulls={false} to Area chart', () => {
    const monthly = [
      { start: '2026-06-01', endExclusive: '2026-07-01', spendUsd: 100, agentSpendUsd: 50, otherSpendUsd: 50, activeUsers: 1, isPartial: false, isMissing: false },
      { start: '2026-07-01', endExclusive: '2026-08-01', spendUsd: null, agentSpendUsd: null, otherSpendUsd: null, activeUsers: null, isPartial: false, isMissing: true },
    ];
    const html = renderToStaticMarkup(<MonthlySpendChart monthly={monthly} />);
    expect(html).toContain('data-testid="area-connectNulls-false"');
  });
});

describe('InsightCard', () => {
  it('renders custom highlight text', () => {
    const html = renderToStaticMarkup(<InsightCard title="MoM Change" value="+2.9%" subtitle="vs prior period" highlightText="Up" />);
    expect(html).toContain('Up');
    expect(html).toContain('vs prior period');
  });
});
