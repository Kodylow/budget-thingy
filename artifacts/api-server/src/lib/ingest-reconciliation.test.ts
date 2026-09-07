// @ts-nocheck
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { pool } from "@workspace/db";
import {
  reconcileSlice,
  reconcileWorkspaceTotal,
} from "./ingest-reconcile.ts";

const workspaceId = `reconcile-${crypto.randomUUID()}`;
const monthStart = "2099-08-01";
const slicePrefix = `slice-${crypto.randomUUID()}`;
const suiteStartedAt = new Date();
const today = new Date().toISOString().slice(0, 10);
const currentMonth = `${today.slice(0, 7)}-01`;

async function cleanup(): Promise<void> {
  await pool.query(
    "delete from ingest_reconciliation where scope='workspace' and scope_id=$1",
    [workspaceId],
  );
  await pool.query(
    "delete from usage_workspace_day where workspace_id=$1",
    [workspaceId],
  );
}

beforeAll(cleanup);
afterAll(cleanup);

async function cleanupSlices(): Promise<void> {
  await pool.query("delete from ingest_cursor where stage='reconciliation'");
  await pool.query(
    `delete from ingest_reconciliation
     where scope_id like $1 or
       (scope='account' and scope_id='enterprise' and checked_at >= $2)`,
    [`${slicePrefix}%`, suiteStartedAt],
  );
  await pool.query(
    `delete from usage_account_observation
     where fetched_at >= $1 and billing_period_start >= '2026-05-01'::date`,
    [suiteStartedAt],
  );
}

beforeEach(cleanupSlices);
afterEach(cleanupSlices);

function totalFetcher(
  total: (workspaceId: string | undefined) => number,
  seen: Array<string | undefined>,
) {
  return async (
    startTime: string,
    endTime: string,
    fetchedWorkspaceId: string | undefined,
    stats: { calls: number },
  ) => {
    stats.calls += 1;
    seen.push(fetchedWorkspaceId);
    return {
      totalCostUsd: total(fetchedWorkspaceId),
      intervalStart: startTime,
      intervalEnd: endTime,
    };
  };
}

test("only compared days become stale after two consecutive mismatches", async () => {
  await pool.query(
    `insert into usage_workspace_day
       (workspace_id,usage_date,total_cost_usd,member_attributable_usd,
        member_unattributable_usd,metrics_json,fetched_at,status,error)
     values
       ($1,'2099-07-31'::date,5,5,0,'[]'::jsonb,now(),'complete',null),
       ($1,'2099-08-01'::date,10,10,0,'[]'::jsonb,now(),'complete',null),
       ($1,'2099-08-02'::date,20,20,0,'[]'::jsonb,now(),'complete',null),
       ($1,'2099-08-03'::date,40,40,0,'[]'::jsonb,now(),'complete',null)`,
    [workspaceId],
  );
  const comparison = {
    monthStart,
    effectiveStart: "2099-08-01",
    effectiveEnd: "2099-08-03",
    workspaceId,
    upstreamUsd: 50,
  };

  const first = await reconcileWorkspaceTotal(comparison);
  expect(first).toMatchObject({ storedUsd: 30, deltaUsd: 20, mismatchCount: 1 });
  expect(
    (await pool.query(
      `select usage_date::text,status from usage_workspace_day
       where workspace_id=$1 order by usage_date`,
      [workspaceId],
    )).rows,
  ).toEqual([
    { usage_date: "2099-07-31", status: "complete" },
    { usage_date: "2099-08-01", status: "complete" },
    { usage_date: "2099-08-02", status: "complete" },
    { usage_date: "2099-08-03", status: "complete" },
  ]);

  const second = await reconcileWorkspaceTotal(comparison);
  expect(second.mismatchCount).toBe(2);
  expect(
    (await pool.query(
      `select usage_date::text,status from usage_workspace_day
       where workspace_id=$1 order by usage_date`,
      [workspaceId],
    )).rows,
  ).toEqual([
    { usage_date: "2099-07-31", status: "complete" },
    { usage_date: "2099-08-01", status: "stale" },
    { usage_date: "2099-08-02", status: "stale" },
    { usage_date: "2099-08-03", status: "complete" },
  ]);

  const recovered = await reconcileWorkspaceTotal({
    ...comparison,
    upstreamUsd: 30.5,
  });
  expect(recovered.mismatchCount).toBe(0);
});

