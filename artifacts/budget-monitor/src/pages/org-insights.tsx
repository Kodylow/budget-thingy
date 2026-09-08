import React from "react";
import { Link } from "wouter";
import { useAuthContext } from "@/components/auth-context";
import { useGetOrgBudgetOverview } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Target, DollarSign, Download, Users, Briefcase } from "lucide-react";
import { formatFinancialUsd } from "@/lib/financial-format";
import { InsightCard, OrgBudgetChart, OrgTeamsTable } from "./org-insights-components";
import { AdminDataQualityNote } from "@/components/admin-data-quality";

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
  // Use generated hook directly. No range filters accepted.
  const { data, isLoading, isError, isFetching, refetch } = useGetOrgBudgetOverview();
  const displayData = data;

  if (isLoading && !displayData) {
    return (
      <div className="mx-auto max-w-[1400px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8 animate-pulse">
         <div className="h-10 w-48 bg-muted rounded-md mb-2" />
         <div className="h-4 w-64 bg-muted rounded-md" />
         <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mt-8">
            {[1,2,3,4,5].map(i => <div key={i} className="h-32 bg-muted rounded-xl" />)}
         </div>
         <div className="h-[400px] bg-muted rounded-xl mt-8" />
         <div className="h-[300px] bg-muted rounded-xl mt-8" />
      </div>
    );
  }

  if (!displayData) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] p-8 text-center" data-testid="org-insights-error">
        <AlertTriangle className="h-10 w-10 text-destructive mb-4" />
        <p className="font-medium text-foreground mb-2">Failed to load organization budget overview.</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          <RefreshCw className="w-4 h-4 mr-2" /> Retry
        </Button>
      </div>
    );
  }

  const { summary, complete, qualification, periodStart, periodEnd } = displayData;
  const isPartial = !complete;

  return (
    <div className="mx-auto max-w-[1400px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2 min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Organization Budget Overview</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Funding Period: {periodStart} to {periodEnd}</span>
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
            <Download className="h-4 w-4" /> Print
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching} className="gap-2">
            <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {isFetching ? "Updating" : "Refresh"}
          </Button>
        </div>
      </div>

      {isError && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="flex-1">
            <strong className="text-foreground">Refresh failed; showing last available values.</strong>
          </div>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => void refetch()}>Retry</button>
        </div>
      )}
      {(isPartial || qualification) && (
        <AdminDataQualityNote title="Budget overview data quality">
          <p>{isPartial ? 'Coverage is partial.' : 'About these values.'}</p>
          {qualification && <p>{qualification}</p>}
        </AdminDataQualityNote>
      )}

      {/* Top Cards */}
      <section className="grid min-w-0 gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        <InsightCard
          title="Account Spend (Eligible)"
          icon={DollarSign}
          value={summary.accountSpendUsd == null ? "Unavailable" : formatFinancialUsd(summary.accountSpendUsd)}
          testId="org-card-account-spend"
        />
        <InsightCard
          title="Total Team Funding"
          icon={Target}
          value={summary.teamAllocationUsd == null ? "Unavailable" : formatFinancialUsd(summary.teamAllocationUsd)}
          testId="org-card-team-funding"
        />
        <InsightCard
          title="Remaining Team Budgets"
          icon={Briefcase}
          value={summary.remainingUsd == null ? "Unavailable" : formatFinancialUsd(summary.remainingUsd)}
          testId="org-card-remaining"
        />
        <InsightCard
          title="Teams Over Budget"
          icon={Users}
          value={summary.teamsOverBudget == null ? "Unavailable" : summary.teamsOverBudget.toString()}
          highlightText={summary.teamsOverBudget != null && summary.teamsOverBudget > 0 ? "Attention" : undefined}
          testId="org-card-over-budget"
        />
        {summary.unassignedSpendUsd != null && summary.unassignedSpendUsd > 0 && (
          <InsightCard
            title="Unassigned Spend"
            icon={AlertTriangle}
            value={formatFinancialUsd(summary.unassignedSpendUsd)}
            subtitle="Not mapped to any team"
            testId="org-card-unassigned"
          />
        )}
      </section>

      {/* Main Chart */}
      <OrgBudgetChart data={displayData} />

      {/* Teams Table */}
      <section className="min-w-0 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">All Teams</h2>
          <p className="text-sm text-muted-foreground">Detailed view of team budgets for the funding period.</p>
        </div>
        <OrgTeamsTable teams={displayData.teams} />
      </section>

      {summary.unassignedSpendUsd != null && summary.unassignedSpendUsd > 0 && (
         <div className="text-xs text-muted-foreground flex gap-2 p-3 bg-muted/20 border rounded items-start">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <p><strong>Reconciliation Note:</strong> There is {formatFinancialUsd(summary.unassignedSpendUsd)} of eligible account spend not mapped to any specific team budget in this view.</p>
         </div>
      )}
    </div>
  );
}
