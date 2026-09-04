import { ReplitConnectors } from "@replit/connectors-sdk";

const CONNECTOR = "replit";
const BUDGETS_API_BASE_URL = "https://api.replit.com";
const BUDGETS_API_KEY_ENV = "REPLIT_ENTERPRISE_API_KEY_BUDGETS";
const MAX_PAGES = 200;
const MAX_REQUEST_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;

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

export type ReplitBudgetType =
  | "workspace_group_limit"
  | "workspace_user_limit"
  | "workspace_default_user_limit";

export type ReplitBudgetWrite =
  | {
      type: "workspace_group_limit";
      workspaceId: string;
      groupId: string;
      amountUsd: number | null;
    }
  | {
      type: "workspace_user_limit";
      workspaceId: string;
      userId: string;
      amountUsd: number | null;
    }
  | {
      type: "workspace_default_user_limit";
      workspaceId: string;
      amountUsd: number | null;
    };

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
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ReplitBudgetConnectorError";
  }
}

export interface ReplitBudgetWriteResult {
  requestId?: string;
  readbackRequestId?: string;
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
  if (process.env[BUDGETS_API_KEY_ENV]?.trim()) return true;
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
  const key = process.env[BUDGETS_API_KEY_ENV]?.trim();
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
  return process.env[BUDGETS_API_KEY_ENV]?.trim()
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

interface ReplitBudgetResponse {
  body: unknown;
  requestId?: string;
}

function upstreamRequestId(response: Response): string | undefined {
  for (const name of [
    "x-request-id",
    "request-id",
    "replit-request-id",
    "x-replit-request-id",
  ]) {
    const value = response.headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function retryDelayMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }

  for (const name of [
    "x-ratelimit-reset",
    "ratelimit-reset",
    "rate-limit-reset",
  ]) {
    const raw = response.headers.get(name)?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    if (value < 1_000_000_000) {
      return Math.min(value * 1_000, MAX_RETRY_DELAY_MS);
    }
    const epochMs = value > 10_000_000_000 ? value : value * 1_000;
    return Math.min(Math.max(0, epochMs - Date.now()), MAX_RETRY_DELAY_MS);
  }
  return 1_000;
}

async function requestDetailed(
  path: string,
  init: ReplitBudgetRequest,
  requiredStatus?: number,
): Promise<ReplitBudgetResponse> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
    try {
      response = await (transportOverride ?? configuredTransport())(path, init);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Replit connector unavailable";
      throw new ReplitBudgetConnectorError(errorKind(message), message);
    }
    if (
      (response.status !== 409 && response.status !== 429) ||
      attempt === MAX_REQUEST_ATTEMPTS - 1
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response!)));
  }
  if (!response) throw new Error("Replit budgets API returned no response");
  const requestId = upstreamRequestId(response);
  if (
    !response.ok ||
    (requiredStatus != null && response.status !== requiredStatus)
  ) {
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
    if (requiredStatus != null && response.ok) {
      message = `expected HTTP ${requiredStatus}, received HTTP ${response.status}`;
    }
    throw new ReplitBudgetConnectorError(
      kind,
      response.status === 400
        ? message
        : `Replit budgets API request failed: ${message}`,
      response.status,
      requestId,
    );
  }
  if (response.status === 204) return { body: null, requestId };
  try {
    return { body: await response.json(), requestId };
  } catch {
    throw new ReplitBudgetConnectorError(
      "error",
      "Replit budgets API returned malformed JSON",
      response.status,
      requestId,
    );
  }
}

async function request(
  path: string,
  init: ReplitBudgetRequest,
): Promise<unknown> {
  return (await requestDetailed(path, init)).body;
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

function isBudgetType(value: unknown): value is ReplitBudgetType {
  return (
    value === "workspace_group_limit" ||
    value === "workspace_user_limit" ||
    value === "workspace_default_user_limit"
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
  const explicitMetric = stringValue(
    row.metric,
    row.metricId,
    isBudgetType(row.type) ? undefined : row.type,
  );
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
  const explicitMetric = stringValue(
    row.metric,
    row.metricId,
    isBudgetType(row.type) ? undefined : row.type,
  );
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

/** List all budget rows of one type, optionally scoped to a workspace. */
export async function listBudgets(
  type: ReplitBudgetType,
  workspaceId?: string,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ type });
    if (workspaceId) query.set("workspaceId", workspaceId);
    query.set("limit", "100");
    if (cursor) query.set("cursor", cursor);
    const body = await request(`/v1/budgets?${query}`, { method: "GET" });
    rows.push(...pageRows(body));
    cursor = nextCursor(body);
    if (!cursor) return rows;
  }
  throw new Error(`Replit budgets pagination exceeded ${MAX_PAGES} pages`);
}

