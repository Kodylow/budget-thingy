import { useMemo, useState } from 'react';
import {
  getGetTrendsQueryKey,
  useGetTrends,
  type GetTrendsGranularity,
} from '@workspace/api-client-react';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ChartContainer,
  type ChartConfig,
} from '@/components/ui/chart';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const SERIES_COLORS = [
  '#0f3d62',
  '#0891b2',
  '#2563eb',
  '#06b6d4',
  '#4f46e5',
  '#0d9488',
  '#7c3aed',
  '#0284c7',
  '#059669',
  '#64748b',
];

type ViewBy = 'team' | 'group';

interface TrendsTabProps {
  teamNames: string[];
  groups: Array<{ groupId: string; name: string; teamName: string | null }>;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex rounded-lg bg-muted p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-all ${
              value === option.value
                ? 'bg-background text-foreground shadow'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid={`${label.toLowerCase().replace(/\s/g, '-')}-${option.value}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TrendsTab({ teamNames, groups }: TrendsTabProps) {
  const [granularity, setGranularity] = useState<GetTrendsGranularity>('week');
  const [viewBy, setViewBy] = useState<ViewBy>('team');
  // An empty set means "all", which preserves that default even if teams load later.
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(() => new Set());
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(() => new Set());

  const sortedTeamNames = useMemo(
    () => [...new Set(teamNames)].sort((a, b) => a.localeCompare(b)),
    [teamNames],
  );
  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.name.localeCompare(b.name) || a.groupId.localeCompare(b.groupId)),
    [groups],
  );
  const params = useMemo(
    () => ({
      granularity,
      ...(selectedTeams.size > 0 ? { teamNames: [...selectedTeams].sort() } : {}),
      ...(selectedGroupIds.size > 0 ? { groupIds: [...selectedGroupIds].sort() } : {}),
    }),
    [granularity, selectedTeams, selectedGroupIds],
  );
  const { data, isLoading, isFetching, isError } = useGetTrends(params, {
    query: {
      queryKey: getGetTrendsQueryKey(params),
      refetchInterval: (query) => query.state.data?.isComplete === false ? 3000 : false,
    },
  });

  const visibleSeries = useMemo(
    () => data?.series.filter((series) => series.type === viewBy) ?? [],
    [data, viewBy],
  );
  const chartConfig = useMemo<ChartConfig>(() => {
    return Object.fromEntries(
      visibleSeries.map((series, index) => [
        series.name,
        { label: series.name, color: SERIES_COLORS[index % SERIES_COLORS.length] },
      ]),
    );
  }, [visibleSeries]);
  const chartData = useMemo(() => {
    return (data?.buckets ?? []).map((bucket, bucketIndex) => {
      const point: Record<string, string | number | null> = {
        bucket,
        rangeStart: data?.bucketRanges[bucketIndex]?.start ?? bucket,
        rangeEnd: data?.bucketRanges[bucketIndex]?.end ?? bucket,
      };
      for (const series of visibleSeries) point[series.name] = series.data[bucketIndex] ?? null;
      return point;
    });
  }, [data, visibleSeries]);

  const progress = data?.totalCount
    ? Math.round((data.loadedCount / data.totalCount) * 100)
    : 0;
  const selectedLabel = selectedTeams.size === 0
    ? 'All teams'
    : `${selectedTeams.size} team${selectedTeams.size === 1 ? '' : 's'}`;
  const selectedGroupsLabel = selectedGroupIds.size === 0
    ? 'All groups'
    : `${selectedGroupIds.size} group${selectedGroupIds.size === 1 ? '' : 's'}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Usage trends</CardTitle>
            <CardDescription>
              Spend by date bucket from the May 20, 2026 data cutoff.
            </CardDescription>
          </div>
          {!data?.isComplete && (isLoading || isFetching) && (
            <Badge variant="outline" className="mt-1 flex w-fit items-center gap-1.5">
              <RefreshCw className="h-3 w-3 animate-spin" />
              {data ? `${progress}% loaded` : 'Loading buckets…'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-end gap-4 rounded-lg border bg-muted/20 p-4">
          <Toggle
            label="Granularity"
            value={granularity}
            onChange={(value) => setGranularity(value as GetTrendsGranularity)}
            options={[
              { value: 'week', label: 'Weekly' },
              { value: 'month', label: 'Monthly' },
            ]}
          />
          <Toggle
            label="View by"
            value={viewBy}
            onChange={(value) => setViewBy(value as ViewBy)}
            options={[
              { value: 'team', label: 'Team' },
              { value: 'group', label: 'Group' },
            ]}
          />
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Team filter</span>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="min-w-40 justify-between" data-testid="team-filter">
                  {selectedLabel}
                  <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-2">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => setSelectedTeams(new Set())}
                >
                  <span className="grid h-4 w-4 place-content-center">
                    {selectedTeams.size === 0 && <Check className="h-4 w-4" />}
                  </span>
                  All teams
                </button>
                <div className="my-1 border-t" />
                {sortedTeamNames.map((team) => (
                  <label
                    key={team}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted"
                  >
                    <Checkbox
                      checked={selectedTeams.size === 0 || selectedTeams.has(team)}
                      onCheckedChange={(checked) => {
                        setSelectedTeams((current) => {
                          const next = new Set(current.size === 0 ? sortedTeamNames : current);
                          if (checked) next.add(team);
                          else next.delete(team);
                          return next.size === sortedTeamNames.length ? new Set() : next;
                        });
                      }}
                    />
                    {team}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          </div>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Group filter</span>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="min-w-40 justify-between" data-testid="group-filter">
                  {selectedGroupsLabel}
                  <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-2">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => setSelectedGroupIds(new Set())}
                >
                  <span className="grid h-4 w-4 place-content-center">
                    {selectedGroupIds.size === 0 && <Check className="h-4 w-4" />}
                  </span>
                  All groups
                </button>
                <div className="my-1 border-t" />
                <div className="max-h-64 overflow-y-auto">
                  {sortedGroups.map((group) => (
                    <label
                      key={group.groupId}
                      className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-sm hover:bg-muted"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selectedGroupIds.size === 0 || selectedGroupIds.has(group.groupId)}
                        onCheckedChange={(checked) => {
                          setSelectedGroupIds((current) => {
                            const next = new Set(current.size === 0 ? sortedGroups.map((item) => item.groupId) : current);
                            if (checked) next.add(group.groupId);
                            else next.delete(group.groupId);
                            return next.size === sortedGroups.length ? new Set() : next;
                          });
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate">{group.name}</span>
                        {group.teamName && (
                          <span className="block truncate text-xs text-muted-foreground">{group.teamName}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {isLoading && !data ? (
          <div className="h-80 animate-pulse-glow rounded-lg bg-muted" data-testid="trends-skeleton" />
        ) : isError ? (
          <div className="grid h-80 place-content-center rounded-lg border border-dashed text-sm text-destructive">
            Trends could not be loaded. Please try again.
          </div>
        ) : visibleSeries.length === 0 ? (
          <div className="grid h-80 place-content-center rounded-lg border border-dashed text-sm text-muted-foreground">
            No {viewBy} trend data matches these filters.
          </div>
        ) : (
          <div className="space-y-3">
          <ChartContainer config={chartConfig} className="h-[420px] w-full">
            <AreaChart data={chartData} margin={{ top: 12, right: 20, left: 12, bottom: 8 }}>
              <defs>
                {visibleSeries.map((series, index) => {
                  const color = SERIES_COLORS[index % SERIES_COLORS.length];
                  return (
                    <linearGradient key={series.name} id={`trend-fill-${index}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={color} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                    </linearGradient>
                  );
                })}
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => formatDate(String(value)).replace(/, \d{4}/, '')}
                minTickGap={28}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => formatUsd(Number(value))}
                width={72}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const point = payload[0]?.payload as Record<string, string>;
                  return (
                    <div className="min-w-48 rounded-lg border bg-background p-3 text-xs shadow-xl">
                      <p className="mb-2 font-medium">
                        {formatDate(point.rangeStart)} – {formatDate(point.rangeEnd)}
                      </p>
                      <div className="space-y-1.5">
                        {payload.filter((item) => item.value != null).map((item) => (
                          <div key={String(item.dataKey)} className="flex items-center justify-between gap-5">
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: item.color }} />
                              {item.name}
                            </span>
                            <span className="font-mono font-medium">{formatUsd(Number(item.value))}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }}
              />
              {visibleSeries.map((series, index) => {
                const color = SERIES_COLORS[index % SERIES_COLORS.length];
                return (
                  <Area
                    key={series.name}
                    type="monotone"
                    dataKey={series.name}
                    stroke={color}
                    fill={`url(#trend-fill-${index})`}
                    strokeWidth={2}
                    connectNulls
                    activeDot={{ r: 5 }}
                  />
                );
              })}
            </AreaChart>
          </ChartContainer>
          <div
            className="flex max-h-24 flex-wrap justify-center gap-x-4 gap-y-2 overflow-y-auto border-t pt-3"
            aria-label={`${viewBy} chart legend`}
          >
            {visibleSeries.map((series, index) => (
              <span key={series.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }}
                />
                {series.name}
              </span>
            ))}
          </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}