import React, { useState, useMemo } from "react";
import { formatUsd } from "@/pages/home-components/format";
import { MetricCard } from "@/components/journey-primitives";
import { OrgBudgetOverviewResponse } from "@workspace/api-client-react";
import { Link } from "wouter";
import { useSearch } from "wouter/use-browser-location";
import { AdminDataQualityNote } from "@/components/admin-data-quality";
import { teamOverviewHref } from "@/lib/reporting-navigation";

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
    <div className="org-summary-item min-w-0 h-full" data-testid={testId}>
      <MetricCard
        className="org-summary-card"
        label={title}
        value={typeof value === "string" || typeof value === "number" ? String(value) : "Unavailable"}
        detail={[highlightText, subtitle].filter(Boolean).join(" ") || undefined}
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
  [key: string]: number | string | boolean | null | undefined;
}

const basisLabel = (basis: OrgBudgetOverviewResponse["teams"][number]["reporting"]["valueBasis"]) =>
  basis === "verified" ? "Verified"
    : basis === "current_membership_qualified" ? "Current-membership qualified"
    : basis === "current_catalog_qualified" ? "Current-catalog creator qualified"
    : basis === "partial_known" ? "Recorded, partial coverage"
    : "Unavailable";

export { OrgBudgetChart } from "./org-budget-chart";

export function OrgTeamsTable({ teams }: { teams: OrgBudgetOverviewResponse['teams'] }) {
  const search = useSearch();

  if (!teams || teams.length === 0) {
    return <div className="text-sm text-muted-foreground p-6 text-center border rounded bg-card">No teams found.</div>;
  }

  return (
    <div className="border rounded bg-card overflow-hidden text-sm">
      <AdminDataQualityNote title="Team balance data quality">
        <ul>
          {teams.map((team) => (
            <li key={team.id}>{team.name}: {basisLabel(team.reporting.valueBasis)}{!team.complete && "; balance not verified complete"}.</li>
          ))}
        </ul>
      </AdminDataQualityNote>
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
                    <Link href={teamOverviewHref(team.id, search)} className="font-semibold text-foreground hover:underline hover:text-primary transition-colors inline-block">
                      {team.name}
                    </Link>
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
                  ) : <span className="text-muted-foreground">
                    {team.allocationUsd === 0 && team.spendUsd != null ? "Not applicable" : "Unavailable"}
                  </span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
