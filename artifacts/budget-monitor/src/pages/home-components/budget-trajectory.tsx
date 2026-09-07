import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Info, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUsd } from './format';
import type { TeamBudgetTracking } from './budget-panels';

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);
const dayNumber = (date: string) => Math.floor(utcDate(date).getTime() / 86_400_000);
const dateLabel = (date: string) => utcDate(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const axisMoney = (value: number) => value >= 1000 ? `$${Math.round(value / 1000)}k` : `$${Math.round(value)}`;

export function trajectoryChartData(tracking: TeamBudgetTracking) {
  const benchmark = tracking.benchmarkEligible &&
    tracking.periodStart &&
    tracking.periodEnd &&
    tracking.allocationUsd != null;
  const startDay = tracking.periodStart ? dayNumber(tracking.periodStart) : null;
  const endDay = tracking.periodEnd ? dayNumber(tracking.periodEnd) : null;
  const dates = new Set(tracking.points.map((point) => point.date));
  if (benchmark && tracking.periodStart && tracking.periodEnd) {
    dates.add(tracking.periodStart);
    dates.add(tracking.periodEnd);
  }
  const actualByDate = new Map(tracking.points.map((point) => [point.date, point.spendUsd]));
  return [...dates].sort().map((date) => {
    const elapsed = startDay == null ? null : dayNumber(date) - startDay;
    const duration = startDay == null || endDay == null ? null : endDay - startDay;
    return {
      date,
      actual: actualByDate.has(date) ? actualByDate.get(date) : null,
      benchmark: benchmark && elapsed != null && duration != null && duration >= 0
        ? tracking.allocationUsd! * (duration === 0 ? 1 : Math.max(0, Math.min(1, elapsed / duration)))
        : null,
    };
  });
}

export function BudgetTrajectory({
  teamName,
  tracking,
  loading,
  error,
  onRetry,
}: {
  teamName: string | null;
  tracking: TeamBudgetTracking | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const [showBenchmark, setShowBenchmark] = useState(true);
  const chartData = useMemo(() => tracking ? trajectoryChartData(tracking) : [], [tracking]);
  const benchmarkEligible = Boolean(tracking?.benchmarkEligible && tracking.periodStart && tracking.periodEnd && tracking.allocationUsd != null);
  const asOfDate = tracking?.asOf?.slice(0, 10) ?? null;
  const benchmarkAsOf = benchmarkEligible && asOfDate && tracking
    ? trajectoryChartData({ ...tracking, points: [{ date: asOfDate, spendUsd: null }] }).find((point) => point.date === asOfDate)?.benchmark
    : null;

  return (
    <section className="overflow-hidden rounded-md border bg-card shadow-none" aria-labelledby="trajectory-title">
      <div className="flex flex-col justify-between gap-4 border-b px-5 py-4 sm:flex-row sm:items-start">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
            <TrendingUp className="h-4 w-4" /> Budget trajectory
          </p>
          <h2 id="trajectory-title" className="mt-1 text-lg font-semibold">{teamName || 'Team funding'}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {tracking?.periodLabel || 'Known actual reporting trajectory'}
            {asOfDate ? ` · as of ${dateLabel(asOfDate)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a href="#monthly-context" className="text-xs font-medium text-primary hover:underline">Monthly context</a>
          {benchmarkEligible && (
            <Button type="button" size="sm" variant={showBenchmark ? 'secondary' : 'outline'} onClick={() => setShowBenchmark((shown) => !shown)} aria-pressed={showBenchmark}>
              {showBenchmark ? 'Hide benchmark' : 'Show benchmark'}
            </Button>
          )}
        </div>
      </div>

      {tracking && (
        <div className="grid gap-4 bg-muted/15 px-5 py-4 sm:grid-cols-3">
          <div><span className="text-xs text-muted-foreground">Spent to date</span><strong className="mt-1 block font-mono text-xl">{formatUsd(tracking.spendUsd)}</strong></div>
          <div><span className="text-xs text-muted-foreground">Even pace as of reporting date</span><strong className="mt-1 block font-mono text-xl">{benchmarkEligible ? formatUsd(benchmarkAsOf) : 'Unavailable'}</strong></div>
          <div><span className="text-xs text-muted-foreground">Funding not yet spent</span><strong className={`mt-1 block font-mono text-xl ${(tracking.remainingUsd ?? 0) < 0 ? 'text-destructive' : ''}`}>{formatUsd(tracking.scopeComplete && tracking.usageComplete ? tracking.remainingUsd : null)}</strong></div>
        </div>
      )}

      <div className="px-5 py-4">
        {loading ? (
          <div className="h-[280px] animate-pulse rounded-sm bg-muted" aria-label="Loading budget trajectory" />
        ) : error ? (
          <div className="flex h-[280px] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            Budget trajectory unavailable
            <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
          </div>
        ) : !tracking || chartData.length === 0 ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">No team trajectory is available.</div>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2"><i className="w-5 border-t-[3px] border-primary" />Actual cumulative spend</span>
              {benchmarkEligible && showBenchmark && <span className="inline-flex items-center gap-2"><i className="w-5 border-t-2 border-dashed border-slate-500" />Even-paced benchmark</span>}
            </div>
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 18, right: 18, left: -5, bottom: 4 }} accessibilityLayer>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
                  <XAxis dataKey="date" axisLine={false} tickLine={false} minTickGap={40} tickFormatter={dateLabel} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                  <YAxis axisLine={false} tickLine={false} width={55} tickFormatter={axisMoney} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                  {asOfDate && <ReferenceLine x={asOfDate} stroke="#0D62FF" strokeDasharray="4 4" label={{ value: 'As of', position: 'insideTopLeft', fontSize: 10, fill: '#0D62FF' }} />}
                  {tracking.allocationUsd != null && benchmarkEligible && (
                    <ReferenceLine y={tracking.allocationUsd} stroke="#94A3B8" strokeDasharray="3 3" />
                  )}
                  <Tooltip
                    cursor={{ stroke: '#CBD5E1', strokeDasharray: '4 4' }}
                    content={({ active, payload, label }) => active && payload?.length ? (
                      <div className="min-w-44 rounded border bg-popover p-2 text-xs shadow-md">
                        <b>{dateLabel(String(label))}</b>
                        {payload.map((item) => typeof item.value === 'number' && (
                          <div key={String(item.dataKey)} className="mt-1 flex justify-between gap-4 text-muted-foreground">
                            <span>{item.name}</span><strong className="font-mono text-foreground">{formatUsd(item.value)}</strong>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  />
                  <Line type="monotone" dataKey="actual" name="Actual spend" stroke="#0D62FF" strokeWidth={3} dot={{ r: 2, fill: '#0D62FF' }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                  {benchmarkEligible && showBenchmark && <Line type="linear" dataKey="benchmark" name="Even-paced benchmark" stroke="#64748B" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
      {benchmarkEligible && (
        <div className="flex gap-2 border-t bg-muted/20 px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span><b className="text-foreground">Planning benchmark, not a monthly allowance.</b> The dashed line evenly paces verified funding across its budget-period boundaries. It is not a forecast.</span>
        </div>
      )}
    </section>
  );
}