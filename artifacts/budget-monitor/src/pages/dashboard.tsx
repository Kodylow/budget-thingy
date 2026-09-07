import { useMemo, useEffect, lazy, Suspense, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useGetDashboard,
  DashboardCard,
  GetDashboardParams,
} from "@workspace/api-client-react";
import { useAuthContext } from "@/components/auth-context";
import { useRange } from "@/components/range-context";
import { Badge } from "@/components/ui/badge";
import { RangeFilter } from "@/components/range-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Target, CheckCircle2, Info, DollarSign, TrendingUp } from "lucide-react";
import { reportDashboardMilestonePainted, markDashboardMilestone, DashboardPerformanceContext } from "@/lib/client-performance";
import {
  dashboardRequestParams,
  dashboardSpendHref,
} from "@/lib/dashboard-request";
import {
  resolveSpendViewScope,
  spendScopeLabel,
  spendScopeOptions,
} from "@/lib/spend-scope";
import { dashboardTotalSpend } from "@/lib/spend-presentation";
import { AdminDataQualityNote } from "@/components/admin-data-quality";

const DashboardProjectionView = lazy(() => import("./dashboard-projection"));
const TrendChart = lazy(() => import("./dashboard-chart"));

function DashboardCardView({ card, title, icon: Icon, onClick, "aria-label": ariaLabel }: { card: DashboardCard; title: string; icon?: React.ElementType; onClick?: () => void; "aria-label"?: string }) {
  const Component = onClick ? 'button' : 'div';
  return (
    <Component
      onClick={onClick}
      aria-label={ariaLabel}
      className={`bg-card border border-border shadow-sm rounded-xl p-5 min-w-0 text-left transition-colors flex flex-col justify-between ${onClick ? 'hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer' : ''}`}
      data-testid={`card-dashboard-${card.key}`}
    >
      <div className="flex items-center gap-2 mb-3">
        {Icon && <Icon className="w-4 h-4 text-primary" />}
        <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest">{title}</div>
      </div>
      <div className="text-3xl font-mono font-semibold tracking-tight break-words text-foreground">
        {formatCardValue(card)}
      </div>
      {card.qualification && (
        <AdminDataQualityNote title={title}>{card.qualification}</AdminDataQualityNote>
      )}
    </Component>
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { role, capabilities, auth, authorizationKey } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();

  const searchParams = new URLSearchParams(searchString);
  const viewScope = resolveSpendViewScope(
    searchParams.get('viewScope') || auth?.viewScope,
    role === 'member' ? 'my' : 'managed',
  );
  const projectionHorizon = (['month_end', 'year_end', 'term_end'].includes(searchParams.get('projectionHorizon') ?? '')
    ? searchParams.get('projectionHorizon') : 'month_end') as GetDashboardParams['projectionHorizon'];

  const canViewAccountUsage = capabilities.canViewAccountUsage === true;
  const scopeOptions = spendScopeOptions(canViewAccountUsage);

  const queryParams = useMemo(() => {
    return dashboardRequestParams({
      rangeType,
      startDate,
      endDate,
      viewScope,
      projectionHorizon,
    });
  }, [rangeType, startDate, endDate, viewScope, projectionHorizon]);

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
        <p className="mt-1 text-sm">Data as of unavailable. No spend values are shown.</p>
        <button className="mt-3 text-sm text-primary hover:underline" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const { scope, period, cards, trend, metadata } = displayData;
  const totalSpend = dashboardTotalSpend(displayData);
  const responseSpendCard = cards.find((card) => [
    'eligible_spend',
    'spend',
  ].includes(card.key));
  const headline: DashboardCard | undefined = totalSpend == null ? undefined : {
    key: responseSpendCard?.key ?? 'spend',
    label: responseSpendCard?.label ?? 'Spend in period',
    value: totalSpend,
    unit: 'usd',
    qualification: responseSpendCard?.qualification ?? null,
  };
  const supportingFacts = cards
    .filter((card) => card !== responseSpendCard && card.key !== 'pools_attention')
    .filter((card) => totalSpend != null || ['allocated_budget', 'monthly_agent_limit'].includes(card.key))
    .slice(0, 3);
  const isPartial = metadata.status === 'partial';

  const navigateToSpend = (filter?: Record<string, string>) => {
    setLocation(dashboardSpendHref(searchString, { viewScope: scope.viewScope, ...filter }));
  };

  const updateUrlParam = (key: string, value: string | undefined) => {
    const params = new URLSearchParams(searchString);
    if (value) params.set(key, value);
    else params.delete(key);
    setLocation(`/?${params.toString()}`);
  };

  const setProjectionHorizon = (val: string) => {
    const params = new URLSearchParams(searchString);
    if (val && val !== 'month_end') params.set('projectionHorizon', val);
    else params.delete('projectionHorizon');
    params.delete('planningEndDate');
    setLocation(`/?${params.toString()}`);
  };

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      {/* Overview Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl" data-testid="text-dashboard-scope">
              Overview
            </h1>
            <div className="flex items-center gap-1.5 mt-1 ml-2">
              {isFetching && (
                <Badge variant="secondary" className="border-border/50 text-muted-foreground font-normal text-xs" data-testid="status-dashboard-updating">
                  <RefreshCw className="h-3 w-3 mr-1.5 animate-spin opacity-70" /> Updating
                </Badge>
              )}
              {isPartial && (
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 font-medium text-xs" data-testid="status-dashboard-partial">
                  Partial
                </Badge>
              )}
              {metadata.stale && !isError && (
                <Badge variant="secondary" className="border-border/50 text-muted-foreground font-normal text-xs" data-testid="status-dashboard-stale">
                  Cached
                </Badge>
              )}
              {isError && (
                <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700 font-medium text-xs" data-testid="status-dashboard-error">
                  <AlertTriangle className="h-3 w-3 mr-1.5 opacity-70" /> Refresh failed
                </Badge>
              )}
              {(isError || !headline) && (
                <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => void refetch()} disabled={isFetching}>
                  Retry
                </Button>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="text-dashboard-period">
            {scope.label} · {spendScopeLabel(resolveSpendViewScope(scope.viewScope, viewScope), canViewAccountUsage)}
          </p>
        </div>
        <div className="flex w-full min-w-0 flex-col items-start gap-3 sm:gap-4 sm:flex-row sm:items-end lg:w-auto">
          {role !== 'member' && (
            <div className="w-full sm:w-auto">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Visibility</p>
              <Select value={viewScope} onValueChange={(value) => updateUrlParam('viewScope', value)}>
                <SelectTrigger className="h-9 w-full bg-background sm:w-[220px]" aria-label="Spend scope" data-testid="select-dashboard-scope">
                  <SelectValue placeholder="Spend scope" />
                </SelectTrigger>
                <SelectContent>
                  {scopeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="w-full sm:w-auto min-w-0">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Reporting period</p>
            <RangeFilter selectedLabel={period.label} />
          </div>
        </div>
      </div>

      {metadata.qualifications.length > 0 && (
        <AdminDataQualityNote title="Overview">
          {metadata.qualifications.join(' ')}
        </AdminDataQualityNote>
      )}

      {/* KPI Cards */}
      <section aria-labelledby="spend-headline" className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {headline ? (
          <DashboardCardView
             card={headline}
             title="Spend"
             icon={DollarSign}
             onClick={() => navigateToSpend()}
             aria-label="Explore spend in Spend"
          />
        ) : (
          <div className="bg-card border border-border shadow-sm rounded-xl p-5 min-w-0 flex flex-col justify-between">
             <div className="flex items-center gap-2 mb-3">
               <DollarSign className="w-4 h-4 text-primary" />
               <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest">Spend</div>
             </div>
             <div>
               <div className="text-xl font-medium text-foreground" data-testid="status-dashboard-spend-unavailable">Unavailable</div>
               <div className="text-xs text-muted-foreground mt-1">No summary for {period.label}</div>
             </div>
          </div>
        )}
        {supportingFacts.map((card) => {
          const isBudget = ['allocated_budget', 'monthly_agent_limit'].includes(card.key);
          const isRemaining = ['allocation_remaining', 'agent_limit_remaining'].includes(card.key);
          const title = isBudget ? 'Budget' : isRemaining ? 'Remaining' : card.label;
          const Icon = isBudget ? Target : isRemaining ? CheckCircle2 : Info;
          return <DashboardCardView key={card.key} card={card} title={title} icon={Icon} />;
        })}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Actual Spend Trend - Primary */}
        <section aria-labelledby="trend-heading" className="min-w-0 bg-card border border-border shadow-sm rounded-xl overflow-hidden flex flex-col">
          <div className="p-5 border-b border-border/50">
            <h2 id="trend-heading" className="text-sm font-semibold flex items-center gap-2 uppercase tracking-wider text-muted-foreground">
              <TrendingUp className="w-4 h-4 text-primary" /> Actual reporting-period trend
            </h2>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">{period.label}</p>
              <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-widest">{trend.granularity === 'day' ? 'Daily' : trend.granularity === 'week' ? 'Weekly' : 'Monthly'} · {trend.mode === 'cumulative' ? 'Known cumulative spend' : 'Period spend'}</p>
            </div>
          </div>
          <div className="p-5 h-[320px]">
            <Suspense fallback={<div className="flex h-full w-full items-center justify-center"><Skeleton className="h-[90%] w-[95%]" /></div>}>
              <TrendChart trend={trend} onClick={() => navigateToSpend()} />
            </Suspense>
          </div>
        </section>

        {/* Projected Outlook - Secondary */}
        <section aria-labelledby="outlook-heading" className="min-w-0 bg-card border border-border shadow-sm rounded-xl overflow-hidden flex flex-col">
          <div className="p-5 border-b border-border/50 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 id="outlook-heading" className="text-sm font-semibold flex items-center gap-2 uppercase tracking-wider text-muted-foreground">
                <Target className="w-4 h-4 text-secondary" /> At-current-rate outlook
                <Badge variant="outline" className="text-[10px] normal-case tracking-normal">Estimate</Badge>
              </h2>
              <AdminDataQualityNote title="At-current-rate outlook">
                This is an estimate for the selected horizon, not additional actual spend.
              </AdminDataQualityNote>
            </div>
            <div className="flex items-center gap-2">
               <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest whitespace-nowrap">Through</span>
               <Select value={projectionHorizon || 'month_end'} onValueChange={setProjectionHorizon}>
                  <SelectTrigger aria-label="Project through" className="h-8 w-[130px] sm:w-[150px] bg-background text-xs font-medium" data-testid="select-projection-horizon">
                    <SelectValue placeholder="Target" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month_end">End of month</SelectItem>
                    <SelectItem value="year_end">End of year</SelectItem>
                    <SelectItem value="term_end">End of term</SelectItem>
                  </SelectContent>
               </Select>
            </div>
          </div>
          <div className="p-5">
             {displayData.projection ? (
               <Suspense fallback={<Skeleton className="h-[280px] w-full" />}>
                 <DashboardProjectionView projection={isError ? { ...displayData.projection, stale: true } : displayData.projection} animateKey={querySignature} />
               </Suspense>
             ) : (
               <div className="flex items-center justify-center h-[280px]">
                 <p className="text-sm text-muted-foreground" data-testid="status-dashboard-outlook-unavailable">Outlook unavailable for this scope and period.</p>
               </div>
             )}
          </div>
        </section>
      </div>
    </div>
  );
}

function formatCardValue(card: DashboardCard) {
  const isCurrency = card.unit === 'usd';
  return card.value === null
    ? 'Unknown'
    : isCurrency
      ? card.value.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
      : card.value.toLocaleString();
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 p-4 md:p-8" role="status" aria-label="Loading Overview">
      <span className="sr-only">Loading Overview. Data as of unavailable until a snapshot is received.</span>
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-4">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-48" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-[400px] rounded-xl w-full" />
        <Skeleton className="h-[400px] rounded-xl w-full" />
      </div>
    </div>
  );
}