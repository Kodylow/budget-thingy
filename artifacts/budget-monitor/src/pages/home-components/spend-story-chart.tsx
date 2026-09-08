import React from 'react';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell, LineChart, Line } from 'recharts';
import { formatFinancialAxis, formatFinancialUsd } from '@/lib/financial-format';
import { AdminDataQualityNote } from '@/components/admin-data-quality';
import { ChartTooltip } from '@/components/financial-chart';
import type { BillingCycleComparisonCycle } from '@workspace/api-client-react';

const cycleSeries = [
  { key: 'current', color: '#0D62FF', dash: undefined },
  { key: 'previous', color: '#64748B', dash: '7 4' },
  { key: 'twoAgo', color: '#A1A1AA', dash: '2 4' },
] as const;

export function billingCycleSeriesData(cycles: BillingCycleComparisonCycle[], scope: 'personal' | 'team') {
  const byKey = new Map(cycles.map((cycle) => [cycle.key, cycle]));
  const maxDay = Math.max(0, ...cycles.flatMap((cycle) => cycle.points.map((point) => point.day)));
  return Array.from({ length: maxDay }, (_, index) => {
    const day = index + 1;
    const row: Record<string, number | string | null> = { day };
    cycleSeries.forEach(({ key }) => {
      const point = byKey.get(key)?.points.find((candidate) => candidate.day === day);
      row[key] = point?.[scope === 'personal' ? 'personalSpendUsd' : 'teamSpendUsd'] ?? null;
      row[`${key}Date`] = point?.date ?? null;
    });
    return row;
  });
}

function formatCycleDate(value: string, includeYear = true) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: includeYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

export function SpendStoryChart({
  cycles,
  scope,
}: {
  cycles: BillingCycleComparisonCycle[];
  scope: 'personal' | 'team';
}) {
   const availableCycles = cycles.filter(cycle => cycle.points.some(point =>
     Number.isFinite(point[scope === 'personal' ? 'personalSpendUsd' : 'teamSpendUsd'])));
   const visibleSeries = cycleSeries.filter(series => availableCycles.some(cycle => cycle.key === series.key));
   const chartData = billingCycleSeriesData(availableCycles, scope);
  const labels = new Map(cycles.map((cycle) => [cycle.key, cycle.label]));
  // Keep one reference even when its spend is unknown. Never borrow dates
  // from an older series or extrapolate past the current period's buckets.
  const referenceDates = new Map(cycles.find(cycle => cycle.key === 'current')?.points.map(point => [point.day, point.date]));
  const dateTicks = chartData.map(row => Number(row.day)).filter(day => referenceDates.has(day));

  if (!chartData.length || !visibleSeries.length) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No comparable period spend available</div>;
  }

  return (
    <div className="flex w-full min-w-0 flex-col">
      <div className="mb-2 flex shrink-0 flex-wrap gap-x-4 gap-y-1" aria-label="Spend comparison legend">
        {visibleSeries.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
              <path d="M0 5h18" stroke={series.color} strokeWidth="2" strokeDasharray={series.dash} />
            </svg>
            {labels.get(series.key) ?? series.key}
          </span>
        ))}
      </div>
      {cycles.length > 1 && (
        <p className="mb-2 shrink-0 text-xs text-muted-foreground">
          {dateTicks.length ? 'Dates: current period (UTC)' : 'Current period dates unavailable'}
        </p>
      )}
      <div className="h-52 shrink-0 sm:h-60">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 8, right: 20, left: -12, bottom: 12 }}
            accessibilityLayer
            aria-label={`${scope === 'personal' ? 'My' : 'Team'} cumulative spend; dates use the current period in UTC, comparisons align by period day`}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" opacity={0.5} />
            <XAxis
              dataKey="day"
              ticks={dateTicks}
              tickFormatter={(day) => {
                const date = referenceDates.get(Number(day));
                return date ? formatCycleDate(date, false) : '';
              }}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              height={36}
              tickMargin={10}
              minTickGap={24}
              interval="preserveStartEnd"
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
              tickFormatter={formatFinancialAxis}
              width={62}
              tickCount={5}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '4 4' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Record<string, number | string | null>;
                return (
                  <ChartTooltip title={`Cycle day ${label}`}>
                    {visibleSeries.map((series) => {
                      const value = row[series.key];
                      const date = row[`${series.key}Date`];
                       if (typeof date !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return null;
                      return (
                        <div key={series.key} className="flex items-start justify-between gap-5">
                          <span className="text-muted-foreground">
                             {labels.get(series.key) ?? series.key}
                            <span className="block text-[10px]">{formatCycleDate(date)}</span>
                          </span>
                          <span className="font-mono font-semibold">
                             {formatFinancialUsd(value)}
                          </span>
                        </div>
                      );
                    })}
                  </ChartTooltip>
                );
              }}
            />
            {visibleSeries.map((series) => (
              <Line
                key={series.key}
                type="monotone"
                dataKey={series.key}
                 name={labels.get(series.key) ?? series.key}
                stroke={series.color}
                strokeWidth={series.key === 'current' ? 2.5 : 2}
                strokeDasharray={series.dash}
                dot={false}
                activeDot={{ r: 3 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function MonthMiniBars({ monthly }: { monthly?: any[] }) {
  if (!monthly || monthly.length === 0) {
    return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No monthly data</div>;
  }

  const chartData = monthly.map(m => ({
    dateLabel: new Date(m.start).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
    val: m.spendUsd ?? null,
    isCurrent: m === monthly[monthly.length - 1]
  }));

  const hasIncomplete = monthly.some(m => m.isPartial || m.isMissing || m.spendUsd == null);

  return (
    <div className="h-full w-full mt-2 relative">
      {hasIncomplete && (
        <AdminDataQualityNote title="My Last 6 Months">
          Some months have partial or unavailable coverage. Missing values are not zero.
        </AdminDataQualityNote>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" opacity={0.5} />
          <XAxis
            dataKey="dateLabel"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            dy={10}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
            tickFormatter={formatFinancialAxis}
            width={40}
            tickCount={3}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.2 }}
            content={({ active, payload }) => {
              if (active && payload && payload.length) {
                const b = payload[0].payload;
                return (
                  <div className="bg-popover border border-border shadow-md rounded-md p-2 text-xs">
                    <div className="font-medium mb-1">{b.dateLabel}</div>
                    <div className="font-mono text-foreground font-semibold">
                      {formatFinancialUsd(b.val)}
                    </div>
                  </div>
                );
              }
              return null;
            }}
          />
          <Bar dataKey="val" radius={[2, 2, 0, 0]} maxBarSize={48}>
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.isCurrent ? '#000A73' : '#0D62FF'} opacity={entry.isCurrent ? 1 : 0.6} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
