// @ts-nocheck
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    client,
    poolQuery: vi.fn(),
    saveIngestCursor: vi.fn(),
    selectFullSyncSlice: vi.fn(),
    runCheck: vi.fn(),
    refreshTeamBudgetSnapshot: vi.fn(),
    reconcileTeamBudgetsUpstream: vi.fn(),
    applyAllMemberLimitPolicies: vi.fn(),
  };
});

vi.mock("@workspace/db", () => ({
  pool: {
    connect: vi.fn(async () => mocks.client),
    query: mocks.poolQuery,
  },
}));
vi.mock("./history", () => ({
  hasDailyRosterSnapshot: vi.fn(async () => true),
  recordDailyRosters: vi.fn(async () => undefined),
}));
vi.mock("./enterprise", () => ({
  assertCompleteRosterDirectory: vi.fn(),
  fetchEnterpriseForIngest: vi.fn(),
  getCachedDirectory: vi.fn(),
  getDirectoryFreshness: vi.fn(() => ({
    dataAsOf: null, isStale: true, isRefreshing: false,
  })),
  refreshDirectoryForIngest: vi.fn(async () => ({
    workspaces: new Map(),
    groups: [],
    groupMembers: new Map(),
  })),
  refreshBillingPeriodMetadata: vi.fn(async () => undefined),
  refreshProjectMetadataSlice: vi.fn(async () => ({
    attempted: 0, succeeded: 0, failed: 0, deferred: 0,
  })),
  getProjectMetadataProgress: vi.fn(async () => ({
    remaining: 0, fresh: 0, deferred: 0, failed: 0,
  })),
  getBillingPeriodMetadata: vi.fn(() => ({
    isFallback: false, start: "2026-05-20", end: "2026-06-20",
  })),
  isConfigured: vi.fn(() => true),
  withEnterpriseIngestAccess: vi.fn(async (work) => work()),
}));
vi.mock("./ingest-selection", () => ({
  CUTOFF: "2026-05-20",
  unitKey: vi.fn(),
  selectIngestSlice: vi.fn(),
  selectLiveSlice: vi.fn(),
  saveIngestCursor: mocks.saveIngestCursor,
  selectFullSyncSlice: mocks.selectFullSyncSlice,
}));
vi.mock("./ingest-reconcile", () => ({
  reconciliationBounds: vi.fn(),
  nextReconciliationMismatchCount: vi.fn(),
  reconcileWorkspaceTotal: vi.fn(),
  reconcileSlice: vi.fn(),
  remainingReconciliationCount: vi.fn(async () => 0),
}));
vi.mock("./usage-store", () => ({
  beginUsageGenerationUpdate: vi.fn(() => vi.fn()),
  invalidateUsageSnapshotMemo: vi.fn(),
}));
vi.mock("./checker", () => ({ runCheck: mocks.runCheck }));
vi.mock("./team-budgets", () => ({
  getAirtableSourceConfigurationStatus: vi.fn(() => ({ configured: true })),
  refreshTeamBudgetSnapshot: mocks.refreshTeamBudgetSnapshot,
  reconcileTeamBudgetsUpstream: mocks.reconcileTeamBudgetsUpstream,
}));
vi.mock("./member-limit-policies", () => ({
  applyAllMemberLimitPolicies: mocks.applyAllMemberLimitPolicies,
}));

// These are intentionally the real orchestration modules. Only their storage,
// provider, and business-operation boundaries above are replaced.
import { runFullDataSync } from "./full-sync";
import { runBackgroundCycleOperations } from "./ingest";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.query.mockImplementation(async (sql: string) => ({
    rows: [{ acquired: sql.includes("pg_try_advisory_lock") }],
  }));
  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.saveIngestCursor.mockResolvedValue(undefined);
  mocks.selectFullSyncSlice.mockResolvedValue({
    units: [],
    remaining: 0,
    remainingLiveCount: 0,
    remainingBackfillCount: 0,
  });
});

test("a successful full-data run never invokes alerts, allocation imports, drift, or limit policies", async () => {
  const result = await runFullDataSync();

  expect(result).toMatchObject({ outcome: "completed", stage: "done", acquired: true });
  expect(mocks.runCheck).not.toHaveBeenCalled();
  expect(mocks.refreshTeamBudgetSnapshot).not.toHaveBeenCalled();
  expect(mocks.reconcileTeamBudgetsUpstream).not.toHaveBeenCalled();
  expect(mocks.applyAllMemberLimitPolicies).not.toHaveBeenCalled();

  // Keep the real ingest business entry point linked in this test: if full
  // sync ever delegates to it, the mocked operation boundaries above expose it.
  expect(runBackgroundCycleOperations).toBeTypeOf("function");
});