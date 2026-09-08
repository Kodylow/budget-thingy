import React, { useState, useMemo } from "react";
import { formatUsd } from "@/pages/home-components/format";
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LineChart, Line, ReferenceLine
} from "recharts";
import { MetricCard } from "@/components/journey-primitives";
import { OrgBudgetOverviewResponse } from "@workspace/api-client-react";
import { Info } from "lucide-react";
import { Link } from "wouter";

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
    <div className="min-w-0 h-full" data-testid={testId}>
      <MetricCard
        label={title}
        value={typeof value === "string" || typeof value === "number" ? String(value) : "Unavailable"}
        detail={[highlightText, subtitle].filter(Boolean).join(" ")}
        tone={highlightText === "Attention" ? "warning" : "default"}
      />
    </div>
  );
}

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);
const dayNumber = (date: string) => Math.floor(utcDate(date).getTime() / 86_400_000);
const dateLabel = (date: string | number) => (typeof date === 'number' ? new Date(date * 86_400_000) : utcDate(date)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

const CHART_COLORS = [
  "#2563eb", "#db2777", "#ea580c", "#059669", "#9333ea",
  "#0891b2", "#dc2626", "#65a30d", "#4f46e5", "#e11d48",
  "#c026d3", "#0284c7", "#16a34a", "#ea580c", "#4338ca"
];

interface ChartRow {
  date: string;
  day: number;
  benchmark: number | null;
  [key: string]: number | string | boolean | null | undefined;
}

export function OrgBudgetChart({ data }: { data: OrgBudgetOverviewResponse }) {
  const [hiddenTeams, setHiddenTeams] = useState<Set<string>>(new Set());

  const eligibleTeams = useMemo(() => {
    return data.teams.filter(t => t.allocationUsd != null && t.allocationUsd > 0 && t.points.length > 0);
  }, [data.teams]);

  const chartData = useMemo(() => {
    const dates = new Set<string>();

    // Pre-index points per team (O(T * P)) rather than scanning points for each date
    const pointsByTeam = new Map<string, Map<string, number | null>>();
    eligibleTeams.forEach(t => {
      const pMap = new Map<string, number | null>();
      t.points.forEach(p => {
        dates.add(p.date);
        pMap.set(p.date, p.spendUsd);
      });
      pointsByTeam.set(t.id, pMap);
    });

    if (data.periodStart) dates.add(data.periodStart);
    if (data.periodEnd) dates.add(data.periodEnd);
    if (data.asOf) dates.add(data.asOf.slice(0, 10));

    const sortedDates = [...dates].sort();
    const startDay = data.periodStart ? dayNumber(data.periodStart) : null;
    const endDay = data.periodEnd ? dayNumber(data.periodEnd) : null;
    const duration = (startDay != null && endDay != null) ? endDay - startDay : -1;

    return sortedDates.map(date => {
      const row: ChartRow = { date, day: dayNumber(date), benchmark: null };

      eligibleTeams.forEach((t, idx) => {
        const spend = pointsByTeam.get(t.id)?.get(date);
        if (spend != null && t.allocationUsd != null && t.allocationUsd > 0) {
          row[`t_${idx}_percent`] = (spend / t.allocationUsd) * 100;
          row[`t_${idx}_spend`] = spend;
          row[`t_${idx}_allocation`] = t.allocationUsd;
          row[`t_${idx}_complete`] = t.complete;
          row[`t_${idx}_name`] = t.name;
        } else {
          // Explicit null so connectNulls={false} yields a gap rather than dropping to 0
          row[`t_${idx}_percent`] = null;
        }
      });

      if (startDay != null && duration >= 0 && dayNumber(date) >= startDay && dayNumber(date) <= (endDay ?? Infinity)) {
        const elapsed = dayNumber(date) - startDay;
        // Inclusive bounds pacing logic: (elapsed + 1) / (duration + 1)
        row.benchmark = Math.max(0, Math.min(100, ((elapsed + 1) / (duration + 1)) * 100));
      }
      return row;
    });
  }, [data, eligibleTeams]);

  const toggleTeam = (teamId: string) => {
    const next = new Set(hiddenTeams);
    if (next.has(teamId)) next.delete(teamId);
    else next.add(teamId);
    setHiddenTeams(next);
  };

  if (eligibleTeams.length === 0) {
    return <div className="h-[400px] flex items-center justify-center text-muted-foreground border rounded bg-card" data-testid="org-budget-chart-empty">No teams with funded budgets found.</div>;
  }

  const asOfDate = data.asOf?.slice(0, 10) ?? null;

  return (
    <div className="flex flex-col gap-4 border rounded bg-card shadow-sm p-4" data-testid="org-budget-chart">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h2 className="text-base font-semibold">Teams Budget Trajectory</h2>
          <p className="text-xs text-muted-foreground mt-1">Cumulative spend as % of team allocation. Click legend to toggle.</p>
        </div>
      </div>

      <div className="h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 20, right: 20, left: 0, bottom: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
            <XAxis
              dataKey="day"
              type="number"
              domain={['dataMin', 'dataMax']}
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              minTickGap={50}
              tickFormatter={dateLabel}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={50}
              domain={[0, 'auto']}
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            {asOfDate && <ReferenceLine x={dayNumber(asOfDate)} stroke="#0D62FF" strokeDasharray="4 4" label={{ value: 'As of', position: 'insideTopLeft', fontSize: 10, fill: '#0D62FF' }} />}
            <ReferenceLine y={100} stroke="#ef4444" strokeDasharray="3 3" />

            <Tooltip
              cursor={{ stroke: '#CBD5E1', strokeDasharray: '4 4' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div className="bg-popover border text-popover-foreground p-3 rounded-md shadow-md text-xs z-50 min-w-56 max-h-[300px] overflow-y-auto">
                    <div className="font-bold mb-3 pb-2 border-b">{dateLabel(Number(label))}</div>
                    <div className="flex flex-col gap-2">
                      {payload.map(p => {
                        if (p.dataKey === 'benchmark') {
                          return (
                            <div key="benchmark" className="text-muted-foreground flex gap-4 justify-between border-t pt-2 mt-1">
                              <span>Even-paced benchmark</span>
                              <span>{Number(p.value).toFixed(1)}%</span>
                            </div>
                          );
                        }
                        const match = String(p.dataKey).match(/^t_(\d+)_percent$/);
                        if (!match) return null;

                        const idx = parseInt(match[1], 10);
                        const spend = p.payload[`t_${idx}_spend`];
                        const alloc = p.payload[`t_${idx}_allocation`];
                        const complete = p.payload[`t_${idx}_complete`];
                        const name = p.payload[`t_${idx}_name`];
                        return (
                          <div key={idx} className="flex gap-4 justify-between items-start" style={{ color: p.color }}>
                            <div className="flex flex-col">
                              <span className="font-semibold">{name}</span>
                              {!complete && <span className="text-[10px] opacity-90 italic">Partial known lower bound</span>}
                            </div>
                            <div className="flex flex-col items-end text-right">
                              <span className="font-mono font-semibold">{Number(p.value).toFixed(1)}%</span>
                              <span className="text-[10px] font-mono opacity-80">{formatUsd(spend as number)} / {formatUsd(alloc as number)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }}
            />

            <Legend
              wrapperStyle={{ fontSize: 11, cursor: 'pointer', paddingTop: '16px' }}
              formatter={(value, entry: any) => {
                if (entry.dataKey === 'benchmark') {
                  return <span style={{ color: entry.color }}>Even-paced benchmark</span>;
                }

                let isHidden = false;
                let isPartial = false;
                const match = String(entry.dataKey).match(/^t_(\d+)_percent$/);
                if (match) {
                  const idx = parseInt(match[1], 10);
                  const team = eligibleTeams[idx];
                  if (team) {
                     isHidden = hiddenTeams.has(team.id);
                     isPartial = !team.complete;
                  }
                }
                return (
                  <button type="button" aria-pressed={!isHidden}
                    className="text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => {
                      const team = match ? eligibleTeams[Number(match[1])] : undefined;
                      if (team) toggleTeam(team.id);
                    }}
                    style={{
                    color: isHidden ? 'var(--muted-foreground)' : entry.color,
                    textDecoration: isHidden ? 'line-through' : 'none'
                  }}>
                    {value} {isPartial && !isHidden && <span className="text-[10px] opacity-75 font-normal ml-1">(Partial lower bound)</span>}
                  </button>
                );
              }}
            />

            <Line
              type="linear"
              dataKey="benchmark"
              name="Benchmark"
              stroke="#64748B"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              isAnimationActive={false}
            />

            {eligibleTeams.map((team, idx) => (
              <Line
                key={team.id}
                type="monotone"
                dataKey={`t_${idx}_percent`}
                name={team.name}
                stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                strokeWidth={2}
                strokeDasharray={team.complete ? undefined : "4 4"}
                connectNulls={false}
                dot={{ r: 1 }}
                activeDot={{ r: 4 }}
                hide={hiddenTeams.has(team.id)}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-2 bg-muted/20 px-4 py-3 mt-2 text-xs leading-relaxed text-muted-foreground rounded">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span><b className="text-foreground">Planning benchmark, not a forecast.</b> The dashed line evenly paces verified funding across its budget-period boundaries. Partial known lines show lower bound spending.</span>
      </div>
    </div>
  );
}

export function OrgTeamsTable({ teams }: { teams: OrgBudgetOverviewResponse['teams'] }) {
  if (!teams || teams.length === 0) {
    return <div className="text-sm text-muted-foreground p-6 text-center border rounded bg-card">No teams found.</div>;
  }

  return (
    <div className="border rounded bg-card overflow-hidden text-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <th className="p-3 font-medium">Team</th>
              <th className="p-3 font-medium text-right">Allocation</th>
              <th className="p-3 font-medium text-right">Spent</th>
              <th className="p-3 font-medium text-right">Remaining</th>
              <th className="p-3 font-medium text-right">Utilization</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {teams.map((team) => (
              <tr key={team.id} className="hover:bg-muted/30 transition-colors">
                <td className="p-3">
                  <div className="flex flex-col">
                    <Link href={`/groups/${team.id}`} className="font-semibold text-foreground hover:underline hover:text-primary transition-colors inline-block">
                      {team.name}
                    </Link>
                    {!team.complete && <span className="text-[10px] text-amber-600 dark:text-amber-500">Partial data</span>}
                  </div>
                </td>
                <td className="p-3 text-right font-mono text-muted-foreground">
                  {team.allocationUsd != null ? formatUsd(team.allocationUsd) : 'Not set'}
                </td>
                <td className="p-3 text-right font-mono text-foreground">
                  {team.spendUsd != null ? formatUsd(team.spendUsd) : 'Unavailable'}
                </td>
                <td className="p-3 text-right font-mono">
                  {team.remainingUsd != null ? (
                    <span className={team.remainingUsd < 0 ? "text-destructive font-semibold" : ""}>
                      {formatUsd(team.remainingUsd)}
                    </span>
                  ) : 'Unavailable'}
                </td>
                <td className="p-3 text-right">
                  {team.percentUsed != null ? (
                    <div className="flex items-center justify-end gap-2">
                      <span className={`font-mono ${team.percentUsed > 100 ? "text-destructive font-semibold" : ""}`}>
                        {team.percentUsed.toFixed(1)}%
                      </span>
                      <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
                        <div
                          className={`h-full ${team.percentUsed > 100 ? 'bg-destructive' : 'bg-primary'}`}
                          style={{ width: `${Math.min(100, Math.max(0, team.percentUsed))}%` }}
                        />
                      </div>
                    </div>
                  ) : <span className="text-muted-foreground">Unavailable</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
