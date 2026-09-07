import React, { useMemo } from 'react';
import {
  DashboardProjection,
  DashboardProjectionStatus
} from '@workspace/api-client-react';
import {
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ComposedChart,
  ReferenceLine
} from 'recharts';
import { BudgetMeter } from '@/components/budget-meter';
import { ChartKey, ChartTooltip } from '@/components/financial-chart';
import { formatFinancialAxis, formatFinancialUsd } from '@/lib/financial-format';
import { AdminDataQualityNote } from '@/components/admin-data-quality';

export interface DashboardProjectionProps {
  projection: DashboardProjection;
  animateKey?: string;
}

const statusColors: Record<DashboardProjectionStatus, string> = {
  within: 'var(--budget-within)',
  near: 'var(--budget-near)',
  over: 'var(--budget-over)',
  unavailable: 'var(--color-muted-foreground)',
};

const priorDay = (value: string | null) => value ? new Date(Date.parse(value) - 86_400_000).toISOString().slice(0, 10) : null;
const reasonText: Record<DashboardProjection['reasons'][number], string> = {
  historical_reporting_period: 'Historical reporting selection: no current-period forecast is substituted.',
  invalid_planning_end: 'The forecast end must be on or after today and after the selected history starts.',
  unverified_cycle_end: 'Billing-cycle end is not verified in the stored metadata.',
  insufficient_rate_history: 'At least seven consecutive complete UTC days are needed for a rate.',
  incomplete_baseline: 'Based on recorded spend. Missing historical spend is not estimated.',
};

