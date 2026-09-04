import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const dashboardSource = readFileSync(
  new URL("./dashboard.tsx", import.meta.url),
  "utf8",
);

test("dashboard table keeps one hierarchy column followed by six metrics", () => {
  const tableHeader = dashboardSource.match(
    /<table[^>]*data-testid="table-groups"[\s\S]*?<thead>([\s\S]*?)<\/thead>/,
  )?.[1];

  expect(tableHeader).toBeDefined();
  expect(tableHeader?.match(/<th\b/g)).toHaveLength(7);
  expect(tableHeader).toContain("Members");
  expect(tableHeader).toContain("Spend");
  expect(tableHeader).toContain("Budget");
  expect(tableHeader).toContain("Remaining");
  expect(tableHeader).toContain("Usage");
  expect(tableHeader).toContain("Pace");
});

test("dashboard disclosures use native accessible controls and seven columns", () => {
  expect(dashboardSource).toContain('aria-expanded={expanded}');
  expect(dashboardSource).toContain('data-testid={`button-workspace-${workspace.workspaceId}`}');
  expect(dashboardSource).toContain('data-testid={`button-family-${familyId}`}');
  expect(dashboardSource).toContain("colSpan={7}");
  expect(dashboardSource).not.toContain("text-workspace-");
  expect(dashboardSource).not.toContain("columnCount={8}");
  expect(dashboardSource).not.toContain("colSpan={8}");
});