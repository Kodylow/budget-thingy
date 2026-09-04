import { DashboardTrendBucket, DashboardResponseTrend } from "@workspace/api-client-react";
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid
} from 'recharts';

export default function TrendChart({ trend, onClick }: { trend: DashboardResponseTrend, onClick: () => void }) {
  if (!trend.buckets || trend.buckets.length === 0) {
    return <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">No trend data available</div>;
  }
  
  const data = trend.buckets.map(b => ({
    ...b,
    dateLabel: new Date(b.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    val: b.valueUsd ?? b.spendUsd ?? null // Note: Don't use fallback across valueUsd/spendUsd if we want to respect missing gaps!
  }));

  // But spec says: "Never use JavaScript OR fallback across valueUsd, spendUsd, and zero; null/missing stays a chart gap and explicit missing qualification, while observed 0 remains $0.00. No fabricated zeros."

  // Wait, if it's missing, we should pass null to Recharts so it leaves a gap.
  const chartData = trend.buckets.map(b => {
    let val = null;
    if (trend.mode === 'cumulative' && b.valueUsd !== null) val = b.valueUsd;
    else if (trend.mode === 'period' && b.spendUsd !== null) val = b.spendUsd;
    
    return {
      ...b,
      dateLabel: new Date(b.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      val
    };
  });

  return (
    <div className="h-full w-full min-h-[250px] cursor-pointer" onClick={onClick}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
          <XAxis 
            dataKey="dateLabel" 
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            dy={10}
          />
          <YAxis 
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickFormatter={(val) => `$${val >= 1000 ? (val/1000).toFixed(1) + 'k' : val}`}
            width={60}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-muted)', opacity: 0.2 }}
            content={({ active, payload, label }) => {
              if (active && payload && payload.length) {
                const b = payload[0].payload as any;
                const v = b.val;
                return (
                  <div className="bg-popover border shadow-md rounded-md p-3 text-sm">
                    <p className="font-medium mb-1">{label}</p>
                    {v !== null ? (
                       <p className="font-mono text-primary font-bold">
                         ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                       </p>
                    ) : (
                       <p className="text-muted-foreground italic">No data</p>
                    )}
                    {b.isPartial && <p className="text-[10px] text-amber-500 mt-1 uppercase font-semibold">Partial Data</p>}
                    {b.isMissing && <p className="text-[10px] text-destructive mt-1 uppercase font-semibold">Missing Data</p>}
                  </div>
                );
              }
              return null;
            }}
          />
          <Bar dataKey="val" radius={[3, 3, 0, 0]} maxBarSize={40}>
            {chartData.map((entry, index) => (
              <Cell 
                key={`cell-${index}`} 
                fill={entry.isMissing ? 'var(--color-destructive)' : entry.isPartial ? 'var(--color-chart-2)' : 'var(--color-primary)'}
                opacity={entry.isMissing ? 0.3 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
