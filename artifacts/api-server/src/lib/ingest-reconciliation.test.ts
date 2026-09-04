// @ts-nocheck
import { afterAll, beforeAll, expect, test } from "vitest";

import { pool } from "@workspace/db";
import { reconcileWorkspaceTotal } from "./ingest.ts";

const workspaceId = `reconcile-${crypto.randomUUID()}`;
const monthStart = "2099-08-01";

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