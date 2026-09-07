import React from "react";

type AttributedRollup = {
  rollupMemberCount?: number;
  rollupSpendLoaded?: boolean;
  rollupSpendUsd?: number;
};

export function UnassignedSummaryRow({
  workspaceId,
  groups,
}: {
  workspaceId: string;
  groups: AttributedRollup[];
}) {
  const totals = groups.reduce(
    (total, group) => ({
      memberCount: total.memberCount + (group.rollupMemberCount ?? 0),
      spendUsd: total.spendUsd + (group.rollupSpendUsd ?? 0),
    }),
    { memberCount: 0, spendUsd: 0 },
  );

  return (
    <tr
      className="border-b border-border bg-muted/20 transition-colors"
      data-testid={`row-unassigned-${workspaceId}`}
    >
      <td className="py-3 px-4 font-semibold text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="w-4" aria-hidden="true" />
          <span>Unassigned</span>
        </div>
      </td>
      <td className="py-3 px-4" />
      <td className="py-3 px-4 text-right">
        <span
          className="text-sm font-mono tabular-nums font-semibold"
          data-testid={`text-unassigned-members-${workspaceId}`}
        >
          {totals.memberCount}
        </span>
      </td>
      <td className="py-3 px-4 text-right">
        <span
          className="text-sm font-mono tabular-nums font-semibold"
          data-testid={`text-unassigned-spend-${workspaceId}`}
        >
          ${totals.spendUsd.toFixed(2)}
        </span>
      </td>
      {Array.from({ length: 4 }, (_, index) => (
        <td className="py-3 px-4 text-right" key={index}>
          <span className="text-sm text-muted-foreground">—</span>
        </td>
      ))}
    </tr>
  );
}
