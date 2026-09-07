import {
  Bar,
  BarChart,
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
  if (data.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No monthly data available</div>;
  }

  const valueFormatter = (value: number) => valueKind === 'usd'
    ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : value.toLocaleString();

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
        <Bar
          dataKey={dataKey}
          fill="hsl(var(--primary))"
          radius={[2, 2, 0, 0]}
          maxBarSize={48}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}