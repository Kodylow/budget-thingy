export type ApiDiagnosticCategory = "success" | "http" | "network" | "parse" | "aborted";

export const DATA_UNAVAILABLE_REASONS = [
  "no_usage_observed",
  "incomplete_usage",
  "incomplete_scope",
  "limit_observation_failed",
  "limit_observation_unavailable",
  "limit_observation_refreshing",
  "missing_allocation",
  "period_mismatch",
  "explicit_unavailable",
  "missing_value",
  "authorization_unavailable",
  "scan_truncated",
  "instrumentation_failed",
] as const;

export type DataUnavailableReason = typeof DATA_UNAVAILABLE_REASONS[number];

export interface DataUnavailableSite {
  path: string;
  reason: DataUnavailableReason;
  count: number;
}

export interface DataUnavailableSummary {
  count: number;
  sites: DataUnavailableSite[];
  truncated: boolean;
}

export interface ApiDiagnosticDataState {
  metadataStatus?: "complete" | "stale" | "partial" | "empty" | "unavailable";
  stale?: boolean;
  dataAvailable?: boolean;
  rowCount?: number;
  dashboardCardKeys?: Array<
    | "eligible_spend"
    | "allocated_budget"
    | "allocation_remaining"
    | "pools_attention"
    | "spend"
    | "agent_spend"
    | "other_services"
    | "members_with_spend"
    | "your_agent_spend"
    | "monthly_agent_limit"
    | "agent_limit_remaining"
  >;
  limitObservationStateCounts?: Partial<
    Record<"not_applicable" | "complete" | "failed" | "unavailable" | "refreshing", number>
  >;
  unavailable?: DataUnavailableSummary;
}

export interface ApiDiagnosticEntry {
  timestamp: string;
  method: string;
  endpoint: string;
  route: string;
  status: number | null;
  elapsedMs: number;
  requestId: string | null;
  category: ApiDiagnosticCategory;
  dataState?: ApiDiagnosticDataState;
}

export interface UiDiagnosticSource {
  page: string;
  selector: string;
  columnIndex?: number;
  attribute?: "title" | "aria-label" | "placeholder" | "alt";
  truncated?: boolean;
}

export interface UiDiagnosticEntry {
  timestamp: string;
  event: "ui_data_unavailable" | "ui_data_available" | "ui_unavailable_removed";
  reason: "rendered_unavailable";
  source: UiDiagnosticSource;
  count: number;
  requestIdCandidates: string[];
  truncated?: boolean;
}

