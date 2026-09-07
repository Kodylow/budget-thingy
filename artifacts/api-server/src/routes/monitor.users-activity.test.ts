import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const routeModules = [
  "monitor.ts",
  "monitor.shared.ts",
  "monitor.groups-list.ts",
  "monitor.groups-detail.ts",
  "monitor.dashboard.ts",
  "monitor.spend-tables.ts",
  "monitor.teams.ts",
  "monitor.limits.ts",
  "monitor.alerts.ts",
  "monitor.admin.ts",
  "monitor.directory.ts",
  "monitor.exports-projects.ts",
  "monitor.exports-users.ts",
];
const routeSources = await Promise.all(
  routeModules.map((file) =>
    readFile(new URL(`./${file}`, import.meta.url), "utf8")
  ),
);
const routeSource = routeSources.join("\n");
const sharedSource = routeSources[1]!;

describe("monitor usage snapshot cutover", () => {
  test("usage-facing routes use the immutable snapshot pipeline", () => {
    expect(routeSource).toContain("resolveUsageWindow");
    expect(routeSource).toContain("readUsageSnapshot");
    expect(routeSource).toContain("computeSnapshotUsageRollup");
    expect(routeSource).toContain("computeHistoricalSnapshotUsageRollups");
  });

  test("legacy range-cache reads and request-time queues are absent", () => {
    const forbidden = [
      "getCanonicalUsage",
      "getSpend(",
      "getMemberUsage",
      "getProjectUsage(",
      "getWorkspaceMemberUsage",
      "getUsageSyncSummary",
      "getProjectUsageSyncSummary",
      "getUsageOperationalDiagnostics",
      "queueFullRangeRebuild",
      "queueGroupSpendFetch",
      "queueMemberUsageFetch",
      "queueProjectUsageFetch",
      "queueWsSpendFetch",
      "queueAccountUsageFetch",
      "range.key",
      "getProjectInfo",
      "getProjectTitles",
      "hasProjectInfo",
    ];
    for (const reference of forbidden) expect(routeSource).not.toContain(reference);
    expect(routeSource).toContain("apiProjectMetadataTable");
    expect(routeSource).toContain("apiProjectMetadataStateTable");
  });

  test("removed mutation routes cannot re-enter the monitor router", () => {
    expect(routeSource).not.toContain('"/groups/:groupId/refresh"');
    expect(routeSource).not.toContain('"/usage/retry"');
    expect(routeSource).not.toContain('"/usage/ranges/rebuild"');
  });

  test("true-admin ingest endpoints use persisted runs", () => {
    expect(routeSource).toContain('"/admin/usage/ingest/cycle"');
    expect(routeSource).toContain('"/admin/usage/ingest/runs/recent"');
    expect(routeSource).toMatch(/ingest\/cycle"[\s\S]*requireCapability\("canRunChecks"\)/);
    expect(routeSource).toMatch(/runs\/recent"[\s\S]*requireCapability\("canManageSystem"\)/);
    expect(routeSource).toContain("await runCycle()");
    expect(routeSource).toContain("from ingest_run order by started_at desc");
    expect(routeSource).toContain("presentUsageIngestRun");
    expect(routeSource).toContain("from unnest($2::text[]) w(workspace_id)");
    expect(routeSource).toContain("p.failed_at>w.fetched_at");
    expect(routeSource).toContain("peakRequestsPerMinute: null");
    expect(routeSource).toContain("projectMetadata?.completeWorkspaceIds");
    expect(routeSource).toContain("System status project metadata detail unavailable");
    expect(routeSource).toContain("projectEnrichment:");
  });

  test("one request performs one scoped snapshot read in the shared path", () => {
    const helper = sharedSource.slice(
      sharedSource.indexOf("async function usageForRequest"),
      sharedSource.indexOf("interface EffectiveBudget"),
    );
    expect(helper.match(/readUsageSnapshot\(/g)).toHaveLength(1);
    expect(helper).toContain("workspaceIds");
  });
});
