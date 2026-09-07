import React, { useId, useState } from 'react';
import type { DashboardResponseTrend } from "@workspace/api-client-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';
import { List, LineChart as LineChartIcon } from 'lucide-react';
import { ChartKey, ChartTooltip } from '@/components/financial-chart';
import { formatFinancialAxis, formatFinancialUsd } from '@/lib/financial-format';
import { AdminDataQualityNote } from '@/components/admin-data-quality';

export default function TrendChart({ trend, onClick }: { trend: DashboardResponseTrend, onClick: () => void }) {
  const [showValues, setShowValues] = useState(false);
  const valuesId = useId();
  if (!trend.buckets || trend.buckets.length === 0) {
    return <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">No trend data available</div>;
  }

  const chartData = trend.buckets.map(b => ({
      ...b,
      dateLabel: new Date(b.start).toLocaleDateString(undefined, trend.granularity === 'month'
        ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
        : { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      val: trend.mode === 'cumulative' ? (b.valueUsd ?? null) : (b.spendUsd ?? null),
  }));

  const hasIncomplete = trend.buckets.some(b => b.isPartial || b.isMissing);
  const seriesLabel = trend.mode === 'cumulative' ? 'Actual cumulative' : 'Actual spend';
  const qualification = trend.mode === 'cumulative'
    ? 'Known cumulative spend · partial coverage'
    : 'Partial coverage · gaps are not zero';
  const bucketRange = (b: typeof chartData[number]) =>
    `${new Date(b.start).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })} – ${new Date(Date.parse(b.endExclusive) - 86_400_000).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })} UTC`;
  const coverageLabel = (b: typeof chartData[number]) =>
    b.isMissing ? 'Missing coverage' : b.isPartial ? 'Partial coverage' : b.val == null ? 'Unavailable' : 'Complete';

  return (
    <div className="h-full w-full min-w-0 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <ChartKey kind="actual">{seriesLabel}</ChartKey>
        <div className="flex items-center gap-2">
          <button type="button" aria-controls={valuesId} aria-pressed={showValues}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium bg-muted hover:bg-muted/80 text-foreground rounded-md transition-colors"
            onClick={() => setShowValues(!showValues)}>
            {showValues ? <><LineChartIcon className="w-3.5 h-3.5" /> Chart</> : <><List className="w-3.5 h-3.5" /> Values</>}
          </button>
          <button type="button" onClick={onClick}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 rounded-md transition-colors">
            Explore spend
          </button>
        </div>
      </div>

      {hasIncomplete && (
        <AdminDataQualityNote title="Actual reporting-period trend">
          {qualification}
        </AdminDataQualityNote>
      )}
      <AdminDataQualityNote title="Trend period coverage">
        {chartData.map(b => (
          <div key={b.start}>{bucketRange(b)}: {coverageLabel(b)}</div>
        ))}
      </AdminDataQualityNote>

      <div id={valuesId} className="flex-1 min-h-0 min-w-0 relative">
        {showValues ? (
          <div className="absolute inset-0 overflow-auto rounded-md border border-border" tabIndex={0} role="region" aria-label="Spend trend values">
            <table className="w-full text-left text-xs tabular-nums">
              <caption className="sr-only">{seriesLabel} in USD by UTC period. Unavailable values are not zero.</caption>
              <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm shadow-[0_1px_0_hsl(var(--border))] z-10">
                <tr>
                  <th scope="col" className="p-3 font-medium text-muted-foreground">UTC period</th>
                  <th scope="col" className="p-3 font-medium text-muted-foreground text-right">{seriesLabel}</th>
                </tr>
              </thead>
              <tbody>{chartData.map(b => (
                <tr key={b.start} className="border-t border-border/50 hover:bg-muted/30 transition-colors">
                  <th scope="row" className="p-3 font-normal">{bucketRange(b)}</th>
                  <td className="p-3 text-right font-medium">{formatFinancialUsd(b.val)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} accessibilityLayer aria-label={`${seriesLabel} in USD. Use left and right arrow keys for values.`}
            onClick={onClick} margin={{ top: 10, right: 10, left: -20, bottom: 0 }} style={{ cursor: 'pointer' }}>
            <defs>
              <linearGradient id="actual-spend-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0D62FF" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#0D62FF" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" opacity={0.5} />
            <XAxis
              dataKey="dateLabel"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
              dy={10}
              minTickGap={32}
              interval="preserveStartEnd"
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)', fontFamily: 'var(--font-mono)' }}
              tickFormatter={formatFinancialAxis}
              width={56}
              tickCount={5}
            />
            <Tooltip
              filterNull={false}
              isAnimationActive={false}
              cursor={{ stroke: 'var(--color-border)', strokeWidth: 1, strokeDasharray: '4 4' }}
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const b = payload[0].payload as typeof chartData[number];
                  return (
                    <ChartTooltip title={bucketRange(b)}>
                      <div className="flex flex-wrap justify-between gap-x-6 gap-y-1">
                        <ChartKey kind="actual">{seriesLabel}</ChartKey>
                        <span className="font-mono font-semibold">{formatFinancialUsd(b.val)}</span>
                      </div>
                    </ChartTooltip>
                  );
                }
                return null;
              }}
            />
            <Area
              type="monotone"
              isAnimationActive={false}
              dataKey="val"
              stroke="#0D62FF"
              strokeWidth={2}
              fill="url(#actual-spend-grad)"
              fillOpacity={1}
              connectNulls={false}
              dot={chartData.filter(point => point.val !== null).length === 1 ? { r: 3, fill: '#0D62FF' } : false}
              activeDot={{ r: 4, fill: '#0D62FF', stroke: 'var(--color-background)', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}