const HISTORY_LIMIT = 25;
const UI_HISTORY_LIMIT = 100;
const ALLOWED_QUERY_KEYS = new Set([
  "role",
  "viewScope",
  "rangeType",
  "start",
  "end",
  "startDate",
  "endDate",
]);
const listeners = new Set<() => void>();
let history: ApiDiagnosticEntry[] = [];
let uiHistory: UiDiagnosticEntry[] = [];
const METADATA_STATUSES = new Set([
  "complete",
  "stale",
  "partial",
  "empty",
  "unavailable",
] as const);
const DASHBOARD_CARD_KEYS = new Set([
  "eligible_spend",
  "allocated_budget",
  "allocation_remaining",
  "pools_attention",
  "spend",
  "agent_spend",
  "other_services",
  "members_with_spend",
  "your_agent_spend",
  "monthly_agent_limit",
  "agent_limit_remaining",
] as const);
const LIMIT_OBSERVATION_STATES = new Set([
  "not_applicable",
  "complete",
  "failed",
  "unavailable",
  "refreshing",
] as const);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Extracts only an intentionally tiny primitive envelope from a parsed response. */
export function summarizeApiResponse(value: unknown): ApiDiagnosticDataState | undefined {
  const root = objectValue(value);
  if (!root) return undefined;
  const summary: ApiDiagnosticDataState = {};
  const metadata = objectValue(root.metadata);

  if (metadata && typeof metadata.status === "string" &&
      METADATA_STATUSES.has(metadata.status as never)) {
    summary.metadataStatus = metadata.status as ApiDiagnosticDataState["metadataStatus"];
  }
  if (metadata && typeof metadata.stale === "boolean") summary.stale = metadata.stale;
  if (metadata && typeof metadata.dataAvailable === "boolean") {
    summary.dataAvailable = metadata.dataAvailable;
  }

  if (Array.isArray(root.rows)) summary.rowCount = root.rows.length;

  if (Array.isArray(root.cards)) {
    const keys = root.cards.flatMap((card) => {
      const key = objectValue(card)?.key;
      return typeof key === "string" && DASHBOARD_CARD_KEYS.has(key as never)
        ? [key as NonNullable<ApiDiagnosticDataState["dashboardCardKeys"]>[number]]
        : [];
    });
    if (keys.length > 0) summary.dashboardCardKeys = [...new Set(keys)];
  }

  const observations = Array.isArray(root.rows)
    ? root.rows
    : Array.isArray(root.members)
      ? root.members
      : null;
  if (observations) {
    const counts: NonNullable<ApiDiagnosticDataState["limitObservationStateCounts"]> = {};
    observations.forEach((item) => {
      const state = objectValue(item)?.limitObservationStatus;
      if (typeof state === "string" && LIMIT_OBSERVATION_STATES.has(state as never)) {
        const safeState = state as keyof typeof counts;
        counts[safeState] = (counts[safeState] ?? 0) + 1;
      }
    });
    if (Object.keys(counts).length > 0) summary.limitObservationStateCounts = counts;
  }

  const unavailableSites: DataUnavailableSite[] = [];
  if (summary.metadataStatus === "unavailable" || summary.dataAvailable === false) {
    unavailableSites.push({
      path: summary.dataAvailable === false ? "metadata.dataAvailable" : "metadata.status",
      reason: "explicit_unavailable",
      count: 1,
    });
  }
  const unavailableCount = summary.limitObservationStateCounts?.unavailable ?? 0;
  const failedCount = summary.limitObservationStateCounts?.failed ?? 0;
  const refreshingCount = summary.limitObservationStateCounts?.refreshing ?? 0;
  if (unavailableCount > 0) unavailableSites.push({ path: "rows[].limitObservationStatus", reason: "limit_observation_unavailable", count: unavailableCount });
  if (failedCount > 0) unavailableSites.push({ path: "rows[].limitObservationStatus", reason: "limit_observation_failed", count: failedCount });
  if (refreshingCount > 0) unavailableSites.push({ path: "rows[].limitObservationStatus", reason: "limit_observation_refreshing", count: refreshingCount });
  if (unavailableSites.length > 0) {
    summary.unavailable = {
      count: unavailableSites.reduce((total, site) => total + site.count, 0),
      sites: unavailableSites,
      truncated: false,
    };
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

const DATA_UNAVAILABLE_REASON_SET = new Set<string>(DATA_UNAVAILABLE_REASONS);
const SAFE_FIELD_PATH = /^(?:[A-Za-z][A-Za-z0-9_]{0,63})(?:(?:\.(?:[A-Za-z][A-Za-z0-9_]{0,63}|\[field\]))|(?:\[\])){0,15}$/;

/** Parses the server's compact, safe availability envelope without retaining its raw value. */
export function parseDataUnavailableHeader(value: string | null): DataUnavailableSummary | undefined {
  if (!value || value.length > 3500 || /[^\x20-\x7e]/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    const root = objectValue(parsed);
    if (!root || !Number.isSafeInteger(root.count) || (root.count as number) < 1 ||
        typeof root.truncated !== "boolean" || !Array.isArray(root.sites) || root.sites.length > 128) {
      return undefined;
    }
    const sites: DataUnavailableSite[] = [];
    for (const candidate of root.sites) {
      const site = objectValue(candidate);
      if (!site || typeof site.path !== "string" || !SAFE_FIELD_PATH.test(site.path) ||
          typeof site.reason !== "string" || !DATA_UNAVAILABLE_REASON_SET.has(site.reason) ||
          !Number.isSafeInteger(site.count) || (site.count as number) < 1) {
        return undefined;
      }
      sites.push({
        path: site.path,
        reason: site.reason as DataUnavailableReason,
        count: site.count as number,
      });
    }
    if (sites.length === 0 || sites.reduce((total, site) => total + site.count, 0) > (root.count as number)) {
      return undefined;
    }
    return { count: root.count as number, sites, truncated: root.truncated };
  } catch {
    return undefined;
  }
}

function safeScopeValue(key: string, value: string): string | null {
  if (key === "start" || key === "end" || key === "startDate" || key === "endDate") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
      ? value
      : null;
  }
  return /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
}

function isDynamicPathSegment(segments: string[], index: number): boolean {
  const previous = segments[index - 1];
  const beforePrevious = segments[index - 2];
  if (
    previous === "groups" ||
    previous === "projects" ||
    previous === "clusters" ||
    previous === "workspaces" ||
    previous === "admins" ||
    previous === "app-admins" ||
    previous === "alerts" ||
    previous === "operations"
  ) {
    return true;
  }
  if (previous === "members" && segments[index] !== "budget") return true;
  if (
    beforePrevious === "reporting" &&
    (previous === "details" || previous === "teams")
  ) {
    return true;
  }
  if (previous === "team-budgets" && segments[index] !== "targets") return true;
  if (previous === "targets" || beforePrevious === "targets") return true;
  return false;
}

function safePathname(pathname: string): string {
  const segments = pathname.split("/");
  return segments
    .map((segment, index) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return "[redacted]";
      }
      return isDynamicPathSegment(segments, index) ||
        decoded.includes("@") ||
        decoded.length > 128
        ? "[redacted]"
        : segment;
    })
    .join("/");
}

