import React, { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw } from 'lucide-react';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';

// ---------- types ----------

interface TrendBucket {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
}

interface TrendGroup {
  groupId: string;
  name: string;
  teamName: string | null;
  spendByBucket: Record<string, number | null>;
}

interface TrendsResponse {
  granularity: 'month' | 'week';
  buckets: TrendBucket[];
  groups: TrendGroup[];
  isComplete: boolean;
  loadedCount: number;
  totalCount: number;
}

// ---------- color palette (navy → cyan family + extras) ----------

const TEAM_COLORS = [
  '#1e4e8c', // navy blue
  '#0891b2', // cyan-600
  '#7c3aed', // violet-600
  '#d97706', // amber-600
  '#059669', // emerald-600
  '#dc2626', // red-600
  '#2563eb', // blue-600
  '#ea580c', // orange-600
  '#db2777', // pink-600
  '#0d9488', // teal-600
  '#65a30d', // lime-600
  '#4f46e5', // indigo-600
];

// ---------- hook ----------

function useTrends(granularity: 'month' | 'week') {
  return useQuery<TrendsResponse>({
    queryKey: ['trends', granularity],
    queryFn: async () => {
      const res = await fetch(`/api/trends?granularity=${granularity}`);
      if (!res.ok) throw new Error('Failed to fetch trends data');
      return res.json() as Promise<TrendsResponse>;
    },
    refetchInterval: (query) =>
      query.state.data?.isComplete === false ? 8000 : false,
  });
}

// ---------- helpers ----------

function fmtUsd(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

// ---------- component ----------

interface TrendsTabProps {
  /** Group list already fetched by the dashboard — used to know which team names exist */
  teamNames: string[];
}

export default function TrendsTab({ teamNames }: TrendsTabProps) {
  const [granularity, setGranularity] = useState<'month' | 'week'>('month');
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(() => new Set());

  const { data, isLoading, isFetching } = useTrends(granularity);

  // Seed selected teams once team names are known
  useEffect(() => {
    if (teamNames.length > 0 && selectedTeams.size === 0) {
      setSelectedTeams(new Set(teamNames));
    }
  }, [teamNames]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive all team names from the trends response (may differ slightly from groups prop)
  const allTeamsFromData = useMemo(() => {
    if (!data) return teamNames;
    const names = new Set<string>();
    for (const g of data.groups) {
      if (g.teamName) names.add(g.teamName);
    }
    return [...names].sort();
  }, [data, teamNames]);

  const toggleTeam = (name: string) => {
    setSelectedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = () => setSelectedTeams(new Set(allTeamsFromData));
  const clearAll = () => setSelectedTeams(new Set());

  // Build recharts data + config
  const { chartData, chartConfig, activeTeams } = useMemo(() => {
    if (!data || data.buckets.length === 0) {
      return { chartData: [], chartConfig: {} as ChartConfig, activeTeams: [] as string[] };
    }

    // Group → team spend map
    const teamSpend = new Map<string, Record<string, number>>();
    for (const g of data.groups) {
      const team = g.teamName ?? '__unassigned__';
      const existing = teamSpend.get(team) ?? {};
      for (const bucket of data.buckets) {
        const v = g.spendByBucket[bucket.key];
        if (v !== null && v !== undefined) {
          existing[bucket.key] = (existing[bucket.key] ?? 0) + v;
        }
      }
      teamSpend.set(team, existing);
    }

    // Only show selected teams that have spend data
    const activeTeams = allTeamsFromData.filter(
      (t) => selectedTeams.has(t) && teamSpend.has(t),
    );

    const chartData = data.buckets.map((bucket) => {
      const point: Record<string, string | number> = { label: bucket.label };
      for (const team of activeTeams) {
        point[team] = teamSpend.get(team)?.[bucket.key] ?? 0;
      }
      return point;
    });

    const chartConfig: ChartConfig = {};
    activeTeams.forEach((team, i) => {
      chartConfig[team] = {
        label: team,
        color: TEAM_COLORS[i % TEAM_COLORS.length],
      };
    });

    return { chartData, chartConfig, activeTeams };
  }, [data, selectedTeams, allTeamsFromData]);

  const progressPct =
    data && data.totalCount > 0
      ? Math.round((data.loadedCount / data.totalCount) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Granularity toggle */}
        <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
          {(['month', 'week'] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-all ${
                granularity === g
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {g === 'month' ? 'Monthly' : 'Weekly'}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-border" />

        {/* Team toggles */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={selectAll}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            All
          </button>
          <span className="text-xs text-muted-foreground">/</span>
          <button
            onClick={clearAll}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            None
          </button>
          {allTeamsFromData.map((team, i) => {
            const active = selectedTeams.has(team);
            const color = TEAM_COLORS[i % TEAM_COLORS.length];
            return (
              <button
                key={team}
                onClick={() => toggleTeam(team)}
                style={
                  active
                    ? { borderColor: color, backgroundColor: `${color}18`, color }
                    : undefined
                }
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all ${
                  active
                    ? 'opacity-100'
                    : 'border-border text-muted-foreground opacity-50 hover:opacity-75'
                }`}
              >
                {team}
              </button>
            );
          })}
        </div>

        {/* Loading badge */}
        {!data?.isComplete && (isFetching || isLoading) && (
          <Badge variant="outline" className="ml-auto flex items-center gap-1.5 shrink-0">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {data ? `${progressPct}% loaded` : 'Loading…'}
          </Badge>
        )}
      </div>

      {/* Chart card */}
      <Card>
        <CardHeader>
          <CardTitle>Spend Over Time</CardTitle>
          <CardDescription>
            {granularity === 'month' ? 'Monthly' : 'Weekly'} spend per team from May 2026 to present.
            {!data?.isComplete && data && (
              <span className="text-amber-600 dark:text-amber-400">
                {' '}Data is loading — chart updates as each bucket completes.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && !data ? (
            <div className="flex flex-col gap-3">
              <div className="h-64 w-full animate-pulse-glow bg-muted rounded" />
            </div>
          ) : activeTeams.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              Select at least one team above to view trends.
            </div>
          ) : (
            <ChartContainer config={chartConfig} className="h-80 w-full">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tickFormatter={(v: number) => fmtUsd(v)}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        typeof value === 'number' ? fmtUsd(value) : String(value)
                      }
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {activeTeams.map((team, i) => (
                  <Line
                    key={team}
                    type="monotone"
                    dataKey={team}
                    stroke={TEAM_COLORS[i % TEAM_COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
