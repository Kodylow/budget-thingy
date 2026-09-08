import React from "react";
import type { OrgBudgetOverviewResponse } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatFinancialUsd } from "@/lib/financial-format";
import { InsightCard } from "./org-insights-components";

const sourceLabels = {
  unmapped_group: "Group not mapped to a budget team",
  no_group: "Workspace-level attribution",
  unresolved_difference: "Unresolved accounting difference",
};

export function UnassignedSpendCard({
  data, isFetching, isError,
}: {
  data: OrgBudgetOverviewResponse;
  isFetching: boolean;
  isError: boolean;
}) {
  const detail = data.unassignedDetail;
  const unavailable = !detail || detail.observation === "unavailable";
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="org-summary-trigger min-w-0 rounded-md text-left transition-colors hover:ring-1 hover:ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Inspect Unassigned Spend"
        >
          <InsightCard
            title="Unassigned Spend"
            value={formatFinancialUsd(data.summary.unassignedSpendUsd)}
            subtitle="View workspace and group details →"
            testId="org-card-unassigned"
          />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl" data-testid="org-unassigned-dialog">
        <DialogHeader>
          <DialogTitle>Unassigned Spend</DialogTitle>
          <DialogDescription>
            This usage is already included in eligible account spend but is not assigned to a team.
            It is not unused budget.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <p className="font-mono text-2xl font-semibold" data-testid="unassigned-detail-total">
            {formatFinancialUsd(data.summary.unassignedSpendUsd)}
          </p>
          <p className="text-sm text-muted-foreground">Funding Period: {data.periodStart} to {data.periodEnd}</p>
          <p className="text-sm text-muted-foreground">Recorded through: {data.asOf ?? "Unavailable"}</p>
        </div>
        {isFetching && <p role="status" className="text-sm text-muted-foreground">Updating overview and details…</p>}
        {isError && <p role="alert" className="text-sm text-destructive">Refresh failed. Showing the last recorded overview and details.</p>}
        {detail?.observation === "partial" && (
          <p className="text-sm text-muted-foreground">
            Recorded usage only; some workspace observations are missing. Missing usage is not zero.
          </p>
        )}
        {unavailable ? (
          <p role="status" className="text-sm">Unassigned spend details are unavailable. Missing usage is not zero.</p>
        ) : detail.workspaces.length === 0 ? (
          <p className="text-sm">No unassigned spend in the recorded usage for this funding period.</p>
        ) : (
          <div className="min-w-0 space-y-5">
            <p className="text-sm text-muted-foreground">
              No group / unresolved attribution may include ungrouped member usage, project non-Agent usage
              without group attribution, and workspace reconciliation residuals. These amounts do not identify a missing owner.
            </p>
            {detail.workspaces.map((workspace) => (
              <section key={workspace.workspaceId ?? "unresolved"} className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="min-w-0 break-words text-sm font-semibold">
                    {workspace.workspaceName ?? workspace.workspaceId ?? "Workspace unresolved"}
                    {workspace.workspaceName && workspace.workspaceId && (
                      <span className="ml-2 font-normal text-muted-foreground">({workspace.workspaceId})</span>
                    )}
                  </h3>
                  <p className="font-mono text-sm">Subtotal: {formatFinancialUsd(workspace.spendUsd)}</p>
                </div>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead scope="col">Group</TableHead>
                    <TableHead scope="col">Source</TableHead>
                    <TableHead scope="col" className="text-right">Amount</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {workspace.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="break-words">{row.groupName ?? (row.source === "no_group" ? "No group / unresolved attribution" : "Unresolved")}</TableCell>
                        <TableCell className="text-muted-foreground">{sourceLabels[row.source]}</TableCell>
                        <TableCell className="whitespace-nowrap text-right font-mono">{formatFinancialUsd(row.spendUsd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}