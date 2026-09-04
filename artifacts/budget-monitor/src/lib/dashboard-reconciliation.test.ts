// @ts-nocheck
import { test, expect } from "vitest";

import {
  isCanonicalSummaryPending,
  isTotalSpendHeadlinePending,
  reconcileDashboardSpend,
} from "./dashboard-reconciliation.ts";

test("canonical summary cards always render settled values", () => {
  expect(isCanonicalSummaryPending(true, undefined)).toBe(false);
  expect(isCanonicalSummaryPending(false, false)).toBe(false);
  expect(isCanonicalSummaryPending(false, true)).toBe(false);
});

test("every syncStatus resolves cards immediately without waiting for isComplete", () => {
  // partial: data won't improve from further polling — show it now
  expect(isCanonicalSummaryPending(false, false, "partial")).toBe(false);
  expect(isCanonicalSummaryPending(true,  false, "partial")).toBe(false);
  // failed: retrySync is the recovery path — show what we have
  expect(isCanonicalSummaryPending(false, false, "failed")).toBe(false);
  expect(isCanonicalSummaryPending(true,  false, "failed")).toBe(false);
  // syncing remains settled too; polling is controlled independently.
  expect(isCanonicalSummaryPending(false, false, "syncing")).toBe(false);
  expect(isCanonicalSummaryPending(false, true,  "syncing")).toBe(false);
  expect(isCanonicalSummaryPending(false, false, undefined)).toBe(false);
  expect(isCanonicalSummaryPending(false, false, null)).toBe(false);
});

test("account headline never exposes a loading state", () => {
  expect(isTotalSpendHeadlinePending({
    isLoading: false,
    isAccountWide: true,
    accountUsageTotalSpendUsd: 123,
    isComplete: false,
    syncStatus: "syncing",
  })).toBe(false);
  expect(isTotalSpendHeadlinePending({
    isLoading: false,
    isAccountWide: true,
    accountUsageTotalSpendUsd: null,
    isComplete: true,
    syncStatus: "complete",
  })).toBe(false);
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

  expect(result.residualSpendUsd).toBe(18);
  expect(result.totalSpendUsd).toBe(100);
  expect(result.isTotalLoaded).toBe(true);
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

  expect(result.residualSpendUsd).toBe(null);
  expect(result.totalSpendUsd).toBe(82);
  expect(result.isTotalLoaded).toBe(false);
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

  expect(result.residualSpendUsd).toBe(3);
  expect(result.totalSpendUsd).toBe(50);
  expect(result.isTotalLoaded).toBe(true);
});

test("internal spend accounting reconciles mixed and zero-exclusion ranges", () => {
  const mixed = { gross: 125, excluded: 25, eligible: 100 };
  expect(mixed.gross - mixed.excluded).toBe(mixed.eligible);

  const noInternal = { gross: 80, excluded: 0, eligible: 80 };
  expect(noInternal.gross - noInternal.excluded).toBe(noInternal.eligible);
});