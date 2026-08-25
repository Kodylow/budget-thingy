import assert from "node:assert/strict";
import test from "node:test";

import {
  isCanonicalSummaryPending,
  reconcileDashboardSpend,
} from "./dashboard-reconciliation.ts";

test("canonical summary cards stay loading during cold and partial responses", () => {
  assert.equal(isCanonicalSummaryPending(true, undefined), true);
  assert.equal(isCanonicalSummaryPending(false, false), true);
  assert.equal(isCanonicalSummaryPending(false, true), false);
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

test("scoped dashboards retain only their project residual accounting", () => {
  const result = reconcileDashboardSpend({
    isAccountWide: false,
    visibleRollupSpendUsd: 50,
    accountUsageTotalSpendUsd: null,
    accountReconciliationSpendUsd: null,
    projectSpendLoaded: true,
    unattributedProjectSpendUsd: 3,
  });

  assert.equal(result.residualSpendUsd, 3);
  assert.equal(result.totalSpendUsd, 53);
  assert.equal(result.isTotalLoaded, true);
});