import assert from "node:assert/strict";
import test from "node:test";

import {
  isCanonicalSummaryPending,
  isTotalSpendHeadlinePending,
  reconcileDashboardSpend,
} from "./dashboard-reconciliation.ts";

test("canonical summary cards always render settled values", () => {
  assert.equal(isCanonicalSummaryPending(true, undefined), false);
  assert.equal(isCanonicalSummaryPending(false, false), false);
  assert.equal(isCanonicalSummaryPending(false, true), false);
});

test("every syncStatus resolves cards immediately without waiting for isComplete", () => {
  // partial: data won't improve from further polling — show it now
  assert.equal(isCanonicalSummaryPending(false, false, "partial"), false);
  assert.equal(isCanonicalSummaryPending(true,  false, "partial"), false);
  // failed: retrySync is the recovery path — show what we have
  assert.equal(isCanonicalSummaryPending(false, false, "failed"), false);
  assert.equal(isCanonicalSummaryPending(true,  false, "failed"), false);
  // syncing remains settled too; polling is controlled independently.
  assert.equal(isCanonicalSummaryPending(false, false, "syncing"), false);
  assert.equal(isCanonicalSummaryPending(false, true,  "syncing"), false);
  assert.equal(isCanonicalSummaryPending(false, false, undefined), false);
  assert.equal(isCanonicalSummaryPending(false, false, null), false);
});

test("account headline never exposes a loading state", () => {
  assert.equal(isTotalSpendHeadlinePending({
    isLoading: false,
    isAccountWide: true,
    accountUsageTotalSpendUsd: 123,
    isComplete: false,
    syncStatus: "syncing",
  }), false);
  assert.equal(isTotalSpendHeadlinePending({
    isLoading: false,
    isAccountWide: true,
    accountUsageTotalSpendUsd: null,
    isComplete: true,
    syncStatus: "complete",
  }), false);
});

test("account rows plus reconciliation equal the unfiltered account anchor", () => {
  const result = reconcileDashboardSpend({
    isAccountWide: true,
    visibleRollupSpendUsd: 82,
    accountUsageTotalSpendUsd: 100,
    accountReconciliationSpendUsd: 18,
    projectSpendLoaded: true,
    unattributedProjectSpendUsd: 7,
  });

  assert.equal(result.residualSpendUsd, 18);
  assert.equal(result.totalSpendUsd, 100);
  assert.equal(result.isTotalLoaded, true);
});

test("an unavailable account anchor remains loading instead of rendering zero", () => {
  const result = reconcileDashboardSpend({
    isAccountWide: true,
    visibleRollupSpendUsd: 82,
    accountUsageTotalSpendUsd: null,
    accountReconciliationSpendUsd: null,
    projectSpendLoaded: true,
    unattributedProjectSpendUsd: 7,
  });

  assert.equal(result.residualSpendUsd, null);
  assert.equal(result.totalSpendUsd, 82);
  assert.equal(result.isTotalLoaded, false);
});

test("scoped dashboards expose project residual without double counting it", () => {
  const result = reconcileDashboardSpend({
    isAccountWide: false,
    visibleRollupSpendUsd: 50,
    accountUsageTotalSpendUsd: null,
    accountReconciliationSpendUsd: null,
    projectSpendLoaded: true,
    unattributedProjectSpendUsd: 3,
  });

  assert.equal(result.residualSpendUsd, 3);
  assert.equal(result.totalSpendUsd, 50);
  assert.equal(result.isTotalLoaded, true);
});