export default function DashboardProjectionView({ projection, animateKey }: DashboardProjectionProps) {
  const { trajectory, target, budget, dataThrough, status, methodology, actualPeriod, rate } = projection;
  const isHistorical = projection.reasons.includes('historical_reporting_period');
  const isIncomplete = !projection.baseline.complete;

  const latestActualDate = dataThrough?.slice(0, 10)
    ?? trajectory.findLast((point) => point.actualCumulativeUsd !== null)?.date;
  const chartStartDate = actualPeriod.start.slice(0, 10);
  const inclusiveTargetEnd = priorDay(target.endExclusive);
  const chartStart = Date.parse(chartStartDate);

  const inclusiveReportingEnd = priorDay(actualPeriod.endExclusive);
  const effectiveEnd = isHistorical ? (latestActualDate ?? inclusiveReportingEnd) : inclusiveTargetEnd;
  const chartEnd = effectiveEnd ? Date.parse(effectiveEnd) : chartStart;

  const chartData = useMemo(() => {
    return trajectory
      .filter((p) => p.date >= chartStartDate && (!effectiveEnd || p.date <= effectiveEnd))
      .map((p) => {
      const isFuture = latestActualDate ? p.date > latestActualDate : true;
      return {
        ...p,
        timestamp: Date.parse(p.date),
        isFuture,
        actualFillUsd: p.actualCumulativeUsd !== null ? p.actualCumulativeUsd : null,
      };
    });
  }, [trajectory, latestActualDate, chartStartDate, effectiveEnd]);

  // Budget meter props
  const actualUsd = projection.baseline.spendUsd ?? null;
  const budgetUsd = budget?.amountUsd ?? null;
  const projectedKnownUsd = projection.projectedKnownTotalUsd ?? null;
  const projectedUsd = projection.projectedTotalUsd ?? projectedKnownUsd;
  const projectedIsOver = projection.projectedRemainingUsd != null
    ? projection.projectedRemainingUsd < 0
    : projection.projectedOverageUsd != null && projection.projectedOverageUsd > 0;
  const comparisonIsCurrent = status !== 'unavailable' && !projection.stale && projection.baseline.complete;
  const comparisonBudgetUsd = comparisonIsCurrent ? budgetUsd : null;
  const hasActual = chartData.some((point) => point.actualCumulativeUsd !== null);
  const hasProjection = chartData.some((point) => point.projectedCumulativeUsd !== null && point.isFuture);
  const hasScenarios = chartData.some((point) =>
    point.isFuture && point.sevenDayScenarioUsd !== null && point.twentyEightDayScenarioUsd !== null);
  const hasChartValues = hasActual || hasProjection || hasScenarios;

  const formatUTC = (val?: string | null) => {
    if (!val) return 'Unknown';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(val));
  };

  const xAxisFormatter = (val: number) => {
     return new Intl.DateTimeFormat(undefined, {
       month: 'short',
       day: 'numeric',
       timeZone: 'UTC'
     }).format(new Date(val));
  };

  const meterStart = actualPeriod.start;
  const meterEnd = target.endExclusive ? target.endExclusive : undefined;
  const xTicks = Array.from(new Set([
    chartStart,
    ...chartData
      .filter((_, index) => chartData.length > 2 && index > 0 && index < chartData.length - 1 && index % Math.ceil(chartData.length / 4) === 0)
      .map((point) => point.timestamp),
    chartEnd,
  ]));

  return (
     <div className="flex min-w-0 flex-col h-full" data-testid="container-dashboard-projection">
       <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 mb-4 border-b border-border/50 pb-4">
          {isIncomplete && actualUsd !== null ? (
            <div className="flex flex-wrap gap-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Known Subtotal</p>
                <div className="text-2xl font-mono font-semibold tracking-tight text-foreground">{formatFinancialUsd(actualUsd)}</div>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Known Estimate</p>
                <div className="text-2xl font-mono font-semibold tracking-tight text-foreground" data-testid="text-projected-total">{formatFinancialUsd(projectedKnownUsd)}</div>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Estimated Total</p>
              <div className="flex items-center gap-3">
                <span className="text-3xl font-mono font-semibold tracking-tight text-foreground" data-testid="text-projected-total">
                  {formatFinancialUsd(projectedUsd)}
                </span>
                {comparisonBudgetUsd !== null && (
                  <span className="text-[11px] font-semibold uppercase tracking-widest px-2.5 py-1 rounded-md" style={{ color: comparisonIsCurrent ? statusColors[status] : 'var(--color-muted-foreground)', backgroundColor: `color-mix(in srgb, ${comparisonIsCurrent ? statusColors[status] : 'var(--color-muted-foreground)'} 15%, transparent)` }}>
                    {status === 'within' ? 'Within Budget' : status === 'near' ? 'Near Budget' : 'Over Budget'}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Daily Pace</p>
              <p className="text-lg font-mono font-semibold text-foreground">{formatFinancialUsd(rate.dailySpendUsd)}<span className="ml-1 text-[10px] font-sans font-medium uppercase text-muted-foreground">/ day</span></p>
            </div>

            {comparisonBudgetUsd !== null && projectedUsd !== null && !isIncomplete && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">{projectedIsOver ? 'Proj. Overage' : 'Proj. Remaining'}</p>
                <p className="text-lg font-mono font-semibold" style={{ color: comparisonIsCurrent ? statusColors[status] : undefined }}>
                  {formatFinancialUsd(projectedIsOver ? projection.projectedOverageUsd : projection.projectedRemainingUsd)}
                </p>
              </div>
            )}
          </div>
       </div>

        {budget && comparisonIsCurrent && (
         <div className="mb-4">
           <BudgetMeter actualUsd={actualUsd} budgetUsd={budgetUsd} projectedUsd={projectedUsd}
             periodStart={meterStart} periodEnd={meterEnd} dataThrough={dataThrough}
             stale={projection.stale} incomplete={!projection.baseline.complete}
             label={budget.label} compact animateKey={animateKey} />
         </div>
       )}

       {/* Chart Section */}
       <div className="flex-1 min-h-[220px]">
          {hasChartValues ? <>
           <div className="flex flex-wrap gap-x-4 gap-y-2 mb-2" aria-label="Chart legend">
             {hasActual && <ChartKey kind="actual">Actual</ChartKey>}
             {hasProjection && <ChartKey kind="projection">Projected</ChartKey>}
              {comparisonBudgetUsd !== null && <ChartKey kind="budget">{budget?.label ?? 'Budget'}</ChartKey>}
             {hasScenarios && <ChartKey kind="scenario">Pace scenarios</ChartKey>}
           </div>
           <div className="relative h-[200px] w-full" aria-label="Cumulative actual and projected spend">
          <ResponsiveContainer width="100%" height="100%">
              <ComposedChart accessibilityLayer aria-label="Cumulative spending in USD. Use left and right arrow keys for values."
                data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" opacity={0.5} />
              <XAxis
                dataKey="timestamp"
                type="number"
                 domain={[chartStart, chartEnd]}
                 ticks={xTicks}
                scale="time"
                axisLine={false}
                tickLine={false}
                tickFormatter={xAxisFormatter}
                tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                dy={10}
                tickCount={5}
                minTickGap={32}
                interval="preserveStartEnd"
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)', fontFamily: 'var(--font-mono)' }}
                 tickFormatter={formatFinancialAxis}
                 width={56}
                  tickCount={4}
                   domain={comparisonBudgetUsd !== null ? [0, (maximum: number) => Math.max(maximum, comparisonBudgetUsd)] : [0, 'auto']}
              />
              <Tooltip
                 filterNull={false}
                 isAnimationActive={false}
                 cursor={{ stroke: 'var(--color-border)', strokeWidth: 1, strokeDasharray: '4 4' }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload;
                    return (
                        <ChartTooltip title={`${formatUTC(data.date)} UTC`}>
                        {data.actualCumulativeUsd !== null && (
                           <div className="flex justify-between gap-x-6 gap-y-1">
                             <ChartKey kind="actual">Actual cumulative</ChartKey>
                             <span className="font-mono font-semibold">{formatFinancialUsd(data.actualCumulativeUsd)}</span>
                          </div>
                        )}
                        {data.projectedCumulativeUsd !== null && data.isFuture && (
                           <div className="flex justify-between gap-x-6 gap-y-1 mt-1">
                             <ChartKey kind="projection">Projected</ChartKey>
                             <span className="font-mono font-semibold">{formatFinancialUsd(data.projectedCumulativeUsd)}</span>
                          </div>
                        )}
                        {data.sevenDayScenarioUsd !== null && data.twentyEightDayScenarioUsd !== null && data.isFuture && (
                           <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
                             <div className="flex justify-between gap-x-6 gap-y-1"><span className="text-[11px] text-muted-foreground">7-day scenario</span><span className="font-mono text-xs">{formatFinancialUsd(data.sevenDayScenarioUsd)}</span></div>
                             <div className="flex justify-between gap-x-6 gap-y-1"><span className="text-[11px] text-muted-foreground">28-day scenario</span><span className="font-mono text-xs">{formatFinancialUsd(data.twentyEightDayScenarioUsd)}</span></div>
                          </div>
                        )}
                          {comparisonBudgetUsd !== null && <div className="flex justify-between gap-x-6 gap-y-1 border-t border-border/50 pt-2 mt-2">
                           <ChartKey kind="budget">{budget?.label ?? 'Budget'}</ChartKey>
                           <span className="font-mono font-semibold">{formatFinancialUsd(budgetUsd)}</span>
                         </div>}
                          {data.actualCumulativeUsd === null && data.projectedCumulativeUsd === null && <p className="text-[11px] text-muted-foreground">Spend unavailable</p>}
                       </ChartTooltip>
                    );
                  }
                  return null;
                }}
              />

              <Bar
                dataKey={(d) => d.isFuture && d.sevenDayScenarioUsd !== null && d.twentyEightDayScenarioUsd !== null ? [Math.min(d.sevenDayScenarioUsd, d.twentyEightDayScenarioUsd), Math.max(d.sevenDayScenarioUsd, d.twentyEightDayScenarioUsd)] : null}
                fill="var(--color-muted)"
                fillOpacity={0.6}
                radius={[2, 2, 0, 0]}
                maxBarSize={48}
                isAnimationActive={false}
              />

              <Bar
                dataKey="actualFillUsd"
                fill="#0D62FF"
                fillOpacity={0.85}
                radius={[2, 2, 0, 0]}
                maxBarSize={48}
                isAnimationActive={false}
               />

              <Bar
                dataKey="projectedCumulativeUsd"
                fill="var(--color-foreground)"
                fillOpacity={0.45}
                radius={[2, 2, 0, 0]}
                maxBarSize={48}
                isAnimationActive={false}
               />

               {latestActualDate && (
                 <ReferenceLine
                     x={Date.parse(latestActualDate)}
                     stroke="var(--color-muted-foreground)"
                     strokeOpacity={0.4}
                 />
              )}

               {comparisonBudgetUsd !== null && (
                <ReferenceLine
                   y={comparisonBudgetUsd}
                   ifOverflow="extendDomain"
                  stroke="var(--color-muted-foreground)"
                   strokeDasharray="2 4"
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          </div>
          </> : (
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-muted-foreground">No chart data available</p>
            </div>
          )}
       </div>

       {projection.stale && <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">Stale observations</p>}
       {(methodology || projection.reasons.length > 0 || !budget || projection.stale || isIncomplete || hasScenarios) && (
         <AdminDataQualityNote title="At-current-rate outlook">
           {methodology} These estimates are not guaranteed charges or hard-limit outcomes. No allocations or limits are changed.
           {projection.reasons.length > 0 && <> {projection.reasons.map((reason) => reasonText[reason]).join(' ')}</>}
           {!budget && <> No matching budget applies to this horizon and scope; no remaining-budget or risk comparison is shown.</>}
           {projection.stale && <> Observations are stale.</>}
           {isIncomplete && <> The baseline has incomplete coverage, so displayed totals are known subtotals and missing spend is not treated as zero.</>}
           {hasScenarios && <> Source-window scenarios are not confidence intervals.</>}
         </AdminDataQualityNote>
       )}
       <details className="mt-4 text-xs text-muted-foreground border-t border-border/50 pt-3" data-testid="projection-values">
          <summary className="cursor-pointer font-medium hover:text-foreground transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm w-fit">
             Dates and values
          </summary>
         <div className="mt-3 space-y-2 pl-5">
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4 bg-muted/30 p-3 rounded-lg">
             <div>
               <p className="text-[10px] uppercase tracking-widest font-semibold mb-0.5">History</p>
               <p className="font-medium text-foreground">{formatUTC(actualPeriod.start)} – {formatUTC(priorDay(actualPeriod.endExclusive))} UTC</p>
             </div>
             <div>
               <p className="text-[10px] uppercase tracking-widest font-semibold mb-0.5">Forecast Through</p>
               <p className="font-medium text-foreground">{isHistorical ? '—' : `${formatUTC(priorDay(target.endExclusive))} UTC`}</p>
               {!isHistorical && (
                 <p className="mt-0.5 text-[11px] text-muted-foreground">{target.kind === 'term_end' ? 'Contract end' : target.kind === 'year_end' ? 'Calendar year-end' : target.kind === 'planning_end' ? 'User-selected planning date' : target.kind === 'cycle_end' ? target.verified ? 'Verified billing cycle' : 'Cycle end unverified' : 'Calendar month-end'}</p>
               )}
             </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-semibold mb-0.5">Pace Window</p>
                <p className="font-medium text-foreground">
                  {rate.completeDays > 0 ? `${formatUTC(rate.windowStart)} – ${formatUTC(priorDay(rate.windowEndExclusive))} UTC · ${rate.completeDays} complete days` : 'Unavailable'}
                </p>
              </div>
           </div>

           <div className="mt-4 max-h-48 overflow-auto rounded-md border border-border" tabIndex={0} role="region" aria-label="Scrollable chart values">
             <table className="w-full min-w-[600px] text-right tabular-nums">
                 <caption className="sr-only">Cumulative USD through each inclusive UTC date</caption>
                <thead className="sticky top-0 bg-muted/90 backdrop-blur shadow-[0_1px_0_hsl(var(--border))] z-10">
                  <tr>
                    <th scope="col" className="p-2 font-medium text-left">Date</th>
                    <th scope="col" className="p-2 font-medium">Actual Spend</th>
                    <th scope="col" className="p-2 font-medium">Projected Spend</th>
                    <th scope="col" className="p-2 font-medium">7-day Scenario</th>
                    <th scope="col" className="p-2 font-medium">28-day Scenario</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {chartData.map((row) => (
                    <tr key={row.date} className="hover:bg-muted/30">
                      <th scope="row" className="p-2 font-normal text-left">{formatUTC(row.date)}</th>
                      <td className="p-2">{row.actualCumulativeUsd !== null ? formatFinancialUsd(row.actualCumulativeUsd) : '—'}</td>
                      <td className="p-2">{row.projectedCumulativeUsd !== null && row.isFuture ? formatFinancialUsd(row.projectedCumulativeUsd) : '—'}</td>
                      <td className="p-2">{row.sevenDayScenarioUsd !== null && row.isFuture ? formatFinancialUsd(row.sevenDayScenarioUsd) : '—'}</td>
                      <td className="p-2">{row.twentyEightDayScenarioUsd !== null && row.isFuture ? formatFinancialUsd(row.twentyEightDayScenarioUsd) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
             </table>
           </div>
         </div>
       </details>
    </div>
  );
}