test("a failed first unit remains retryable on the next slice", async () => {
  let accountAttempts = 0;
  const fetchTotal = async (
    startTime: string,
    endTime: string,
    fetchedWorkspaceId: string | undefined,
    stats: { calls: number },
  ) => {
    stats.calls += 1;
    if (fetchedWorkspaceId === undefined && ++accountAttempts === 1) {
      throw new Error("isolated provider failure");
    }
    return {
      totalCostUsd: 0,
      intervalStart: startTime,
      intervalEnd: endTime,
    };
  };

  const first = await reconcileSlice([], today, fetchTotal);
  expect(first.attempted).toBeLessThanOrEqual(8);
  expect(first.failed).toBe(1);
  expect(first.remaining).toBeGreaterThan(0);

  const second = await reconcileSlice([], today, fetchTotal);
  expect(second.attempted).toBeLessThanOrEqual(8);
  expect(second.failed).toBe(0);
  expect(accountAttempts).toBeGreaterThanOrEqual(2);
  expect(second.reconciliations).toContainEqual(
    expect.objectContaining({ monthStart: currentMonth, scope: "account" }),
  );
});

test("bounded fair slices advance beyond a permanently failing early unit", async () => {
  const workspaceIds = Array.from(
    { length: 10 },
    (_, index) => `${slicePrefix}-fair-${String(index).padStart(2, "0")}`,
  );
  const seen: Array<string | undefined> = [];
  const fetchTotal = async (
    startTime: string,
    endTime: string,
    fetchedWorkspaceId: string | undefined,
    stats: { calls: number },
  ) => {
    stats.calls += 1;
    seen.push(fetchedWorkspaceId);
    if (fetchedWorkspaceId === undefined) throw new Error("permanent account failure");
    return {
      totalCostUsd: 0,
      intervalStart: startTime,
      intervalEnd: endTime,
    };
  };

  const first = await reconcileSlice(workspaceIds, today, fetchTotal);
  const firstSeen = new Set(seen.filter(Boolean));
  seen.length = 0;
  const second = await reconcileSlice(workspaceIds, today, fetchTotal);
  const secondSeen = new Set(seen.filter(Boolean));

  expect(first.attempted).toBeLessThanOrEqual(8);
  expect(second.attempted).toBeLessThanOrEqual(8);
  expect(first.remaining).toBeGreaterThan(0);
  expect(second.remaining).toBeGreaterThan(0);
  expect([...secondSeen].some((id) => !firstSeen.has(id))).toBe(true);
});

test("a one-unit time slice durably alternates current and older work", async () => {
  let clock = 0;
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const starts: string[] = [];
  const fetchTotal = async (
    startTime: string,
    endTime: string,
    _workspaceId: string | undefined,
    stats: { calls: number },
  ) => {
    stats.calls += 1;
    starts.push(startTime);
    clock += 46_000;
    return {
      totalCostUsd: 0,
      intervalStart: startTime,
      intervalEnd: endTime,
    };
  };

  try {
    const first = await reconcileSlice([], today, fetchTotal);
    const second = await reconcileSlice([], today, fetchTotal);
    expect(first.attempted).toBe(1);
    expect(second.attempted).toBe(1);
    expect(starts[0]).toBe(`${currentMonth}T00:00:00.000Z`);
    expect(starts[1]).not.toBe(`${currentMonth}T00:00:00.000Z`);
  } finally {
    now.mockRestore();
  }
});

test("same-day successes do not repeat mismatches but next-day late charges do", async () => {
  const lateWorkspaceId = `${slicePrefix}-late`;
  const first = await reconcileSlice(
    [lateWorkspaceId],
    today,
    totalFetcher((id) => id === lateWorkspaceId ? 2 : 0, []),
  );
  expect(first.reconciliations).toContainEqual(expect.objectContaining({
    monthStart: currentMonth,
    scopeId: lateWorkspaceId,
    mismatchCount: 1,
  }));

  const sameDay = await reconcileSlice(
    [lateWorkspaceId],
    today,
    totalFetcher((id) => id === lateWorkspaceId ? 3 : 0, []),
  );
  expect(sameDay.reconciliations).not.toContainEqual(expect.objectContaining({
    monthStart: currentMonth,
    scopeId: lateWorkspaceId,
  }));
  expect(
    (await pool.query(
      `select mismatch_count from ingest_reconciliation
       where month_start=$1::date and scope='workspace' and scope_id=$2`,
      [currentMonth, lateWorkspaceId],
    )).rows[0]?.mismatch_count,
  ).toBe(1);

  const tomorrow = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000)
    .toISOString().slice(0, 10);
  const nextDay = await reconcileSlice(
    [lateWorkspaceId],
    tomorrow,
    totalFetcher((id) => id === lateWorkspaceId ? 3 : 0, []),
  );
  expect(nextDay.reconciliations).toContainEqual(expect.objectContaining({
    monthStart: currentMonth,
    scopeId: lateWorkspaceId,
    mismatchCount: 2,
  }));
});