/**
 * Returns only the path and explicitly approved scoping query parameters.
 * Hosts, fragments, identities, and all other query values are discarded.
 */
export function sanitizeDiagnosticUrl(input: string): string {
  try {
    const url = new URL(input, "https://diagnostics.invalid");
    const query = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      const safeValue = safeScopeValue(key, value);
      if (ALLOWED_QUERY_KEYS.has(key) && safeValue) query.append(key, safeValue);
    });
    const suffix = query.toString();
    return `${safePathname(url.pathname)}${suffix ? `?${suffix}` : ""}`;
  } catch {
    return "[invalid-path]";
  }
}

export function getApiDiagnostics(): readonly ApiDiagnosticEntry[] {
  return history;
}

export function getUiDiagnostics(): readonly UiDiagnosticEntry[] {
  return uiHistory;
}

export function getRecentDiagnosticRequestIds(limit = 5): string[] {
  const result: string[] = [];
  const route = currentDiagnosticRoute();
  for (let index = history.length - 1; index >= 0 && result.length < Math.max(0, Math.min(limit, 10)); index -= 1) {
    const entry = history[index];
    if (entry?.route !== route) continue;
    const requestId = entry.requestId;
    if (requestId && !result.includes(requestId)) result.push(requestId);
  }
  return result;
}

export function subscribeApiDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A diagnostics UI subscriber must never alter API request behavior.
      try {
        console.error("api_diagnostics_subscriber_failed", { category: "subscriber" });
      } catch {
        // Diagnostics logging itself is best effort.
      }
    }
  });
}

export function recordApiDiagnostic(entry: ApiDiagnosticEntry): void {
  history = [...history.slice(-(HISTORY_LIMIT - 1)), Object.freeze({ ...entry })];
  notifyListeners();
}

export function recordUiDiagnostic(entry: UiDiagnosticEntry): void {
  recordUiDiagnostics([entry]);
}

/** Appends a frame of UI transitions and notifies subscribers only once. */
export function recordUiDiagnostics(entries: readonly UiDiagnosticEntry[]): void {
  if (entries.length === 0) return;
  const frozen = entries.map(entry => Object.freeze({
    ...entry,
    source: Object.freeze({ ...entry.source }),
    requestIdCandidates: Object.freeze([...entry.requestIdCandidates]) as unknown as string[],
  }));
  uiHistory = [...uiHistory, ...frozen].slice(-UI_HISTORY_LIMIT);
  notifyListeners();
}

/** Clears volatile history. Primarily useful when signing out and in tests. */
export function clearApiDiagnostics(): void {
  history = [];
  uiHistory = [];
  notifyListeners();
}

export function currentDiagnosticRoute(): string {
  if (typeof window === "undefined") return "[non-browser]";
  return sanitizeDiagnosticUrl(`${window.location.pathname}${window.location.search}`);
}

export function sanitizeDiagnosticRequestId(value: string | null): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}