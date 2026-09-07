import { beforeEach, expect, test, vi } from "vitest";

const { pglite } = await vi.hoisted(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  return { pglite: new PGlite() };
});

vi.mock("@workspace/db", () => ({
  pool: {
    query: (text: string, values?: unknown[]) => pglite.query(text, values),
    connect: async () => ({
      query: (text: string, values?: unknown[]) => pglite.query(text, values),
      release: () => undefined,
    }),
  },
}));

import {
  saveIngestCursor,
  selectFullSyncSlice,
  unitKey,
} from "./ingest-selection";
import { remainingReconciliationCount } from "./ingest-reconcile";

const TODAY = "2026-05-25";
const FRESH_AFTER = new Date("2026-05-25T12:00:00.000Z");

beforeEach(async () => {
  await pglite.exec(`
    drop table if exists ingest_reconciliation, ingest_cursor, ingest_run,
      usage_workspace_day, usage_account_day cascade;
    create table usage_workspace_day (
      workspace_id text not null,
      usage_date date not null,
      total_cost_usd double precision not null default 0,
      member_attributable_usd double precision not null default 0,
      member_unattributable_usd double precision not null default 0,
      metrics_json jsonb not null default '[]'::jsonb,
      fetched_at timestamptz not null,
      status text not null,
      error text,
      primary key (workspace_id,usage_date)
    );
    create table usage_account_day (
      usage_date date primary key,
      total_cost_usd double precision not null default 0,
      fetched_at timestamptz not null
    );
    create table ingest_run (
      id serial primary key,
      kind text not null,
      started_at timestamptz not null,
      finished_at timestamptz,
      units integer not null default 0,
      calls integer not null default 0,
      failures integer not null default 0,
      error text,
      remaining integer
    );
    create table ingest_cursor (
      stage text primary key,
      cursor text not null,
      updated_at timestamptz not null default now()
    );
    create table ingest_reconciliation (
      month_start date not null,
      scope text not null,
      scope_id text not null,
      upstream_usd double precision not null,
      stored_usd double precision not null,
      delta_usd double precision not null,
      mismatch_count integer not null default 0,
      checked_at timestamptz not null,
      primary key (month_start,scope,scope_id)
    );
  `);
});

test("full selection uniquely counts missing, stale, failed, and stale-live units", async () => {
  await pglite.query(
    `insert into usage_workspace_day
       (workspace_id,usage_date,fetched_at,status)
     values
       ('ws','2026-05-20','2026-05-25T13:00:00Z','complete'),
       ('ws','2026-05-21','2026-05-25T13:00:00Z','stale'),
       ('ws','2026-05-23','2026-05-25T13:00:00Z','complete'),
       ('ws','2026-05-24','2026-05-25T13:00:00Z','failed')`,
  );
  await pglite.query(
    `insert into usage_account_day(usage_date,fetched_at)
     values
       ('2026-05-20','2026-05-25T13:00:00Z'),
       ('2026-05-21','2026-05-25T13:00:00Z'),
       ('2026-05-22','2026-05-25T13:00:00Z'),
       ('2026-05-24','2026-05-25T11:00:00Z'),
       ('2026-05-25','2026-05-25T13:00:00Z')`,
  );

  const result = await selectFullSyncSlice(
    ["ws", "ws"],
    TODAY,
    FRESH_AFTER,
    20,
  );

  expect(result).toMatchObject({
    remaining: 6,
    remainingLiveCount: 4,
    remainingBackfillCount: 2,
  });
  expect(result.units.map(unitKey).sort()).toEqual([
    "2026-05-21|ws",
    "2026-05-22|ws",
    "2026-05-23|",
    "2026-05-24|",
    "2026-05-24|ws",
    "2026-05-25|ws",
  ]);
  expect(new Set(result.units.map(unitKey)).size).toBe(result.units.length);
});

