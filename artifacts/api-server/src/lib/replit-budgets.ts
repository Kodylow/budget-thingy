import { ReplitConnectors } from "@replit/connectors-sdk";

const CONNECTOR = "replit";
const BUDGETS_API_BASE_URL = "https://api.replit.com";
const BUDGETS_API_KEY_ENV = "REPLIT_ENTERPRISE_API_KEY_BUDGETS";
const MAX_PAGES = 200;

export type BudgetConnectorStatus = "available" | "unavailable" | "error";

export interface ReplitMemberBudget {
  workspaceId: string;
  userId: string;
  budgetUsd: number | null;
}

export interface ReplitGroupBudget {
  workspaceId: string;
  groupId: string;
  budgetUsd: number | null;
}

export interface ReplitBudgetSnapshot {
  status: BudgetConnectorStatus;
  canWrite: boolean;
  error: string | null;
  budgets: Map<string, ReplitMemberBudget>;
}

export interface ReplitGroupBudgetSnapshot {
  status: BudgetConnectorStatus;
  canWrite: boolean;
  error: string | null;
  budgets: Map<string, ReplitGroupBudget>;
}

export class ReplitBudgetConnectorError extends Error {
  constructor(
    public readonly kind: Exclude<BudgetConnectorStatus, "available">,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export interface ReplitBudgetRequest {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export type ReplitBudgetTransport = (
  path: string,
  init: ReplitBudgetRequest,
) => Promise<Response>;

let transportOverride: ReplitBudgetTransport | null = null;
let writeCapabilityOverride: boolean | null = null;

/** Test-only seam; null restores the real Replit connector. */
export function setReplitBudgetTransportForTests(
  transport: ReplitBudgetTransport | null,
  canWrite = true,
): void {
  transportOverride = transport;
  writeCapabilityOverride = transport ? canWrite : null;
}

function containsScope(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .some((scope) => scope.trim().toLowerCase() === expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsScope(item, expected));
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    /scope|permission|grant/i.test(key) && containsScope(nested, expected),
  );
}

async function connectorCanWrite(): Promise<boolean> {
  if (writeCapabilityOverride != null) return writeCapabilityOverride;
  // Enterprise budget keys are provisioned with their scopes upstream. Do not
  // add a second local feature flag that can contradict the key's real grants;
  // the Budgets API remains the source of truth and will reject unauthorized
  // writes with 401/403.
  if (process.env[BUDGETS_API_KEY_ENV]) return true;
  try {
    const connections = await new ReplitConnectors().listConnections({
      // The current connector API rejects the unsupported "integration"
      // expansion. Request only connector metadata so capability discovery
      // does not fail closed for every otherwise healthy connection.
      expand: ["connector"],
      refresh_policy: "auto",
    });
    const active = connections.find(
      (connection) =>
        connection.connector_name === CONNECTOR &&
        !/disconnected|error|invalid|expired|revoked/i.test(
          `${connection.status ?? ""} ${connection.status_message ?? ""}`,
        ),
    );
    return active ? containsScope(active, "write:budgets") : false;
  } catch {
    // Capability discovery is advisory and always fails closed.
    return false;
  }
}

async function connectorTransport(
  path: string,
  init: ReplitBudgetRequest,
): Promise<Response> {
  return new ReplitConnectors().proxy(CONNECTOR, path, init);
}

async function enterpriseBudgetTransport(
  path: string,
  init: ReplitBudgetRequest,
): Promise<Response> {
  const key = process.env[BUDGETS_API_KEY_ENV];
  if (!key) {
    throw new Error(`${BUDGETS_API_KEY_ENV} is not configured`);
  }
  return fetch(`${BUDGETS_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${key}`,
    },
  });
}

function configuredTransport(): ReplitBudgetTransport {
  return process.env[BUDGETS_API_KEY_ENV]
    ? enterpriseBudgetTransport
    : connectorTransport;
}

function errorKind(message: string): "unavailable" | "error" {
  return /(not.?connected|not configured|connector.*unavailable|identity|renewal|hostname)/i.test(
    message,
  )
    ? "unavailable"
    : "error";
}

async function request(
  path: string,
  init: ReplitBudgetRequest,
): Promise<unknown> {
  let response: Response;
  try {
    response = await (transportOverride ?? configuredTransport())(path, init);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Replit connector unavailable";
    throw new ReplitBudgetConnectorError(errorKind(message), message);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text || `${response.status} ${response.statusText}`.trim();
    try {
      const parsed = JSON.parse(text) as {
        error?: string | { message?: string };
        message?: string;
      };
      message =
        typeof parsed.error === "string"
          ? parsed.error
          : (parsed.error?.message ?? parsed.message ?? message);
    } catch {
      // Preserve the text response.
    }
    const kind =
      response.status === 401 ||
      /not.?connected|connector.*unavailable/i.test(message)
        ? "unavailable"
        : "error";
    throw new ReplitBudgetConnectorError(
      kind,
      `Replit budgets API request failed: ${message}`,
      response.status,
    );
  }
  if (response.status === 204) return null;
  return response.json();
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(...values: unknown[]): string | null {
  return values.find(
    (value) => typeof value === "string" && value.length > 0,
  ) as string | null;
}

function isAgentMetric(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.toLowerCase() === "agent" ||
      value.toLowerCase().includes("ai_agent") ||
      value.toLowerCase().includes("ai-agent"))
  );
}

