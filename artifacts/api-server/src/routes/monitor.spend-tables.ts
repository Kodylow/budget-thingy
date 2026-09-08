import { Router, type IRouter, type Request, type Response } from "express";
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
  buildProjectIntelligence,
  personalProjectCatalog,
  prepareScopedAccounting,
  rowsForView,
  type SpendRow,
  type SpendPersonWorkspace,
  type TableView,
} from "../services/scoped-accounting";
import type { Authorization } from "../lib/authz";
import { UsageWindowError } from "../lib/usage-window";
import { escapeCsvCell, windowFromQuery } from "./monitor.shared";

const router: IRouter = Router();

function compareRows(sort: string, a: SpendRow, b: SpendRow): number {
  if (sort === "updated_at_asc" || sort === "updated_at_desc") {
    const aTime = a.updatedAt == null ? null : Date.parse(a.updatedAt);
    const bTime = b.updatedAt == null ? null : Date.parse(b.updatedAt);
    if (aTime === null && bTime !== null) return 1;
    if (aTime !== null && bTime === null) return -1;
    if (aTime !== null && bTime !== null && aTime !== bTime) {
      return sort === "updated_at_asc" ? aTime - bTime : bTime - aTime;
    }
    return a.name.localeCompare(b.name) ||
      (a.workspaceId ?? "").localeCompare(b.workspaceId ?? "") ||
      a.id.localeCompare(b.id);
  }
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

function personWorkspace(row: SpendRow): SpendPersonWorkspace {
  return {
    workspaceId: row.workspaceId!,
    workspaceName: row.workspaceName,
    spendUsd: row.spendUsd,
    agentSpendUsd: row.agentSpendUsd,
    otherServicesUsd: row.otherServicesUsd,
    allocationUsd: row.allocationUsd,
    remainingUsd: row.remainingUsd,
    percentUsed: row.percentUsed,
    currentCycleAgentSpendUsd: row.currentCycleAgentSpendUsd ?? null,
    currentCycleRemainingUsd: row.currentCycleRemainingUsd ?? null,
    currentCyclePercentUsed: row.currentCyclePercentUsed ?? null,
    limitState: row.limitState!,
    limitObservationStatus: row.limitObservationStatus,
    usageObserved: row.usageObserved,
  };
}

export function projectPeopleRows(rows: readonly SpendRow[]): SpendRow[] {
  const grouped = new Map<string, SpendRow[]>();
  for (const row of rows) {
    const userId = row.userId;
    if (!userId || row.workspaceId === null) continue;
    const current = grouped.get(userId) ?? [];
    current.push(row);
    grouped.set(userId, current);
  }
  return [...grouped.entries()].map(([userId, memberships]) => {
    memberships.sort((a, b) =>
      (a.workspaceName ?? a.workspaceId!).localeCompare(
        b.workspaceName ?? b.workspaceId!));
    const first = memberships[0]!;
    const workspaces = memberships.map(personWorkspace);
    if (memberships.length === 1) {
      return { ...first, id: `person:${userId}`, userId, workspaces };
    }
    const currentKnown = memberships.every(
      (row) => row.currentCycleAgentSpendUsd != null);
    return {
      ...first,
      id: `person:${userId}`,
      userId,
      workspaceId: null,
      workspaceName: memberships
        .map((row) => row.workspaceName ?? row.workspaceId!)
        .join(", "),
      spendUsd: memberships.reduce((sum, row) => sum + row.spendUsd, 0),
      agentSpendUsd: memberships.reduce((sum, row) => sum + row.agentSpendUsd, 0),
      otherServicesUsd: memberships.reduce(
        (sum, row) => sum + row.otherServicesUsd, 0),
      allocationUsd: null,
      remainingUsd: null,
      percentUsed: null,
      currentCycleAgentSpendUsd: currentKnown
        ? memberships.reduce(
          (sum, row) => sum + row.currentCycleAgentSpendUsd!, 0)
        : null,
      currentCycleRemainingUsd: null,
      currentCyclePercentUsed: null,
      status: "per_workspace",
      limitState: "not_applicable",
      limitObservationStatus: "not_applicable",
      usageObserved: memberships.some((row) => row.usageObserved),
      workspaces,
    };
  });
}

export function matchesSpendStatus(row: SpendRow, status: string): boolean {
  if (status === "all") return true;
  if (status === "budgeted") return row.allocationUsd !== null;
  if (status === "unbudgeted") return row.allocationUsd === null;
  return row.status === status || row.limitState === status;
}

export function authorizeSpendView(authz: Authorization, view: TableView): boolean {
  if (view === "people" || view === "projects") {
    return true;
  }
  const isManager = authz.roles.some((role) =>
    role === "account" || role === "workspace_admin" || role === "team_admin");
  return view === "pools"
    ? isManager || authz.capabilities.canEditAllocations
    : isManager;
}

export function filterAndSortSpendRows(
  allRows: readonly SpendRow[],
  query: Record<string, unknown>,
): SpendRow[] {
  const search = String(query["search"] ?? "").trim().toLocaleLowerCase();
  const status = String(query["status"] ?? "all");
  const workspaceId = String(query["workspaceId"] ?? "");
  const deployedOnly = query["deployedOnly"] === true;
  const staleButSpending = query["staleButSpending"] === true;
  const filtered = allRows.filter((row) =>
    (!search || [
      row.name, row.workspaceName ?? "", row.ownerName ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(search))) &&
    (!workspaceId || row.workspaceId === workspaceId) &&
    (!deployedOnly || row.hasDeployment === true) &&
    (!staleButSpending || row.staleButSpending === true) &&
    matchesSpendStatus(row, status));
  filtered.sort((a, b) => compareRows(String(query["sort"] ?? "status"), a, b));
  return filtered;
}

export function pageSpendRows(
  rows: readonly SpendRow[],
  page: number,
  pageSize: number,
): SpendRow[] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

export async function buildSpendTablePayload(
  authz: Authorization,
  view: TableView,
  query: Record<string, unknown>,
  prepared?: Awaited<ReturnType<typeof prepareScopedAccounting>>,
  ownerId?: string,
) {
  const intelligence = view === "projects"
    ? await buildProjectIntelligence(authz, query, prepared)
    : null;
  const result = intelligence?.result ??
    await buildScopedAccounting(authz, query, view, prepared);
  const allRows = rowsForView(result, view).filter((row) =>
    ownerId === undefined || row.ownerId === ownerId);
  const workspaceId = String(query["workspaceId"] ?? "");
  const projectionRows = view === "people" && workspaceId
    ? allRows.filter((row) => row.workspaceId === workspaceId)
    : allRows;
  const rawFiltered = filterAndSortSpendRows(projectionRows, query);
  const filteredUserIds = view === "people"
    ? new Set(rawFiltered.map((row) => row.userId))
    : null;
  const presentedAllRows = view === "people"
    ? projectPeopleRows(projectionRows)
    : projectionRows;
  const filtered = view === "people"
    ? projectPeopleRows(projectionRows.filter(
      (row) => filteredUserIds!.has(row.userId)))
    : rawFiltered;
  filtered.sort((a, b) => compareRows(String(query["sort"] ?? "status"), a, b));
  const page = Number(query["page"] ?? 1);
  const pageSize = Number(query["pageSize"] ?? 25);
  const rows = pageSpendRows(filtered, page, pageSize);
  const statuses: Record<string, number> = {};
  const workspaces = new Map<string, { id: string; name: string; count: number }>();
  const statusPeople = new Map<string, Set<string>>();
  const workspacePeople = new Map<string, Set<string>>();
  for (const row of allRows) {
    if (view === "people" && row.userId) {
      const people = statusPeople.get(row.status) ?? new Set<string>();
      people.add(row.userId);
      statusPeople.set(row.status, people);
    } else {
      statuses[row.status] = (statuses[row.status] ?? 0) + 1;
    }
    if (row.workspaceId) {
      const current = workspaces.get(row.workspaceId) ?? {
        id: row.workspaceId,
        name: row.workspaceName ?? row.workspaceId,
        count: 0,
      };
      if (view === "people" && row.userId) {
        const people = workspacePeople.get(row.workspaceId) ?? new Set<string>();
        people.add(row.userId);
        workspacePeople.set(row.workspaceId, people);
      } else {
        current.count += 1;
      }
      workspaces.set(row.workspaceId, current);
    }
  }
  for (const [status, people] of statusPeople) statuses[status] = people.size;
  for (const [workspaceId, people] of workspacePeople) {
    workspaces.get(workspaceId)!.count = people.size;
  }
  const allocationUsd = view === "pools"
    ? filtered.reduce((sum, row) => sum + (row.allocationUsd ?? 0), 0)
    : 0;
  return {
    view, scope: result.scope, period: result.period, rows, page, pageSize,
    totalRows: presentedAllRows.length, filteredRows: filtered.length,
    totals: {
      spendUsd: filtered.reduce((sum, row) => sum + row.spendUsd, 0),
      agentSpendUsd: filtered.reduce((sum, row) => sum + row.agentSpendUsd, 0),
      otherServicesUsd: filtered.reduce((sum, row) => sum + row.otherServicesUsd, 0),
      allocationUsd,
      internalExcludedUsd: result.accounting.internalExcludedUsd,
      unbudgetedUsd: result.accounting.unbudgetedUsd,
      unattributedUsd: result.accounting.unattributedUsd,
      reconciliationUsd: result.accounting.reconciliationUsd,
      currentMonthSpendUsd: view === "projects" &&
          intelligence?.staleEvaluation.availability === "unavailable"
        ? null
        : filtered.reduce(
          (sum, row) => sum + (row.currentMonthSpendUsd ?? 0), 0),
    },
    facets: {
      statuses,
      workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    metadata: result.metadata,
    personalProjectCatalog: view === "projects"
      ? (() => {
        const catalog = personalProjectCatalog(
          result.usage.projectMetadata,
          result.usage.workspaceIds,
          result.authz,
        );
        if (!catalog) return undefined;
        const { projects: _projects, ...summary } = catalog;
        return summary;
      })()
      : undefined,
    staleEvaluation: intelligence?.staleEvaluation,
    filteredAllRows: view === "people" ? rawFiltered : filtered,
  };
}

async function cachedSpendTablePayload(
  authz: Authorization,
  view: TableView,
  query: Record<string, unknown>,
  configuration?: Express.Request["configurationSnapshot"],
) {
  // Directory, effective authorization, reporting window, and persisted usage
  // generation are resolved before cache lookup. The same prepared context is
  // then reused by a miss, avoiding a second shared-directory read.
  const prepared = await prepareScopedAccounting(
    authz, query, view, configuration);
  return buildSpendTablePayload(authz, view, query, prepared);
}

function mount(
  path: string,
  view: TableView,
  querySchema: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { message: string } } },
  responseSchema: { parse(value: unknown): unknown },
): void {
  router.get(path, async (req, res): Promise<void> => {
    const startedAt = performance.now();
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
      windowFromQuery(parsed.data as Record<string, unknown>);
    } catch (error) {
      res.status(400).json({
        error: error instanceof UsageWindowError
          ? error.message
          : "Invalid reporting date range",
      });
      return;
    }
    try {
      const query = parsed.data as Record<string, unknown>;
      const payload = await cachedSpendTablePayload(
        req.authz!, view, query, req.configurationSnapshot);
      res.setHeader("Server-Timing", `spend;dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.json(responseSchema.parse(payload));
    } catch (error) {
      req.log.error({ err: error, view }, "spend table stored accounting failed");
      res.status(503).json({ error: "Spend details unavailable" });
    }
  });
}

export interface SpendCsvQualifications {
  status: string;
  dataAsOf: string | null;
  stale: boolean;
  coverage: {
    ratio: number;
    requestedDays: number;
    missingDays: readonly string[];
    failedWorkspaceDays: readonly string[];
  };
  qualifications: readonly string[];
}

export function serializeSpendCsv(
  rows: readonly SpendRow[],
  metadata: SpendCsvQualifications,
): string {
  const header = [
    "qualified_id", "kind", "name", "workspace_id", "workspace",
    "spend_usd", "agent_spend_usd", "other_services_usd",
    "allocation_or_limit_usd", "remaining_usd", "percent_used",
    "current_cycle_agent_spend_usd", "current_cycle_remaining_usd",
    "current_cycle_percent_used",
    "status", "limit_state", "limit_observation_status", "shared_pool", "member_count", "owner",
    "usage_observed",
    "data_status", "data_as_of", "data_stale", "coverage_ratio",
    "coverage_requested_days", "coverage_missing_days",
    "coverage_failed_workspace_days", "data_qualifications",
  ];
  const lines = rows.map((row) => [
    row.id, row.kind, row.name, row.workspaceId ?? "", row.workspaceName ?? "",
    row.usageObserved === false ? "" : row.spendUsd,
    row.usageObserved === false ? "" : row.agentSpendUsd,
    row.usageObserved === false ? "" : row.otherServicesUsd,
    row.allocationUsd ?? "", row.remainingUsd ?? "", row.percentUsed ?? "",
    row.currentCycleAgentSpendUsd ?? "", row.currentCycleRemainingUsd ?? "",
    row.currentCyclePercentUsed ?? "",
    row.status, row.limitState, row.limitObservationStatus,
    row.sharedPool, row.memberCount ?? "", row.ownerName ?? "", row.usageObserved,
    metadata.status, metadata.dataAsOf ?? "", metadata.stale,
    metadata.coverage.ratio, metadata.coverage.requestedDays,
    metadata.coverage.missingDays.join(";"),
    metadata.coverage.failedWorkspaceDays.join(";"),
    metadata.qualifications.join(" "),
  ].map(escapeCsvCell).join(","));
  if (lines.length === 0) {
    const metadataRow: Array<string | number | boolean> =
      Array.from({ length: header.length }, () => "");
    metadataRow[1] = "export_metadata";
    metadataRow[21] = metadata.status;
    metadataRow[22] = metadata.dataAsOf ?? "";
    metadataRow[23] = metadata.stale;
    metadataRow[24] = metadata.coverage.ratio;
    metadataRow[25] = metadata.coverage.requestedDays;
    metadataRow[26] = metadata.coverage.missingDays.join(";");
    metadataRow[27] = metadata.coverage.failedWorkspaceDays.join(";");
    metadataRow[28] = metadata.qualifications.join(" ");
    lines.push(metadataRow.map(escapeCsvCell).join(","));
  }
  return [header.map(escapeCsvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

function createCsvHandler(
  view: TableView,
  querySchema: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { message: string } } },
): (req: Request, res: Response) => Promise<void> {
  return async (req, res): Promise<void> => {
    const startedAt = performance.now();
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
      windowFromQuery(parsed.data as Record<string, unknown>);
    } catch (error) {
      res.status(400).json({
        error: error instanceof UsageWindowError
          ? error.message
          : "Invalid reporting date range",
      });
      return;
    }
    try {
      const payload = await cachedSpendTablePayload(
        req.authz!,
        view,
        parsed.data as Record<string, unknown>,
        req.configurationSnapshot,
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="spend-${view}.csv"`);
      res.setHeader("X-Filtered-Rows", String(payload.filteredAllRows.length));
      res.setHeader("X-Total-Spend-Usd", String(payload.filteredAllRows.reduce(
        (sum, row) => sum + row.spendUsd, 0)));
      res.setHeader("X-Generation-Id", payload.metadata.generationId);
      res.setHeader("X-Data-Status", payload.metadata.status);
      res.setHeader("X-Data-As-Of", payload.metadata.dataAsOf ?? "");
      res.setHeader("X-Coverage-Ratio", String(payload.metadata.coverage.ratio));
      res.setHeader(
        "X-Usage-Range",
        `${payload.period.start}/${payload.period.endExclusive}`,
      );
      res.setHeader("Server-Timing", `spend;dur=${(performance.now() - startedAt).toFixed(1)}`);
      res.send(serializeSpendCsv(payload.filteredAllRows, payload.metadata));
    } catch (error) {
      req.log.error({ err: error, view }, "spend CSV stored accounting failed");
      res.status(503).json({ error: "Spend export unavailable" });
    }
  };
}

function mountCsv(
  path: string,
  handler: (req: Request, res: Response) => Promise<void>,
): void {
  router.get(path, handler);
}

export const handleSpendProjectsCsv = createCsvHandler(
  "projects",
  ExportSpendProjectsTableCsvQueryParams,
);

mount("/spend/pools", "pools", ListSpendPoolsQueryParams, ListSpendPoolsResponse);
mount("/spend/groups", "groups", ListSpendGroupsQueryParams, ListSpendGroupsResponse);
mount("/spend/people", "people", ListSpendPeopleQueryParams, ListSpendPeopleResponse);
mount("/spend/projects", "projects", ListSpendProjectsQueryParams, ListSpendProjectsResponse);
mountCsv("/spend/pools.csv", createCsvHandler("pools", ExportSpendPoolsCsvQueryParams));
mountCsv("/spend/groups.csv", createCsvHandler("groups", ExportSpendGroupsCsvQueryParams));
mountCsv("/spend/people.csv", createCsvHandler("people", ExportSpendPeopleCsvQueryParams));
mountCsv("/spend/projects.csv", handleSpendProjectsCsv);

export default router;