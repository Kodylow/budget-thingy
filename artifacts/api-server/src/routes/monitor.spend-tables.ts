import { Router, type IRouter } from "express";
import {
  ListSpendGroupsQueryParams,
  ListSpendGroupsResponse,
  ListSpendPeopleQueryParams,
  ListSpendPeopleResponse,
  ListSpendPoolsQueryParams,
  ListSpendPoolsResponse,
  ListSpendProjectsQueryParams,
  ListSpendProjectsResponse,
  ExportSpendPoolsCsvQueryParams,
  ExportSpendGroupsCsvQueryParams,
  ExportSpendPeopleCsvQueryParams,
  ExportSpendProjectsTableCsvQueryParams,
} from "@workspace/api-zod";
import {
  buildScopedAccounting,
  rowsForView,
  type SpendRow,
  type TableView,
} from "../services/scoped-accounting";
import type { Authorization } from "../lib/authz";
import { escapeCsvCell } from "./monitor.shared";

const router: IRouter = Router();
const cacheByView = new Map<TableView, Map<string, {
  expiresAt: number;
  promise: Promise<unknown>;
}>>([
  ["pools", new Map()],
  ["groups", new Map()],
  ["people", new Map()],
  ["projects", new Map()],
]);
const CACHE_MS = 30_000;

function compareRows(sort: string, a: SpendRow, b: SpendRow): number {
  if (sort === "spend_asc") return a.spendUsd - b.spendUsd || a.name.localeCompare(b.name);
  if (sort === "name_asc") return a.name.localeCompare(b.name);
  if (sort === "name_desc") return b.name.localeCompare(a.name);
  if (sort === "status") {
    const rank: Record<string, number> = {
      over: 0, attention: 1, unavailable: 2, shared: 3, no_allocation: 4,
      unbudgeted: 4, budgeted: 5, explicit: 5, inherited: 6, no_limit: 7,
    };
    return (rank[a.status] ?? 8) - (rank[b.status] ?? 8) ||
      b.spendUsd - a.spendUsd || a.name.localeCompare(b.name);
  }
  return b.spendUsd - a.spendUsd || a.name.localeCompare(b.name);
}

export function matchesSpendStatus(row: SpendRow, status: string): boolean {
  if (status === "all") return true;
  if (status === "budgeted") return row.allocationUsd !== null;
  if (status === "unbudgeted") return row.allocationUsd === null;
  return row.status === status || row.limitState === status;
}

export function authorizeSpendView(authz: Authorization, view: TableView): boolean {
  return !(
    (view === "pools" || view === "groups") &&
    authz.roles.every((role) => role === "member")
  );
}

export function filterAndSortSpendRows(
  allRows: readonly SpendRow[],
  query: Record<string, unknown>,
): SpendRow[] {
  const search = String(query["search"] ?? "").trim().toLocaleLowerCase();
  const status = String(query["status"] ?? "all");
  const filtered = allRows.filter((row) =>
    (!search || [
      row.name, row.workspaceName ?? "", row.ownerName ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(search))) &&
    matchesSpendStatus(row, status));
  filtered.sort((a, b) => compareRows(String(query["sort"] ?? "status"), a, b));
  return filtered;
}

