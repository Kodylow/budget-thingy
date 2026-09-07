import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardProjection } from '@workspace/api-client-react';
import DashboardProjectionView from './dashboard-projection';

const rendering = vi.hoisted(() => ({
  chart: {} as Record<string, any>,
  yAxis: {} as Record<string, any>,
  xAxis: {} as Record<string, any>,
  references: [] as Record<string, any>[],
  adminNotes: [] as React.ReactNode[],
}));
vi.mock('@/components/admin-data-quality', () => ({
  AdminDataQualityNote: ({ children }: { children: React.ReactNode }) => {
    rendering.adminNotes.push(children);
    return null;
  },
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => children,
  ComposedChart: ({ children, ...props }: any) => { rendering.chart = props; return children; },
  YAxis: (props: any) => { rendering.yAxis = props; return null; },
  ReferenceLine: (props: any) => { rendering.references.push(props); return null; },
  XAxis: (props: any) => { rendering.xAxis = props; return null; },
  CartesianGrid: () => null,
  Tooltip: () => null,
  Bar: () => null,
}));
beforeEach(() => {
  rendering.references = [];
  rendering.adminNotes = [];
});

const adminNotesHtml = () => renderToStaticMarkup(<>{rendering.adminNotes}</>);

const projection: DashboardProjection = {
  actualPeriod: { start: '2026-09-01T00:00:00Z', endExclusive: '2026-09-06T00:00:00Z' },
  target: { kind: 'planning_end', start: '2026-09-01T00:00:00Z', endExclusive: '2026-10-01T00:00:00Z', verified: true },
  dataThrough: '2026-09-05',
  rate: { dailySpendUsd: 10, windowStart: '2026-08-08T00:00:00Z', windowEndExclusive: '2026-09-05T00:00:00Z', completeDays: 28, sevenDayDailySpendUsd: 12, twentyEightDayDailySpendUsd: 10 },
  baseline: { spendUsd: 40, complete: true },
  budget: null, projectedTotalUsd: 300, projectedRemainingUsd: null, projectedOverageUsd: null,
  projectedUsePercent: null, status: 'unavailable', stale: false, reasons: [], methodology: 'Mean of complete UTC days.',
  trajectory: [
    { date: '2026-09-01', actualCumulativeUsd: 0, projectedCumulativeUsd: null, sevenDayScenarioUsd: null, twentyEightDayScenarioUsd: null },
    { date: '2026-09-05', actualCumulativeUsd: 40, projectedCumulativeUsd: 40, sevenDayScenarioUsd: 40, twentyEightDayScenarioUsd: 40 },
    { date: '2026-09-30', actualCumulativeUsd: null, projectedCumulativeUsd: 300, sevenDayScenarioUsd: 352, twentyEightDayScenarioUsd: 300 },
  ],
};