export async function listReplitMemberBudgets(
  workspaceId: string,
): Promise<ReplitBudgetSnapshot> {
  const budgets = new Map<string, ReplitMemberBudget>();
  try {
    const canWrite = await connectorCanWrite();
    for (const value of await listBudgets("workspace_user_limit", workspaceId)) {
      const parsed = parseReplitMemberBudget(value, workspaceId);
      if (parsed && parsed.workspaceId === workspaceId) {
        const existing = budgets.get(parsed.userId);
        if (existing && existing.budgetUsd !== parsed.budgetUsd) {
          throw new Error(
            `Replit budgets API returned conflicting limits for workspace user ${parsed.userId}`,
          );
        }
        budgets.set(parsed.userId, parsed);
      }
    }
    return { status: "available", canWrite, error: null, budgets };
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
  try {
    const canWrite = await connectorCanWrite();
    for (const value of await listBudgets("workspace_group_limit", workspaceId)) {
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
    return { status: "available", canWrite, error: null, budgets };
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
  amountUsd: number | null,
): Promise<void> {
  await setBudget({
    type: "workspace_user_limit",
    workspaceId,
    userId,
    amountUsd,
  });
}

export async function setReplitGroupBudget(
  workspaceId: string,
  groupId: string,
  amountUsd: number | null,
): Promise<void> {
  await setBudget({
    type: "workspace_group_limit",
    workspaceId,
    groupId,
    amountUsd,
  });
}

export async function setWorkspaceDefaultUserLimit(
  workspaceId: string,
  amountUsd: number | null,
): Promise<void> {
  await setBudget({
    type: "workspace_default_user_limit",
    workspaceId,
    amountUsd,
  });
}

export interface ReversibleBudgetCanaryResult {
  previousAmountUsd: number | null;
  temporaryAmountUsd: number;
  restoredAmountUsd: number | null;
}

export class ReversibleBudgetCanaryError extends Error {
  constructor(
    public readonly mutationError: unknown,
    public readonly restorationError: unknown,
  ) {
    super(
      restorationError
        ? "Budget canary failed and the prior state could not be verified as restored"
        : "Budget canary mutation failed after the prior state was restored",
    );
    this.name = "ReversibleBudgetCanaryError";
  }
}

/**
 * Exercise the verified write boundary on one member and always restore the
 * exact prior desired state after the temporary write succeeds.
 */
export async function runReversibleMemberBudgetCanary(
  workspaceId: string,
  userId: string,
  temporaryAmountUsd: number,
): Promise<ReversibleBudgetCanaryResult> {
  const snapshot = await listReplitMemberBudgets(workspaceId);
  if (snapshot.status !== "available") {
    throw new ReplitBudgetConnectorError(
      snapshot.status,
      snapshot.error ?? "Unable to read the current member limit",
    );
  }
  const previousAmountUsd = snapshot.budgets.get(userId)?.budgetUsd ?? null;
  let mutationError: unknown = null;
  try {
    await setReplitMemberBudget(workspaceId, userId, temporaryAmountUsd);
  } catch (error) {
    mutationError = error;
  }
  let restorationError: unknown = null;
  try {
    // A POST can reach upstream even when response parsing or readback fails.
    // Therefore cleanup is unconditional once the mutation call has started.
    await setReplitMemberBudget(workspaceId, userId, previousAmountUsd);
  } catch (error) {
    restorationError = error;
  }
  if (mutationError || restorationError) {
    throw new ReversibleBudgetCanaryError(mutationError, restorationError);
  }
  return {
    previousAmountUsd,
    temporaryAmountUsd,
    restoredAmountUsd: previousAmountUsd,
  };
}

function assertAlphanumericId(name: string, value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9]+$/.test(value)) {
    throw new TypeError(`${name} must be a non-empty alphanumeric string`);
  }
}

function validateBudgetWrite(budget: ReplitBudgetWrite): void {
  if (!isBudgetType(budget.type)) {
    throw new TypeError("type must be a supported Replit budget type");
  }
  assertAlphanumericId("workspaceId", budget.workspaceId);
  if (budget.type === "workspace_group_limit") {
    if (typeof budget.groupId !== "string" || budget.groupId.trim().length === 0) {
      throw new TypeError("groupId must be a non-empty string");
    }
  }
  if (
    budget.type === "workspace_user_limit" &&
    !/^[1-9]\d*$/.test(budget.userId)
  ) {
    throw new TypeError("userId must be a positive decimal string");
  }
  if (
    budget.amountUsd !== null &&
    (!Number.isFinite(budget.amountUsd) || budget.amountUsd <= 0)
  ) {
    throw new TypeError(
      "amountUsd must be null or a finite number greater than zero",
    );
  }
}

function desiredBudgetBody(budget: ReplitBudgetWrite): Record<string, unknown> {
  return {
    type: budget.type,
    workspaceId: budget.workspaceId,
    ...(budget.type === "workspace_group_limit"
      ? { groupId: budget.groupId }
      : {}),
    ...(budget.type === "workspace_user_limit"
      ? { userId: budget.userId }
      : {}),
    currency: "USD",
    period: "billing_cycle",
    amountUsd: budget.amountUsd,
  };
}

function hasTargetIdentity(value: unknown, budget: ReplitBudgetWrite): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.type === budget.type &&
    row.workspaceId === budget.workspaceId &&
    (budget.type !== "workspace_group_limit" ||
      row.groupId === budget.groupId) &&
    (budget.type !== "workspace_user_limit" || row.userId === budget.userId)
  );
}

