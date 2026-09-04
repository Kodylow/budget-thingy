import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";

const dashboardSource = readFileSync(
  new URL("./dashboard.tsx", import.meta.url),
  "utf8",
);
const pageSources = readdirSync(new URL(".", import.meta.url), {
  withFileTypes: true,
})
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx"),
  )
  .map((entry) => ({
    name: entry.name,
    source: readFileSync(new URL(entry.name, import.meta.url), "utf8"),
  }));

test("dashboard table keeps one hierarchy column followed by six metrics", () => {
  const tableHeader = dashboardSource.match(
    /<table[^>]*data-testid="table-groups"[\s\S]*?<thead>([\s\S]*?)<\/thead>/,
  )?.[1];

  const columnGroup = dashboardSource.match(
    /<table[^>]*data-testid="table-groups"[\s\S]*?<colgroup>([\s\S]*?)<\/colgroup>/,
  )?.[1];

  expect(tableHeader).toBeDefined();
  expect(tableHeader?.match(/<th\b/g)).toHaveLength(7);
  expect(columnGroup).toBeDefined();
  expect(columnGroup?.match(/<col\b/g)).toHaveLength(7);
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

test("dashboard keeps usage-health warnings toast-only", () => {
  expect(dashboardSource).not.toContain("Usage data may be out of date");
  expect(dashboardSource).not.toContain("Some usage data is still updating");
  expect(dashboardSource).not.toContain('data-testid="usage-health-warning"');
  expect(dashboardSource).not.toMatch(
    /usageHealth\.status\s*===\s*["'](?:partial|stale)["']/,
  );
  expect(dashboardSource).not.toMatch(/>\s*Details\s*</);

  // Empty usage is a content state, not an operational warning.
  expect(dashboardSource).toContain('data-testid="empty-usage-data"');
  expect(dashboardSource).toContain(
    "No usage data is available for this period.",
  );
});

test("pages do not render inline usage-health warning controls", () => {
  for (const { name, source } of pageSources) {
    expect(source, name).not.toContain("Usage data may be out of date");
    expect(source, name).not.toContain("Some usage data is still updating");
    expect(source, name).not.toMatch(
      /data-testid=["'][^"']*usage-health-(?:warning|details)[^"']*["']/,
    );
  }
});
