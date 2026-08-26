import { useEffect, useMemo, useState } from 'react';
import {
  getGetUserActivityQueryKey,
  getGetTrendsQueryKey,
  useGetUserActivity,
  useGetTrends,
  type GetTrendsGranularity,
} from '@workspace/api-client-react';
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useRange } from '@/components/range-context';
import { buildTrendsParams, PARTIAL_BUCKET_EXPLANATION } from '@/lib/trends-ui';

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

function useUserActivity() {
  const { rangeType, startDate, endDate } = useRange();
  const params = {
    rangeType,
    ...(rangeType === 'custom' ? { startDate, endDate } : {}),
  };
  return useGetUserActivity(params, {
    query: {
      queryKey: getGetUserActivityQueryKey(params),
      refetchInterval: (query) =>
        query.state.data?.isComplete === false ? 8000 : false,
    },
  });
}

const PAGE_SIZE = 50;

function fmtUsd(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

function fmtRole(role: string): string {
  if (role === 'account_admin') return 'Account Admin';
  if (role === 'admin') return 'Admin';
  if (role === 'member') return 'Member';
  return role;
}

// ---------- UserActivityCard ----------

function UserActivityCard() {
  const { data, isLoading, isFetching } = useUserActivity();
  const [view, setView] = useState<'spenders' | 'inactive'>('spenders');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset pagination when view/search changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [view, search]);

  const { spenders, inactive } = useMemo(() => {
    const users = data?.users ?? [];
    const query = search.trim().toLowerCase();
    const filtered = query
      ? users.filter(
          (u) =>
            u.username.toLowerCase().includes(query) ||
            u.email.toLowerCase().includes(query) ||
            u.teamName.toLowerCase().includes(query) ||
            u.groupName.toLowerCase().includes(query),
        )
      : users;
    const spenders = filtered.filter((u) => u.spendUsd >= 0.01);
    const inactive = filtered.filter((u) => u.spendUsd < 0.01);
    return { spenders, inactive };
  }, [data, search]);

  const rows = view === 'spenders' ? spenders : inactive;
  const visibleRows = rows.slice(0, visibleCount);
  const hasMore = rows.length > visibleCount;

  const progressPct =
    data && data.totalCount > 0
      ? Math.round((data.loadedCount / data.totalCount) * 100)
      : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>User Activity</CardTitle>
            <CardDescription className="mt-1">
              Workspace members ranked by member AI plus creator-attributed project
              hosting and other non-AI costs for the selected range.
              {!data?.isComplete && data && (
                <span className="text-amber-600 dark:text-amber-400">
                  {' '}Data is loading — updates as each group completes.
                </span>
              )}
            </CardDescription>
          </div>
          {/* Loading badge */}
          {!data?.isComplete && (isFetching || isLoading) && (
            <Badge variant="outline" className="flex items-center gap-1.5 shrink-0 self-start mt-0.5">
              <RefreshCw className="h-3 w-3 animate-spin" />
              {data ? `${progressPct}% loaded` : 'Loading…'}
            </Badge>
          )}
        </div>

        {/* Toggle + search row */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            <button
              onClick={() => setView('spenders')}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-all ${
                view === 'spenders'
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Top Spenders
              {data && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  ({spenders.length})
                </span>
              )}
            </button>
            <button
              onClick={() => setView('inactive')}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-all ${
                view === 'inactive'
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Inactive
              {data && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  ({inactive.length})
                </span>
              )}
            </button>
          </div>

          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name, email, group…"
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {isLoading && !data ? (
          <div className="px-6 py-8">
            <div className="h-48 w-full animate-pulse-glow bg-muted rounded" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm px-6">
            {search ? 'No users match that filter.' : view === 'inactive' ? 'No inactive accounts found.' : 'No spend data yet.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    {view === 'spenders' && (
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground w-10">#</th>
                    )}
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden sm:table-cell">Team → Group</th>
                    {view === 'inactive' ? (
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden md:table-cell">Role</th>
                    ) : (
                      <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Spend</th>
                    )}
                    {view === 'inactive' && (
                      <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Status</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {visibleRows.map((user, idx) => (
                    <tr key={user.userId} className="hover:bg-muted/20 transition-colors">
                      {view === 'spenders' && (
                        <td className="px-4 py-2.5 text-muted-foreground tabular-nums text-xs">
                          {idx + 1}
                        </td>
                      )}
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          {/* Avatar */}
                          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground shrink-0 uppercase">
                            {user.username.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate">{user.username}</div>
                            <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell">
                        {user.teamName || user.groupName ? (
                          <span className="text-muted-foreground text-xs">
                            {user.teamName && (
                              <span className="font-medium text-foreground">{user.teamName}</span>
                            )}
                            {user.teamName && user.groupName && (
                              <span className="mx-1 text-muted-foreground">→</span>
                            )}
                            {user.groupName && <span>{user.groupName}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Unassigned</span>
                        )}
                      </td>
                      {view === 'inactive' ? (
                        <>
                          <td className="px-4 py-2.5 hidden md:table-cell text-xs text-muted-foreground">
                            {fmtRole(user.workspaceRole)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <Badge variant="secondary" className="text-xs">
                              No spend recorded
                            </Badge>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium">
                            <div>{fmtUsd(user.spendUsd)}</div>
                            <div className="text-[10px] font-normal text-muted-foreground">
                              AI {fmtUsd(user.aiSpendUsd)} · Hosting {fmtUsd(user.nonAiSpendUsd)}
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div className="flex items-center justify-center px-4 py-3 border-t">
                <button
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
                >
                  Show more ({rows.length - visibleCount} remaining)
                </button>
              </div>
            )}

            {!hasMore && rows.length > PAGE_SIZE && (
              <div className="px-4 py-3 border-t text-xs text-center text-muted-foreground">
                Showing all {rows.length} {view === 'inactive' ? 'inactive accounts' : 'users'}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- TrendsTab ----------

export default function TrendsTab({ teamNames, groups }: TrendsTabProps) {
  const { rangeType, startDate, endDate } = useRange();
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
    () => buildTrendsParams({
      granularity,
      rangeType,
      startDate,
      endDate,
      selectedTeams,
      selectedGroupIds,
    }),
    [granularity, rangeType, startDate, endDate, selectedTeams, selectedGroupIds],
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
        isPartial: data?.bucketRanges[bucketIndex]?.isPartial ? 'yes' : 'no',
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
  const hasPartialBucket = data?.bucketRanges.some((bucket) => bucket.isPartial) ?? false;

  return (
    <div className="space-y-4">
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

          {hasPartialBucket && (
            <div
              className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
              data-testid="partial-bucket-disclosure"
            >
              <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-200">Partial</Badge>
              <span>{PARTIAL_BUCKET_EXPLANATION}</span>
            </div>
          )}

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
                           {point.isPartial === 'yes' && (
                             <span className="ml-1 text-amber-600 dark:text-amber-400">(Partial)</span>
                           )}
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

      {/* User Activity card */}
      <UserActivityCard />
    </div>
  );
}