test("durable failures are unique and retire behind a newer fetched success", async () => {
  const usageDate = "2026-05-20";
  const freshAfter = new Date("2026-05-20T12:00:00.000Z");
  await pglite.query(
    `insert into usage_workspace_day
       (workspace_id,usage_date,fetched_at,status)
     values ('ws',$1::date,'2026-05-20T12:30:00Z','complete')`,
    [usageDate],
  );
  await pglite.query(
    `insert into usage_account_day(usage_date,fetched_at)
     values ($1::date,'2026-05-20T12:30:00Z')`,
    [usageDate],
  );
  await pglite.query(
    `insert into ingest_run(kind,started_at,finished_at,error)
     values ('full-sync','2026-05-20T12:59:00Z','2026-05-20T13:00:00Z',$1)`,
    [`failed-units:${usageDate}|ws\n${usageDate}|ws\n${usageDate}|`],
  );

  const failed = await selectFullSyncSlice(["ws"], usageDate, freshAfter, 10);
  expect(failed.remaining).toBe(2);
  expect(failed.units.map(unitKey).sort()).toEqual([
    `${usageDate}|`,
    `${usageDate}|ws`,
  ]);

  await pglite.query(
    `update usage_workspace_day set fetched_at='2026-05-20T13:01:00Z'
     where workspace_id='ws' and usage_date=$1::date`,
    [usageDate],
  );
  await pglite.query(
    `update usage_account_day set fetched_at='2026-05-20T13:01:00Z'
     where usage_date=$1::date`,
    [usageDate],
  );
  const retired = await selectFullSyncSlice(["ws"], usageDate, freshAfter, 10);
  expect(retired).toMatchObject({
    units: [],
    remaining: 0,
    remainingLiveCount: 0,
    remainingBackfillCount: 0,
  });
});

test("full selection is SQL-bounded and rotates on the full-sync cursor", async () => {
  const first = await selectFullSyncSlice(["ws"], TODAY, FRESH_AFTER, 2);
  expect(first.units).toHaveLength(2);
  expect(first.remaining).toBe(12);
  expect(first.remainingLiveCount).toBe(6);
  expect(first.remainingBackfillCount).toBe(6);

  await saveIngestCursor("full-sync", unitKey(first.units.at(-1)!));
  const second = await selectFullSyncSlice(["ws"], TODAY, FRESH_AFTER, 2);
  expect(second.units).toHaveLength(2);
  expect(second.remaining).toBe(12);
  expect(second.units.map(unitKey)).not.toEqual(first.units.map(unitKey));
  expect(new Set([...first.units, ...second.units].map(unitKey)).size).toBe(4);
});

test("changed-fact reconciliation includes historical facts but excludes live tail", async () => {
  await pglite.query(
    `insert into ingest_reconciliation
       (month_start,scope,scope_id,upstream_usd,stored_usd,delta_usd,checked_at)
     values
       ('2026-05-01','account','enterprise',0,0,0,'2026-06-10T10:00:00Z'),
       ('2026-05-01','workspace','ws',0,0,0,'2026-06-10T10:00:00Z'),
       ('2026-06-01','account','enterprise',0,0,0,'2026-06-10T10:00:00Z'),
       ('2026-06-01','workspace','ws',0,0,0,'2026-06-10T10:00:00Z')`,
  );
  await pglite.query(
    `insert into usage_account_day(usage_date,fetched_at)
     values
       ('2026-05-25','2026-06-10T11:00:00Z'),
       ('2026-06-09','2026-06-10T11:00:00Z')`,
  );
  await pglite.query(
    `insert into usage_workspace_day
       (workspace_id,usage_date,fetched_at,status)
     values
       ('ws','2026-06-07','2026-06-10T11:00:00Z','complete'),
       ('ws','2026-06-09','2026-06-10T11:00:00Z','complete')`,
  );

  expect(await remainingReconciliationCount(["ws"], "2026-06-10")).toBe(0);
  expect(
    await remainingReconciliationCount(["ws"], "2026-06-10", true),
  ).toBe(2);
});