export async function buildSpendTablePayload(
  authz: Authorization,
  view: TableView,
  query: Record<string, unknown>,
) {
  const result = await buildScopedAccounting(authz, query, view);
  const allRows = rowsForView(result, view);
  const filtered = filterAndSortSpendRows(allRows, query);
  const page = Number(query["page"] ?? 1);
  const pageSize = Number(query["pageSize"] ?? 25);
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const statuses: Record<string, number> = {};
  const workspaces = new Map<string, { id: string; name: string; count: number }>();
  for (const row of allRows) {
    statuses[row.status] = (statuses[row.status] ?? 0) + 1;
    if (row.workspaceId) {
      const current = workspaces.get(row.workspaceId) ?? {
        id: row.workspaceId,
        name: row.workspaceName ?? row.workspaceId,
        count: 0,
      };
      current.count += 1;
      workspaces.set(row.workspaceId, current);
    }
  }
  const allocationUsd = view === "pools"
    ? filtered.reduce((sum, row) => sum + (row.allocationUsd ?? 0), 0)
    : 0;
  return {
    view, scope: result.scope, period: result.period, rows, page, pageSize,
    totalRows: allRows.length, filteredRows: filtered.length,
    totals: {
      spendUsd: filtered.reduce((sum, row) => sum + row.spendUsd, 0),
      agentSpendUsd: filtered.reduce((sum, row) => sum + row.agentSpendUsd, 0),
      otherServicesUsd: filtered.reduce((sum, row) => sum + row.otherServicesUsd, 0),
      allocationUsd,
      internalExcludedUsd: result.accounting.internalExcludedUsd,
      unbudgetedUsd: result.accounting.unbudgetedUsd,
      unattributedUsd: result.accounting.unattributedUsd,
      reconciliationUsd: result.accounting.reconciliationUsd,
    },
    facets: {
      statuses,
      workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    metadata: result.metadata,
    filteredAllRows: filtered,
  };
}

function mount(
  path: string,
  view: TableView,
  querySchema: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { message: string } } },
  responseSchema: { parse(value: unknown): unknown },
): void {
  router.get(path, async (req, res): Promise<void> => {
    if (!authorizeSpendView(req.authz!, view)) {
      res.status(403).json({ error: `The ${view} view is outside your authorized scope` });
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error?.message ?? "Invalid table query" });
      return;
    }
    try {
      const query = parsed.data as Record<string, unknown>;
      const key = JSON.stringify([
        req.authz!.userId, req.authz!.roles, req.authz!.workspaceIds,
        req.authz!.groupIds, req.authz!.managedGroupIds,
        req.authz!.groupUserIds, req.authz!.userIds, req.authz!.isPreview, query,
      ]);
      const viewCache = cacheByView.get(view)!;
      const cached = viewCache.get(key);
      let promise: Promise<unknown>;
      if (cached && cached.expiresAt > Date.now()) {
        promise = cached.promise;
      } else {
        promise = buildSpendTablePayload(req.authz!, view, query);
        viewCache.set(key, { expiresAt: Date.now() + CACHE_MS, promise });
        void promise.catch(() => viewCache.delete(key));
      }
      res.json(responseSchema.parse(await promise));
    } catch (error) {
      req.log.error({ err: error, view }, "spend table stored accounting failed");
      res.status(503).json({ error: "Spend details unavailable" });
    }
  });
}

export function serializeSpendCsv(rows: readonly SpendRow[]): string {
  const header = [
    "qualified_id", "kind", "name", "workspace_id", "workspace",
    "spend_usd", "agent_spend_usd", "other_services_usd",
    "allocation_or_limit_usd", "remaining_usd", "percent_used",
    "status", "limit_state", "limit_observation_status", "shared_pool", "member_count", "owner",
  ];
  const lines = rows.map((row) => [
    row.id, row.kind, row.name, row.workspaceId ?? "", row.workspaceName ?? "",
    row.spendUsd, row.agentSpendUsd, row.otherServicesUsd,
    row.allocationUsd ?? "", row.remainingUsd ?? "", row.percentUsed ?? "",
    row.status, row.limitState, row.limitObservationStatus,
    row.sharedPool, row.memberCount ?? "", row.ownerName ?? "",
  ].map(escapeCsvCell).join(","));
  return [header.map(escapeCsvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

function mountCsv(
  path: string,
  view: TableView,
  querySchema: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { message: string } } },
): void {
  router.get(path, async (req, res): Promise<void> => {
    if (!authorizeSpendView(req.authz!, view)) {
      res.status(403).json({ error: `The ${view} export is outside your authorized scope` });
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error?.message ?? "Invalid export query" });
      return;
    }
    try {
      const payload = await buildSpendTablePayload(
        req.authz!,
        view,
        parsed.data as Record<string, unknown>,
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="spend-${view}.csv"`);
      res.setHeader("X-Filtered-Rows", String(payload.filteredRows));
      res.setHeader("X-Total-Spend-Usd", String(payload.totals.spendUsd));
      res.setHeader("X-Generation-Id", payload.metadata.generationId);
      res.setHeader(
        "X-Usage-Range",
        `${payload.period.start}/${payload.period.endExclusive}`,
      );
      res.send(serializeSpendCsv(payload.filteredAllRows));
    } catch (error) {
      req.log.error({ err: error, view }, "spend CSV stored accounting failed");
      res.status(503).json({ error: "Spend export unavailable" });
    }
  });
}

mount("/spend/pools", "pools", ListSpendPoolsQueryParams, ListSpendPoolsResponse);
mount("/spend/groups", "groups", ListSpendGroupsQueryParams, ListSpendGroupsResponse);
mount("/spend/people", "people", ListSpendPeopleQueryParams, ListSpendPeopleResponse);
mount("/spend/projects", "projects", ListSpendProjectsQueryParams, ListSpendProjectsResponse);
mountCsv("/spend/pools.csv", "pools", ExportSpendPoolsCsvQueryParams);
mountCsv("/spend/groups.csv", "groups", ExportSpendGroupsCsvQueryParams);
mountCsv("/spend/people.csv", "people", ExportSpendPeopleCsvQueryParams);
mountCsv("/spend/projects.csv", "projects", ExportSpendProjectsTableCsvQueryParams);

export default router;