function agentAmount(value: unknown, amountKeys: string[]): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const metric = stringValue(
    record.metric,
    record.metricId,
    record.id,
    record.name,
    record.type,
  );
  if (metric && isAgentMetric(metric)) {
    for (const key of amountKeys) {
      const amount = finiteNumber(record[key]);
      if (amount != null) return amount;
    }
  }
  for (const key of ["metrics", "items", "budgets", "usage", "limits"]) {
    const values = record[key];
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      const amount = agentAmount(item, amountKeys);
      if (amount != null) return amount;
    }
  }
  return null;
}

/** Normalize workspace user limits from current and earlier flat beta responses. */
export function parseReplitMemberBudget(
  value: unknown,
  fallbackWorkspaceId?: string,
): ReplitMemberBudget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const user =
    row.user && typeof row.user === "object"
      ? (row.user as Record<string, unknown>)
      : {};
  const workspace =
    row.workspace && typeof row.workspace === "object"
      ? (row.workspace as Record<string, unknown>)
      : {};
  const userId = stringValue(row.userId, row.memberId, user.id);
  const workspaceId = stringValue(
    row.workspaceId,
    workspace.id,
    fallbackWorkspaceId,
  );
  if (!userId || !workspaceId) return null;
  const explicitMetric = stringValue(row.metric, row.metricId, row.type);
  if (explicitMetric && !isAgentMetric(explicitMetric)) return null;

  const budgetUsd =
    finiteNumber(row.budgetUsd) ??
    finiteNumber(row.amountUsd) ??
    finiteNumber(row.limitUsd) ??
    finiteNumber(row.desiredBudgetUsd) ??
    agentAmount(row, ["budgetUsd", "amountUsd", "limitUsd", "amount", "limit"]);
  return { workspaceId, userId, budgetUsd };
}

/** Normalize workspace group limits from current and earlier flat beta responses. */
export function parseReplitGroupBudget(
  value: unknown,
  fallbackWorkspaceId?: string,
): ReplitGroupBudget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const group =
    row.group && typeof row.group === "object"
      ? (row.group as Record<string, unknown>)
      : {};
  const workspace =
    row.workspace && typeof row.workspace === "object"
      ? (row.workspace as Record<string, unknown>)
      : {};
  const groupId = stringValue(row.groupId, group.id);
  const workspaceId = stringValue(
    row.workspaceId,
    workspace.id,
    fallbackWorkspaceId,
  );
  if (!groupId || !workspaceId) return null;
  const explicitMetric = stringValue(row.metric, row.metricId, row.type);
  if (explicitMetric && !isAgentMetric(explicitMetric)) return null;

  const budgetUsd =
    finiteNumber(row.budgetUsd) ??
    finiteNumber(row.amountUsd) ??
    finiteNumber(row.limitUsd) ??
    finiteNumber(row.desiredBudgetUsd) ??
    agentAmount(row, ["budgetUsd", "amountUsd", "limitUsd", "amount", "limit"]);
  return { workspaceId, groupId, budgetUsd };
}

function pageRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") {
    throw new Error("Replit budgets API returned an invalid page");
  }
  const object = body as Record<string, unknown>;
  const data = object.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    if (Array.isArray(nested.budgets)) return nested.budgets;
    if (Array.isArray(nested.items)) return nested.items;
  }
  if (Array.isArray(object.budgets)) return object.budgets;
  if (Array.isArray(object.items)) return object.items;
  throw new Error("Replit budgets API returned an invalid page");
}

function nextCursor(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const object = body as Record<string, any>;
  const pagination = object.pagination ?? object.data?.pagination;
  const cursor =
    pagination?.cursor ??
    pagination?.nextCursor ??
    object.nextCursor ??
    object.cursor;
  const hasMore = pagination?.hasMore ?? object.hasMore;
  return hasMore !== false && typeof cursor === "string" && cursor
    ? cursor
    : null;
}

