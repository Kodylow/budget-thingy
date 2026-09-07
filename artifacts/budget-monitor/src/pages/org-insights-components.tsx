import React, { useId } from "react";
import { DashboardResponse } from "@workspace/api-client-react";
import { formatFinancialUsd, formatFinancialAxis } from "@/lib/financial-format";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { ChartTooltip } from "@/components/financial-chart";

export function InsightCard({
  title,
  value,
  subtitle,
  icon: Icon,
  testId,
  highlightText
}: {
  title: string;
  value: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ElementType;
  testId?: string;
  highlightText?: React.ReactNode;
}) {
  return (
    <div
      className="bg-card border border-border shadow-sm rounded-xl p-5 min-w-0 text-left flex flex-col justify-between h-full"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 mb-2">
        {Icon && <Icon className="w-4 h-4 text-primary opacity-80" />}
        <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest">
          {title}
        </div>
      </div>
      <div>
        <div className="text-2xl font-mono font-semibold tracking-tight break-words text-foreground">
          {value}
        </div>
        {(highlightText || subtitle) && (
          <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-1 items-center leading-tight">
            {highlightText && <span className="text-emerald-600 dark:text-emerald-500 font-medium">{highlightText}</span>}
            {subtitle && <span>{subtitle}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function MonthlySpendChart({ monthly }: { monthly: NonNullable<DashboardResponse["insights"]>["monthly"] }) {
  const chartId = useId();
  if (!monthly || monthly.length === 0) {
    return <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">No monthly spend data</div>;
  }

  const data = monthly.map(m => {
    const d = new Date(m.start);
    return {
      name: d.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }),
      agent: m.agentSpendUsd,
      other: m.otherSpendUsd,
      total: m.spendUsd,
      isPartial: m.isPartial,
      isMissing: m.isMissing,
    };
  });

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id={`colorAgent-${chartId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={`colorOther-${chartId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.22} />
            <stop offset="95%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0} />
          </linearGradient>
          <pattern id={`stripe-${chartId}`} patternUnits="userSpaceOnUse" width="4" height="4">
            <path d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2" stroke="hsl(var(--primary))" strokeWidth="1" strokeOpacity={0.2} />
          </pattern>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.5} />
        <XAxis
          dataKey="name"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          dy={10}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={formatFinancialAxis}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload;
            return (
              <ChartTooltip title={label}>
                <div className="flex flex-col gap-1 mt-1">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Agent</span>
                    <span className="font-mono font-medium text-foreground">{p.agent != null ? formatFinancialUsd(p.agent) : 'Unavailable'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Other</span>
                    <span className="font-mono font-medium text-foreground">{p.other != null ? formatFinancialUsd(p.other) : 'Unavailable'}</span>
                  </div>
                  <div className="flex justify-between gap-4 border-t border-border pt-1">
                    <span className="text-muted-foreground">Total</span>
                    <span className="font-mono font-medium text-foreground">{p.total != null ? formatFinancialUsd(p.total) : 'Unavailable'}</span>
                  </div>
                  {(p.isPartial || p.isMissing) && (
                    <div className="text-amber-600 dark:text-amber-500 text-xs mt-1">
                      {p.isMissing ? 'Data unavailable' : 'Partial month'}
                    </div>
                  )}
                </div>
              </ChartTooltip>
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="agent"
          isAnimationActive={false}
          name="Agent"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill={`url(#colorAgent-${chartId})`}
          activeDot={{ r: 4, fill: "hsl(var(--primary))" }}
          connectNulls={false}
        />
        <Area
          type="monotone"
          dataKey="other"
          isAnimationActive={false}
          name="Other"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth={2}
          fill={`url(#colorOther-${chartId})`}
          connectNulls={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TopSpendersList({ spenders }: { spenders: NonNullable<DashboardResponse["insights"]>["topSpenders"] }) {
  if (!spenders || spenders.length === 0) {
    return <div className="text-sm text-muted-foreground p-4 text-center">No spenders found.</div>;
  }

  const knownSpend = spenders.flatMap((spender) => spender.spendUsd == null ? [] : [spender.spendUsd]);
  const maxSpend = knownSpend.length > 0 ? Math.max(...knownSpend) : null;
  
  return (
    <div className="flex flex-col gap-2.5 h-full overflow-y-auto pr-2">
      {spenders.map((spender, idx) => {
        const spend = spender.spendUsd;
        const width = spend != null && maxSpend != null && maxSpend > 0 ? (spend / maxSpend) * 100 : 0;
        return (
          <div key={spender.id} className="flex items-center gap-3 text-xs">
            <div className="w-5 text-[10px] text-muted-foreground font-mono text-right shrink-0">#{idx + 1}</div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline mb-1 gap-2">
                <div className="truncate font-medium text-foreground">{spender.name || "Unknown"}</div>
                <div className="font-mono text-muted-foreground shrink-0">{spend != null ? formatFinancialUsd(spend) : "Unavailable"}</div>
              </div>
              <div className="h-1.5 w-full bg-muted/30 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-primary rounded-full transition-all duration-500" 
                  style={{ width: `${width}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CategoryCards({ categories }: { categories: NonNullable<DashboardResponse["insights"]>["categories"] }) {
  if (!categories || categories.length === 0) return null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {categories.map((cat, idx) => (
        <div key={cat.key} className="bg-card border border-border shadow-sm rounded-xl p-5 min-w-0">
          <div className="flex items-center gap-2 mb-3">
             <div className={`w-2.5 h-2.5 rounded-full ${idx === 0 ? 'bg-primary' : 'bg-muted-foreground'}`} />
             <div className="text-sm font-medium">{cat.label}</div>
          </div>
          <div className="text-xl font-mono font-semibold text-foreground">
            {cat.spendUsd != null ? formatFinancialUsd(cat.spendUsd) : "Unavailable"}
          </div>
          {cat.activeUsers != null && (
            <div className="text-xs text-muted-foreground mt-2">
              {cat.activeUsers} active users
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
