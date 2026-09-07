import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { UnassignedSummaryRow } from "./unassigned-summary-row";

test("renders unattributed usage once as a non-expandable Unassigned summary", () => {
  const html = renderToStaticMarkup(
    <table>
      <tbody>
        <UnassignedSummaryRow
          workspaceId="workspace-1"
          groups={[
            {
              rollupMemberCount: 2,
              rollupSpendLoaded: true,
              rollupSpendUsd: 12.25,
            },
            {
              rollupMemberCount: 3,
              rollupSpendLoaded: true,
              rollupSpendUsd: 7.75,
            },
          ]}
        />
      </tbody>
    </table>,
  );

  expect(html.match(/Unassigned/g)).toHaveLength(1);
  expect(html).toContain('data-testid="text-unassigned-members-workspace-1">5');
  expect(html).toContain(
    'data-testid="text-unassigned-spend-workspace-1">$20.00',
  );
  expect(html).not.toContain("No group");
  expect(html).not.toContain("tabindex");
  expect(html).not.toContain("button");
});

test("the summary preserves reconciliation totals without rendering source rows", () => {
  const groups = [
    {
      rollupMemberCount: 1,
      rollupSpendLoaded: true,
      rollupSpendUsd: 40,
    },
    {
      rollupMemberCount: 4,
      rollupSpendLoaded: true,
      rollupSpendUsd: 15,
    },
  ];
  const assignedSpendUsd = 95;
  const html = renderToStaticMarkup(
    <table>
      <tbody>
        <UnassignedSummaryRow workspaceId="workspace-2" groups={groups} />
      </tbody>
    </table>,
  );

  expect(
    assignedSpendUsd +
      groups.reduce((sum, group) => sum + group.rollupSpendUsd, 0),
  ).toBe(150);
  expect(html.match(/\$55\.00/g)).toHaveLength(1);
  expect(html.match(/<tr/g)).toHaveLength(1);
});
