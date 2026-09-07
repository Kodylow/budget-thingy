import { useId } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const tooltipStyle = {
  borderRadius: '6px',
  border: '1px solid hsl(var(--border))',
  fontSize: '12px',
  background: 'hsl(var(--card))',
  color: 'hsl(var(--foreground))',
} as const;

function monthLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
}

export function TrendAreaChart({
  data,
  dataKey,
  valueKind = 'usd',
  valueLabel,
}: {
  data: Array<{ month: string; [key: string]: string | number | null }>;
  dataKey: string;
  valueKind?: 'usd' | 'count';
  valueLabel: string;
}) {
  const instanceId = useId().replace(/:/g, '');
  const fillId = `trend-fill-${instanceId}`;
  const strokeId = `trend-stroke-${instanceId}`;

  if (data.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No monthly data available</div>;
  }

  const valueFormatter = (value: number) => valueKind === 'usd'
    ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : value.toLocaleString();

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(var(--primary))" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.65} />
          </linearGradient>
        </defs>
        <XAxis dataKey="month" fontSize={11} tickLine={false} axisLine={false} tickMargin={8} tickFormatter={monthLabel} />
        <YAxis
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={valueKind === 'usd' ? 64 : 42}
          tickFormatter={(value: number) => valueKind === 'usd' ? `$${value.toLocaleString()}` : value.toLocaleString()}
        />
        <Tooltip
          labelFormatter={(label) => monthLabel(String(label))}
          formatter={(value) => [valueFormatter(Number(value)), valueLabel]}
          contentStyle={tooltipStyle}
          cursor={{ stroke: 'hsl(var(--border))', strokeDasharray: '4 4' }}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={`url(#${strokeId})`}
          fill={`url(#${fillId})`}
          strokeWidth={2.5}
          connectNulls={false}
          isAnimationActive={false}
          dot={(props) => {
            const value = props.payload?.[dataKey];
            return value == null
              ? <g key={`missing-${props.index}`} />
              : <circle key={`known-${props.index}`} cx={props.cx} cy={props.cy} r={2.5} fill="hsl(var(--primary))" />;
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}