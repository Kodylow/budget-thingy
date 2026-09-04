import { sql } from "drizzle-orm";
import {
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const usageMemberDayTable = pgTable(
  "usage_member_day",
  {
    workspaceId: text("workspace_id").notNull(),
    usageDate: date("usage_date", { mode: "string" }).notNull(),
    userId: text("user_id").notNull(),
    totalCostUsd: doublePrecision("total_cost_usd").notNull(),
    aiCostUsd: doublePrecision("ai_cost_usd").notNull(),
    metricsJson: jsonb("metrics_json").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.usageDate, t.userId] }),
    index("usage_member_day_usage_date_idx").on(t.usageDate),
  ],
);

export const usageProjectDayTable = pgTable(
  "usage_project_day",
  {
    workspaceId: text("workspace_id").notNull(),
    usageDate: date("usage_date", { mode: "string" }).notNull(),
    projectId: text("project_id").notNull(),
    totalCostUsd: doublePrecision("total_cost_usd").notNull(),
    metricsJson: jsonb("metrics_json").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.usageDate, t.projectId] })],
);

export const usageWorkspaceDayTable = pgTable(
  "usage_workspace_day",
  {
    workspaceId: text("workspace_id").notNull(),
    usageDate: date("usage_date", { mode: "string" }).notNull(),
    totalCostUsd: doublePrecision("total_cost_usd").notNull(),
    memberAttributableUsd: doublePrecision("member_attributable_usd").notNull(),
    memberUnattributableUsd: doublePrecision(
      "member_unattributable_usd",
    ).notNull(),
    metricsJson: jsonb("metrics_json").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    error: text("error"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.usageDate] }),
    check(
      "usage_workspace_day_status_check",
      sql`${t.status} in ('complete', 'failed')`,
    ),
  ],
);

export const usageAccountDayTable = pgTable("usage_account_day", {
  usageDate: date("usage_date", { mode: "string" }).primaryKey(),
  totalCostUsd: doublePrecision("total_cost_usd").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const ingestRunTable = pgTable(
  "ingest_run",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    units: integer("units").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    check(
      "ingest_run_kind_check",
      sql`${t.kind} in ('live', 'backfill', 'reconcile')`,
    ),
  ],
);

export const ingestReconciliationTable = pgTable(
  "ingest_reconciliation",
  {
    monthStart: date("month_start", { mode: "string" }).notNull(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    upstreamUsd: doublePrecision("upstream_usd").notNull(),
    storedUsd: doublePrecision("stored_usd").notNull(),
    deltaUsd: doublePrecision("delta_usd").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.monthStart, t.scope, t.scopeId] })],
);

export type UsageMemberDay = typeof usageMemberDayTable.$inferSelect;
export type UsageProjectDay = typeof usageProjectDayTable.$inferSelect;
export type UsageWorkspaceDay = typeof usageWorkspaceDayTable.$inferSelect;
export type UsageAccountDay = typeof usageAccountDayTable.$inferSelect;
export type IngestRun = typeof ingestRunTable.$inferSelect;
export type IngestReconciliation =
  typeof ingestReconciliationTable.$inferSelect;
