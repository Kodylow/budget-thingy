import React from "react";
import { useAuthContext } from "@/components/auth-context";
import { getGetOrgBudgetOverviewQueryKey, useGetOrgBudgetOverview } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Target, DollarSign, Download, Users, Briefcase } from "lucide-react";
import { formatFinancialUsd } from "@/lib/financial-format";
import { InsightCard, OrgBudgetChart, OrgTeamsTable } from "./org-insights-components";
import { AdminDataQualityNote } from "@/components/admin-data-quality";
import { OrgChartBoundary } from "./org-chart-recovery";
import { UnassignedSpendCard } from "./org-unassigned-spend";

export default function OrgInsights() {
  const { authorizationKey, capabilities } = useAuthContext();

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

  return <OrgInsightsView key={authorizationKey} authorizationKey={authorizationKey} />;
}

function OrgInsightsView({ authorizationKey }: { authorizationKey: string }) {
  // Scope the cache entry to the complete identity/authorization fingerprint.
  // React Query natively retains its last committed data during same-key refetches.
  const { data, isLoading, isFetching, isError, error, refetch } = useGetOrgBudgetOverview({
    query: { queryKey: [...getGetOrgBudgetOverviewQueryKey(), authorizationKey] },
  });
  const denied = isError && [401, 403].includes(Number((error as { status?: number })?.status));
  const displayData = denied ? undefined : data;

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
  const {
    fundedTeamCount,
    resolvedTeamCount,
    unresolvedTeamCount,
  } = summary;
  const isPartial = !complete;
  const hasUnresolvedFundedTeams = unresolvedTeamCount > 0;
  const knownCoverage = hasUnresolvedFundedTeams
    ? `${resolvedTeamCount} of ${fundedTeamCount} funded teams; ${unresolvedTeamCount} unresolved.`
    : undefined;
  const retryChart = async () => {
    const result = await refetch();
    if (result.isError) throw new Error('Chart refresh failed');
  };

  return (
    <div className="mx-auto max-w-[1400px] min-w-0 space-y-8 px-4 py-6 md:px-8 md:py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2 min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Organization Budget Overview</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Funding Period: {periodStart} to {periodEnd}</span>
            <span>Recorded through: {displayData.asOf ?? "Unavailable"}</span>
            <div className="flex items-center gap-1.5">
              {isFetching && (
                <Badge variant="secondary" className="border-border/50 text-[11px] font-normal text-muted-foreground">
                  <RefreshCw className="h-3 w-3 mr-1.5 animate-spin opacity-70" /> Updating
                </Badge>
              )}
            </div>
          </div>
          {displayData.teams.some((team) => !team.complete && team.remainingUsd != null) && (
            <p className="text-sm text-muted-foreground" data-testid="org-balance-basis">
              Balances based on recorded spend
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-2">
            <Download className="h-4 w-4" /> Print
          </Button>
          <Button data-testid="refresh-org-insights" variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching} className="gap-2">
            <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {isFetching ? "Updating" : "Refresh"}
          </Button>
        </div>
      </div>

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          Refresh failed. Showing the last recorded overview and details.
        </p>
      )}

      {(isPartial || qualification) && (
        <AdminDataQualityNote title="Budget overview data quality">
          {isPartial && <p>Balances use available recorded spend, not verified complete usage. Missing inputs remain unavailable.</p>}
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
          title={hasUnresolvedFundedTeams ? "Remaining Team Budgets (Known)" : "Remaining Team Budgets"}
          icon={Briefcase}
          value={summary.remainingUsd == null ? "Unavailable" : formatFinancialUsd(summary.remainingUsd)}
          subtitle={knownCoverage}
          testId="org-card-remaining"
        />
        <InsightCard
          title={hasUnresolvedFundedTeams ? "Teams Over Budget (Known)" : "Teams Over Budget"}
          icon={Users}
          value={summary.teamsOverBudget == null ? "Unavailable" : summary.teamsOverBudget.toString()}
          subtitle={knownCoverage}
          highlightText={summary.teamsOverBudget != null && summary.teamsOverBudget > 0 ? "Attention" : undefined}
          testId="org-card-over-budget"
        />
        <UnassignedSpendCard data={displayData} isFetching={isFetching} isError={isError} />
      </section>

      {/* Main Chart */}
      <OrgChartBoundary onRetry={retryChart}>
        <OrgBudgetChart data={displayData} onRetry={retryChart} />
      </OrgChartBoundary>

      {/* Teams Table */}
      <section className="min-w-0 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">All Teams</h2>
        </div>
        <OrgTeamsTable teams={displayData.teams} />
      </section>
    </div>
  );
}
