import React from "react";
import { DashboardResponse } from "@workspace/api-client-react";
import { formatFinancialUsd, formatFinancialAxis } from "@/lib/financial-format";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { ChartTooltip } from "@/components/financial-chart";
import { MetricCard } from "@/components/journey-primitives";

export function InsightCard({
  title,
  value,
  subtitle,
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
      className="min-w-0 h-full"
      data-testid={testId}
    >
      <MetricCard
        label={title}
        value={typeof value === "string" || typeof value === "number" ? String(value) : "Unavailable"}
        detail={[highlightText, subtitle].filter(Boolean).join(" ")}
        tone={highlightText === "Up" ? "warning" : "default"}
      />
    </div>
  );
}

export function MonthlySpendChart({ monthly }: { monthly: NonNullable<DashboardResponse["insights"]>["monthly"] }) {
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
      <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
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
        <Bar
          dataKey="agent"
          isAnimationActive={false}
          name="Agent"
          fill="hsl(var(--primary))"
          stackId="spend"
          radius={[2, 2, 0, 0]}
          maxBarSize={48}
        />
        <Bar
          dataKey="other"
          isAnimationActive={false}
          name="Other"
          fill="hsl(var(--muted-foreground))"
          stackId="spend"
          radius={[2, 2, 0, 0]}
          maxBarSize={48}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TopSpendersList({ spenders }: { spenders: NonNullable<DashboardResponse["insights"]>["topSpenders"] }) {
  if (!spenders || spenders.length === 0) {
    return <div className="text-sm text-muted-foreground p-4 text-center">No spenders found.</div>;
  }

  return (
    <div className="space-y-1">
      {spenders.map((spender, idx) => {
        const spend = spender.spendUsd;
        return (
          <div key={spender.id} className="flex items-center gap-3 border-b py-3 last:border-0">
            <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground">
              {String(idx + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{spender.name || "Unknown"}</p>
            </div>
            <span className="shrink-0 font-mono text-sm font-semibold">
              {spend != null ? formatFinancialUsd(spend) : "Unavailable"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CategoryCards({ categories }: { categories: NonNullable<DashboardResponse["insights"]>["categories"] }) {
  if (!categories || categories.length === 0) return null;
  return (
    <section aria-label="Spend categories" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {categories.map((cat, idx) => (
        <div key={cat.key} className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs">
          <span className={`h-2 w-2 shrink-0 rounded-full ${idx === 0 ? 'bg-primary' : idx === 1 ? 'bg-[#5277b8]' : 'bg-[#8aa4ca]'}`} />
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{cat.label}</div>
          <span className="shrink-0 font-mono font-semibold text-foreground">
            {cat.spendUsd != null ? formatFinancialUsd(cat.spendUsd) : "Unavailable"}
          </span>
          {cat.activeUsers != null && (
            <span className="sr-only">{cat.activeUsers} active users</span>
          )}
        </div>
      ))}
    </section>
  );
}