export async function listReplitMemberBudgets(
  workspaceId: string,
): Promise<ReplitBudgetSnapshot> {
  const budgets = new Map<string, ReplitMemberBudget>();
  let cursor: string | null = null;
  try {
    const canWrite = await connectorCanWrite();
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        workspaceId,
        billingPeriod: "current",
        limit: "100",
      });
      if (cursor) query.set("cursor", cursor);
      const body = await request(`/v1/budgets?${query}`, { method: "GET" });
      for (const value of pageRows(body)) {
        const parsed = parseReplitMemberBudget(value, workspaceId);
        if (parsed && parsed.workspaceId === workspaceId) {
          const existing = budgets.get(parsed.userId);
          if (existing && existing.budgetUsd !== parsed.budgetUsd) {
            throw new Error(
              `Replit budgets API returned conflicting limits for workspace user ${parsed.userId}`,
            );
          }
          // Stable workspace/user identity deduplicates replayed pages without
          // duplicating a limit across role-based groups.
          budgets.set(parsed.userId, parsed);
        }
      }
      cursor = nextCursor(body);
      if (!cursor) return { status: "available", canWrite, error: null, budgets };
    }
    throw new Error(`Replit budgets pagination exceeded ${MAX_PAGES} pages`);
  } catch (error) {
    const connectorError =
      error instanceof ReplitBudgetConnectorError
        ? error
        : new ReplitBudgetConnectorError(
            "error",
            error instanceof Error
              ? error.message
              : "Unknown Replit budgets error",
          );
    return {
      status: connectorError.kind,
      canWrite: false,
      error: connectorError.message,
      budgets: new Map(),
    };
  }
}

export async function listReplitGroupBudgets(
  workspaceId: string,
): Promise<ReplitGroupBudgetSnapshot> {
  const budgets = new Map<string, ReplitGroupBudget>();
  let cursor: string | null = null;
  try {
    const canWrite = await connectorCanWrite();
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        workspaceId,
        billingPeriod: "current",
        metric: "replit:v0:teams:ai_agent",
        limit: "100",
      });
      if (cursor) query.set("cursor", cursor);
      const body = await request(`/v1/budgets?${query}`, { method: "GET" });
      for (const value of pageRows(body)) {
        const parsed = parseReplitGroupBudget(value, workspaceId);
        if (parsed && parsed.workspaceId === workspaceId) {
          const existing = budgets.get(parsed.groupId);
          if (existing && existing.budgetUsd !== parsed.budgetUsd) {
            throw new Error(
              `Replit budgets API returned conflicting limits for workspace group ${parsed.groupId}`,
            );
          }
          budgets.set(parsed.groupId, parsed);
        }
      }
      cursor = nextCursor(body);
      if (!cursor) return { status: "available", canWrite, error: null, budgets };
    }
    throw new Error(`Replit budgets pagination exceeded ${MAX_PAGES} pages`);
  } catch (error) {
    const connectorError =
      error instanceof ReplitBudgetConnectorError
        ? error
        : new ReplitBudgetConnectorError(
            "error",
            error instanceof Error
              ? error.message
              : "Unknown Replit budgets error",
          );
    return {
      status: connectorError.kind,
      canWrite: false,
      error: connectorError.message,
      budgets: new Map(),
    };
  }
}

export async function setReplitMemberBudget(
  workspaceId: string,
  userId: string,
  amountUsd: number,
): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new TypeError("amountUsd must be a finite number greater than zero");
  }
  if (!(await connectorCanWrite())) {
    throw new ReplitBudgetConnectorError(
      "unavailable",
      "The approved Replit integration does not grant write:budgets",
    );
  }
  await request("/v1/budgets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      userId,
      billingPeriod: "current",
      metric: "replit:v0:teams:ai_agent",
      amountUsd,
    }),
  });
}

export async function clearReplitMemberBudget(
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!(await connectorCanWrite())) {
    throw new ReplitBudgetConnectorError(
      "unavailable",
      "The approved Replit integration does not grant write:budgets",
    );
  }
  const query = new URLSearchParams({
    workspaceId,
    userId,
    billingPeriod: "current",
    metric: "replit:v0:teams:ai_agent",
  });
  await request(`/v1/budgets?${query}`, { method: "DELETE" });
}

export async function setReplitGroupBudget(
  workspaceId: string,
  groupId: string,
  amountUsd: number,
): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new TypeError("amountUsd must be a finite number greater than zero");
  }
  if (!(await connectorCanWrite())) {
    throw new ReplitBudgetConnectorError(
      "unavailable",
      "The approved Replit integration does not grant write:budgets",
    );
  }
  await request("/v1/budgets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      groupId,
      billingPeriod: "current",
      metric: "replit:v0:teams:ai_agent",
      amountUsd,
    }),
  });
}

export async function clearReplitGroupBudget(
  workspaceId: string,
  groupId: string,
): Promise<void> {
  if (!(await connectorCanWrite())) {
    throw new ReplitBudgetConnectorError(
      "unavailable",
      "The approved Replit integration does not grant write:budgets",
    );
  }
  const query = new URLSearchParams({
    workspaceId,
    groupId,
    billingPeriod: "current",
    metric: "replit:v0:teams:ai_agent",
  });
  await request(`/v1/budgets?${query}`, { method: "DELETE" });
}