function matchesDesiredBudget(
  value: unknown,
  budget: ReplitBudgetWrite,
): boolean {
  if (!hasTargetIdentity(value, budget) || !value || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    row.currency === "USD" &&
    row.period === "billing_cycle" &&
    row.amountUsd === budget.amountUsd
  );
}

function validationError(
  message: string,
  requestId?: string,
): ReplitBudgetConnectorError {
  return new ReplitBudgetConnectorError("error", message, 200, requestId);
}

async function readbackBudget(
  budget: ReplitBudgetWrite,
): Promise<string | undefined> {
  let cursor: string | null = null;
  let requestId: string | undefined;
  const matchingRows: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({
      type: budget.type,
      workspaceId: budget.workspaceId,
      limit: "100",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await requestDetailed(`/v1/budgets?${query}`, {
      method: "GET",
    });
    requestId = response.requestId ?? requestId;
    let rows: unknown[];
    try {
      rows = pageRows(response.body);
    } catch (error) {
      throw validationError(
        error instanceof Error
          ? error.message
          : "Replit budgets API returned an invalid readback page",
        response.requestId,
      );
    }
    matchingRows.push(
      ...rows.filter((row) => hasTargetIdentity(row, budget)),
    );
    cursor = nextCursor(response.body);
    if (!cursor) {
      if (budget.amountUsd === null) {
        if (matchingRows.length !== 0) {
          throw validationError(
            "Replit budgets API readback did not confirm the cleared desired state",
            requestId,
          );
        }
      } else if (
        matchingRows.length !== 1 ||
        !matchesDesiredBudget(matchingRows[0], budget)
      ) {
        throw validationError(
          "Replit budgets API readback did not match the requested desired state",
          requestId,
        );
      }
      return requestId;
    }
  }
  throw new ReplitBudgetConnectorError(
    "error",
    `Replit budgets pagination exceeded ${MAX_PAGES} pages during readback`,
    undefined,
    requestId,
  );
}

export async function setBudget(
  budget: ReplitBudgetWrite,
): Promise<ReplitBudgetWriteResult> {
  validateBudgetWrite(budget);
  const hasEnterpriseKey = Boolean(process.env[BUDGETS_API_KEY_ENV]?.trim());
  if (
    (transportOverride && !(await connectorCanWrite())) ||
    (!transportOverride && !hasEnterpriseKey)
  ) {
    throw new ReplitBudgetConnectorError(
      "unavailable",
      `${BUDGETS_API_KEY_ENV} is not configured for budget writes`,
    );
  }
  const response = await requestDetailed("/v1/budgets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(desiredBudgetBody(budget)),
  }, 200);

  if (
    !response.body ||
    typeof response.body !== "object" ||
    !Object.prototype.hasOwnProperty.call(response.body, "data")
  ) {
    throw validationError(
      "Replit budgets API returned an invalid budget update response",
      response.requestId,
    );
  }
  const data = (response.body as Record<string, unknown>).data;
  if (
    (budget.amountUsd === null && data !== null) ||
    (budget.amountUsd !== null && !matchesDesiredBudget(data, budget))
  ) {
    throw validationError(
      "Replit budgets API response did not match the requested desired state",
      response.requestId,
    );
  }

  const readbackRequestId = await readbackBudget(budget);
  return {
    ...(response.requestId ? { requestId: response.requestId } : {}),
    ...(readbackRequestId ? { readbackRequestId } : {}),
  };
}
