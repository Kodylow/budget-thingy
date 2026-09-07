import React, { useMemo } from "react";
import { useSearch, Link } from "wouter";
import { useAuthContext } from "@/components/auth-context";
import { useRange } from "@/components/range-context";
import { useGetDashboard } from "@workspace/api-client-react";
import { dashboardRequestParams } from "@/lib/dashboard-request";
import { RangeFilter } from "@/components/range-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Users, Target, Activity, TrendingUp, DollarSign, Download } from "lucide-react";
import { formatFinancialUsd } from "@/lib/financial-format";
import { dashboardTotalSpend } from "@/lib/spend-presentation";
import { InsightCard, MonthlySpendChart, TopSpendersList, CategoryCards } from "./org-insights-components";
import { OrgInsightsPeopleTable } from "./org-insights-table";
import { AdminDataQualityNote } from "@/components/admin-data-quality";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function OrgInsights() {
  const { capabilities } = useAuthContext();
  
  if (capabilities.canViewAccountUsage !== true) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8 text-center" data-testid="org-insights-forbidden">
        <AlertTriangle className="h-10 w-10 text-destructive mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">Access Denied</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          Organization insights are only available to account administrators.
        </p>
      </div>
    );
  }
  
  return <OrgInsightsView />;
}

function OrgInsightsView() {
  const searchString = useSearch();
  const { rangeType, startDate, endDate } = useRange();

  const queryParams = useMemo(() => {
    const workspaceId = new URLSearchParams(searchString).get('workspaceId') || undefined;
    return dashboardRequestParams({
      rangeType,
      startDate,
      endDate,
      viewScope: "all_authorized",
      workspaceId,
    });
  }, [rangeType, startDate, endDate, searchString]);

  const { data, isLoading, isError, isFetching, refetch } = useGetDashboard(queryParams);
  const displayData = data;

  if (isLoading && !displayData) {
    return (
      <div className="mx-auto max-w-[1400px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8 animate-pulse">
         <div className="h-10 w-48 bg-muted rounded-md mb-2" />
         <div className="h-4 w-64 bg-muted rounded-md" />
         <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mt-8">
            {[1,2,3,4,5].map(i => <div key={i} className="h-32 bg-muted rounded-xl" />)}
         </div>
         <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-8">
            <div className="h-[400px] bg-muted rounded-xl" />
            <div className="h-[400px] bg-muted rounded-xl lg:col-span-2" />
         </div>
      </div>
    );
  }

  if (!displayData) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] p-8 text-center" data-testid="org-insights-error">
        <AlertTriangle className="h-10 w-10 text-destructive mb-4" />
        <p className="font-medium text-foreground mb-2">Failed to load organization insights.</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          <RefreshCw className="w-4 h-4 mr-2" /> Retry
        </Button>
      </div>
    );
  }

  const { period, metadata, projection, insights } = displayData;
  const isPartial = metadata.status === 'partial';
  const totalSpend = dashboardTotalSpend(displayData);

  return (
    <div className="mx-auto max-w-[1280px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2 min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Org Insights</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Organization-wide Replit adoption and spend for {period.label}</span>
            <div className="flex items-center gap-1.5">
              {isFetching && (
                <Badge variant="secondary" className="border-border/50 text-[11px] font-normal text-muted-foreground">
                  <RefreshCw className="h-3 w-3 mr-1.5 animate-spin opacity-70" /> Updating
                </Badge>
              )}
              {isPartial && (
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[11px] font-medium text-amber-700">
                  Partial data
                </Badge>
              )}
              {metadata.stale && !isError && (
                <Badge variant="secondary" className="border-border/50 text-[11px] font-normal text-muted-foreground">
                  Cached
                </Badge>
              )}
              {isError && (
                <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700 font-medium text-xs">
                  <AlertTriangle className="h-3 w-3 mr-1.5 opacity-70" /> Refresh failed
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-2">
            <Download className="h-4 w-4" /> Export view
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching} className="gap-2">
            <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {isFetching ? "Updating" : "Refresh data"}
          </Button>
        </div>
      </div>

      {isError && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="flex-1">
            <strong className="text-foreground">Refresh failed; last available organization values are shown.</strong>
          </div>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => void refetch()}>Retry</button>
        </div>
      )}
      {(metadata.status !== 'complete' || metadata.stale || metadata.qualifications.length > 0) && (
        <AdminDataQualityNote title="Organization insights data quality">
          <p>{isPartial ? 'Partial coverage.' : metadata.stale ? 'Data may be stale.' : 'About these values.'}</p>
          {metadata.qualifications.map((qualification) => <p key={qualification}>{qualification}</p>)}
        </AdminDataQualityNote>
      )}
      {displayData.staleSpend && <AdminDataQualityNote title="Stale project spend data quality">
        <p>
          Stale project spend is current UTC-month authorized spend for projects last updated on or before{' '}
          <time dateTime={displayData.staleSpend.staleCutoff}>{new Date(displayData.staleSpend.staleCutoff).toLocaleDateString()}</time>.
          {' '}Project update time is metadata freshness, not an activity audit trail.
          {displayData.staleSpend.availability !== 'complete' ? ` Observation availability is ${displayData.staleSpend.availability}.` : ''}
        </p>
      </AdminDataQualityNote>}

      <div className="flex flex-col gap-3 rounded-md border bg-card p-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <p>
            <strong className="font-semibold text-foreground">Organization insights data quality.</strong>{" "}
            {isPartial
              ? "Coverage is partial; values shown are the last available UTC totals."
              : metadata.stale
                ? "Values shown are the last available cached UTC totals."
                : "Values reflect the latest available UTC totals."}
          </p>
        </div>
        <div className="w-full shrink-0 sm:w-auto">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Reporting period</p>
          <RangeFilter selectedLabel={period.label} />
        </div>
      </div>

      {/* Top Cards */}
      <section className="grid min-w-0 gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6">
        <InsightCard 
          title="Total Spend" 
          icon={DollarSign} 
          value={totalSpend == null ? "Unavailable" : formatFinancialUsd(totalSpend)}
          testId="org-card-total"
        />
        <InsightCard 
          title="Change vs prior period" 
          icon={TrendingUp} 
          value={insights?.changePercent != null ? `${insights.changePercent > 0 ? '+' : ''}${insights.changePercent.toFixed(1)}%` : "Unavailable"} 
          subtitle={insights?.previousPeriodSpendUsd != null ? `vs ${formatFinancialUsd(insights.previousPeriodSpendUsd)} previous equal-length UTC window` : undefined}
          highlightText={insights?.changePercent != null ? (insights.changePercent <= 0 ? "Down" : "Up") : undefined}
          testId="org-card-change"
        />
        <InsightCard 
          title="Active Users" 
          icon={Users} 
          value={insights?.activeUsers != null ? insights.activeUsers.toLocaleString() : "Unavailable"} 
          subtitle="with spend this period"
          testId="org-card-users"
        />
        <InsightCard 
          title="Avg / Active User" 
          icon={Activity} 
          value={insights?.avgSpendPerActiveUserUsd != null ? formatFinancialUsd(insights.avgSpendPerActiveUserUsd) : "Unavailable"} 
          subtitle="per user"
          testId="org-card-avg"
        />
        <div className="relative group">
          <InsightCard 
            title="Stale spend This month"
            icon={AlertTriangle}
            value={displayData.staleSpend?.spendUsd != null ? formatFinancialUsd(displayData.staleSpend.spendUsd) : "Unavailable"}
            subtitle={displayData.staleSpend?.projectCount != null ? `${displayData.staleSpend.projectCount} stale projects` : undefined}
            testId="org-card-stale"
          />
          {displayData.staleSpend?.drillThrough && (
            <Link href={displayData.staleSpend.drillThrough}
                  className="absolute inset-0 z-10 rounded-xl ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 opacity-0 group-hover:opacity-100 transition-opacity bg-primary/5 flex items-center justify-center backdrop-blur-[1px]"
                  aria-label="View Stale Projects">
               <span className="bg-primary text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-full shadow-sm">
                 View projects
               </span>
            </Link>
          )}
        </div>
        <div className="relative group">
          <InsightCard
            title="Projected Total" 
            icon={Target} 
            value={projection?.projectedKnownTotalUsd != null ? `~${formatFinancialUsd(projection.projectedKnownTotalUsd)}` : (projection?.projectedTotalUsd != null ? `~${formatFinancialUsd(projection.projectedTotalUsd)}` : "Unavailable")} 
            subtitle={projection?.dataThrough ? `based on spend through ${new Date(projection.dataThrough).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : undefined}
            testId="org-card-projected"
          />
          <Link href={`/overview?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(searchString).entries()), viewScope: 'all_authorized' }).toString()}`}
                className="absolute inset-0 z-10 rounded-xl ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 opacity-0 group-hover:opacity-100 transition-opacity bg-primary/5 flex items-center justify-center backdrop-blur-[1px]"
                aria-label="View Forecast Details">
             <span className="bg-primary text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-full shadow-sm">
               Forecast details
             </span>
          </Link>
        </div>
      </section>

      {/* Middle section */}
       <div className="grid min-w-0 gap-4 lg:grid-cols-5">
          <Card className="shadow-none lg:col-span-2">
             <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                 <Users className="w-3.5 h-3.5 text-primary" /> Top Spenders
                </CardTitle>
             </CardHeader>
             <CardContent className="space-y-1">
               <TopSpendersList spenders={insights?.topSpenders ?? []} />
             </CardContent>
          </Card>
          <Card className="shadow-none lg:col-span-3">
             <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                 <Activity className="w-3.5 h-3.5 text-primary" /> Monthly Spend by Category
                </CardTitle>
             </CardHeader>
             <CardContent>
             <div className="h-56">
               <MonthlySpendChart monthly={insights?.monthly ?? []} />
            </div>
             </CardContent>
          </Card>
      </div>
      
      {/* Category Cards */}
      {insights?.categories && insights.categories.length > 0 && (
         <CategoryCards categories={insights.categories} />
      )}

       {/* People Table */}
       <section className="min-w-0 space-y-3">
          <div>
            <h2 className="text-lg font-semibold">People using Replit</h2>
            <p className="text-sm text-muted-foreground">Account-wide users with activity in the selected period.</p>
          </div>
         <OrgInsightsPeopleTable />
      </section>
    </div>
  );
}
