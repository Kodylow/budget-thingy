import { useMemo, useEffect, lazy, Suspense, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useGetDashboard,
  DashboardCard,
  DashboardBreakdownItem,
} from "@workspace/api-client-react";
import { useAuthContext } from "@/components/auth-context";
import { useRange } from "@/components/range-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RangeFilter } from "@/components/range-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, DollarSign, Wallet, User, Activity, PieChart, RefreshCw } from "lucide-react";
import { reportDashboardMilestonePainted, markDashboardMilestone, DashboardPerformanceContext } from "@/lib/client-performance";
import {
  dashboardRequestParams,
  dashboardSpendHref,
} from "@/lib/dashboard-request";

const TrendChart = lazy(() => import("./dashboard-chart"));

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { role, isAccountAdmin, authorizationKey } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();

  const searchParams = new URLSearchParams(searchString);
  const granularity = searchParams.get('granularity') || undefined;
  const trendMode = searchParams.get('trendMode') || undefined;
  const viewScope = searchParams.get('viewScope') || undefined;

  const queryParams = useMemo(() => {
    return dashboardRequestParams({
      rangeType,
      startDate,
      endDate,
      granularity: granularity as Parameters<typeof dashboardRequestParams>[0]["granularity"],
      trendMode: trendMode as Parameters<typeof dashboardRequestParams>[0]["trendMode"],
      viewScope: viewScope as Parameters<typeof dashboardRequestParams>[0]["viewScope"],
    });
  }, [rangeType, startDate, endDate, granularity, trendMode, viewScope]);

  const { data, isLoading, isError, isFetching, refetch } = useGetDashboard(queryParams);

  const querySignature = JSON.stringify(queryParams);
  const generation = useRef(-1);
  const previousQuerySignature = useRef<string | null>(null);
  const paintedGeneration = useRef<number | null>(null);
  const phaseRef = useRef<{
    context: DashboardPerformanceContext;
    kind: 'initial' | 'range';
    startMark: string;
  } | null>(null);
  const backgroundRefreshRef = useRef<{
    context: DashboardPerformanceContext;
    startMark: string;
  } | null>(null);

  useEffect(() => {
    generation.current += 1;
    const context: DashboardPerformanceContext = {
      generation: generation.current,
      scopeKey: viewScope ?? role ?? 'unknown',
      rangeKey: querySignature,
    };
    const kind = previousQuerySignature.current === null ? 'initial' : 'range';
    const startMark = markDashboardMilestone(
      kind === 'initial' ? 'initial-load-start' : 'range-change-start',
      context,
    );
    previousQuerySignature.current = querySignature;
    paintedGeneration.current = null;
    backgroundRefreshRef.current = null;
    phaseRef.current = { context, kind, startMark };
  }, [authorizationKey, querySignature, role, viewScope]);

  useEffect(() => {
    const phase = phaseRef.current;
    if (!data || !phase || paintedGeneration.current === phase.context.generation) {
      return undefined;
    }

    const context: DashboardPerformanceContext = {
      ...phase.context,
      scopeKey: data.scope?.viewScope || phase.context.scopeKey,
      rangeKey: data.period?.label || phase.context.rangeKey,
    };
    markDashboardMilestone('required-requests-complete', context);
    const firstReadyMark = markDashboardMilestone('first-useful-values-ready', context);
    const allReadyMark = markDashboardMilestone('all-required-values-ready', context);
    const cleanups = [
      reportDashboardMilestonePainted(
        'first-useful-values',
        context,
        firstReadyMark,
        phase.startMark,
      ),
      reportDashboardMilestonePainted(
        'all-required-values',
        context,
        allReadyMark,
        phase.startMark,
      ),
    ];
    if (phase.kind === 'range') {
      cleanups.push(reportDashboardMilestonePainted(
        'range-change-complete',
        context,
        allReadyMark,
        phase.startMark,
      ));
    }
    paintedGeneration.current = phase.context.generation;
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [data]);

  useEffect(() => {
    const phase = phaseRef.current;
    if (!phase || paintedGeneration.current !== phase.context.generation) return undefined;
    if (isFetching && !backgroundRefreshRef.current) {
      const context = {
        ...phase.context,
        scopeKey: data?.scope?.viewScope || phase.context.scopeKey,
        rangeKey: data?.period?.label || phase.context.rangeKey,
      };
      backgroundRefreshRef.current = {
        context,
        startMark: markDashboardMilestone('background-refresh-start', context),
      };
      return undefined;
    }
    if (!isFetching && data && backgroundRefreshRef.current) {
      const refresh = backgroundRefreshRef.current;
      const readyMark = markDashboardMilestone('background-refresh-ready', refresh.context);
      const cleanup = reportDashboardMilestonePainted(
        'background-refresh-complete',
        refresh.context,
        readyMark,
        refresh.startMark,
      );
      backgroundRefreshRef.current = null;
      return cleanup;
    }
    return undefined;
  }, [data, isFetching]);

  const displayData = data;

  if (isLoading && !displayData) {
    return <DashboardSkeleton />;
  }

  if (!displayData) {
    return (
      <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center h-[50vh]">
        <AlertTriangle className="h-10 w-10 text-destructive mb-4" />
        <p className="font-medium text-foreground">Failed to load dashboard data.</p>
        <button className="mt-3 text-sm text-primary hover:underline" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const { scope, period, cards, trend, breakdown, accounting, metadata } = displayData;

  const navigateToSpend = (filter?: Record<string, string>) => {
    setLocation(dashboardSpendHref(searchString, filter));
  };

  const updateUrlParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchString);
    params.set(key, value);
    setLocation(`/?${params.toString()}`);
  };

  return (
    <div className="p-4 md:p-8 space-y-6 md:space-y-8 max-w-[100vw] overflow-x-hidden">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-dashboard-scope">
              {scope.label || 'Dashboard'}
            </h1>
            {isFetching && displayData && (
              <Badge variant="outline" className="border-muted text-muted-foreground bg-muted/20 animate-pulse" data-testid="status-dashboard-updating">
                <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Updating
              </Badge>
            )}
            {metadata.status === 'partial' && (
              <Badge variant="outline" className="border-amber-500 text-amber-600 bg-amber-50 dark:bg-amber-950/30" title="Data for this period is incomplete" data-testid="status-dashboard-partial">
                Partial Data
              </Badge>
            )}
            {metadata.stale && (
              <Badge variant="outline" className="border-blue-500 text-blue-600 bg-blue-50 dark:bg-blue-950/30" title="Using cached snapshot" data-testid="status-dashboard-stale">
                Stale
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap" data-testid="text-dashboard-period">
            <span>{period.label}</span>
            <span className="text-muted-foreground/50">•</span>
            <span>Yours · {scope.viewScope.replace('_', ' ')}</span>
            {metadata.dataAsOf && (
              <>
                <span className="text-muted-foreground/50">•</span>
                <span title="Data as of">As of {new Date(metadata.dataAsOf).toLocaleDateString()}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 md:w-auto md:shrink-0">
          <RangeFilter selectedLabel={period.label} />
        </div>
      </div>

      {/* Headline Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card, i) => (
          <DashboardMetricCard key={card.key + i} card={card} onClick={() => navigateToSpend()} />
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2 shadow-sm border-border overflow-hidden flex flex-col">
          <CardHeader className="border-b bg-muted/10 pb-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  Spend Trend
                </CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <Select value={trend.granularity} onValueChange={(val) => updateUrlParam('granularity', val)}>
                  <SelectTrigger className="h-8 w-[100px] text-xs" data-testid="select-dashboard-granularity">
                    <SelectValue placeholder="Daily" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Daily</SelectItem>
                    <SelectItem value="week">Weekly</SelectItem>
                    <SelectItem value="month">Monthly</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={trend.mode} onValueChange={(val) => updateUrlParam('trendMode', val)}>
                  <SelectTrigger className="h-8 w-[130px] text-xs" data-testid="select-dashboard-trend-mode">
                    <SelectValue placeholder="Period spend" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="period">Period spend</SelectItem>
                    <SelectItem value="cumulative">Cumulative</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6 pb-2 px-2 sm:px-6 flex-1 min-h-[300px]">
            <Suspense fallback={<div className="h-full w-full flex items-center justify-center"><Skeleton className="h-[90%] w-[95%]" /></div>}>
              <TrendChart trend={trend} onClick={() => navigateToSpend()} />
            </Suspense>
          </CardContent>
        </Card>

        {breakdown && breakdown.length > 0 && (
          <Card className="shadow-sm border-border overflow-hidden flex flex-col">
            <CardHeader className="border-b bg-muted/10 pb-4">
              <CardTitle className="flex items-center gap-2">
                <PieChart className="h-4 w-4 text-muted-foreground" />
                Breakdown
              </CardTitle>
              <CardDescription className="mt-1">
                Top entities by spend
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 pb-4 px-4 flex-1">
              <BreakdownList breakdown={breakdown} onClick={(item) => {
                if (item.drillThrough) {
                   setLocation(item.drillThrough);
                } else {
                   const tab = item.kind === 'workspace' ? 'groups' : item.kind === 'group' ? 'groups' : 'projects';
                   navigateToSpend({ tab, search: item.label });
                }
              }} />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Accounting Meta */}
      {isAccountAdmin && accounting && (
        <div className="rounded-lg border bg-muted/10 p-4 text-xs text-muted-foreground flex flex-wrap gap-x-6 gap-y-2">
          <div><strong>Gross Spend:</strong> ${accounting.grossSpendUsd.toFixed(2)}</div>
          <div><strong>Eligible:</strong> ${accounting.eligibleSpendUsd.toFixed(2)}</div>
          <div><strong>Excluded:</strong> ${accounting.internalExcludedUsd.toFixed(2)}</div>
          <div><strong>Unbudgeted:</strong> ${accounting.unbudgetedUsd.toFixed(2)}</div>
          <div><strong>Unattributed:</strong> ${accounting.unattributedUsd.toFixed(2)}</div>
        </div>
      )}
    </div>
  );
}

function DashboardMetricCard({ card, onClick }: { card: DashboardCard, onClick: () => void }) {
  const isCurrency = card.unit === 'usd';
  const val = card.value === null ? '—' : isCurrency ? `$${card.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : card.value.toLocaleString();

  let Icon = DollarSign;
  if (card.key.includes('limit') || card.key.includes('budget')) Icon = Wallet;
  if (card.key.includes('attention')) Icon = AlertTriangle;
  if (card.key.includes('members')) Icon = User;

  const isWarning = card.key.includes('attention') && card.value !== null && card.value > 0;

  return (
    <Card
      className={`shadow-sm transition-all hover:shadow-md hover:border-primary/30 cursor-pointer group ${isWarning ? 'border-amber-500/50 bg-amber-50/10' : ''}`}
      onClick={onClick}
      data-testid={`card-dashboard-${card.key}`}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 md:p-6 md:pb-2">
        <CardTitle className={`text-sm font-medium ${isWarning ? 'text-amber-700 dark:text-amber-400' : ''}`}>
          {card.label}
        </CardTitle>
        <Icon className={`h-4 w-4 ${isWarning ? 'text-amber-500' : 'text-muted-foreground'} group-hover:text-primary transition-colors`} />
      </CardHeader>
      <CardContent className="px-4 pb-4 md:px-6 md:pb-6">
        <div className={`text-2xl font-bold font-mono tabular-nums ${isWarning ? 'text-amber-600 dark:text-amber-400' : ''}`}>
          {val}
        </div>
        {card.qualification && (
          <p className="text-xs text-muted-foreground mt-1 truncate" title={card.qualification}>
            {card.qualification}
          </p>
        )}
      </CardContent>
    </Card>
  );
}


function BreakdownList({ breakdown, onClick }: { breakdown: DashboardBreakdownItem[], onClick: (item: DashboardBreakdownItem) => void }) {
  const maxSpend = Math.max(...breakdown.map(b => b.spendUsd));

  return (
    <div className="space-y-4">
      {breakdown.map((item, i) => {
        const pct = maxSpend > 0 ? (item.spendUsd / maxSpend) * 100 : 0;
        const isOther = item.kind === 'other' || item.kind === 'unattributed' || item.kind === 'reconciliation';

        return (
          <div
            key={item.id + i}
            className="group cursor-pointer flex flex-col gap-1.5"
            onClick={() => onClick(item)}
            data-testid={`link-dashboard-breakdown-${item.id}`}
          >
            <div className="flex justify-between items-end text-sm">
              <span className={`font-medium truncate pr-4 ${isOther ? 'text-muted-foreground italic' : ''}`}>
                {item.label}
              </span>
              <span className="font-mono tabular-nums font-semibold">
                ${item.spendUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${isOther ? 'bg-muted-foreground/30' : 'bg-primary'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="p-4 md:p-8 space-y-6 md:space-y-8 max-w-[100vw]">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-10 w-64" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map(i => (
          <Card key={i} className="shadow-sm">
            <CardHeader className="p-6 pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
            <CardContent className="p-6 pt-0 space-y-2">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2 shadow-sm"><CardContent className="h-[400px] flex items-center justify-center"><Skeleton className="h-[90%] w-[95%]" /></CardContent></Card>
        <Card className="shadow-sm"><CardContent className="h-[400px] flex items-center justify-center"><Skeleton className="h-[90%] w-[90%]" /></CardContent></Card>
      </div>
    </div>
  );
}