describe('projection presentation contract', () => {
  it('keeps stale partial-history observations visible outside the method disclosure', () => {
    const html = renderToStaticMarkup(<DashboardProjectionView projection={{
      ...projection,
      baseline: { spendUsd: 40, complete: false },
      projectedTotalUsd: null,
      projectedKnownTotalUsd: 300,
      stale: true,
      status: 'unavailable',
    }} />);
    expect(html).toContain('Stale observations');
    expect(html.indexOf('Stale observations')).toBeLessThan(html.indexOf('data-testid="projection-values"'));
    expect(html).not.toContain('Within projected budget');
  });
  it('keeps an applicable budget in the visible axis domain when only actuals are available', () => {
    renderToStaticMarkup(<DashboardProjectionView projection={{
      ...projection,
      projectedTotalUsd: null,
      status: 'within',
      budget: { amountUsd: 2000, kind: 'canonical_allocation', label: 'Allocation' },
      trajectory: projection.trajectory.map(point => ({
        ...point, projectedCumulativeUsd: null, sevenDayScenarioUsd: null, twentyEightDayScenarioUsd: null,
      })),
    }} />);
    expect(rendering.yAxis.domain[1](40)).toBe(2000);
    expect(rendering.yAxis.domain[1](2500)).toBe(2500);
    expect(rendering.references.find(line => line.y === 2000)?.strokeDasharray).toBe('2 4');
    expect(rendering.chart.accessibilityLayer).toBe(true);
  });
  it('shows dollar estimates without inventing a matching budget', () => {
    const html = renderToStaticMarkup(<DashboardProjectionView projection={projection} />);
    expect(html).toContain('$300.00');
    expect(html).toContain('$10.00');
    expect(html).not.toContain('No matching budget applies');
    expect(adminNotesHtml()).toContain('No matching budget applies');
    expect(html).not.toContain('Within projected budget');
    expect(html).not.toContain('budget-meter__track');
    expect(rendering.references.some(line => 'y' in line)).toBe(false);
  });
  it('labels inclusive reporting, planning and rate dates without adding a day', () => {
    const html = renderToStaticMarkup(<DashboardProjectionView projection={projection} />);
    expect(html).toContain('Sep 30, 2026');
    expect(html).toContain('Sep 5, 2026');
    expect(html).toContain('Sep 4, 2026');
    expect(html).toContain('User-selected planning date');
    expect(html).not.toContain('not guaranteed charges');
    expect(adminNotesHtml()).toContain('not guaranteed charges');
    expect(html).toContain('History');
    expect(html).toContain('Forecast Through');
    expect(html).not.toContain('UTC midnight boundary');
    expect(rendering.xAxis.domain).toEqual([Date.parse('2026-09-01'), Date.parse('2026-09-30')]);
    expect(rendering.xAxis.ticks.at(-1)).toBe(Date.parse('2026-09-30'));
    expect(rendering.xAxis.ticks).not.toContain(Date.parse('2026-10-01'));
  });
  it('qualifies a partial known-spend projection and suppresses budget comparisons', () => {
    const partialProjection = {
      ...projection,
      baseline: { spendUsd: 40, complete: false },
      budget: { amountUsd: 200, kind: 'canonical_allocation' as const, label: 'Allocation' },
      projectedTotalUsd: null,
      projectedKnownTotalUsd: 280,
      projectedRemainingUsd: -80,
      projectedOverageUsd: 80,
      projectedUsePercent: 140,
      status: 'over' as const,
      reasons: ['incomplete_baseline' as const],
    };
    const html = renderToStaticMarkup(<DashboardProjectionView projection={partialProjection} />);
    expect(html).toContain('Known Estimate');
    expect(html).toContain('$280.00');
    expect(html).not.toContain('Estimated Total');
    expect(html).not.toContain('Proj. Overage');
    expect(html).not.toContain('Over Budget');
    expect(html).not.toContain('budget-meter__track');
    expect(rendering.references.some(line => line.y === 200)).toBe(false);
    expect(rendering.yAxis.domain).toEqual([0, 'auto']);
  });
  it('renders historical suppression and incomplete reasons explicitly', () => {
    const html = renderToStaticMarkup(<DashboardProjectionView projection={{
      ...projection,
      baseline: { spendUsd: 40, complete: false },
      projectedTotalUsd: null,
      trajectory: projection.trajectory.map((point) => ({ ...point, projectedCumulativeUsd: null, sevenDayScenarioUsd: null, twentyEightDayScenarioUsd: null })),
      reasons: ['historical_reporting_period', 'incomplete_baseline'],
    }} />);
    expect(html).not.toContain('Historical reporting selection');
    expect(html).not.toContain('Missing historical spend is not estimated');
    expect(adminNotesHtml()).toContain('Historical reporting selection');
    expect(adminNotesHtml()).toContain('Missing historical spend is not estimated');
    expect(html).not.toContain('$300.00');
    expect(html).toContain('Actual');
    expect(html).not.toContain('At-current-rate projection');
  });
  it('suppresses overage and budget comparisons for stale estimates', () => {
    const html = renderToStaticMarkup(<DashboardProjectionView projection={{
      ...projection, budget: { amountUsd: 200, kind: 'canonical_allocation', label: 'Allocation' },
      projectedRemainingUsd: -100, projectedOverageUsd: 100, projectedUsePercent: 150, status: 'over', stale: true,
    }} />);
    expect(html).not.toContain('Proj. Overage');
    expect(html).not.toContain('Over Budget');
    expect(html).toContain('Stale observations');
    expect(html).not.toContain('budget-meter__track');
    expect(html).not.toContain('budget-meter__projection--green');
  });
  it('does not turn unknown values into zero', () => {
    const html = renderToStaticMarkup(<DashboardProjectionView projection={{
      ...projection,
      rate: { ...projection.rate, dailySpendUsd: null },
      projectedTotalUsd: null,
      trajectory: [{
        date: '2026-09-01',
        actualCumulativeUsd: null,
        projectedCumulativeUsd: null,
        sevenDayScenarioUsd: null,
        twentyEightDayScenarioUsd: null,
      }],
    }} />);
    expect(html.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('$0.00');
  });
  it('provides exact accessible table values and scenario semantics', () => {
    const html = renderToStaticMarkup(<DashboardProjectionView projection={projection} />);
    expect(html).toContain('Cumulative USD through each inclusive UTC date');
    expect(html).not.toContain('scenarios are not confidence intervals');
    expect(adminNotesHtml()).toContain('scenarios are not confidence intervals');
    expect(html).toContain('Actual Spend');
    expect(html).toContain('Projected Spend');
    expect(html).toContain('7-day Scenario');
    expect(html).toContain('28-day Scenario');
    expect(html).toContain('$40.00');
    expect(html).toContain('$352.00');
    expect(html).not.toContain('an em dash means unavailable or not applicable');
  });
});