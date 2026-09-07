import React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell } from 'recharts';
import { formatFinancialAxis, formatFinancialUsd } from '@/lib/financial-format';
import type { DashboardResponseTrend } from '@workspace/api-client-react';
import { AdminDataQualityNote } from '@/components/admin-data-quality';

export function SpendStoryChart({ trend }: { trend?: DashboardResponseTrend }) {
  if (!trend?.buckets || trend.buckets.length === 0) {
    return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No trend data available</div>;
  }

  const chartData = trend.buckets.map(b => ({
    ...b,
    dateLabel: new Date(b.start).toLocaleDateString(undefined, trend.granularity === 'month'
      ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    val: trend.mode === 'cumulative' ? (b.valueUsd ?? null) : (b.spendUsd ?? null),
  }));

  const hasIncomplete = trend.buckets.some(b => b.isPartial || b.isMissing);

  return (
    <div className="h-full w-full min-w-0 relative">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="actual-spend-grad-home" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0D62FF" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#0D62FF" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" opacity={0.5} />
          <XAxis
            dataKey="dateLabel"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            dy={10}
            minTickGap={32}
            interval="preserveStartEnd"
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
            tickFormatter={formatFinancialAxis}
            width={56}
            tickCount={5}
          />
          <Tooltip
            cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '4 4' }}
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
          <Area
            type="monotone"
            isAnimationActive={false}
            dataKey="val"
            stroke="#0D62FF"
            strokeWidth={2}
            fill="url(#actual-spend-grad-home)"
            fillOpacity={1}
            connectNulls={false}
            dot={chartData.filter(point => point.val != null).length === 1 ? { r: 4, fill: '#0D62FF' } : false}
            activeDot={{ r: 4, fill: '#0D62FF', stroke: 'var(--background)', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      {hasIncomplete && (
        <AdminDataQualityNote title="My Spend Story">
          Partial coverage. Missing buckets are not zero.
        </AdminDataQualityNote>
      )}
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
          <Bar dataKey="val" radius={[2, 2, 0, 0]}>
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.isCurrent ? '#000A73' : '#0D62FF'} opacity={entry.isCurrent ? 1 : 0.6} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
